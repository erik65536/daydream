/**
 * Loudness (ITU-R BS.1770: K-weighting, 400 ms blocks, the absolute and relative gates), for bringing every voice on
 * both engines to the game's level (docs/voices.md, "Loudness").
 */

/** The game's speech level, in LUFS. */
const TARGET_LUFS = -18;

type Biquad = [number, number, number, number, number]; // b0 b1 b2 a1 a2 (a0 = 1)

/**
 * BS.1770's two filters at any sample rate, from their analog prototypes (the derivation that gives the standard's
 * own coefficients at 48 kHz): the head's high shelf, then the high pass.
 */
export function kWeighting(rate: number): Biquad[] {
  const shelf = (f0: number, gainDb: number, q: number): Biquad => {
    const K = Math.tan((Math.PI * f0) / rate), Vh = 10 ** (gainDb / 20), Vb = Vh ** 0.4996667741545416, a0 = 1 + K / q + K * K;
    return [(Vh + (Vb * K) / q + K * K) / a0, (2 * (K * K - Vh)) / a0, (Vh - (Vb * K) / q + K * K) / a0, (2 * (K * K - 1)) / a0, (1 - K / q + K * K) / a0];
  };
  const highpass = (f0: number, q: number): Biquad => {
    const K = Math.tan((Math.PI * f0) / rate), a0 = 1 + K / q + K * K;
    return [1, -2, 1, (2 * (K * K - 1)) / a0, (1 - K / q + K * K) / a0];
  };
  return [shelf(1681.974450955533, 3.999843853973347, 0.7071752369554196), highpass(38.13547087602444, 0.5003270373238773)];
}

/** Integrated loudness of 16-bit mono PCM, in LUFS (-Infinity for silence or too little audio). */
export function loudness(pcm: Uint8Array, rate: number): number {
  const n = Math.floor(pcm.length / 2);
  const view = new DataView(pcm.buffer, pcm.byteOffset, n * 2);
  const x = new Float64Array(n);
  for (let i = 0; i < n; i++) x[i] = view.getInt16(i * 2, true) / 32768;
  for (const [b0, b1, b2, a1, a2] of kWeighting(rate)) {
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
  const block = Math.round(rate * 0.4), hop = Math.round(rate * 0.1);
  const powers: number[] = [];
  for (let start = 0; start + block <= n; start += hop) {
    let sum = 0;
    for (let i = start; i < start + block; i++) sum += x[i]! * x[i]!;
    powers.push(sum / block);
  }
  const lufs = (p: number) => -0.691 + 10 * Math.log10(p);
  const mean = (ps: number[]) => ps.reduce((a, b) => a + b, 0) / ps.length;
  const loud = powers.filter((p) => lufs(p) > -70);
  if (!loud.length) return -Infinity;
  const gate = lufs(mean(loud)) - 10;
  const kept = loud.filter((p) => lufs(p) > gate);
  return lufs(mean(kept));
}

/** The linear gain that brings audio of this loudness to the game's level (1 when it cannot be measured). */
export function gainFor(lufs: number): number {
  if (!Number.isFinite(lufs)) return 1;
  return Math.max(0.1, Math.min(8, 10 ** ((TARGET_LUFS - lufs) / 20)));
}
