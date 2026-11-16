/**
 * Making a generated take game-ready (docs/sound.md, "Game-ready"), with a few general rules that do not depend on
 * what the sound is:
 *
 * - One-shots keep their main sound: the stretch around the loudest moment that ends at the first silence (40 dB
 *   under the peak) longer than a quarter of a second (a second for music, which has rests); anything past such a
 *   gap is the model's padding or a stray artifact. Then a 3 ms fade-in, a fade-out over the last 15% (at most
 *   120 ms), and the level of its loudness group.
 * - Textures (ambience) loop by crossfading their last 1.5 s into their start.
 * - Music loops are a whole number of 8-bar phrases at the piece's tempo (measured from the audio when the model did
 *   not keep the one asked for). The bar it starts on (the bars before become an intro played once) and the number of
 *   phrases are chosen so the seam matches best by rhythm and timbre, and the loop's last beat is crossfaded into the
 *   beat before its start, so it runs on into its start as the intro does.
 *
 * A take is refused when it is nearly silent, clipped, too short to be a sound or to loop, an ambience with a sudden
 * event standing out of it, or music too short to hold a loop.
 */
import OpusModule from '@discordjs/opus';
import { writeOggOpus, type SoundKind, type SoundShape } from '@daydream/shared';
import { envelope, frames, fromDb, integratedLoudness, momentaryLoudness, mono, peak, peakLoudness, resample, scaled, slice, spectrogram, type Pcm } from './dsp.ts';

const { OpusEncoder } = OpusModule as unknown as { OpusEncoder: new (rate: number, ch: number) => { encode(b: Buffer): Buffer; setBitrate(b: number): void } };

/** Every sound is played at 48 kHz (Opus's rate). */
export const RATE = 48000;

/**
 * Each loudness group's level: short sounds by their loudest 100 ms (K-weighted, like LUFS), long ones (ambience,
 * music) by integrated LUFS. Ambience sits well under everything else.
 */
export const TARGET: Record<SoundKind, number> = { interface: -18, reward: -12, loot: -15, spell: -12, combat: -11, creature: -12, stinger: -18, loop: -20, ambience: -28 };
const LONG = new Set<SoundKind>(['stinger', 'loop', 'ambience']);
/** Sample peaks stay under this (room for the peaks between samples under -1 dBFS). */
const CEIL = fromDb(-1.5);

const loudnessOf = (p: Pcm, kind: SoundKind) => (LONG.has(kind) ? integratedLoudness(p) : peakLoudness(p));

function level(p: Pcm, kind: SoundKind): Pcm {
  const out = scaled(p, fromDb(TARGET[kind] - loudnessOf(p, kind)));
  const pk = peak(out);
  return pk > CEIL ? scaled(out, CEIL / pk) : out;
}

/** The stretch around the loudest moment, up to the first silence longer than `gapS` on either side. */
function mainSound(p: Pcm, gapS: number, relDb = 40): Pcm {
  const { db: e, hop } = envelope(mono(p), p.rate);
  if (!e.length) return p;
  let top = 0;
  for (let i = 1; i < e.length; i++) if (e[i]! > e[top]!) top = i;
  const on = (i: number) => e[i]! > e[top]! - relDb;
  const gap = Math.round(gapS / (hop / p.rate));
  const reach = (dir: 1 | -1) => {
    let edge = top;
    for (let i = top, quiet = 0; i >= 0 && i < e.length; i += dir) {
      quiet = on(i) ? 0 : quiet + 1;
      if (quiet > gap) break;
      if (on(i)) edge = i;
    }
    return edge;
  };
  return slice(p, reach(-1) * hop - Math.round(0.005 * p.rate), (reach(1) + 1) * hop + Math.round(0.03 * p.rate));
}

function fades(p: Pcm): Pcm {
  const n = frames(p);
  const fi = Math.min(n, Math.round(0.003 * p.rate)), fo = Math.min(n, Math.round(Math.min(0.12, (0.15 * n) / p.rate) * p.rate));
  return {
    rate: p.rate,
    ch: p.ch.map((c) => {
      const o = c.slice();
      for (let i = 0; i < fi; i++) o[i]! *= i / fi;
      for (let i = 0; i < fo; i++) o[n - fo + i]! *= Math.cos(((i / fo) * Math.PI) / 2) ** 2;
      return o;
    }),
  };
}

/** `a`'s last `x` samples crossfaded (equal power) into `b`'s first: what makes a seam inaudible. */
function crossfade(tail: Float32Array, head: Float32Array, x: number): Float32Array {
  const out = head.slice();
  for (let i = 0; i < x; i++) {
    const t = ((i / x) * Math.PI) / 2;
    out[i] = tail[i]! * Math.cos(t) + head[i]! * Math.sin(t);
  }
  return out;
}

/** The crossfade of a texture's end into its start, in seconds. */
const TEXTURE_FADE = 1.5;

function textureLoop(p: Pcm): Pcm {
  const x = Math.round(TEXTURE_FADE * p.rate), L = frames(p) - x;
  return { rate: p.rate, ch: p.ch.map((c) => { const o = c.slice(0, L); o.set(crossfade(c.subarray(L, L + x), c.subarray(0, x), x)); return o; }) };
}

/** Onset strength per frame: how much louder each frequency gets, summed. */
function onsetStrength(spec: Float32Array[], bands?: number[]): Float64Array {
  const f = new Float64Array(spec.length);
  const log = spec.map((s) => (bands ? bandsOf(s, bands) : Float64Array.from(s, (v) => Math.log(v + 1e-6))));
  for (let t = 1; t < log.length; t++) {
    let s = 0;
    for (let k = 0; k < log[t]!.length; k++) s += Math.max(0, log[t]![k]! - log[t - 1]![k]!);
    f[t] = s;
  }
  return f;
}

function bandsOf(s: Float32Array, edges: number[]): Float64Array {
  const out = new Float64Array(edges.length - 1);
  for (let b = 0; b < out.length; b++) {
    let sum = 0;
    for (let k = edges[b]!; k < edges[b + 1]!; k++) sum += s[k]!;
    out[b] = Math.log(sum + 1e-6);
  }
  return out;
}

/** The tempo the audio keeps: the beat lag of its onset strength's autocorrelation, refined over 16 beats. */
export function measuredBpm(m: Float32Array, rate: number): number {
  const hop = 256;
  const f = onsetStrength(spectrogram(m, 1024, hop));
  const mean = f.reduce((a, b) => a + b, 0) / f.length;
  for (let i = 0; i < f.length; i++) f[i]! -= mean;
  const ac = (lag: number) => {
    let s = 0;
    for (let i = 0; i + lag < f.length; i++) s += f[i]! * f[i + lag]!;
    return s;
  };
  const fps = rate / hop;
  const best = (lo: number, hi: number) => {
    let at = lo, top = -Infinity;
    for (let l = lo; l < hi; l++) {
      const v = ac(l);
      if (v > top) [top, at] = [v, l];
    }
    return at;
  };
  const beat = best(Math.floor((fps * 60) / 180), Math.floor((fps * 60) / 70));
  const a = Math.floor(16 * beat * 0.97), b = Math.floor(16 * beat * 1.03);
  if (b >= f.length) return (60 * fps) / beat;
  return (16 * 60 * fps) / best(a, b);
}

/** A music loop and the intro before it (see the file comment); null when the take has none. */
function musicLoop(p: Pcm, askedBpm: number): { intro: Pcm; loop: Pcm } | null {
  const m = mono(p);
  const found = measuredBpm(m, p.rate);
  const bpm = Math.abs(found / askedBpm - 1) > 0.02 ? found : askedBpm;
  const beat = 60 / bpm, bar = 4 * beat, hop = 512;
  const spec = spectrogram(m, 2048, hop);
  const bins = spec[0]?.length ?? 0;
  const edges = [...new Set(Array.from({ length: 49 }, (_, i) => Math.floor(2 * ((bins - 1) / 2) ** (i / 48))))];
  const bands = spec.map((s) => bandsOf(s, edges));
  const flux = onsetStrength(spec, edges);
  const W = Math.floor((2 * bar * p.rate) / hop);
  const centered = (xs: ArrayLike<number>, from: number, n: number) => {
    let mean = 0;
    for (let i = 0; i < n; i++) mean += xs[from + i]! / n;
    return Array.from({ length: n }, (_, i) => xs[from + i]! - mean);
  };
  const cos = (a: number[], b: number[]) => {
    let ab = 0, aa = 0, bb = 0;
    for (let i = 0; i < a.length; i++) {
      ab += a[i]! * b[i]!;
      aa += a[i]! ** 2;
      bb += b[i]! ** 2;
    }
    return ab / (Math.sqrt(aa * bb) + 1e-9);
  };
  const score = (s: number, e: number) => {
    if (e + W > bands.length) return -2;
    let timbre = 0;
    for (let i = 0; i < W; i++) timbre += cos(centered(bands[s + i]!, 0, bands[s + i]!.length), centered(bands[e + i]!, 0, bands[e + i]!.length)) / W;
    return cos(centered(flux, s, W), centered(flux, e, W)) + timbre;
  };
  const totalBars = Math.floor((frames(p) / p.rate - beat) / bar);
  let best: { sc: number; k: number; n: number } | null = null;
  for (let k = 1; k <= 8; k++)
    for (let n = 16; n <= totalBars - k; n += 8) {
      // A longer loop repeats less, so it wins near-ties.
      const sc = score(Math.round((k * bar * p.rate) / hop), Math.round(((k + n) * bar * p.rate) / hop)) + (0.05 * n) / 8;
      if (!best || sc > best.sc) best = { sc, k, n };
    }
  if (!best) return null;
  const s = Math.round(best.k * bar * p.rate), L = Math.round(best.n * bar * p.rate), x = Math.round(beat * p.rate);
  // The loop's last beat fades into the beat before its start: it ends on the sample before its first, as the intro
  // does, so both ways into the loop run on without a cut.
  const loop: Pcm = { rate: p.rate, ch: p.ch.map((c) => { const o = c.slice(s, s + L); o.set(crossfade(c.subarray(s + L - x, s + L), c.subarray(s - x, s), x), L - x); return o; }) };
  const levelled = level(loop, 'loop');
  const g = peak(levelled) / (peak(loop) + 1e-9);
  return { intro: scaled(slice(p, 0, s), g), loop: levelled };
}

export type Ready = { ok: true; main: Pcm; intro?: Pcm } | { ok: false; problem: string };

/**
 * One take made game-ready, or why it cannot be used. `bpm`: the tempo a music loop was asked for.
 */
export function makeReady(take: Pcm, spec: { kind: SoundKind; shape: SoundShape }, bpm?: number): Ready {
  const p = resample(take, RATE);
  if (peak(p) >= 0.999) return { ok: false, problem: 'clipped' };
  const loud = loudnessOf(p, spec.kind);
  if (loud < (spec.kind === 'ambience' ? -54 : -50)) return { ok: false, problem: `nearly silent (${loud.toFixed(0)} LUFS)` };
  if (spec.shape === 'texture') {
    // A steady bed: no moment much louder than the bed's usual level (a single call or bell is heard again on every loop).
    const blocks = momentaryLoudness(p).sort((a, b) => a - b);
    const over = blocks[blocks.length - 1]! - blocks[Math.floor(blocks.length / 2)]!;
    if (over > 12) return { ok: false, problem: `a sudden sound stands out (${over.toFixed(0)} LU over the bed)` };
    // Its end is faded into its start: it needs as much again to be left with.
    if (frames(p) < 2 * TEXTURE_FADE * p.rate) return { ok: false, problem: 'too short to loop' };
    return { ok: true, main: level(textureLoop(p), spec.kind) };
  }
  if (spec.shape === 'loop') {
    const l = musicLoop(p, bpm ?? 120);
    return l ? { ok: true, main: l.loop, intro: l.intro } : { ok: false, problem: 'no loop in it' };
  }
  const main = mainSound(p, spec.kind === 'stinger' ? 1 : 0.25);
  if (frames(main) < 0.04 * p.rate) return { ok: false, problem: 'too short to be a sound' };
  return { ok: true, main: level(fades(main), spec.kind) };
}

/** A game-ready sound as Ogg Opus at 48 kHz (`kbps` for both channels), ending exactly where it ends. */
export function oggOpus(p: Pcm, kbps: number): Uint8Array {
  const ch = p.ch.length as 1 | 2;
  const enc = new OpusEncoder(RATE, ch);
  enc.setBitrate(kbps * 1000);
  const n = frames(p), packets: Uint8Array[] = [];
  for (let at = 0; at < n; at += 960) {
    const pcm = Buffer.alloc(960 * ch * 2);
    for (let i = 0; i < 960 && at + i < n; i++)
      for (let c = 0; c < ch; c++) pcm.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(p.ch[c]![at + i]! * 32767))), (i * ch + c) * 2);
    packets.push(enc.encode(pcm));
  }
  // One more packet carries the encoder's last delayed samples.
  packets.push(enc.encode(Buffer.alloc(960 * ch * 2)));
  return writeOggOpus(packets, RATE, { channels: ch, samples: n });
}
