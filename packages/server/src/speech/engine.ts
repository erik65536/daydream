/**
 * The speech engines behind one interface (docs/voices.md, "The engines"): Pocket TTS on this machine's CPU, in the
 * game server's own process (pocket.ts), and the VoxCPM2 runner on the GPU through the broker (gpu.ts). Both take a
 * line (a voice's reference clip and the text) and give its audio back as 16-bit PCM as it is made, so choosing an
 * engine is one decision in one place (speech.ts).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';

export type EngineName = 'cpu' | 'gpu';
export type LineEnd = 'done' | 'failed' | 'expired' | 'cancelled';

export interface LineRequest {
  lineId: string;
  /** Unique across worlds: the engine keeps each voice's state under it. */
  voiceId: string;
  /** The voice's reference clip, as a path the engine can read. */
  clip: string;
  text: string;
  /** Wall-clock ms (this machine's) after which a line that has not started is not spoken; speech.ts keeps it for every engine. */
  deadline: number;
  /** Lower goes first. */
  priority: number;
}

export interface LineEvents {
  started(sampleRate: number): void;
  audio(pcm: Uint8Array): void;
  end(how: LineEnd, error?: string): void;
}

export interface EngineStatus {
  name: EngineName;
  /** Answering and loaded. */
  ready: boolean;
  slots: number;
  free: number;
  waiting: number;
  detail?: string;
}

export interface SpeechEngine {
  readonly name: EngineName;
  /** Whether a line of this priority given now would likely start within `ms`. */
  canStart(ms: number, priority: number): boolean;
  speak(req: LineRequest, ev: LineEvents): void;
  cancel(lineId: string): void;
  /** Make a voice's state ahead of its first line (best effort). */
  prepare(clip: string): void;
  status(): EngineStatus;
  stop(): void;
}

/** Roughly how long a line takes to say, for estimating waits (the voices speak about 14 characters a second). */
export const sayMs = (text: string) => (text.length / 14) * 1000;

/**
 * Whether a line of this priority given now would likely start within `ms`, among an engine's lines (waiting, or
 * speaking since `startedAt`): each of `slots` clears its work at `loadedRtf` of real time, and the line starts once
 * the work ahead of it is done. Lines waiting with a later priority do not hold it up.
 */
export function startsWithin(lines: { text: string; priority: number; startedAt?: number }[], slots: number, loadedRtf: number, ms: number, priority: number): boolean {
  const speaking = lines.filter((l) => l.startedAt);
  const waiting = lines.filter((l) => !l.startedAt && l.priority <= priority);
  if (speaking.length + waiting.length < slots) return true;
  const now = Date.now();
  const remaining = speaking.map((l) => Math.max(0, sayMs(l.text) * loadedRtf - (now - l.startedAt!))).sort((a, b) => a - b);
  const ahead = waiting.reduce((s, l) => s + sayMs(l.text) * loadedRtf, 0) / slots;
  return (remaining[0] ?? 0) + ahead < ms;
}

const hashes = new Map<string, { mtimeMs: number; size: number; hash: string }>();

/** A voice clip's SHA-256, which names the voice to the engines (read again when the clip changes). */
export function clipHash(clip: string): string {
  const st = fs.statSync(clip);
  const known = hashes.get(clip);
  if (known && known.mtimeMs === st.mtimeMs && known.size === st.size) return known.hash;
  const hash = crypto.createHash('sha256').update(fs.readFileSync(clip)).digest('hex');
  hashes.set(clip, { mtimeMs: st.mtimeMs, size: st.size, hash });
  return hash;
}
