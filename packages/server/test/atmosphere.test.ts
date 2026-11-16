import sharp from 'sharp';
import { describe, expect, it } from 'vitest';
import { MIST_SIZE, flatten, makeMist, measureLight, type Draft } from '../src/worldgen/atmosphere.ts';
import { mistTile, type MistShape } from '../src/worldgen/mistnoise.ts';
import { mockModels } from './helpers.ts';

const N = MIST_SIZE;

/** A noisy RGB tile with a strong brightness gradient across it (not tileable). */
function tile(seed = 1): Buffer {
  const px = Buffer.alloc(N * N * 3);
  let s = seed;
  for (let i = 0; i < N * N; i++) {
    s = (s * 1103515245 + 12345) >>> 0;
    const v = 40 + ((i % N) / N) * 120 + (s % 60);
    px[i * 3] = v;
    px[i * 3 + 1] = v * 0.9;
    px[i * 3 + 2] = v * 0.8;
  }
  return px;
}

/** Raw pixels rolled by half the size both ways (the tile's edges meet in the middle). */
function roll(px: Buffer, size: number, channels: number): Buffer {
  const out = Buffer.alloc(px.length), h = size / 2;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) px.copy(out, (((y + h) % size) * size + ((x + h) % size)) * channels, (y * size + x) * channels, (y * size + x + 1) * channels);
  return out;
}

function memoryDraft(): Draft & { files: Map<string, unknown> } {
  const files = new Map<string, unknown>();
  return {
    files,
    json: <T>(n: string) => files.get(`${n}.json`) as T | undefined,
    saveJson: (n, v) => void files.set(`${n}.json`, v),
    png: (n) => files.get(`${n}.png`) as Buffer | undefined,
    savePng: (n, b) => void files.set(`${n}.png`, b),
  };
}

describe('mist textures', () => {
  it('flattens large-scale brightness without breaking the wrap', () => {
    const px = tile();
    const flat = flatten(px, N);
    const colMean = (b: Buffer, x: number) => {
      let s = 0;
      for (let y = 0; y < N; y++) s += b[(y * N + x) * 3]!;
      return s / N;
    };
    // Most of the gradient across the tile is gone (relative to the tile's mean brightness).
    const mean = (b: Buffer) => b.reduce((a, v, k) => (k % 3 ? a : a + v), 0) / (N * N);
    const across = (b: Buffer) => Math.abs(colMean(b, 700) - colMean(b, 300)) / mean(b);
    expect(across(px)).toBeGreaterThan(0.3);
    expect(across(flat)).toBeLessThan(across(px) / 2);
    // Uses the full range.
    expect(Math.max(...flat.subarray(0, 30000))).toBeGreaterThan(230);
    // Wrap-invariant: flattening a rolled tile is the rolled flattened tile.
    expect(flatten(roll(px, N, 3), N).equals(roll(flat, N, 3))).toBe(true);
  });

});

describe('mist tiles', () => {
  const shape: MistShape = { scale: 3, swirl: 0.5, flow: 0.5, wisps: 0.5, threads: 0.3, cover: 0.6, contrast: 0.4, motes: 0.2, thin: '#40606a', dense: '#e8e0c8' };
  const S = 256;
  const luma = (b: Buffer, x: number, y: number) => 0.2126 * b[(y * S + x) * 3]! + 0.7152 * b[(y * S + x) * 3 + 1]! + 0.0722 * b[(y * S + x) * 3 + 2]!;

  it('tiles: across the wrap it changes no more than between neighbors inside', () => {
    const px = mistTile(shape, S, 3);
    let wrap = 0, inside = 0;
    for (let i = 0; i < S; i++) {
      wrap += Math.abs(luma(px, S - 1, i) - luma(px, 0, i)) + Math.abs(luma(px, i, S - 1) - luma(px, i, 0));
      inside += Math.abs(luma(px, S / 2 - 1, i) - luma(px, S / 2, i)) + Math.abs(luma(px, i, S / 2 - 1) - luma(px, i, S / 2));
    }
    expect(wrap).toBeLessThan(inside * 1.5 + S);
  });

  it('spreads its density from clear to dense, its middle set by cover, and repeats for a seed', () => {
    const median = (m: MistShape) => {
      const px = mistTile(m, S, 4), l: number[] = [];
      for (let y = 0; y < S; y += 2) for (let x = 0; x < S; x += 2) l.push(luma(px, x, y));
      l.sort((a, b) => a - b);
      expect(l[Math.floor(l.length * 0.98)]).toBeGreaterThan(200);
      return l[l.length >> 1]!;
    };
    const thin = median({ ...shape, cover: 0.1 }), thick = median({ ...shape, cover: 0.9 });
    expect(thick).toBeGreaterThan(thin + 40);
    expect(mistTile(shape, S, 4).equals(mistTile(shape, S, 4))).toBe(true);
    expect(mistTile(shape, S, 4).equals(mistTile(shape, S, 5))).toBe(false);
  });

  it('is designed once and made again from the draft', async () => {
    const draft = memoryDraft();
    const brief = { name: 'Saltglass Flats', kind: 'wilderness', indoor: false, description: 'salt flats by the sea', weather: 'none', fogColor: '#34474a', lightColor: '#c6d1cc' };
    const models = await mockModels();
    try {
      const a = await makeMist(brief, draft, 5);
      expect(models.seen.filter((n) => n === 'mist')).toHaveLength(1);
      expect(draft.json<{ shape: MistShape }>('mist')?.shape.scale).toBeGreaterThanOrEqual(1);
      const meta = await sharp(a).metadata();
      expect([meta.format, meta.width, meta.height]).toEqual(['webp', N, N]);
      const b = await makeMist(brief, draft, 5);
      expect(models.seen.filter((n) => n === 'mist')).toHaveLength(1);
      expect(b.equals(a)).toBe(true);
    } finally {
      models.stop();
    }
  });
});

describe('painting light', () => {
  it('measures the lit color, the shadow color and the mean brightness', async () => {
    // A dark blue-gray place with a warm lamp-lit tenth.
    const W = 200, H = 100, px = Buffer.alloc(W * H * 3);
    for (let i = 0; i < W * H; i++) px.set(i % 10 === 0 ? [250, 200, 120] : [20, 26, 40], i * 3);
    const l = await measureLight(await sharp(px, { raw: { width: W, height: H, channels: 3 } }).png().toBuffer());
    expect(l.light).toBe('#fac878');
    expect(l.shade).toBe('#141a28');
    expect(l.level).toBeGreaterThan(0.16);
    expect(l.level).toBeLessThan(0.18);
  });
});
