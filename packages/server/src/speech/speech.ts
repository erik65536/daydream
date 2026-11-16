/**
 * Speech at play time (docs/voices.md): lines are spoken by an engine, encoded to Opus once as the audio arrives, and
 * the same packets go to everyone listening. The one rule: speech never holds up the game. A line that has not
 * started six seconds after its text was ready is dropped, and its listeners are told it could not be voiced. The
 * deadline is kept here, by this machine's clock, whichever engine has the line.
 *
 * - A reply (an NPC's answer, the story so far) chooses its engine once, at its first sentence, so the voice does not
 *   change in the middle; the next reply chooses again: the GPU if it is on and has a slot, else Pocket TTS if the
 *   line can start in time, else nothing.
 * - A reply's later sentences are needed only once the ones before them have played: each may start until six
 *   seconds after that (estimated), and they wait behind first sentences of other replies.
 * - A line spoken at build time is a file (`assets/speech/<hash>.opus`) and plays at once, whoever is free.
 * - Lines of one queue (one conversation, one narrator) play one after another on the client; the server speaks
 *   them as soon as it can, so a reply's later sentences are often ready before they are needed.
 * - A line nobody listens to any more is canceled, which frees its engine's slot.
 * - A reply's listeners are asked for at each sentence, so someone who joins the conversation hears the rest of it and
 *   someone who leaves, or skips one of its lines, hears no more of it.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import OpusModule from '@discordjs/opus';
import { linePacket, readOggOpus, type LineCodec, type ServerMessage } from '@daydream/shared';
import { reportError } from '../log.ts';
import { sayMs, type EngineName, type LineEnd, type SpeechEngine } from './engine.ts';
import { PocketEngine } from './pocket.ts';
import { GpuEngine } from './gpu.ts';
import type { GenAIConfig } from '../genai/types.ts';
import { resolveSecret } from '../genai/providers.ts';
import { control } from '../gpu/presence.ts';
import { sayable, spokenText } from './text.ts';

const { OpusEncoder } = OpusModule as unknown as { OpusEncoder: new (rate: number, channels: number) => OpusEncoderLike };
interface OpusEncoderLike {
  encode(buf: Buffer): Buffer;
  setBitrate(bps: number): void;
}

/** How long a line may wait to start after its text is ready. */
const START_WITHIN_MS = 6000;
/** Speech is mono, 20 ms packets, about 32 kbit/s. */
const OPUS_BITRATE = 32_000;
const OPUS_RATES = [8000, 12000, 16000, 24000, 48000];

/** A voice: a character's or the narrator's in one world. */
export interface Voice {
  /** Unique across worlds (`<worldId>/<voiceId>`): engines keep each voice's state under it. */
  key: string;
  /** Its reference clip. */
  clip: string;
  /** Where its world keeps the lines spoken at build time. */
  speechDir: string;
  /** Linear gain per engine that brings it to the game's loudness (measured at build time). */
  gain?: Partial<Record<EngineName, number>>;
}

/** Someone who hears lines: one player's connection to one adventure. */
export interface Listener {
  key: string;
  codec: LineCodec;
  send(m: ServerMessage): void;
  sendBinary(data: Uint8Array): void;
}

interface LineOptions {
  /** Lines of a queue play one after another (a conversation, a narrator). */
  queue: string;
  listeners: Listener[];
  /** Lower goes first (0: someone is waiting to hear it now; a reply's later sentences come after). */
  priority?: number;
  /** Where the speaker stands, for lines heard from a distance (barks). */
  at?: { x: number; y: number };
  /** The line could not be voiced (it expired or failed); not called when it was canceled. */
  onUnvoiced?: (lineId: string) => void;
}

/** A reply's options: who hears it is asked for at each sentence (a fixed list for something said once). */
export type ReplyOptions = Omit<LineOptions, 'listeners'> & { listeners: Listener[] | (() => Listener[]) };

/** The file a line spoken at build time is kept in, from its voice and words. */
export function fixedLineFile(speechDir: string, voiceId: string, text: string): string {
  const hash = crypto.createHash('sha256').update(`${voiceId}\n${spokenText(text)}`).digest('hex').slice(0, 24);
  return path.join(speechDir, `${hash}.opus`);
}

class Line {
  readonly listeners = new Map<string, Listener>();
  /** Opus packets so far, for listeners who join mid-line. */
  readonly packets: Uint8Array[] = [];
  readonly pcm: Uint8Array[] = [];
  rate = 0;
  started = false;
  ended: LineEnd | null = null;
  engine: SpeechEngine | null = null;
  /** Ends the line if it has not started by its deadline. */
  deadline: ReturnType<typeof setTimeout> | null = null;
  private encoder: OpusEncoderLike | null = null;
  private pending = Buffer.alloc(0);
  private frameBytes = 0;
  readonly id: string;
  readonly text: string;
  readonly opts: LineOptions;
  readonly gain: number;

  constructor(id: string, text: string, opts: LineOptions, gain: number) {
    this.id = id;
    this.text = text;
    this.opts = opts;
    this.gain = gain;
    for (const l of opts.listeners) this.listeners.set(l.key, l);
  }

  announce(l: Listener) {
    l.send({ t: 'line', id: this.id, queue: this.opts.queue, at: this.opts.at });
    if (!this.started) return;
    l.send({ t: 'line_start', id: this.id, rate: this.rate, codec: l.codec });
    for (const p of l.codec === 'opus' ? this.packets : this.pcm) l.sendBinary(linePacket(this.id, p));
    if (this.ended) l.send({ t: 'line_end', id: this.id, status: this.ended });
  }

  start(rate: number) {
    this.started = true;
    this.rate = rate;
    if (OPUS_RATES.includes(rate)) {
      this.encoder = new OpusEncoder(rate, 1);
      this.encoder.setBitrate(OPUS_BITRATE);
      this.frameBytes = (rate / 50) * 2;
    }
    for (const l of this.listeners.values()) l.send({ t: 'line_start', id: this.id, rate, codec: l.codec });
  }

  audio(pcm: Uint8Array) {
    const buf = Buffer.from(pcm.buffer, pcm.byteOffset, pcm.byteLength);
    if (this.gain !== 1) {
      for (let i = 0; i + 1 < buf.length; i += 2) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(buf.readInt16LE(i) * this.gain))), i);
    }
    this.pcm.push(buf);
    for (const l of this.listeners.values()) if (l.codec === 'pcm') l.sendBinary(linePacket(this.id, buf));
    if (!this.encoder) return;
    this.pending = Buffer.concat([this.pending, buf]);
    while (this.pending.length >= this.frameBytes) {
      this.packet(this.encoder.encode(this.pending.subarray(0, this.frameBytes)));
      this.pending = this.pending.subarray(this.frameBytes);
    }
  }

  /** A packet from a file spoken at build time. */
  packet(p: Uint8Array) {
    this.packets.push(p);
    for (const l of this.listeners.values()) if (l.codec === 'opus') l.sendBinary(linePacket(this.id, p));
  }

  end(how: LineEnd) {
    if (this.ended) return;
    if (this.encoder && this.pending.length) {
      const last = Buffer.alloc(this.frameBytes);
      this.pending.copy(last);
      this.packet(this.encoder.encode(last));
    }
    this.ended = how;
    this.encoder = null;
    for (const l of this.listeners.values()) l.send({ t: 'line_end', id: this.id, status: how });
  }
}

interface SpeechCounts {
  spoken: Record<EngineName | 'file', number>;
  expired: number;
  failed: number;
  cancelled: number;
}

/** One reply's lines, all spoken by the engine chosen at the first. */
export class Reply {
  private engine: SpeechEngine | null | undefined;
  /** Lines said so far, and how long they take to say (the next one is needed once they have played). */
  private said = 0;
  private aheadMs = 0;
  /** Listeners who skipped one of its lines: they hear no more of it. */
  private skipped = new Set<string>();
  private hub: Speech;
  private voice: Voice;
  private opts: ReplyOptions;
  constructor(hub: Speech, voice: Voice, opts: ReplyOptions) {
    this.hub = hub;
    this.voice = voice;
    this.opts = opts;
  }

  /** A listener skipped one of the reply's lines. */
  skip(listenerKey: string) {
    this.skipped.add(listenerKey);
  }

  /** Speak one sentence; returns its line id, or null when there was nothing to say or nobody to hear it. */
  say(text: string): string | null {
    const words = spokenText(text);
    const all = typeof this.opts.listeners === 'function' ? this.opts.listeners() : this.opts.listeners;
    const listeners = all.filter((l) => !this.skipped.has(l.key));
    if (!sayable(words) || !listeners.length) return null;
    const opts: LineOptions = { ...this.opts, listeners };
    const file = fixedLineFile(this.voice.speechDir, this.voice.key.split('/').pop()!, words);
    let id: string;
    if (fs.existsSync(file)) id = this.hub.playFile(file, words, opts);
    else {
      if (this.engine === undefined) this.engine = this.hub.choose();
      id = this.hub.speak(this.engine, this.voice, words, { ...opts, priority: (opts.priority ?? 0) + Math.min(this.said, 9) }, Date.now() + START_WITHIN_MS + this.aheadMs);
    }
    this.hub.lineOf(id, this);
    this.said++;
    this.aheadMs += sayMs(words);
    return id;
  }
}

export class Speech {
  private engines: Partial<Record<EngineName, SpeechEngine>> = {};
  private lines = new Map<string, Line>();
  /** The reply each recent line belongs to (a line can be skipped after the server has sent all of it). */
  private replies = new Map<string, Reply>();
  /** GPU speech is on for the whole game (the switch on the admin GPU page). */
  gpuOn: () => boolean = () => true;
  readonly counts: SpeechCounts = { spoken: { cpu: 0, gpu: 0, file: 0 }, expired: 0, failed: 0, cancelled: 0 };

  setEngine(name: EngineName, engine: SpeechEngine | null) {
    this.engines[name]?.stop();
    if (engine) this.engines[name] = engine;
    else delete this.engines[name];
  }

  engine(name: EngineName): SpeechEngine | undefined {
    return this.engines[name];
  }

  /** Whether this installation speaks at all. */
  enabled(): boolean {
    return Object.keys(this.engines).length > 0;
  }

  /** The engine for a reply: the GPU when it is on and has a slot, else the CPU if it can start in time, else none. */
  choose(priority = 0): SpeechEngine | null {
    const gpu = this.engines.gpu;
    if (gpu && this.gpuOn() && gpu.canStart(300, priority)) return gpu;
    const cpu = this.engines.cpu;
    if (cpu && cpu.canStart(START_WITHIN_MS - 1000, priority)) return cpu;
    return null;
  }

  reply(voice: Voice, opts: ReplyOptions): Reply {
    return new Reply(this, voice, opts);
  }

  /** A reply said one of its lines. The last few hundred are kept, which covers every line a player can still skip. */
  lineOf(lineId: string, reply: Reply) {
    this.replies.set(lineId, reply);
    if (this.replies.size > 400) this.replies.delete(this.replies.keys().next().value!);
  }

  /** Make a voice's state ahead of its first line (someone walks up to talk with its speaker). */
  prepare(voice: Voice) {
    for (const e of Object.values(this.engines)) e.prepare(voice.clip);
  }

  private open(text: string, opts: LineOptions, gain = 1): Line {
    const line = new Line(`l${crypto.randomBytes(6).toString('hex')}`, text, opts, gain);
    this.lines.set(line.id, line);
    for (const l of line.listeners.values()) line.announce(l);
    return line;
  }

  private close(line: Line, how: LineEnd, error?: string) {
    if (line.ended) return;
    if (line.deadline) clearTimeout(line.deadline);
    line.end(how);
    this.lines.delete(line.id);
    if (how === 'done') this.counts.spoken[line.engine?.name ?? 'file']++;
    else this.counts[how]++;
    if (how === 'failed' && error) reportError(new Error(`Speech failed: ${error}`), { engine: line.engine?.name, text: line.text.slice(0, 80) });
    if (how === 'expired' || how === 'failed') line.opts.onUnvoiced?.(line.id);
  }

  speak(engine: SpeechEngine | null, voice: Voice, text: string, opts: LineOptions, deadline = Date.now() + START_WITHIN_MS): string {
    const line = this.open(text, opts, (engine && voice.gain?.[engine.name]) ?? 1);
    if (!engine) {
      // No engine could start it in time: it is not spoken, and its listeners see why.
      queueMicrotask(() => this.close(line, 'expired'));
      return line.id;
    }
    line.engine = engine;
    // The six seconds, for every engine: a line still waiting then (for a slot, for a voice's state, on an engine that
    // went quiet) is not spoken.
    line.deadline = setTimeout(() => {
      if (line.started) return;
      this.close(line, 'expired');
      engine.cancel(line.id);
    }, Math.max(0, deadline - Date.now()));
    line.deadline.unref();
    engine.speak(
      { lineId: line.id, voiceId: voice.key, clip: voice.clip, text, deadline, priority: opts.priority ?? 0 },
      {
        started: (rate) => line.start(rate),
        audio: (pcm) => line.audio(pcm),
        end: (how, error) => this.close(line, how, error),
      },
    );
    return line.id;
  }

  /** A line spoken at build time: its packets go out at once (the client plays them in time). */
  playFile(file: string, text: string, opts: LineOptions): string {
    const line = this.open(text, opts);
    try {
      const { packets, sampleRate } = readOggOpus(fs.readFileSync(file));
      line.start(sampleRate);
      for (const p of packets) line.packet(p);
      // A browser without WebCodecs gets nothing from a file (it cannot decode Opus); it shows the text alone.
      this.close(line, 'done');
    } catch (e) {
      this.close(line, 'failed', `${path.basename(file)}: ${(e as Error).message}`);
    }
    return line.id;
  }

  /** Someone joins a queue that is speaking (a conversation): they hear its lines from where they are. */
  join(queue: string, listener: Listener) {
    for (const line of this.lines.values()) {
      if (line.opts.queue !== queue || line.listeners.has(listener.key)) continue;
      line.listeners.set(listener.key, listener);
      line.announce(listener);
    }
  }

  /**
   * Someone stops hearing a queue's lines (closing the conversation), one line (skipping it, and with it the rest of
   * its reply), or everything (`queue` and `lineId` both unset: they left). A line nobody hears any more is canceled.
   */
  leave(listenerKey: string, which: { queue?: string; lineId?: string } = {}) {
    if (which.lineId) this.replies.get(which.lineId)?.skip(listenerKey);
    for (const line of [...this.lines.values()]) {
      if (which.queue && line.opts.queue !== which.queue) continue;
      if (which.lineId && line.id !== which.lineId) continue;
      if (!line.listeners.delete(listenerKey) || line.listeners.size) continue;
      if (line.engine) line.engine.cancel(line.id);
      else this.close(line, 'cancelled');
    }
  }

  status() {
    return { gpuOn: this.gpuOn(), engines: Object.values(this.engines).map((e) => e.status()), counts: this.counts, lines: this.lines.size };
  }

  stop() {
    for (const e of Object.values(this.engines)) e.stop();
    this.engines = {};
  }
}

let hub: Speech | null = null;

/**
 * Start the engines config/genai.json names: `speech.cpu` (a pocket-tts provider) and `speech.gpu` (the GPU broker:
 * a comfyui provider with "broker": true, whose address and token it shares).
 */
export function startSpeech(cfg: GenAIConfig) {
  const hub = speech();
  const cpu = cfg.purposes['speech.cpu'];
  const pc = cpu && cfg.providers[cpu.provider];
  if (pc?.type === 'pocket-tts') {
    try {
      hub.setEngine('cpu', new PocketEngine({ models: pc.models, lines: pc.lines, threads: pc.threads, model: pc.model, smallModel: pc.smallModel }));
    } catch (e) {
      console.warn(`[speech] Pocket TTS's models are not exported (docs/hosting.md, step 4a): no speech on the CPU. ${(e as Error).message}`);
    }
  }
  const gpu = cfg.purposes['speech.gpu'];
  const gc = gpu && cfg.providers[gpu.provider];
  if (gc?.type === 'comfyui' && gc.baseUrl) hub.setEngine('gpu', new GpuEngine({ baseUrl: gc.baseUrl, token: resolveSecret(gc.apiKey) }));
  hub.gpuOn = () => !control('gpuSpeechOff');
}

/** The game server's speech (its engines start with `startSpeech`). */
export function speech(): Speech {
  return (hub ??= new Speech());
}
