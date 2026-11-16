/**
 * Cutting characters, objects, and icons out of their painting. The painter paints each one on a plain chroma-key
 * backdrop (picked per subject by the prompt writer, the key the subject uses least), and the classic chroma key cuts
 * it out, with no cutter model:
 *
 *  - the backdrop's color field B is estimated from the pixels joined to the image border;
 *  - a color's key strength is how far the key's own channel exceeds the others (green: G - max(R, B); blue:
 *    B - max(R, G); magenta: min(R, B) - G), and a pixel's opacity is 1 - its strength / the backdrop's there. Smoke,
 *    steam, glass, a spider's thread, and the middle of a ring come out as they should, see-through or open;
 *  - the backdrop's own shadows (C ≈ s·B) count as backdrop, and opacity under CLIP is the backdrop's grain;
 *  - the backdrop is un-mixed from see-through pixels, F = (C - (1-a)·B) / a, and any color still lying along the
 *    backdrop's hue is removed from them: a painter paints what shows through glass or steam pinker than a true mix
 *    of a magenta backdrop would be. Opaque pixels keep their color, so a red cork on magenta stays red;
 *  - the score: the key cannot judge a dull backdrop, nor a subject that carries the key's own hue. The key then reads
 *    part of the subject as see-through and the un-mixing overshoots into the key's opposite (a lavender ghost on
 *    magenta comes out teal); that is a clash, and the next attempt paints on another key.
 */
import sharp from 'sharp';

/** The chroma-key backdrops, as image models render them reliably (named with their exact color). */
export const KEY_COLORS = {
  green: { name: 'pure chroma-key green (#00b140)', hex: '#00b140' },
  blue: { name: 'pure chroma-key blue (#0047bb)', hex: '#0047bb' },
  magenta: { name: 'pure bright magenta (#ff00ff)', hex: '#ff00ff' },
} as const;
export type KeyColor = keyof typeof KEY_COLORS;
export const KEY_NAMES = Object.keys(KEY_COLORS) as [KeyColor, ...KeyColor[]];

/** Ends every asset prompt. */
export const backdropSentence = (key: KeyColor) =>
  `The subject is isolated on a perfectly plain, flat, evenly lit ${KEY_COLORS[key].name} studio background that fills the whole frame from edge to edge, with nothing else in the image.`;

/** Gates of the score: the backdrop's key strength (0–255, its median), and the share of the cut that is a clash. */
export const LIMITS = { strength: 25, clash: 0.02 };
/** Opacity below this is the backdrop's grain. */
const CLIP = 0.06;
/** A see-through pixel whose un-mixed color lies this far (0–255) opposite the backdrop's hue is a clash. */
const OVERSHOOT = 40;

export interface Cutout {
  /** Full-size RGBA, the backdrop un-mixed from see-through pixels. */
  data: Buffer;
  width: number;
  height: number;
  /** The key the backdrop was read as. */
  key: KeyColor;
  /** The backdrop is strong enough for the key to judge. */
  judgeable: boolean;
  /** Opacity the key read as see-through but whose color overshot to the key's opposite, as a share of all opacity. */
  clash: number;
}

interface RGB {
  w: number;
  h: number;
  d: Float32Array;
}

/**
 * The backdrop's color field: the border's median color, refined from the pixels near it that join the border
 * (so subject colors close to it are not taken for backdrop) away from `exclude`, and filled in behind the
 * subject by diffusion on a coarse grid.
 */
function backdropField(img: RGB, exclude: Uint8Array) {
  const { w, h, d } = img;
  const N = w * h;
  const border: number[][] = [[], [], []];
  const sampleBorder = (x: number, y: number) => {
    for (let c = 0; c < 3; c++) border[c]!.push(d[(y * w + x) * 3 + c]!);
  };
  for (let x = 0; x < w; x += 2) for (const y of [0, 1, h - 2, h - 1]) sampleBorder(x, y);
  for (let y = 0; y < h; y += 2) for (const x of [0, 1, w - 2, w - 1]) sampleBorder(x, y);
  const med = border.map((v) => v.sort((a, b) => a - b)[v.length >> 1]!) as [number, number, number];
  const distMed = (k: number) => Math.hypot(d[k * 3]! - med[0], d[k * 3 + 1]! - med[1], d[k * 3 + 2]! - med[2]);
  const near = (k: number) => !exclude[k] && distMed(k) < 45;
  const conn = new Uint8Array(N);
  const stack: number[] = [];
  const seed = (k: number) => {
    if (!conn[k] && near(k)) (conn[k] = 1), stack.push(k);
  };
  for (let x = 0; x < w; x++) seed(x), seed((h - 1) * w + x);
  for (let y = 0; y < h; y++) seed(y * w), seed(y * w + w - 1);
  while (stack.length) {
    const k = stack.pop()!;
    const x = k % w;
    if (x > 0) seed(k - 1);
    if (x < w - 1) seed(k + 1);
    if (k >= w) seed(k - w);
    if (k < N - w) seed(k + w);
  }
  const G = 16, gw = Math.ceil(w / G), gh = Math.ceil(h / G);
  const sum = new Float32Array(gw * gh * 3), cnt = new Float32Array(gw * gh);
  const dev: number[] = [];
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x;
      if (!conn[k]) continue;
      const gk = ((y / G) | 0) * gw + ((x / G) | 0);
      for (let c = 0; c < 3; c++) sum[gk * 3 + c] += d[k * 3 + c]!;
      cnt[gk]++;
      if ((x < 4 || y < 4 || x >= w - 4 || y >= h - 4) && (x + y) % 3 === 0) dev.push(distMed(k));
    }
  dev.sort((a, b) => a - b);
  const noise = Math.max(6, dev.length ? dev[Math.floor(dev.length * 0.9)]! : 8);
  const known = new Uint8Array(gw * gh);
  const grid = new Float32Array(gw * gh * 3);
  for (let i = 0; i < gw * gh; i++) {
    known[i] = cnt[i]! >= G * G * 0.25 ? 1 : 0;
    for (let c = 0; c < 3; c++) grid[i * 3 + c] = known[i] ? sum[i * 3 + c]! / cnt[i]! : med[c]!;
  }
  for (let it = 0; it < 400; it++)
    for (let gy = 0; gy < gh; gy++)
      for (let gx = 0; gx < gw; gx++) {
        const i = gy * gw + gx;
        if (known[i]) continue;
        for (let c = 0; c < 3; c++) {
          let s = 0, n = 0;
          if (gx > 0) (s += grid[(i - 1) * 3 + c]!), n++;
          if (gx < gw - 1) (s += grid[(i + 1) * 3 + c]!), n++;
          if (gy > 0) (s += grid[(i - gw) * 3 + c]!), n++;
          if (gy < gh - 1) (s += grid[(i + gw) * 3 + c]!), n++;
          grid[i * 3 + c] = s / n;
        }
      }
  const B = new Float32Array(N * 3);
  for (let y = 0; y < h; y++) {
    const fy = Math.min(gh - 1, Math.max(0, (y + 0.5) / G - 0.5));
    const y0 = Math.floor(fy), y1 = Math.min(gh - 1, y0 + 1), ty = fy - y0;
    for (let x = 0; x < w; x++) {
      const fx = Math.min(gw - 1, Math.max(0, (x + 0.5) / G - 0.5));
      const x0 = Math.floor(fx), x1 = Math.min(gw - 1, x0 + 1), tx = fx - x0;
      for (let c = 0; c < 3; c++)
        B[(y * w + x) * 3 + c] = (1 - ty) * ((1 - tx) * grid[(y0 * gw + x0) * 3 + c]! + tx * grid[(y0 * gw + x1) * 3 + c]!) + ty * ((1 - tx) * grid[(y1 * gw + x0) * 3 + c]! + tx * grid[(y1 * gw + x1) * 3 + c]!);
    }
  }
  return { B, noise, chroma: Math.max(...med) - Math.min(...med) };
}

/** The key a backdrop color is: its strongest channel (magenta's red outweighs its blue). */
function keyOf(r: number, g: number, b: number): KeyColor {
  return g >= r && g >= b ? 'green' : b >= r ? 'blue' : 'magenta';
}

/** A color's key strength: how far the key's own channel (magenta: the weaker of red and blue) exceeds the others. */
const STRENGTH: Record<KeyColor, (r: number, g: number, b: number) => number> = {
  green: (r, g, b) => g - Math.max(r, b),
  blue: (r, g, b) => b - Math.max(r, g),
  magenta: (r, g, b) => Math.min(r, b) - g,
};

/** Cut a painting out of its chroma-key backdrop (any alpha the painting has is ignored). */
export async function cutout(png: Buffer): Promise<Cutout> {
  const { data: raw, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, N = w * h;
  const d = Float32Array.from(raw);
  const { B } = backdropField({ w, h, d }, new Uint8Array(N));
  let sr = 0, sg = 0, sb = 0;
  for (let k = 0; k < N; k++) (sr += B[k * 3]!), (sg += B[k * 3 + 1]!), (sb += B[k * 3 + 2]!);
  const key = keyOf(sr, sg, sb), strength = STRENGTH[key];

  const out = Buffer.alloc(N * 4);
  const v = [0, 0, 0], u = [0, 0, 0];
  const strengths = new Float32Array(N);
  let opacity = 0, clashed = 0;
  for (let k = 0; k < N; k++) {
    const r = d[k * 3]!, g = d[k * 3 + 1]!, b = d[k * 3 + 2]!;
    const R = B[k * 3]!, G = B[k * 3 + 1]!, Bb = B[k * 3 + 2]!;
    const sB = strength(R, G, Bb);
    strengths[k] = sB;
    let a = Math.min(1, Math.max(0, 1 - strength(r, g, b) / Math.max(1, sB)));
    // The backdrop's own shadow or light falloff: C ≈ s·B.
    const s = (r * R + g * G + b * Bb) / (R * R + G * G + Bb * Bb);
    if (s > 0.5 && s < 1.05 && Math.hypot(r - s * R, g - s * G, b - s * Bb) < 3 + 0.07 * s * Math.hypot(R, G, Bb)) a = 0;
    if (a < CLIP) a = 0;
    v[0] = r, v[1] = g, v[2] = b;
    if (a > 0 && a < 0.98) {
      for (let c = 0; c < 3; c++) v[c] = (d[k * 3 + c]! - (1 - a) * B[k * 3 + c]!) / a;
      // The backdrop's hue (its color minus its gray) as a unit vector; what lies along it is spill, what lies far
      // opposite it is the key misreading the subject's own color.
      const m = (R + G + Bb) / 3, n = Math.hypot(R - m, G - m, Bb - m) || 1;
      (u[0] = (R - m) / n), (u[1] = (G - m) / n), (u[2] = (Bb - m) / n);
      const vm = (v[0]! + v[1]! + v[2]!) / 3, along = (v[0]! - vm) * u[0]! + (v[1]! - vm) * u[1]! + (v[2]! - vm) * u[2]!;
      if (along > 0) for (let c = 0; c < 3; c++) v[c]! -= along * u[c]!;
      else if (along < -OVERSHOOT) clashed += a;
    }
    opacity += a;
    for (let c = 0; c < 3; c++) out[k * 4 + c] = Math.max(0, Math.min(255, Math.round(v[c]!)));
    out[k * 4 + 3] = Math.round(a * 255);
  }
  const median = strengths.sort()[N >> 1]!;
  return { data: out, width: w, height: h, key, judgeable: median >= LIMITS.strength, clash: clashed / Math.max(1, opacity) };
}

/** What the score says is wrong with a cutout (empty when it passes). */
export function cutoutProblems(c: Cutout): string[] {
  if (!c.judgeable) return ['the backdrop is too dull to key'];
  if (c.clash > LIMITS.clash) return ['the backdrop color clashes with the subject'];
  return [];
}

export interface FinishedImage {
  png: Buffer;
  width: number;
  height: number;
  /** Where the subject stands, as a share of the image height from the top. */
  anchorY: number;
  /** Problems that call for another attempt. */
  problems: string[];
  /** Softer concerns that lower the score. */
  notes: string[];
}

/** Trim a cutout to its subject (with a small margin) and scale it to at most `maxHeight`; check its framing. */
export async function finishCutout(c: Cutout, maxHeight: number): Promise<FinishedImage> {
  const { data, width: w, height: h } = c;
  let x0 = w, y0 = h, x1 = -1, y1 = -1, solid = 0, luma = 0;
  let edge = 0;
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const k = y * w + x, a = data[k * 4 + 3]!;
      if (a < 24) continue;
      if (x < x0) x0 = x;
      if (x > x1) x1 = x;
      if (y < y0) y0 = y;
      if (y > y1) y1 = y;
      if (a > 200) (solid++, (luma += 0.2126 * data[k * 4]! + 0.7152 * data[k * 4 + 1]! + 0.0722 * data[k * 4 + 2]!));
      if (a > 100 && (x === 0 || y === 0 || x === w - 1 || y === h - 1)) edge++;
    }
  const problems: string[] = [], notes: string[] = [];
  if (x1 < 0) return { png: await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer(), width: w, height: h, anchorY: 0.97, problems: ['no subject found'], notes };
  if (solid / (w * h) < 0.02) problems.push('subject too small');
  if (edge > (w + h) * 0.04) problems.push('subject is cut off by the image border');
  if (luma / Math.max(1, solid) < 30) notes.push('subject is very dark and may not read on the map');
  const pad = Math.round(Math.max(x1 - x0, y1 - y0) * 0.02) + 2;
  const left = Math.max(0, x0 - pad), top = Math.max(0, y0 - pad);
  const cw = Math.min(w - 1, x1 + pad) - left + 1, ch = Math.min(h - 1, y1 + pad) - top + 1;
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } })
    .extract({ left, top, width: cw, height: ch })
    .resize({ height: Math.min(maxHeight, ch), withoutEnlargement: true, kernel: 'lanczos3' })
    .png()
    .toBuffer();
  const m = await sharp(png).metadata();
  return { png, width: m.width ?? cw, height: m.height ?? ch, anchorY: (y1 - top + 0.5) / ch, problems, notes };
}
