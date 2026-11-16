import type http from 'node:http';
import nodeHttp from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import { Broker } from '../src/scheduler.ts';
import { ComfyAdapter } from '../src/adapters/comfyui.ts';
import { createFront } from '../src/http.ts';
import { blocker, fakeComfy } from './fakecomfy.ts';

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
/** Until the check holds, however long a busy machine takes. */
const until = <T>(check: () => T | Promise<T>) => vi.waitFor(check, { timeout: 20_000, interval: 10 });
const uuid = () => crypto.randomUUID();

describe('GPU broker front (ComfyUI pass-through)', () => {
  const comfy = fakeComfy();
  let front: http.Server;
  let base = '';
  let broker: Broker;
  beforeAll(async () => {
    const comfyUrl = await listen(comfy.server);
    const adapter = new ComfyAdapter({ url: comfyUrl, pollMs: 10, freeSettleMs: 5 });
    broker = new Broker({ comfyui: adapter, blocker }, { graceMs: 0, log: () => {} });
    front = createFront(broker, adapter, { clients: { prod: 'secret-prod' } });
    base = await listen(front);
  });
  afterAll(() => {
    broker.stop();
    front.close();
    comfy.server.close();
  });

  const post = (path: string, body: unknown, headers: Record<string, string> = {}) =>
    fetch(base + path, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body: JSON.stringify(body) });

  /** Other work keeps the GPU until `release()`: what is queued meanwhile waits in the broker. */
  const busy = async () => {
    const work = { released: false };
    const it = broker.submit('blocker', work, { client: 'local', rank: 0 });
    await until(() => expect(it.state).toBe('running'));
    return {
      release: async () => {
        work.released = true;
        await until(() => expect(it.state).toBe('done'));
      },
    };
  };

  it('holds a prompt while the GPU is busy, then runs it in ComfyUI under the same id', async () => {
    const gpu = await busy();

    const id = uuid();
    const queued = await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: id, extra_data: { daydream: { workflow: 'klein', rank: 2 } } }, { authorization: 'Bearer secret-prod' });
    expect(((await queued.json()) as { prompt_id: string }).prompt_id).toBe(id);
    const waiting = await fetch(`${base}/history/${id}`);
    expect(await waiting.json()).toEqual({});
    expect(waiting.headers.get('x-broker-state')).toBe('queued; position=1');
    const q = (await (await fetch(`${base}/queue`)).json()) as { queue_pending: unknown[][] };
    expect(q.queue_pending.map((p) => p[1])).toEqual([id]);
    expect(broker.get(id)!.client).toBe('prod');
    expect(comfy.queued.some((p) => p.id === id)).toBe(false);

    await gpu.release();
    await until(async () => {
      const entry = (await (await fetch(`${base}/history/${id}`)).json()) as Record<string, { outputs: Record<string, { images: { filename: string }[] }> }>;
      expect(entry[id]?.outputs['9']!.images[0]!.filename).toBe('out.png');
    });
    expect(comfy.queued.find((p) => p.id === id)).toBeTruthy();
    expect(Buffer.from(await (await fetch(`${base}/view?filename=out.png&type=output`)).arrayBuffer()).toString()).toBe('PNGDATA');
  });

  it('cancels a held prompt and reports it the way ComfyUI reports an error', async () => {
    const gpu = await busy();
    const id = uuid();
    await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: id });
    await post('/queue', { delete: [id] });
    const h = (await (await fetch(`${base}/history/${id}`)).json()) as Record<string, { status: { status_str: string; messages: [string, { exception_message: string }][] } }>;
    expect(h[id]!.status.status_str).toBe('error');
    expect(h[id]!.status.messages[0]![1].exception_message).toBe('cancelled');
    await gpu.release();
  });

  it('fails a download ComfyUI drops partway through, and keeps answering', async () => {
    await expect(fetch(`${base}/view?filename=cut.png&type=output`).then((r) => r.arrayBuffer())).rejects.toThrow();
    expect(Buffer.from(await (await fetch(`${base}/view?filename=out.png&type=output`)).arrayBuffer()).toString()).toBe('PNGDATA');
  });

  it('refuses requests from web pages, even from this PC', async () => {
    const res = await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } } }, { origin: 'https://example.com' });
    expect(res.status).toBe(403);
    expect((await fetch(`${base}/broker/queue`, { headers: { 'sec-fetch-site': 'cross-site' } })).status).toBe(403);
  });

  it("ignores callers' /free, refuses unknown tokens, and answers 404 for prompts it never saw", async () => {
    const frees = comfy.calls.filter((c) => c === 'POST /free').length;
    expect((await post('/free', { unload_models: true })).status).toBe(200);
    expect(comfy.calls.filter((c) => c === 'POST /free').length).toBe(frees);
    expect((await fetch(`${base}/queue`, { headers: { authorization: 'Bearer wrong' } })).status).toBe(401);
    expect((await fetch(`${base}/history/${uuid()}`)).status).toBe(404);
  });

  it("lets a client stop only its own work, never another client's", async () => {
    const prod = { authorization: 'Bearer secret-prod' };
    const gpu = await busy();
    const [theirs, mine] = [uuid(), uuid()];
    await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: theirs }, prod);
    await post('/prompt', { prompt: { '1': { class_type: 'X', inputs: {} } }, prompt_id: mine });

    // This PC's client (no token) tries each way of stopping production's prompt: only its own goes.
    await post('/queue', { delete: [theirs] });
    await post('/interrupt', { prompt_id: theirs });
    await post('/queue', { clear: true });
    expect(broker.get(theirs)!.state).toBe('queued');
    expect(broker.get(mine)!.state).toBe('cancelled');

    await post('/queue', { clear: true }, prod);
    expect(broker.get(theirs)!.state).toBe('cancelled');
    await gpu.release();
  });

  it('answers 400 for a body that is not JSON, and 404 for a broker address it does not have', async () => {
    const bad = await fetch(`${base}/prompt`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{not json' });
    expect(bad.status).toBe(400);
    const calls = comfy.calls.length;
    expect((await post('/broker/nothing', {})).status).toBe(404);
    expect((await fetch(`${base}/broker/queue`, { method: 'DELETE' })).status).toBe(404);
    // No speech on this broker: its addresses are not passed to ComfyUI either.
    expect((await post('/broker/speech/sessions', {})).status).toBe(404);
    expect(comfy.calls.length).toBe(calls);
  });

  it('takes this PC for a client only when asked for by its own name (not a rebound host name)', async () => {
    const status = (host: string, headers: Record<string, string> = {}) =>
      new Promise<number>((resolve, reject) => {
        const u = new URL(base);
        nodeHttp.get({ host: u.hostname, port: u.port, path: '/broker/queue', headers: { host, ...headers } }, (res) => resolve(res.resume().statusCode ?? 0)).on('error', reject);
      });
    expect(await status(`evil.example:${new URL(base).port}`)).toBe(401);
    expect(await status(`localhost:${new URL(base).port}`)).toBe(200);
    // A client with a token is known by it, whatever name it reaches the GPU PC by.
    expect(await status('gpu-pc.lan:8190', { authorization: 'Bearer secret-prod' })).toBe(200);
  });
});
