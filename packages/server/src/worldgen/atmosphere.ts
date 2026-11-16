/**
 * A place's air and light, for the game to tie everything to the painting: the mist that drifts over unexplored
 * ground and past the painting's edge, and the light the painting itself carries (measured from its pixels).
 *
 * The mist is one square texture that tiles, made from noise (worldgen/mistnoise.ts) with no image model: Luna says
 * what drifts in the place (sea fog, ash haze, cave spores) as a few numbers and two colors from its palette, and
 * its large-scale brightness is flattened out so no repeat shows. The game reads its brightness as density (see
 * docs/world-art.md).
 */
import sharp from 'sharp';
import { z } from 'zod';
import { genai } from '../genai/service.ts';
import { mistTile, type MistShape } from './mistnoise.ts';

/** The mist tile's size. */
export const MIST_SIZE = 1024;

/** What the mist's design needs to know about the place. */
export interface MistBrief {
  name: string;
  kind: string;
  indoor: boolean;
  description: string;
  /** The painting's art direction (palette, light, materials). */
  style?: string;
  weather: string;
  fogColor: string;
  lightColor: string;
}

/** Where a place's steps are saved, so a resumed build picks up where it stopped. */
export interface Draft {
  json<T>(name: string): T | undefined;
  saveJson(name: string, v: unknown): void;
  png(name: string): Buffer | undefined;
  savePng(name: string, b: Buffer): void;
}


const unit = (what: string) => z.number().min(0).max(1).describe(what);
const MistSchema = z.object({
  air: z.string().max(200).describe('What drifts in the air here, in a few words (sea fog, ash haze, cave spores, snow flurries)'),
  scale: z.number().int().min(1).max(6).describe('Banks of it across a 16 m square: 1 one broad bank, 2–3 rolling fog, 4–6 small puffs and patches'),
  swirl: unit('How much its wisps curl: 0 straight soft billows (still air), 0.5 drifting, 1 curling eddies (smoke, wind, magic)'),
  flow: unit('How much it streams one way: 0 still air pooling in place (caves, hollows), 0.5 drifting, 1 long streaks driven by wind or current'),
  wisps: unit('How much of it is fine wisps rather than soft banks: 0 smooth banks (heavy fog), 1 mostly wisps and streaks'),
  threads: unit('0 soft rounded wisps (fog, steam), 1 thin bright threads and streaks (smoke, ash, spider-silk haze)'),
  cover: unit('Share of the ground it covers: 0.35 sparse patches, 0.6 broken fog, 0.85 a thick blanket'),
  contrast: unit('0 hazy and even with a soft glow (dust, steam, sea fog), 1 crisp banks with clear gaps (smoke, cloud)'),
  motes: unit('Small bright specks drifting in it (spores, embers, snow, pollen, sparks): 0 none, 0.3 a few, 1 many'),
  thin: z.string().describe('Its color where thin, hex #rrggbb: a mid-tone of the place, often near the shadow color but clearly lighter'),
  dense: z.string().describe('Its color where dense, hex #rrggbb: light, often near the light color (dense parts are lighter)'),
});

/** Luna's picture of the place's air, as the noise's shape and colors. */
async function designMist(b: MistBrief): Promise<MistShape> {
  const out = await genai().structured('world.design', {
    system: 'You are the art director of a 2D top-down RPG. Each place has a layer of drifting air laid over unexplored ground and the edges of the place, made from noise shaped by a few numbers.',
    prompt: `PLACE: ${b.name} (${b.kind}${b.indoor ? ', indoors' : ''}): ${b.description}
${b.style ? `Art direction: ${b.style}
` : ''}Light color ${b.lightColor}, shadow color ${b.fogColor}${b.weather !== 'none' ? `, weather: ${b.weather}` : ''}.

Decide what drifts in the air of this place as seen from above (sea fog, river mist, ash haze, cave spores, smoke, dust, steam, pollen, snow) and give its shape and its two colors from the palette.`,
    schema: MistSchema,
    name: 'mist',
    maxTokens: 600,
  });
  const hex = (c: string, or: string) => (/^#[0-9a-f]{6}$/i.test(c.trim()) ? c.trim() : or);
  return { ...out, thin: hex(out.thin, b.fogColor), dense: hex(out.dense, b.lightColor) };
}

/**
 * Even out a tile's large-scale brightness (a wrap-around blur divided out) and stretch it to the full range, so
 * it repeats without a visible pattern and its brightness reads as density. Keeps its colors. RGB in, RGB out.
 */
export function flatten(px: Buffer, size: number): Buffer {
  const G = 64, cell = size / G;
  const luma = (i: number) => 0.2126 * px[i]! + 0.7152 * px[i + 1]! + 0.0722 * px[i + 2]!;
  const low = new Float32Array(G * G);
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) low[Math.floor(y / cell) * G + Math.floor(x / cell)]! += luma((y * size + x) * 3) / (cell * cell);
  // Wrap-around Gaussian, separable, sigma 10 cells (about a sixth of the tile: billows smaller than that stay).
  const S = 10, R = S * 3, k = Array.from({ length: 2 * R + 1 }, (_, i) => Math.exp(-((i - R) ** 2) / (2 * S * S)));
  const ks = k.reduce((a, b) => a + b);
  const blur = (src: Float32Array, dx: number, dy: number) => {
    const out = new Float32Array(G * G);
    for (let y = 0; y < G; y++)
      for (let x = 0; x < G; x++) {
        let s = 0;
        for (let i = -R; i <= R; i++) s += src[((y + i * dy + G) % G) * G + ((x + i * dx + G) % G)]! * k[i + R]!;
        out[y * G + x] = s / ks;
      }
    return out;
  };
  const smooth = blur(blur(low, 1, 0), 0, 1);
  const mean = smooth.reduce((a, b) => a + b) / smooth.length;
  // Bilinear, wrapping, between cell centers.
  const at = (x: number, y: number) => {
    const fx = x / cell - 0.5, fy = y / cell - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const v = (cx: number, cy: number) => smooth[((cy + G) % G) * G + ((cx + G) % G)]!;
    return (v(x0, y0) * (1 - tx) + v(x0 + 1, y0) * tx) * (1 - ty) + (v(x0, y0 + 1) * (1 - tx) + v(x0 + 1, y0 + 1) * tx) * ty;
  };
  const even = new Float32Array(px.length);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const f = (mean + 4) / (at(x, y) + 4), i = (y * size + x) * 3;
      for (let ch = 0; ch < 3; ch++) even[i + ch] = px[i + ch]! * f;
    }
  // Stretch brightness (not color): the 2nd to the 98th percentile becomes the full range, each pixel's color
  // scaled with it, so the thin parts go dark and the dense ones light without the hues getting louder.
  const lum = (i: number) => 0.2126 * even[i]! + 0.7152 * even[i + 1]! + 0.0722 * even[i + 2]!;
  const hist = new Uint32Array(1024);
  for (let i = 0; i < even.length; i += 3) hist[Math.max(0, Math.min(1023, Math.round(lum(i) * 2)))]!++;
  const pct = (p: number) => {
    let n = 0;
    for (let i = 0; i < 1024; i++) if ((n += hist[i]!) >= p * size * size) return i / 2;
    return 511.5;
  };
  const lo = pct(0.02), hi = Math.max(lo + 8, pct(0.98));
  const out = Buffer.alloc(px.length);
  for (let i = 0; i < even.length; i += 3) {
    const l = lum(i), f = (Math.max(0, Math.min(1, (l - lo) / (hi - lo))) * 255) / Math.max(1, l);
    for (let ch = 0; ch < 3; ch++) out[i + ch] = Math.max(0, Math.min(255, Math.round(even[i + ch]! * f)));
  }
  return out;
}

/**
 * The place's mist, as a finished tile (WebP, RGB; brightness is density): designed by Luna and made from noise
 * (a couple of seconds, no GPU), its design saved so a resumed build makes the same tile.
 */
export async function makeMist(b: MistBrief, draft: Draft, seed: number): Promise<Buffer> {
  const shape = draft.json<{ shape?: MistShape }>('mist')?.shape ?? (await designMist(b));
  draft.saveJson('mist', { shape });
  return mistImage(shape, seed);
}

/**
 * A mist tile from its shape (WebP, RGB). It is made at half size and enlarged: the game draws the mist at half the
 * view's resolution, so the finer pixels would never show, and it takes a quarter of the time.
 */
async function mistImage(shape: MistShape, seed: number): Promise<Buffer> {
  const H = MIST_SIZE / 2, half = mistTile(shape, H, seed);
  const px = await sharp(half, { raw: { width: H, height: H, channels: 3 } }).resize(MIST_SIZE, MIST_SIZE, { kernel: 'lanczos3' }).raw().toBuffer();
  return sharp(flatten(px, MIST_SIZE), { raw: { width: MIST_SIZE, height: MIST_SIZE, channels: 3 } }).webp({ quality: 88 }).toBuffer();
}

const hex = (c: number[]) => `#${c.map((v) => Math.round(Math.max(0, Math.min(255, v))).toString(16).padStart(2, '0')).join('')}`;

/**
 * The light a painting carries: the color of its lit parts (its brightest tenth), of its shadows (its darkest
 * third) and its mean brightness (0..1). Characters drawn over it take this light.
 */
export async function measureLight(image: Buffer): Promise<{ light: string; shade: string; level: number }> {
  const { data } = await sharp(image).resize(256, 256, { fit: 'inside', withoutEnlargement: true }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const n = data.length / 3;
  const lum = new Float32Array(n);
  let sum = 0;
  for (let i = 0; i < n; i++) sum += lum[i] = 0.2126 * data[i * 3]! + 0.7152 * data[i * 3 + 1]! + 0.0722 * data[i * 3 + 2]!;
  const sorted = Float32Array.from(lum).sort();
  const mean = (pick: (l: number) => boolean) => {
    const acc = [0, 0, 0];
    let m = 0;
    for (let i = 0; i < n; i++) {
      if (!pick(lum[i]!)) continue;
      m++;
      for (let ch = 0; ch < 3; ch++) acc[ch]! += data[i * 3 + ch]!;
    }
    return acc.map((v) => v / Math.max(1, m));
  };
  const top = sorted[Math.floor(n * 0.9)]!, bottom = sorted[Math.floor(n * 0.33)]!;
  return { light: hex(mean((l) => l >= top)), shade: hex(mean((l) => l <= bottom)), level: Math.round((sum / n / 255) * 1000) / 1000 };
}
