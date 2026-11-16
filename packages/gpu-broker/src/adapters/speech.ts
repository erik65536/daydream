/**
 * Speech on the GPU (docs/voices.md): the VoxCPM2 runner and the VoiceDesign designer in one Python service
 * (speech/speech_service.py), which this adapter starts, supervises and talks to.
 *
 * Speech is not queued behind other GPU work:
 * - While the GPU is idle (nothing queued or running), the runner stays loaded and game servers' lines are spoken at
 *   once, over a WebSocket (`/broker/speech`): lines from every connection share its slots.
 * - When work is queued for anything else, new lines are refused at once (the game speaks them on its CPU), the lines
 *   speaking finish, and the runner is unloaded like any other model.
 * - Build-time voice work (designing voices, speaking fixed lines) is a queued session (model "session"): when its
 *   turn comes, the connection that holds it (`{op: "session", key}`) has the service to itself.
 *
 * The connection speaks the engines' protocol (shared/speech.ts frames, one per WebSocket message). Line and request
 * ids are made unique per connection on the way in and given back unchanged on the way out. A voice is named by its
 * clip's SHA-256, the same for every caller; the service keeps clips on disk and asks for one it lacks (`need`).
 */
import { spawn, type ChildProcess } from 'node:child_process';
import crypto from 'node:crypto';
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { FrameReader, audioFrame, jsonFrame } from '@daydream/shared';
import type { WebSocket } from 'ws';
import type { GpuAdapter, RunContext } from '../scheduler.ts';

export interface SpeechOptions {
  /** The Python of the runner's environment (default speech/.venv in this package, made from speech/requirements.txt). */
  python?: string;
  /** Lines spoken at once (default 16). */
  slots?: number;
  /** Where the service keeps voices' reference clips (default data/broker/speech-clips in the repository). */
  clips?: string;
}

/** A build's turn with the speech service: it ends when the caller releases it (or closes its connection). */
export interface SpeechWork {
  key: string;
  released?: boolean;
}

interface Conn {
  id: string;
  ws: WebSocket;
}

const SPEECH_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', 'speech');
const SCRIPT = path.join(SPEECH_DIR, 'speech_service.py');
const VENV_PYTHON = path.join(SPEECH_DIR, '.venv', process.platform === 'win32' ? 'Scripts/python.exe' : 'bin/python');
const CLIPS = path.resolve(SPEECH_DIR, '..', '..', '..', 'data', 'broker', 'speech-clips');
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const SEP = '~';

export class SpeechAdapter implements GpuAdapter<SpeechWork> {
  readonly name = 'speech';
  readonly freeBetweenModels = true;
  private proc: ChildProcess | null = null;
  private sock: net.Socket | null = null;
  private ready = false;
  private stopped = false;
  private restarts = 0;
  /** What the service has loaded, and what it was last asked to load. */
  private loaded: string | null = null;
  /** Load and unload requests waiting for their answer, by reqId. */
  private waiters = new Map<string, { done: (error?: string) => void }>();
  private reqs = 0;
  private conns = new Map<string, Conn>();
  /** Lines speaking now (the connection-unique ids). */
  private speaking = new Set<string>();
  private session: { key: string; work: SpeechWork; conn?: string } | null = null;
  /** Lines may be taken for play (the GPU is idle and the runner loaded). */
  private open = false;
  private loading = false;
  readonly counts = { spoken: 0, refused: 0, failed: 0, expired: 0 };

  private readonly python: string;
  private o: SpeechOptions;
  private idle: () => boolean;
  private claim: () => Promise<boolean>;

  constructor(o: SpeechOptions, idle: () => boolean, claim: () => Promise<boolean>) {
    this.o = o;
    this.idle = idle;
    this.claim = claim;
    this.python = o.python ?? VENV_PYTHON;
    this.start();
    setInterval(() => this.broadcastStatus(), 2000).unref();
  }

  // ----------------------------------------------------------------------------------------- the Python service

  private start() {
    if (this.stopped) return;
    const token = crypto.randomBytes(16).toString('hex');
    const proc = spawn(this.python, [SCRIPT, '--port', '0', '--clips', this.o.clips ?? CLIPS, '--slots', String(this.o.slots ?? 16)], { env: { ...process.env, SPEECH_TOKEN: token, PYTHONUNBUFFERED: '1' }, stdio: ['ignore', 'pipe', 'pipe'] });
    this.proc = proc;
    let out = '';
    proc.stdout!.setEncoding('utf8').on('data', (s: string) => {
      out += s;
      let nl;
      while ((nl = out.indexOf('\n')) >= 0) {
        const line = out.slice(0, nl).trim();
        out = out.slice(nl + 1);
        const m = /^SPEECH LISTENING (\d+)$/.exec(line);
        if (m) this.connect(Number(m[1]), token);
        else if (line) console.log(`[broker] ${line}`);
      }
    });
    let err = '';
    proc.stderr!.setEncoding('utf8').on('data', (s: string) => (err = (err + s).slice(-4000)));
    proc.on('error', (e) => console.warn(`[broker] speech could not start (${this.python}): ${e.message}`));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      this.sock?.destroy();
      if (this.stopped) return;
      console.warn(`[broker] speech stopped (exit ${code}); restarting.${err ? `\n${err.trim().split('\n').slice(-8).join('\n')}` : ''}`);
      setTimeout(() => this.start(), Math.min(60_000, 1000 * 2 ** this.restarts++)).unref();
    });
  }

  private connect(port: number, token: string) {
    const sock = net.connect({ port, host: '127.0.0.1' });
    const reader = new FrameReader();
    sock.setNoDelay(true);
    sock.on('connect', () => sock.write(jsonFrame({ op: 'hello', token })));
    sock.on('data', (chunk: Buffer) => {
      for (const f of reader.push(chunk)) {
        if (f.kind === 'audio') this.route(f.lineId.startsWith('design:') ? f.lineId.slice(7) : f.lineId, (conn, id) => conn.ws.send(audioFrame(f.lineId.startsWith('design:') ? `design:${id}` : id, f.pcm)));
        else this.onEvent(f.msg);
      }
    });
    sock.on('error', () => {});
    sock.on('close', () => {
      if (this.sock === sock) this.sock = null;
      this.ready = false;
      this.loaded = null;
      for (const w of this.waiters.values()) w.done('the service went away');
      this.waiters.clear();
      for (const id of this.speaking) this.route(id, (conn, lineId) => conn.ws.send(jsonFrame({ ev: 'failed', lineId, error: 'GPU speech went away' })));
      this.speaking.clear();
      this.update();
    });
    this.sock = sock;
  }

  private send(msg: Record<string, unknown>) {
    this.sock?.write(jsonFrame(msg));
  }

  /**
   * A load or unload, answered once the service has done it (requests are done in order, so an unload sent while a
   * load runs is answered after that load). A service that does not answer in time is stuck holding its memory: it
   * is restarted, which gives the memory back, and the request fails.
   */
  private ask(op: 'load' | 'unload', ms: number, extra: Record<string, unknown> = {}): Promise<void> {
    const reqId = `broker:${++this.reqs}`;
    return new Promise((resolve, reject) => {
      const t = setTimeout(() => {
        this.waiters.delete(reqId);
        const why = `speech: no answer to "${op}" within ${ms / 1000} s`;
        void this.restart(why).then(() => reject(new Error(`${why}; restarted the service to free its memory`)));
      }, ms);
      this.waiters.set(reqId, { done: (error) => (clearTimeout(t), error ? reject(new Error(`speech: ${error}`)) : resolve()) });
      this.send({ op, reqId, ...extra });
    });
  }

  /** Stop the service and everything it started (the venv's python.exe is a launcher with a child), then wait. */
  private async restart(why: string) {
    const proc = this.proc;
    if (!proc || proc.exitCode !== null) return;
    console.warn(`[broker] ${why}: restarting it`);
    const exited = new Promise((r) => proc.once('exit', r));
    if (process.platform === 'win32' && proc.pid) spawn('taskkill', ['/pid', String(proc.pid), '/T', '/F'], { stdio: 'ignore' });
    else proc.kill('SIGKILL');
    await Promise.race([exited, sleep(15_000)]);
  }

  private onEvent(m: Record<string, unknown>) {
    const ev = String(m.ev);
    if (ev === 'hello') {
      this.ready = true;
      this.restarts = 0;
      this.loaded = (m.model as string) ?? null;
      console.log('[broker] speech ready');
      return this.update();
    }
    if (ev === 'loaded' || ev === 'unloaded') {
      this.loaded = ev === 'loaded' ? String(m.model) : null;
      const w = typeof m.reqId === 'string' ? this.waiters.get(m.reqId) : undefined;
      if (w) {
        this.waiters.delete(m.reqId as string);
        w.done(m.error as string | undefined);
      }
      return this.update();
    }
    if (typeof m.lineId === 'string') {
      const id = m.lineId;
      if (ev === 'done' || ev === 'failed' || ev === 'expired') {
        this.speaking.delete(id);
        if (ev === 'done') this.counts.spoken++;
        else this.counts[ev]++;
      }
      return this.route(id, (conn, lineId) => conn.ws.send(jsonFrame({ ...m, lineId })));
    }
    if (typeof m.reqId === 'string') this.route(m.reqId, (conn, reqId) => conn.ws.send(jsonFrame({ ...m, reqId, ids: (m.ids as string[] | undefined)?.map((i) => i.split(SEP).slice(1).join(SEP)) })));
  }

  /** Hand something with a connection-unique id back to its connection, with the id it gave. */
  private route(id: string, fn: (conn: Conn, ownId: string) => void) {
    const at = id.indexOf(SEP);
    const conn = at > 0 ? this.conns.get(id.slice(0, at)) : undefined;
    if (conn && conn.ws.readyState === conn.ws.OPEN) fn(conn, id.slice(at + 1));
  }

  // ------------------------------------------------------------------------------------------- the broker's side

  async alive() {
    return this.ready && !!this.sock;
  }

  async load(model: string) {
    if (this.loaded === model) return;
    await this.ask('load', 180_000, { model });
  }

  /**
   * Lines speaking finish (up to 15 s) before the model goes; new ones are refused meanwhile. Always asked of the
   * service, even when nothing is loaded here: a load may still be under way, or may have failed and left memory.
   */
  async unload() {
    this.open = false;
    this.broadcastStatus();
    for (let t = 0; t < 150 && this.speaking.size && !this.session; t++) await sleep(100);
    if (!this.sock) return;
    await this.ask('unload', 60_000);
  }

  async run(work: SpeechWork, ctx: RunContext): Promise<unknown> {
    this.session = { key: work.key, work };
    this.update();
    const started = Date.now();
    try {
      for (;;) {
        if (work.released) return undefined;
        if (ctx.signal.aborted) throw new Error('cancelled');
        // A caller that never takes its turn (it went away while queued) gives it up.
        if (!this.session.conn && Date.now() - started > 120_000) throw new Error('the caller did not take its session');
        await sleep(200);
      }
    } finally {
      this.session = null;
      this.update();
    }
  }

  /** The broker's queue changed or fell idle: keep the runner loaded while the GPU is idle. */
  async update() {
    if (this.idle() && this.ready && this.loaded !== 'runner' && !this.session && !this.loading) {
      this.loading = true;
      try {
        if (await this.claim()) await this.load('runner');
      } catch (e) {
        console.warn(`[broker] ${(e as Error).message}`);
      } finally {
        this.loading = false;
      }
    }
    this.open = this.idle() && this.ready && this.loaded === 'runner' && !this.session;
    this.broadcastStatus();
  }

  status() {
    const slots = this.o.slots ?? 16;
    return { ready: this.open, model: this.loaded, slots, free: this.open ? Math.max(0, slots - this.speaking.size) : 0, session: !!this.session, counts: this.counts };
  }

  private broadcastStatus() {
    const s = jsonFrame({ ev: 'status', ...this.status() });
    for (const c of this.conns.values()) if (c.ws.readyState === c.ws.OPEN) c.ws.send(s);
  }

  // ---------------------------------------------------------------------------------- connections from callers

  /** A caller's WebSocket (`/broker/speech`, already authenticated). */
  attach(ws: WebSocket) {
    const conn: Conn = { id: crypto.randomBytes(4).toString('hex'), ws };
    this.conns.set(conn.id, conn);
    ws.send(jsonFrame({ ev: 'status', ...this.status() }));
    // A caller that vanished without closing (its machine lost power or network) would hold its session, and so the
    // GPU, for good: one that answers no ping is dropped, which closes it like any other.
    let alive = true;
    ws.on('pong', () => (alive = true));
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false;
      ws.ping();
    }, 15_000);
    const reader = new FrameReader();
    ws.on('message', (data: Buffer) => {
      let frames;
      try {
        frames = reader.push(new Uint8Array(data));
      } catch {
        return ws.close();
      }
      for (const f of frames) if (f.kind === 'json') this.request(conn, f.msg);
    });
    ws.on('close', () => {
      clearInterval(beat);
      this.conns.delete(conn.id);
      for (const id of [...this.speaking]) if (id.startsWith(conn.id + SEP)) {
        this.speaking.delete(id);
        this.send({ op: 'cancel', lineId: id });
      }
      // A build whose connection dropped (it stopped or crashed) gives the GPU back.
      if (this.session?.conn === conn.id) this.session.work.released = true;
    });
  }

  private request(conn: Conn, m: Record<string, unknown>) {
    const own = (id: unknown) => `${conn.id}${SEP}${String(id)}`;
    const mine = !!this.session && this.session.conn === conn.id;
    switch (m.op) {
      case 'session':
        // The build whose turn it is takes the service.
        if (this.session && m.key === this.session.key) this.session.conn = conn.id;
        return conn.ws.send(jsonFrame({ ev: 'session', ok: this.session?.conn === conn.id }));
      case 'voice':
        return this.send({ op: 'voice', voiceId: m.voiceId, wav: m.wav });
      case 'speak': {
        if (!(this.open || mine)) {
          this.counts.refused++;
          return conn.ws.send(jsonFrame({ ev: 'failed', lineId: m.lineId, error: 'the GPU is busy' }));
        }
        const lineId = own(m.lineId);
        this.speaking.add(lineId);
        if (mine) this.send({ op: 'load', model: 'runner' });
        return this.send({ op: 'speak', lineId, voiceId: m.voiceId, text: m.text, startWithinMs: m.startWithinMs, priority: m.priority });
      }
      case 'cancel':
        this.speaking.delete(own(m.lineId));
        return this.send({ op: 'cancel', lineId: own(m.lineId) });
      case 'design':
        if (!mine) return conn.ws.send(jsonFrame({ ev: 'designed', reqId: m.reqId, error: 'designing voices needs a session' }));
        return this.send({ op: 'design', reqId: own(m.reqId), designs: ((m.designs as { id: string; description: string }[]) ?? []).map((d) => ({ id: own(d.id), description: d.description })) });
      case 'status':
        return conn.ws.send(jsonFrame({ ev: 'status', reqId: m.reqId, ...this.status() }));
    }
  }

  stop() {
    this.stopped = true;
    this.sock?.destroy();
    this.proc?.kill();
  }
}
