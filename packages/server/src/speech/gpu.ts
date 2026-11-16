/**
 * Speech on the GPU: the VoxCPM2 runner behind the GPU broker (packages/gpu-broker/src/adapters/speech.ts), over its
 * WebSocket `/broker/speech`. The broker says whether it takes lines now (the GPU idle, the runner loaded) and how
 * many of its slots are free. A voice goes by its reference clip's SHA-256, and the broker keeps clips on disk: a clip is
 * sent only when the broker asks for it (`need`), the first time it ever meets that voice.
 *
 * The connection speaks the frames of `FrameReader` (the Python side is packages/gpu-broker/speech/wire.py): requests
 * go out as JSON, events and audio come back. The engine keeps its own account of the lines it gave, to estimate
 * waits and to end every line exactly once even if the connection drops.
 *
 * The same connection serves builds (`session`): a build's turn with the GPU is queued with the broker like any GPU
 * work; once it runs, this connection holds it and may design voices and speak however many lines it likes.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import WebSocket from 'ws';
import { FrameReader, jsonFrame } from '@daydream/shared';
import { clipHash, startsWithin, type EngineStatus, type LineEnd, type LineEvents, type LineRequest, type SpeechEngine } from './engine.ts';

interface GpuSpeechConfig {
  /** The broker's address (the comfyui provider's baseUrl) and this installation's token. */
  baseUrl: string;
  token?: string;
}

export class GpuEngine implements SpeechEngine {
  readonly name = 'gpu' as const;
  private ws: WebSocket | null = null;
  private stopped = false;
  private retry = 0;
  private ready = false;
  private slots = 1;
  /** Free slots as the broker last said (null: it has not said; this side's own account is used). */
  private free: number | null = null;
  /** Lines given and not ended: waiting (no start yet) or speaking. */
  private lines = new Map<string, { ev: LineEvents; text: string; priority: number; startedAt?: number }>();
  /** Seconds of compute per second of speech when every slot is busy (for wait estimates). */
  private loadedRtf = 0.25;
  private reader = new FrameReader();
  /** Each clip hash's path. */
  private paths = new Map<string, string>();
  /** Clips sent on this connection (the broker asks once per line waiting for one). */
  private sent = new Set<string>();
  private waiters = new Map<string, (m: Record<string, unknown>) => void>();
  private clips = new Map<string, Buffer[]>();
  private cfg: GpuSpeechConfig;

  constructor(cfg: GpuSpeechConfig) {
    this.cfg = cfg;
    this.open();
  }

  private open() {
    if (this.stopped) return;
    const url = `${this.cfg.baseUrl.replace(/^http/, 'ws').replace(/\/+$/, '')}/broker/speech`;
    const ws = new WebSocket(url, { headers: this.cfg.token ? { authorization: `Bearer ${this.cfg.token}` } : {}, maxPayload: 16 * 1024 * 1024 });
    ws.binaryType = 'nodebuffer';
    ws.on('open', () => (this.retry = 0));
    ws.on('message', (data: Buffer) => this.receive(data) || ws.close());
    ws.on('error', () => {});
    ws.on('close', () => {
      if (this.ws !== ws) return;
      this.ws = null;
      this.sent.clear();
      // The connection went: every line given is over.
      this.ready = false;
      this.reader = new FrameReader();
      for (const id of [...this.lines.keys()]) this.end(id, 'failed', 'gpu speech went away');
      for (const w of this.waiters.values()) w({ error: 'GPU speech went away' });
      this.waiters.clear();
      if (!this.stopped) setTimeout(() => this.open(), Math.min(30_000, 1000 * 2 ** this.retry++)).unref();
    });
    this.ws = ws;
  }

  /** Send a message; false when not connected. */
  private send(msg: Record<string, unknown>): boolean {
    if (this.ws?.readyState !== WebSocket.OPEN) return false;
    this.ws.send(jsonFrame(msg));
    return true;
  }

  private connected(): boolean {
    return this.ws?.readyState === WebSocket.OPEN;
  }

  /** Bytes from the connection. False when they make no sense (the connection should be dropped). */
  private receive(chunk: Uint8Array): boolean {
    let frames;
    try {
      frames = this.reader.push(chunk);
    } catch (e) {
      console.warn(`[speech] gpu: ${(e as Error).message}`);
      return false;
    }
    for (const f of frames) {
      if (f.kind === 'json') this.onEvent(f.msg);
      // Audio of designs arrives as frames named "design:<id>".
      else if (f.lineId.startsWith('design:')) this.clips.get(f.lineId.slice(7))?.push(Buffer.from(f.pcm));
      else this.lines.get(f.lineId)?.ev.audio(f.pcm);
    }
    return true;
  }

  private onEvent(m: Record<string, unknown>) {
    if (m.ev === 'need') return this.giveClip(String(m.voiceId), String(m.lineId));
    const key = m.ev === 'designed' ? `design:${String(m.reqId)}` : m.ev === 'session' ? 'session' : undefined;
    if (key && this.waiters.has(key)) {
      this.waiters.get(key)!(m);
      this.waiters.delete(key);
      return;
    }
    const id = String(m.lineId ?? '');
    const line = this.lines.get(id);
    switch (m.ev) {
      case 'hello':
        this.ready = !!m.loaded || m.loaded === undefined;
        if (typeof m.slots === 'number') this.slots = m.slots;
        break;
      case 'status':
        if (typeof (m.ready ?? m.loaded) === 'boolean') this.ready = Boolean(m.ready ?? m.loaded);
        if (typeof m.slots === 'number') this.slots = m.slots;
        if (typeof m.free === 'number') this.free = m.free;
        break;
      case 'started':
        if (line) {
          line.startedAt = Date.now();
          line.ev.started(Number(m.sampleRate));
        }
        break;
      case 'done':
      case 'expired':
      case 'failed':
        this.end(id, m.ev, typeof m.error === 'string' ? m.error : undefined);
        break;
    }
  }

  /** A line ends, once. */
  private end(lineId: string, how: LineEnd, error?: string) {
    const line = this.lines.get(lineId);
    if (!line) return;
    this.lines.delete(lineId);
    line.ev.end(how, error);
  }

  canStart(ms: number, priority: number): boolean {
    if (!this.ready || !this.connected()) return false;
    // Slots the broker says are free (shared with other callers), when it says.
    if (this.free !== null && this.free <= 0) return false;
    return startsWithin([...this.lines.values()], this.slots, this.loadedRtf, ms, priority);
  }

  speak(req: LineRequest, ev: LineEvents) {
    let voiceId: string;
    try {
      voiceId = this.hashOf(req.clip);
    } catch (e) {
      return ev.end('failed', `no clip for ${req.voiceId}: ${(e as Error).message}`);
    }
    this.lines.set(req.lineId, { ev, text: req.text, priority: req.priority });
    // How long the line may still wait, not when it must start: the GPU PC's clock is its own.
    const sent = this.send({ op: 'speak', lineId: req.lineId, voiceId, text: req.text, priority: req.priority, startWithinMs: Math.max(0, req.deadline - Date.now()) });
    if (!sent) this.end(req.lineId, 'failed', 'gpu speech is not connected');
  }

  cancel(lineId: string) {
    if (!this.lines.has(lineId)) return;
    this.send({ op: 'cancel', lineId });
    this.end(lineId, 'cancelled');
  }

  /** The broker keeps each voice's clip and the runner its prompt: there is nothing to make ahead. */
  prepare() {}

  status(): EngineStatus {
    const speaking = [...this.lines.values()].filter((l) => l.startedAt).length;
    // Free as the broker says, when it does: its slots are shared with other installations.
    return { name: this.name, ready: this.ready && this.connected(), slots: this.slots, free: this.free ?? Math.max(0, this.slots - speaking), waiting: this.lines.size - speaking };
  }

  /** A clip's SHA-256, and the clip it names. */
  private hashOf(clip: string): string {
    const hash = clipHash(clip);
    this.paths.set(hash, clip);
    return hash;
  }

  private giveClip(voiceId: string, lineId: string) {
    if (this.sent.has(voiceId)) return;
    const clip = this.paths.get(voiceId);
    let wav: Buffer;
    try {
      wav = fs.readFileSync(clip ?? '');
      if (crypto.createHash('sha256').update(wav).digest('hex') !== voiceId) throw new Error('it changed');
    } catch (e) {
      // The clip went (a world deleted or rebuilt): the line cannot be spoken.
      this.send({ op: 'cancel', lineId });
      return this.end(lineId, 'failed', `no clip for voice ${voiceId.slice(0, 12)}: ${(e as Error).message}`);
    }
    this.send({ op: 'voice', voiceId, wav: wav.toString('base64') });
    this.sent.add(voiceId);
  }

  // ------------------------------------------------------------------------------------------------ builds

  /** Take a build's turn with the GPU (queued with the broker, `key` from it) for this connection. */
  async session(key: string): Promise<void> {
    // The broker shows the session running a moment before its turn begins (what was loaded is unloaded first).
    for (const t0 = Date.now(); ; await new Promise((r) => setTimeout(r, 500))) {
      const reply = await this.ask('session', () => this.send({ op: 'session', key }));
      if (reply.ok) return;
      if (Date.now() - t0 > 120_000) throw new Error(String(reply.error ?? 'the broker did not give this connection the session'));
    }
  }

  /** Reference clips for voice descriptions: 16-bit PCM at `sampleRate`, by id, each saying `text`. */
  async design(designs: { id: string; description: string }[]): Promise<{ sampleRate: number; text: string; clips: Map<string, Buffer> }> {
    const reqId = Math.random().toString(36).slice(2);
    for (const d of designs) this.clips.set(d.id, []);
    try {
      const reply = await this.ask(`design:${reqId}`, () => this.send({ op: 'design', reqId, designs }), 600_000);
      if (reply.error) throw new Error(String(reply.error));
      return { sampleRate: Number(reply.sampleRate), text: String(reply.text ?? ''), clips: new Map(designs.map((d) => [d.id, Buffer.concat(this.clips.get(d.id) ?? [])])) };
    } finally {
      for (const d of designs) this.clips.delete(d.id);
    }
  }

  private ask(key: string, send: () => void, ms = 30_000): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      if (!this.connected()) return reject(new Error('GPU speech is not connected'));
      const t = setTimeout(() => {
        this.waiters.delete(key);
        reject(new Error(`GPU speech: no answer to ${key.split(':')[0]}`));
      }, ms);
      this.waiters.set(key, (m) => (clearTimeout(t), resolve(m)));
      send();
    });
  }

  /** Whether the connection is up (for build tools waiting for it). */
  isOpen() {
    return this.connected();
  }

  stop() {
    this.stopped = true;
    this.ws?.close();
  }
}
