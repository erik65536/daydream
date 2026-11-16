/**
 * Audio arithmetic for making sounds game-ready (sound/ready.ts): floating-point channels, resampling, loudness as
 * ITU-R BS.1770 measures it (integrated, and the loudest 100 ms for short sounds), envelopes and a short-time
 * spectrum.
 */
import { kWeighting } from '../speech/loudness.ts';

/** Audio as floating-point channels (-1 to 1) at a sample rate. */
export interface Pcm {
  rate: number;
  ch: Float32Array[];
}

export const frames = (p: Pcm) => p.ch[0]?.length ?? 0;
export const seconds = (p: Pcm) => frames(p) / p.rate;

/** The channels averaged. */
export function mono(p: Pcm): Float32Array {
  const n = frames(p), out = new Float32Array(n);
  for (const c of p.ch) for (let i = 0; i < n; i++) out[i]! += c[i]! / p.ch.length;
  return out;
}

export const slice = (p: Pcm, from: number, to: number): Pcm => ({ rate: p.rate, ch: p.ch.map((c) => c.slice(Math.max(0, from), Math.min(c.length, to))) });

export function scaled(p: Pcm, g: number): Pcm {
  return { rate: p.rate, ch: p.ch.map((c) => c.map((v) => v * g)) };
}

/** The largest sample, as a linear value. */
export function peak(p: Pcm): number {
  let m = 0;
  for (const c of p.ch) for (const v of c) m = Math.max(m, Math.abs(v));
  return m;
}

export const db = (v: number) => 20 * Math.log10(Math.max(v, 1e-9));
export const fromDb = (d: number) => 10 ** (d / 20);

const gcd = (a: number, b: number): number => (b ? gcd(b, a % b) : a);

/**
 * Change the sample rate with a windowed-sinc filter (Kaiser window, 32 taps a side), precomputed for each of the
 * ratio's phases: exact for the rational ratios audio uses (44.1 kHz to 48 kHz is 147:160).
 */
export function resample(p: Pcm, to: number): Pcm {
  if (p.rate === to) return p;
  const g = gcd(p.rate, to), up = to / g, down = p.rate / g;
  const half = 32, cutoff = Math.min(1, to / p.rate) * 0.96, beta = 8.6;
  const bessel = (x: number) => {
    let s = 1, t = 1;
    for (let k = 1; k < 30; k++) {
      t *= (x / (2 * k)) ** 2;
      s += t;
    }
    return s;
  };
  // Kernel for each output phase, one after another: output n sits at input position n * down / up.
  const taps = 2 * half, kernels = new Float64Array(up * taps);
  for (let ph = 0; ph < up; ph++) {
    const frac = ph / up, k = kernels.subarray(ph * taps, (ph + 1) * taps);
    let sum = 0;
    for (let j = 0; j < taps; j++) {
      const x = j - half + 1 - frac;
      const sinc = x === 0 ? 1 : Math.sin(Math.PI * cutoff * x) / (Math.PI * cutoff * x);
      const w = bessel(beta * Math.sqrt(Math.max(0, 1 - (x / half) ** 2))) / bessel(beta);
      sum += (k[j] = sinc * w);
    }
    for (let j = 0; j < taps; j++) k[j]! /= sum;
  }
  const n = frames(p), outN = Math.floor((n * up) / down);
  return {
    rate: to,
    ch: p.ch.map((c) => {
      const out = new Float32Array(outN);
      // The first input under output o's kernel, and the kernel's phase, stepped along instead of divided out.
      for (let o = 0, first = 1 - half, ph = 0; o < outN; o++) {
        // Only the taps over the input (near the ends some fall outside it).
        const from = Math.max(0, -first), to = Math.min(taps, n - first), k = ph * taps;
        let s = 0;
        for (let j = from; j < to; j++) s += c[first + j]! * kernels[k + j]!;
        out[o] = s;
        for (ph += down; ph >= up; ph -= up) first++;
      }
      return out;
    }),
  };
}

/** The K-weighted power of every sample, summed over channels (BS.1770's channel weights are 1 for front channels). */
function weightedPower(p: Pcm): Float64Array {
  const n = frames(p), e = new Float64Array(n);
  for (const c of p.ch) {
    const x = Float64Array.from(c);
    for (const [b0, b1, b2, a1, a2] of kWeighting(p.rate)) {
      let x1 = 0, x2 = 0, y1 = 0, y2 = 0;
      for (let i = 0; i < n; i++) {
        const v = x[i]!;
        const y = b0 * v + b1 * x1 + b2 * x2 - a1 * y1 - a2 * y2;
        x2 = x1;
        x1 = v;
        y2 = y1;
        y1 = y;
        x[i] = y;
      }
    }
    for (let i = 0; i < n; i++) e[i]! += x[i]! * x[i]!;
  }
  return e;
}

const lufs = (power: number) => -0.691 + 10 * Math.log10(Math.max(power, 1e-12));

/** Mean power over windows of `win` s every `hop` s. */
function windows(e: Float64Array, rate: number, win: number, hop: number): number[] {
  const w = Math.max(1, Math.round(win * rate)), h = Math.max(1, Math.round(hop * rate));
  const out: number[] = [];
  if (e.length < w) return [e.reduce((a, b) => a + b, 0) / w];
  let sum = 0;
  for (let i = 0; i < w; i++) sum += e[i]!;
  for (let start = 0; ; ) {
    out.push(sum / w);
    const next = start + h;
    if (next + w > e.length) break;
    for (let i = start; i < next; i++) sum -= e[i]!;
    for (let i = start + w; i < next + w; i++) sum += e[i]!;
    start = next;
  }
  return out;
}

/** Integrated loudness in LUFS, gated as BS.1770 says (-70 for silence). */
export function integratedLoudness(p: Pcm): number {
  const blocks = windows(weightedPower(p), p.rate, 0.4, 0.1);
  const loud = blocks.filter((b) => lufs(b) > -70);
  if (!loud.length) return -70;
  const mean = (xs: number[]) => xs.reduce((a, b) => a + b, 0) / xs.length;
  const gate = lufs(mean(loud)) - 10;
  const kept = loud.filter((b) => lufs(b) > gate);
  return lufs(mean(kept));
}

/** Momentary loudness (400 ms blocks every 100 ms), in LUFS. */
export function momentaryLoudness(p: Pcm): number[] {
  return windows(weightedPower(p), p.rate, 0.4, 0.1).map(lufs);
}

/** The loudness of the loudest `win` seconds (100 ms: the measure for short sounds, whose integrated loudness means little). */
export function peakLoudness(p: Pcm, win = 0.1): number {
  return lufs(Math.max(...windows(weightedPower(p), p.rate, win, 0.01)));
}

/** A mono signal's level every `hop` seconds, in dB (RMS). */
export function envelope(m: Float32Array, rate: number, hop = 0.005): { db: Float32Array; hop: number } {
  const h = Math.max(1, Math.round(rate * hop)), n = Math.floor(m.length / h);
  const out = new Float32Array(n);
  for (let f = 0; f < n; f++) {
    let s = 0;
    for (let i = f * h; i < (f + 1) * h; i++) s += m[i]! * m[i]!;
    out[f] = 10 * Math.log10(s / h + 1e-12);
  }
  return { db: out, hop: h };
}

/** In-place radix-2 FFT of `re` and `im` (their length a power of two). */
function fft(re: Float64Array, im: Float64Array) {
  const n = re.length;
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j]!, re[i]!];
      [im[i], im[j]] = [im[j]!, im[i]!];
    }
  }
  for (let len = 2; len <= n; len <<= 1) {
    const ang = (-2 * Math.PI) / len, wr = Math.cos(ang), wi = Math.sin(ang);
    for (let i = 0; i < n; i += len) {
      let cr = 1, ci = 0;
      for (let k = 0; k < len / 2; k++) {
        const a = i + k, b = a + len / 2;
        const tr = re[b]! * cr - im[b]! * ci, ti = re[b]! * ci + im[b]! * cr;
        re[b] = re[a]! - tr;
        im[b] = im[a]! - ti;
        re[a]! += tr;
        im[a]! += ti;
        [cr, ci] = [cr * wr - ci * wi, cr * wi + ci * wr];
      }
    }
  }
}

/** Magnitude spectra of a mono signal: frames of `size` (a power of two, Hann window) every `hop` samples. */
export function spectrogram(m: Float32Array, size: number, hop: number): Float32Array[] {
  const win = Float64Array.from({ length: size }, (_, i) => 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / size));
  const out: Float32Array[] = [];
  const re = new Float64Array(size), im = new Float64Array(size);
  for (let at = 0; at + size <= m.length; at += hop) {
    for (let i = 0; i < size; i++) {
      re[i] = m[at + i]! * win[i]!;
      im[i] = 0;
    }
    fft(re, im);
    const mag = new Float32Array(size / 2 + 1);
    for (let k = 0; k <= size / 2; k++) mag[k] = Math.hypot(re[k]!, im[k]!);
    out.push(mag);
  }
  return out;
}
