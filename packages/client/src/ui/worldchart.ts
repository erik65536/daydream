/**
 * The land of the world map, built once per world: each place owns an organic territory filled with its own ground
 * painting, shaded toward its borders and inked along borders and coast, under a unifying wash and paper grain. It
 * does not depend on what the party knows (worldmap.tsx lays fog, roads and faded places over it each time the map
 * opens), so it is built once, off the game's thread (worldchart.worker.ts) where the browser allows.
 *
 * Only OffscreenCanvas and plain pixel work: no canvas filters, which Safari has long lacked.
 */

export const MAP_W = 880;
export const MAP_H = 540;
const PAD = 70;
/** Territory grid resolution (px per cell). */
export const CELL = 3;

export const mapPos = (p: { x: number; y: number }) => ({ x: PAD + p.x * (MAP_W - PAD * 2), y: PAD * 0.8 + p.y * (MAP_H - PAD * 1.6) });

// ---------------------------------------------------------------------------- noise

export function hash(x: number, y: number, s: number) {
  let h = (x * 374761393 + y * 668265263 + s * 2147483647) | 0;
  h = Math.imul(h ^ (h >>> 13), 1274126177);
  return ((h ^ (h >>> 16)) >>> 0) / 4294967295;
}
function vnoise(x: number, y: number, s: number) {
  const xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi;
  const u = xf * xf * (3 - 2 * xf), v = yf * yf * (3 - 2 * yf);
  const a = hash(xi, yi, s), b = hash(xi + 1, yi, s), c = hash(xi, yi + 1, s), d = hash(xi + 1, yi + 1, s);
  return a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v;
}
export const fbm = (x: number, y: number, s: number) => vnoise(x, y, s) * 0.55 + vnoise(x * 2.1, y * 2.1, s + 7) * 0.3 + vnoise(x * 4.3, y * 4.3, s + 13) * 0.15;
export const seedOf = (id: string) => [...id].reduce((h, c) => (h * 31 + c.charCodeAt(0)) | 0, 7) & 0xffff;

// ---------------------------------------------------------------------------- the build

export interface ChartInput {
  seed: number;
  /** Places in map order: where each sits (0..1) and the absolute address of its ground painting. */
  places: { at: { x: number; y: number }; painting?: string }[];
  /** Device pixels per map pixel. */
  dpr: number;
}

export interface ChartBase {
  gw: number;
  gh: number;
  /** Which place owns each grid cell (-1 for sea). */
  owner: Int16Array;
  /** The land in full color, for visited places. */
  land: ImageBitmap;
  /** The same land faded, for places only heard of. */
  faded: ImageBitmap;
}

const canvas = (w: number, h: number) => new OffscreenCanvas(Math.max(1, Math.round(w)), Math.max(1, Math.round(h)));

export async function buildChart({ seed, places, dpr }: ChartInput): Promise<ChartBase> {
  const pts = places.map((p) => mapPos(p.at));
  const t = territories(pts, seed);
  const paintings = await Promise.all(places.map((p) => (p.painting ? loadPainting(p.painting) : Promise.resolve(null))));
  const W = MAP_W * dpr, H = MAP_H * dpr;
  const land = canvas(W, H);
  const ctx = land.getContext('2d')!;
  ctx.scale(dpr, dpr);
  ctx.imageSmoothingEnabled = true;
  ctx.imageSmoothingQuality = 'high';

  // Sea: deep ink with a faint swell.
  const sea = ctx.createRadialGradient(MAP_W / 2, MAP_H / 2, 40, MAP_W / 2, MAP_H / 2, MAP_W * 0.7);
  sea.addColorStop(0, '#15171a');
  sea.addColorStop(1, '#08090b');
  ctx.fillStyle = sea;
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  // Each territory: the place's own painting, covering the territory's bounds, masked to its shape.
  const { gw, gh, owner, edge, inland } = t;
  const tile = canvas(W, H);
  const tc = tile.getContext('2d')!;
  tc.scale(dpr, dpr);
  tc.imageSmoothingEnabled = true;
  for (let i = 0; i < places.length; i++) {
    tc.globalCompositeOperation = 'source-over';
    tc.clearRect(0, 0, MAP_W, MAP_H);
    const img = paintings[i];
    const b = t.bounds[i];
    if (!b) continue;
    if (img) {
      const bx = b.x0 * CELL, by = b.y0 * CELL, bw = (b.x1 - b.x0 + 1) * CELL, bh = (b.y1 - b.y0 + 1) * CELL;
      const s = Math.max(bw / img.width, bh / img.height);
      tc.drawImage(img, bx + (bw - img.width * s) / 2, by + (bh - img.height * s) / 2, img.width * s, img.height * s);
    } else {
      tc.fillStyle = '#4a4a44';
      tc.fillRect(0, 0, MAP_W, MAP_H);
    }
    tc.globalCompositeOperation = 'destination-in';
    tc.drawImage(maskOf(t, (o) => o === i), 0, 0, MAP_W, MAP_H);
    ctx.drawImage(tile, 0, 0, MAP_W, MAP_H);
  }

  // Shading: darker toward borders, lighter in the heart of each place; ink along borders and the coast.
  const shade = new ImageData(gw, gh);
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const k = gy * gw + gx;
      const o = owner[k]!;
      if (o < 0) {
        // Shallow water glow just off the coast.
        const near = (gx > 2 && owner[k - 3]! >= 0) || (gx < gw - 3 && owner[k + 3]! >= 0) || (gy > 2 && owner[k - 3 * gw]! >= 0) || (gy < gh - 3 && owner[k + 3 * gw]! >= 0);
        if (near) shade.data.set([120, 140, 150, 34], k * 4);
        continue;
      }
      const border = (gx < gw - 1 && owner[k + 1] !== o) || (gy < gh - 1 && owner[k + gw] !== o) || (gx > 0 && owner[k - 1] !== o) || (gy > 0 && owner[k - gw] !== o);
      const coast = border && ((gx < gw - 1 && owner[k + 1]! < 0) || (gy < gh - 1 && owner[k + gw]! < 0) || (gx > 0 && owner[k - 1]! < 0) || (gy > 0 && owner[k - gw]! < 0));
      let a = Math.max(0, 1 - edge[k]! / 26) * 0.45 + Math.max(0, 1 - inland[k]! / 30) * 0.5;
      if (border) a = coast ? 0.95 : 0.7;
      shade.data.set(coast ? [18, 15, 12, Math.min(255, a * 255)] : [22, 18, 14, Math.min(255, a * 255)], k * 4);
    }
  const sc = canvas(gw, gh);
  sc.getContext('2d')!.putImageData(shade, 0, 0);
  ctx.drawImage(sc, 0, 0, MAP_W, MAP_H);

  // A unifying wash and paper grain, so different art reads as one chart.
  ctx.save();
  ctx.globalCompositeOperation = 'soft-light';
  ctx.fillStyle = 'rgba(205, 180, 135, 0.35)';
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.restore();
  ctx.fillStyle = ctx.createPattern(grain(seed), 'repeat')!;
  ctx.fillRect(0, 0, MAP_W, MAP_H);

  const faded = canvas(W, H);
  const fctx = faded.getContext('2d')!;
  fctx.drawImage(land, 0, 0);
  // Known but unvisited places read like a hearsay sketch: mostly gray and darker.
  const px = fctx.getImageData(0, 0, faded.width, faded.height);
  const d = px.data;
  for (let i = 0; i < d.length; i += 4) {
    const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    d[i] = (d[i]! * 0.3 + l * 0.7) * 0.6;
    d[i + 1] = (d[i + 1]! * 0.3 + l * 0.7) * 0.6;
    d[i + 2] = (d[i + 2]! * 0.3 + l * 0.7) * 0.6;
  }
  fctx.putImageData(px, 0, 0);
  return { gw, gh, owner, land: land.transferToImageBitmap(), faded: faded.transferToImageBitmap() };
}

// ---------------------------------------------------------------------------- territories

interface Territories {
  gw: number;
  gh: number;
  owner: Int16Array;
  /** How far inside its territory a cell is (distance to the next place minus to its own), in px. */
  edge: Float32Array;
  /** How far inside the land a cell is, in px (for the coast). */
  inland: Float32Array;
  /** Each place's territory bounds in cells (undefined when it owns none). */
  bounds: ({ x0: number; y0: number; x1: number; y1: number } | undefined)[];
}

function territories(pts: { x: number; y: number }[], seed: number): Territories {
  const gw = Math.ceil(MAP_W / CELL), gh = Math.ceil(MAP_H / CELL);
  const owner = new Int16Array(gw * gh).fill(-1);
  const edge = new Float32Array(gw * gh);
  const inland = new Float32Array(gw * gh);
  const bounds: Territories['bounds'] = pts.map(() => undefined);
  // How far land reaches from a place: about half the typical spacing between neighbors.
  let spacing = 0;
  for (const p of pts) spacing += Math.min(...pts.filter((q) => q !== p).map((q) => Math.hypot(p.x - q.x, p.y - q.y)), 400);
  const reach = Math.max(70, Math.min(150, (spacing / Math.max(1, pts.length)) * 0.95));
  for (let gy = 0; gy < gh; gy++)
    for (let gx = 0; gx < gw; gx++) {
      const x = gx * CELL, y = gy * CELL;
      // Warp the sample point so borders and coasts wander like real ones.
      const wx = x + (fbm(x / 90, y / 90, seed) - 0.5) * 70;
      const wy = y + (fbm(x / 90, y / 90, seed + 101) - 0.5) * 70;
      let d1 = Infinity, d2 = Infinity, i1 = -1;
      for (let i = 0; i < pts.length; i++) {
        const d = Math.hypot(wx - pts[i]!.x, wy - pts[i]!.y);
        if (d < d1) {
          d2 = d1;
          d1 = d;
          i1 = i;
        } else if (d < d2) d2 = d;
      }
      const coast = reach * (0.75 + fbm(x / 60, y / 60, seed + 202) * 0.5);
      if (d1 >= coast) continue;
      const k = gy * gw + gx;
      owner[k] = i1;
      edge[k] = (d2 - d1) / 2;
      inland[k] = coast - d1;
      const b = bounds[i1];
      if (!b) bounds[i1] = { x0: gx, y0: gy, x1: gx, y1: gy };
      else {
        if (gx < b.x0) b.x0 = gx;
        if (gx > b.x1) b.x1 = gx;
        if (gy > b.y1) b.y1 = gy;
      }
    }
  return { gw, gh, owner, edge, inland, bounds };
}

/** A grid-sized mask of the cells `pick` accepts (drawn scaled up, the smoothing softens its steps). */
export function maskOf(t: { gw: number; gh: number; owner: Int16Array }, pick: (owner: number) => boolean): OffscreenCanvas {
  const md = new ImageData(t.gw, t.gh);
  for (let k = 0; k < t.owner.length; k++) if (pick(t.owner[k]!)) md.data[k * 4 + 3] = 255;
  const m = canvas(t.gw, t.gh);
  m.getContext('2d')!.putImageData(md, 0, 0);
  return m;
}

// ---------------------------------------------------------------------------- paintings

/**
 * A place's painting at the size the chart needs (the full one is thousands of pixels), brought to a common mid tone
 * so a white carpet and a black cave both read as land, and a little less saturated so the chart reads as one.
 */
async function loadPainting(url: string): Promise<OffscreenCanvas | null> {
  try {
    const res = await fetch(url, { credentials: 'same-origin' });
    if (!res.ok) return null;
    const bmp = await createImageBitmap(await res.blob());
    const s = Math.min(1, 512 / Math.max(bmp.width, bmp.height));
    const c = canvas(bmp.width * s, bmp.height * s);
    const x = c.getContext('2d')!;
    x.drawImage(bmp, 0, 0, c.width, c.height);
    bmp.close();
    const px = x.getImageData(0, 0, c.width, c.height);
    const d = px.data;
    let sum = 0;
    for (let i = 0; i < d.length; i += 4) sum += 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
    const tone = Math.max(0.45, Math.min(1.8, 0.42 / Math.max(0.05, sum / (d.length / 4) / 255)));
    for (let i = 0; i < d.length; i += 4) {
      const l = 0.2126 * d[i]! + 0.7152 * d[i + 1]! + 0.0722 * d[i + 2]!;
      // saturate(0.8), then brightness(tone).
      d[i] = (l + (d[i]! - l) * 0.8) * tone;
      d[i + 1] = (l + (d[i + 1]! - l) * 0.8) * tone;
      d[i + 2] = (l + (d[i + 2]! - l) * 0.8) * tone;
    }
    x.putImageData(px, 0, 0);
    return c;
  } catch {
    return null;
  }
}

/** A small tile of paper grain (repeated: a full-size one costs half a million random numbers for the same look). */
function grain(seed: number): OffscreenCanvas {
  const n = 128;
  const g = new ImageData(n, n);
  for (let i = 0; i < n * n; i++) {
    const v = hash(i % n, (i / n) | 0, seed) * 255;
    g.data.set([v, v, v, 10], i * 4);
  }
  const c = canvas(n, n);
  c.getContext('2d')!.putImageData(g, 0, 0);
  return c;
}
