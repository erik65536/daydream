/**
 * Pocket TTS on this machine's CPU, in the game server's own process: ONNX Runtime on one worker thread per line slot
 * (pocketWorker.ts), with the models speech/pocket_export.py exported. Its config is a `pocket-tts` provider in
 * config/genai.json, named by the `speech.cpu` purpose.
 *
 * Lines wait in order (priority first); one that has not started by its deadline is canceled by speech.ts, which
 * keeps the deadline for every engine. When lines due soon are waiting, the next is spoken with the small model, which
 * clears the queue faster; otherwise the usual one is used.
 *
 * A voice's state (the model's keys and values after hearing its reference clip) takes about a second per second of
 * clip to make. It is made once per model and clip: kept in shared memory, which every slot reads, for the voices in
 * use, and on disk under the clip's hash (`<data>/cache/pocket/<model>.<export>/`), so a restart, a later line, or a
 * build that already met the voice never makes it again.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { DATA_DIR, MODELS_DIR, ROOT_DIR } from '../paths.ts';
import { clipHash, startsWithin, type EngineStatus, type LineEnd, type LineEvents, type LineRequest, type SpeechEngine } from './engine.ts';
import type { VoiceState } from './pocketModel.ts';
import type { FromWorker, ToWorker, WorkerSetup } from './pocketWorker.ts';

interface PocketConfig {
  /** The folder the export wrote, with a folder per model (default models/pocket in the repository). */
  models?: string;
  /** Lines spoken at once (default 2), each on `threads` threads (default 1). */
  lines?: number;
  threads?: number;
  /** The usual model and the small one used while lines wait (empty: none). */
  model?: string;
  smallModel?: string;
}

/** The folder of the exported models: the config's (relative to the repository), else models/pocket. */
export const pocketModels = (folder?: string) => (folder ? path.resolve(ROOT_DIR, folder) : path.join(MODELS_DIR, 'pocket'));

/** A line waiting that must start within this long (ms) switches the next lines to the small model. */
const SMALL_WHEN_DUE_MS = 3000;
/** Voice states kept in memory, the least recently used dropped beyond this (they reload from disk in milliseconds). */
const VOICE_MEMORY_BYTES = 256 * 1024 * 1024;

interface Line {
  req: LineRequest;
  ev: LineEvents;
  seq: number;
  startedAt?: number;
  slot?: Slot;
}

interface Slot {
  worker: Worker;
  ready: boolean;
  /** Its line (which may have ended while the worker stops it), or none while it makes a voice. */
  line: Line | null;
  busy: boolean;
}

export class PocketEngine implements SpeechEngine {
  readonly name = 'cpu' as const;
  private models: Record<string, { folder: string; exportId: string; sampleRate: number }> = {};
  private large: string;
  private small: string | null;
  private slots: Slot[] = [];
  private lines = new Map<string, Line>();
  private seq = 0;
  private voices = new Map<string, Promise<VoiceState>>();
  private voiceBytes = new Map<string, number>();
  private requests = new Map<number, { slot: Slot; resolve: (v: VoiceState) => void; reject: (e: Error) => void }>();
  private requestId = 0;
  private prepares: string[] = [];
  private stopped = false;
  private restarts = 0;
  /** Seconds of compute per second of speech when every slot is busy (for wait estimates). */
  private loadedRtf = 0.3;
  private cfg: PocketConfig;
  private cacheDir: string;

  constructor(cfg: PocketConfig, cacheDir = path.join(DATA_DIR, 'cache', 'pocket')) {
    this.cfg = cfg;
    this.cacheDir = cacheDir;
    this.large = cfg.model || 'english_2026-10';
    this.small = cfg.smallModel === '' ? null : cfg.smallModel || 'english_18m_2026-10';
    for (const name of [this.large, this.small]) {
      if (!name) continue;
      const folder = path.join(pocketModels(cfg.models), name);
      const s = JSON.parse(fs.readFileSync(path.join(folder, 'model.json'), 'utf8')) as { exportId: string; sampleRate: number };
      this.models[name] = { folder, exportId: s.exportId, sampleRate: s.sampleRate };
    }
    for (let i = 0; i < (cfg.lines ?? 2); i++) this.slots.push(this.startSlot());
  }

  private startSlot(): Slot {
    const setup: WorkerSetup = { models: Object.fromEntries(Object.entries(this.models).map(([n, m]) => [n, m.folder])), threads: this.cfg.threads ?? 1 };
    const slot: Slot = { worker: new Worker(new URL('./pocketWorker.ts', import.meta.url), { workerData: setup }), ready: false, line: null, busy: true };
    slot.worker.on('message', (m: FromWorker) => this.onMessage(slot, m));
    slot.worker.on('error', (e: Error) => console.warn(`[speech] Pocket TTS: ${e.message}`));
    slot.worker.on('exit', () => {
      const i = this.slots.indexOf(slot);
      if (i < 0) return;
      slot.ready = false;
      if (slot.line) this.finish(slot.line, 'failed', 'Pocket TTS stopped');
      for (const [id, r] of this.requests) {
        if (r.slot !== slot) continue;
        this.requests.delete(id);
        r.reject(new Error('Pocket TTS stopped'));
      }
      if (this.stopped) return;
      console.warn('[speech] a Pocket TTS slot stopped; restarting it');
      // Quickly the first time, then backing off, so a broken install does not spin.
      setTimeout(() => {
        if (!this.stopped) this.slots[i] = this.startSlot();
      }, Math.min(60_000, 1000 * 2 ** this.restarts++)).unref();
    });
    return slot;
  }

  private onMessage(slot: Slot, m: FromWorker) {
    if (m.ev === 'ready') {
      slot.ready = true;
      slot.busy = false;
      if (this.slots.every((s) => s.ready)) {
        this.restarts = 0;
        console.log('[speech] Pocket TTS ready');
      }
      this.dispatch();
    } else if (m.ev === 'voice') {
      const r = this.requests.get(m.id);
      this.requests.delete(m.id);
      if (m.voice) r?.resolve(m.voice);
      else r?.reject(new Error(m.error));
    } else if (m.ev === 'audio') {
      if (slot.line?.req.lineId === m.lineId && this.lines.has(m.lineId)) slot.line.ev.audio(m.pcm);
    } else if (m.ev === 'end' && slot.line?.req.lineId === m.lineId) {
      if (m.how === 'failed') console.warn(`[speech] Pocket TTS line failed: ${m.error}`);
      this.finish(slot.line, m.how, m.error);
      this.free(slot);
    }
  }

  private send(slot: Slot, m: ToWorker) {
    slot.worker.postMessage(m);
  }

  /** A voice's state for a model, made by `slot` unless it is known or being made. */
  private async voice(slot: Slot, model: string, clip: string): Promise<VoiceState> {
    const m = this.models[model]!;
    const hash = clipHash(clip);
    const key = `${model}/${hash}`;
    let voice = this.voices.get(key);
    if (voice) {
      this.voices.delete(key);
      this.voices.set(key, voice);
      return voice;
    }
    const id = ++this.requestId;
    voice = new Promise<VoiceState>((resolve, reject) => this.requests.set(id, { slot, resolve, reject }));
    this.send(slot, { op: 'voice', id, model, clip, file: path.join(this.cacheDir, `${model}.${m.exportId}`, `${hash}.f32`) });
    this.voices.set(key, voice);
    voice.then(
      (v) => {
        this.voiceBytes.set(key, v.data.byteLength);
        let total = [...this.voiceBytes.values()].reduce((a, b) => a + b, 0);
        for (const old of this.voices.keys()) {
          if (total <= VOICE_MEMORY_BYTES || old === key) break;
          total -= this.voiceBytes.get(old) ?? 0;
          this.voices.delete(old);
          this.voiceBytes.delete(old);
        }
      },
      () => this.voices.delete(key),
    );
    return voice;
  }

  private dispatch() {
    for (const slot of this.slots) {
      if (slot.busy || !slot.ready) continue;
      const line = this.next();
      if (line) void this.run(slot, line);
      else if (this.prepares.length) void this.prepareOn(slot, this.prepares.shift()!);
    }
  }

  private async run(slot: Slot, line: Line) {
    slot.busy = true;
    slot.line = line;
    line.slot = slot;
    // Lines waiting that are due soon: the small model clears them faster.
    const soon = Date.now() + SMALL_WHEN_DUE_MS;
    const model = this.small && [...this.lines.values()].some((l) => !l.slot && l.req.deadline < soon) ? this.small : this.large;
    let voice: VoiceState;
    try {
      voice = await this.voice(slot, model, line.req.clip);
    } catch (e) {
      this.finish(line, 'failed', (e as Error).message);
      return this.free(slot);
    }
    // Canceled or expired meanwhile.
    if (!this.lines.has(line.req.lineId)) return this.free(slot);
    line.startedAt = Date.now();
    line.ev.started(this.models[model]!.sampleRate);
    this.send(slot, { op: 'speak', lineId: line.req.lineId, model, text: line.req.text, voice });
  }

  private async prepareOn(slot: Slot, clip: string) {
    slot.busy = true;
    for (const model of Object.keys(this.models)) await this.voice(slot, model, clip).catch((e: Error) => console.warn(`[speech] Pocket TTS voice ${clip}: ${e.message}`));
    this.free(slot);
  }

  private free(slot: Slot) {
    slot.line = null;
    slot.busy = false;
    this.dispatch();
  }

  /** The line ends, once (its slot is freed when the worker is done with it). */
  private finish(line: Line, how: LineEnd, error?: string) {
    if (this.lines.delete(line.req.lineId)) line.ev.end(how, error);
  }

  /** The first line waiting, by priority then order. */
  private next(): Line | null {
    let best: Line | null = null;
    for (const l of this.lines.values()) if (!l.slot && (!best || l.req.priority < best.req.priority || (l.req.priority === best.req.priority && l.seq < best.seq))) best = l;
    return best;
  }

  canStart(ms: number, priority: number): boolean {
    if (!this.slots.every((s) => s.ready)) return false;
    return startsWithin([...this.lines.values()].map((l) => ({ text: l.req.text, priority: l.req.priority, startedAt: l.startedAt })), this.slots.length, this.loadedRtf, ms, priority);
  }

  speak(req: LineRequest, ev: LineEvents) {
    if (Date.now() > req.deadline) return ev.end('expired');
    this.lines.set(req.lineId, { req, ev, seq: this.seq++ });
    this.dispatch();
  }

  cancel(lineId: string) {
    const line = this.lines.get(lineId);
    if (!line) return;
    if (line.slot && line.startedAt) this.send(line.slot, { op: 'cancel', lineId });
    this.finish(line, 'cancelled');
  }

  prepare(clip: string) {
    if (!this.prepares.includes(clip)) this.prepares.push(clip);
    this.dispatch();
  }

  status(): EngineStatus {
    const speaking = this.slots.filter((s) => s.line).length;
    return { name: this.name, ready: this.slots.every((s) => s.ready), slots: this.slots.length, free: this.slots.length - speaking, waiting: [...this.lines.values()].filter((l) => !l.slot).length };
  }

  stop() {
    this.stopped = true;
    // Lines still waiting or being spoken are over, so nobody waits on them.
    for (const l of [...this.lines.values()]) this.finish(l, 'cancelled');
    for (const s of this.slots) void s.worker.terminate();
  }
}
