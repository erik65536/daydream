/**
 * The broker's HTTP front. It speaks ComfyUI's own API, so a caller's ComfyUI code only changes its base URL:
 * /prompt is queued here and sent to ComfyUI in its turn; /history answers "not yet" while it waits (with an
 * X-Broker-State header saying so, which callers use to keep their deadline from running); /queue shows the work
 * held here as pending; uploads and downloads pass straight through. Plus /broker/queue (everything, for the admin
 * page), /broker/speech (speech on the GPU: a WebSocket, see adapters/speech.ts) and /broker/speech/sessions (a
 * build's turn with it).
 *
 * Every client sees the whole queue, and stops only its own work: canceling, clearing and interrupting act on what
 * that client queued, never on another's.
 */
import crypto from 'node:crypto';
import http from 'node:http';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Broker, Item } from './scheduler.ts';
import type { ComfyAdapter, ComfyWork } from './adapters/comfyui.ts';
import type { SpeechAdapter, SpeechWork } from './adapters/speech.ts';
import { WebSocketServer } from 'ws';

interface FrontOptions {
  /** Bearer token → client name. Requests from this PC without a token are the client "local". */
  clients: Record<string, string>;
  speech?: SpeechAdapter;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1']);
const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[::1\])(:\d+)?$/;

/** The request itself is wrong (answered 400, not 500). */
class BadRequest extends Error {}

function readBody(req: http.IncomingMessage, limit = 64 * 1024 * 1024): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let n = 0;
    req.on('data', (c: Buffer) => {
      n += c.length;
      if (n > limit) {
        reject(new BadRequest('body too large'));
        req.destroy();
      } else parts.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(parts)));
    req.on('error', reject);
  });
}

/** A request's JSON body, which must be an object (none at all is an empty one). */
async function readJson<T>(req: http.IncomingMessage): Promise<T> {
  let body: unknown;
  try {
    body = JSON.parse((await readBody(req)).toString('utf8') || '{}');
  } catch (e) {
    throw e instanceof BadRequest ? e : new BadRequest('the body is not JSON');
  }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new BadRequest('the body is not a JSON object');
  return body as T;
}

const json = (res: http.ServerResponse, status: number, body: unknown, headers: Record<string, string> = {}) => {
  res.writeHead(status, { 'content-type': 'application/json', ...headers });
  res.end(JSON.stringify(body));
};

/** How a queued item is waiting, for X-Broker-State. */
function stateHeader(broker: Broker, it: Item): string {
  if (it.state !== 'queued') return it.state;
  const parts = ['queued', `position=${broker.position(it.id)}`];
  if (broker.isDown(it.adapter)) parts.push(`waiting=${it.adapter} not answering`);
  return parts.join('; ');
}

export function createFront(broker: Broker, comfy: ComfyAdapter, opts: FrontOptions): http.Server {
  const byToken = new Map(Object.entries(opts.clients).map(([name, token]) => [token, name]));

  const clientOf = (req: http.IncomingMessage): string | null => {
    const m = /^Bearer\s+(.+)$/i.exec(req.headers.authorization ?? '');
    if (m) return byToken.get(m[1]!.trim()) ?? null;
    // Without a token, only this PC's own programs, asking for this PC by its own name: a web page that points a
    // host name of its own at 127.0.0.1 (DNS rebinding) sends that name as Host.
    return LOOPBACK.has(req.socket.remoteAddress ?? '') && LOCAL_HOST.test(req.headers.host ?? '') ? 'local' : null;
  };

  /** Pass a request to ComfyUI unchanged (minus our auth), streaming both ways. */
  const proxy = async (req: http.IncomingMessage, res: http.ServerResponse, body?: Buffer) => {
    const headers: Record<string, string> = {};
    for (const [k, v] of Object.entries(req.headers)) if (typeof v === 'string' && !['host', 'authorization', 'connection', 'content-length'].includes(k)) headers[k] = v;
    try {
      const hasBody = req.method !== 'GET' && req.method !== 'HEAD';
      // duplex: Node's fetch needs it to stream a request body.
      const init = { method: req.method, headers, body: hasBody ? (body ?? Readable.toWeb(req)) : undefined, duplex: hasBody && !body ? 'half' : undefined };
      const up = await fetch(comfy.url + req.url, init as RequestInit);
      const out: Record<string, string> = {};
      up.headers.forEach((v, k) => {
        if (!['content-encoding', 'content-length', 'transfer-encoding', 'connection'].includes(k)) out[k] = v;
      });
      res.writeHead(up.status, out);
      // pipeline, not pipe: ComfyUI closing mid-download must fail this one reply, not crash the broker.
      if (up.body) await pipeline(Readable.fromWeb(up.body as never), res);
      else res.end();
    } catch (e) {
      if (!res.headersSent) json(res, 502, { error: `ComfyUI is not answering: ${(e as Error).message}` });
      else res.destroy();
    }
  };

  const comfyItems = () => broker.queued().filter((i) => i.adapter === 'comfyui') as Item<ComfyWork>[];

  const routes = async (req: http.IncomingMessage, res: http.ServerResponse, client: string) => {
    const url = new URL(req.url ?? '/', 'http://broker');
    const p = url.pathname;

    if (req.method === 'POST' && p === '/prompt') {
      const body = await readJson<ComfyWork & { prompt_id?: string }>(req);
      if (!body.prompt || typeof body.prompt !== 'object') return json(res, 400, { error: { type: 'no_prompt', message: 'No prompt provided' } });
      const tag = (body.extra_data?.daydream ?? {}) as { workflow?: string; rank?: number };
      const id = typeof body.prompt_id === 'string' && UUID.test(body.prompt_id) ? body.prompt_id : undefined;
      const work: ComfyWork = { prompt: body.prompt, client_id: body.client_id, extra_data: body.extra_data };
      let it: Item;
      try {
        it = broker.submit('comfyui', work, { client, rank: tag.rank, model: tag.workflow || modelsOf(body.prompt), tag: body.extra_data?.daydream as Record<string, unknown> }, id);
      } catch (e) {
        return json(res, 400, { error: { type: 'invalid_prompt_id', message: (e as Error).message } });
      }
      return json(res, 200, { prompt_id: it.id, number: it.number, node_errors: {} }, { 'x-broker-state': stateHeader(broker, it) });
    }

    const hist = /^\/history\/([^/]+)$/.exec(p);
    if (req.method === 'GET' && hist) {
      const id = decodeURIComponent(hist[1]!);
      const it = broker.get(id);
      if (it && it.state === 'queued') return json(res, 200, {}, { 'x-broker-state': stateHeader(broker, it) });
      let entry: unknown;
      try {
        entry = ((await (await fetch(`${comfy.url}/history/${encodeURIComponent(id)}`, { signal: AbortSignal.timeout(15_000) })).json()) as Record<string, unknown>)[id];
      } catch (e) {
        if (it) return json(res, 200, {}, { 'x-broker-state': `${it.state}; waiting=comfyui not answering` });
        return json(res, 502, { error: `ComfyUI is not answering: ${(e as Error).message}` });
      }
      if (entry) return json(res, 200, { [id]: entry }, it ? { 'x-broker-state': it.state } : {});
      if (!it) return json(res, 404, { error: 'unknown prompt (the broker may have restarted): submit it again' });
      // Ended here without a history entry in ComfyUI (refused, or canceled before it was sent): say so as ComfyUI would.
      if (it.state === 'failed' || it.state === 'cancelled') {
        const message = it.state === 'cancelled' ? 'cancelled' : (it.error ?? 'failed');
        return json(res, 200, { [id]: { outputs: {}, status: { status_str: 'error', completed: false, messages: [['execution_error', { exception_message: message }]] } } }, { 'x-broker-state': it.state });
      }
      return json(res, 200, {}, { 'x-broker-state': it.state });
    }

    if (req.method === 'GET' && p === '/queue') {
      // ComfyUI's queue (at most the broker's one running prompt, plus anything sent to it directly) and the
      // prompts held here, as pending, so the game's admin page and canceling keep working unchanged.
      let q: { queue_running?: unknown[]; queue_pending?: unknown[] };
      try {
        q = (await (await fetch(`${comfy.url}/queue`, { signal: AbortSignal.timeout(5000) })).json()) as typeof q;
      } catch (e) {
        return json(res, 502, { error: `ComfyUI is not answering: ${(e as Error).message}` });
      }
      const held = comfyItems().map((i) => [i.number, i.id, i.work.prompt, { client_id: i.work.client_id, ...i.work.extra_data }, []]);
      return json(res, 200, { queue_running: q.queue_running ?? [], queue_pending: [...(q.queue_pending ?? []), ...held] });
    }

    if (req.method === 'POST' && p === '/queue') {
      const body = await readJson<{ delete?: unknown; clear?: boolean }>(req);
      // The client's own prompts are canceled here and another client's are left alone. Ids the broker never saw
      // (prompts sent to ComfyUI directly, on this PC) go on to ComfyUI.
      const rest: string[] = [];
      for (const id of Array.isArray(body.delete) ? body.delete.map(String) : []) {
        const it = broker.get(id);
        if (!it) rest.push(id);
        else if (it.client === client) broker.cancel(id);
      }
      if (body.clear) for (const i of comfyItems()) if (i.client === client) broker.cancel(i.id);
      if (!rest.length) return json(res, 200, {});
      return proxy(req, res, Buffer.from(JSON.stringify({ delete: rest })));
    }

    if (req.method === 'POST' && p === '/interrupt') {
      const body = await readJson<{ prompt_id?: unknown }>(req);
      const id = typeof body.prompt_id === 'string' ? body.prompt_id : undefined;
      // Without an id: the prompt running now, when it is this client's. Another client's is never interrupted.
      const running = broker.snapshot().running;
      const it = broker.get(id ?? (running?.adapter === 'comfyui' ? running.id : ''));
      if (it?.client === client) broker.cancel(it.id);
      if (it || !id) return json(res, 200, {});
      // An id the broker never saw: a prompt sent to ComfyUI directly, interrupted there by its id.
      return proxy(req, res, Buffer.from(JSON.stringify({ prompt_id: id })));
    }

    // Only the broker unloads: a caller's /free is answered and ignored.
    if (req.method === 'POST' && p === '/free') return json(res, 200, {});

    if (req.method === 'GET' && p === '/system_stats') {
      try {
        const s = (await (await fetch(`${comfy.url}/system_stats`, { signal: AbortSignal.timeout(5000) })).json()) as Record<string, unknown>;
        return json(res, 200, { ...s, broker: broker.snapshot() });
      } catch (e) {
        return json(res, 502, { error: `ComfyUI is not answering: ${(e as Error).message}` });
      }
    }

    if (req.method === 'GET' && p === '/broker/queue') return json(res, 200, broker.snapshot());

    if ((p === '/broker/speech' || p.startsWith('/broker/speech/')) && !opts.speech) return json(res, 404, { error: 'this broker does no speech (config/broker.json adapters.speech)' });
    if (req.method === 'GET' && p === '/broker/speech' && opts.speech) return json(res, 200, opts.speech.status());
    if (req.method === 'POST' && p === '/broker/speech/sessions' && opts.speech) {
      const body = await readJson<{ rank?: number; tag?: Record<string, unknown> }>(req);
      const key = crypto.randomUUID();
      const it = broker.submit<SpeechWork>('speech', { key }, { client, rank: body.rank, model: 'session', tag: body.tag });
      return json(res, 200, { id: it.id, key, state: stateHeader(broker, it) });
    }
    const session = /^\/broker\/speech\/sessions\/([^/]+)$/.exec(p);
    if (session) {
      const it = broker.get(decodeURIComponent(session[1]!)) as Item<SpeechWork> | undefined;
      if (!it || it.adapter !== 'speech' || it.client !== client) return json(res, 404, { error: 'no such session' });
      if (req.method === 'GET') return json(res, 200, { id: it.id, state: it.state, position: broker.position(it.id), error: it.error });
      if (req.method === 'DELETE') {
        if (it.state === 'running') it.work.released = true;
        else broker.cancel(it.id);
        return json(res, 200, { ok: true });
      }
    }

    // The broker's own paths end here: an address or method it does not have is not ComfyUI's either.
    if (p.startsWith('/broker/')) return json(res, 404, { error: `the broker has no ${req.method} ${p}` });

    // Everything else (uploads, /view, /object_info, …) is ComfyUI's.
    return proxy(req, res);
  };

  const wss = new WebSocketServer({ noServer: true, maxPayload: 16 * 1024 * 1024 });
  const server = http.createServer((req, res) => {
    // Browsers are never callers: a web page open on this PC must not reach the GPU (or ComfyUI) through the
    // broker, which would trust it as a local client and send its work on server-side, past ComfyUI's own checks.
    if (req.headers.origin || req.headers['sec-fetch-site']) return json(res, 403, { error: 'the GPU broker does not take requests from web pages' });
    const client = clientOf(req);
    if (!client) return json(res, 401, { error: 'unknown client: send Authorization: Bearer <token> (config/broker.json "clients")' });
    routes(req, res, client).catch((e) => {
      if (!res.headersSent) json(res, e instanceof BadRequest ? 400 : 500, { error: (e as Error).message });
      else res.destroy();
    });
  });
  server.on('upgrade', (req, socket, head) => {
    const client = clientOf(req);
    const url = new URL(req.url ?? '/', 'http://broker');
    if (req.headers.origin || !client || url.pathname !== '/broker/speech' || !opts.speech) {
      socket.end('HTTP/1.1 403 Forbidden\r\n\r\n');
      return;
    }
    wss.handleUpgrade(req, socket, head, (ws) => opts.speech!.attach(ws));
  });
  return server;
}

/** The model files a workflow loads, when its caller did not name one (ComfyUI loader inputs). */
function modelsOf(prompt: unknown): string {
  const names = new Set<string>();
  for (const node of Object.values((prompt ?? {}) as Record<string, { inputs?: Record<string, unknown> }>))
    for (const v of Object.values(node?.inputs ?? {})) if (typeof v === 'string' && /\.(safetensors|ckpt|pt|pth|gguf)$/i.test(v)) names.add(v);
  return [...names].sort().join('+') || 'workflow';
}
