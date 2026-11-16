/**
 * Lining a plan up with its painting. An image model asked to redraw a map "with exactly the same layout" keeps the
 * layout but not its exact place: GPT Image 2.5 Sunburst's plans come back shifted by up to a meter and slightly
 * stretched, 2.6 Sunburst's stretched by up to half a meter (docs/experiments/plan-align). Two plans voted per
 * quarter-meter cell then disagree along every thin wall, and the wall is voted away. So each plan is moved back onto
 * the painting before it is read: the painting's and the plan's edges are matched tile by tile, and an affine map
 * (shift, scale, and shear on each axis) is fitted to the tiles' shifts.
 */
import sharp from 'sharp';

/** Plan pixels the search reaches either way (at the plans' 1.4 MP, about 1.7 m on a 3 × 2 tile map). */
const REACH = 32;
/** Tiles across the longer side; the shorter side gets as many as keep them square. */
const TILES = 6;

/** A map from the painting's frame to the plan's, both in plan pixels: x' = ax·[1,x,y], y' = ay·[1,x,y]. */
interface Affine {
  ax: [number, number, number];
  ay: [number, number, number];
}

/** Edge strength (gradient magnitude) of a picture at `w` × `h`, lightly blurred so nearby edges still overlap. */
async function edges(png: Buffer, w: number, h: number): Promise<Float32Array> {
  const { data } = await sharp(png).removeAlpha().resize(w, h, { fit: 'fill' }).greyscale().blur(1).raw().toBuffer({ resolveWithObject: true });
  const e = new Float32Array(w * h);
  for (let y = 1; y < h - 1; y++)
    for (let x = 1; x < w - 1; x++) {
      const i = y * w + x;
      e[i] = Math.hypot(data[i + 1]! - data[i - 1]!, data[i + w]! - data[i - w]!);
    }
  return e;
}

/** Normalized correlation of `a` in a box with `b` shifted by (dx, dy), sampling every `step` pixels. */
function corr(a: Float32Array, b: Float32Array, w: number, h: number, box: number[], dx: number, dy: number, step: number): number {
  const [x0, y0, x1, y1] = box as [number, number, number, number];
  let sab = 0, saa = 0, sbb = 0, sa = 0, sb = 0, n = 0;
  for (let y = Math.max(y0, -dy); y < Math.min(y1, h - dy); y += step)
    for (let x = Math.max(x0, -dx); x < Math.min(x1, w - dx); x += step) {
      const va = a[y * w + x]!, vb = b[(y + dy) * w + x + dx]!;
      (sab += va * vb), (saa += va * va), (sbb += vb * vb), (sa += va), (sb += vb), n++;
    }
  if (n < 16) return -1;
  return (sab - (sa * sb) / n) / Math.sqrt((saa - (sa * sa) / n) * (sbb - (sb * sb) / n) + 1e-9);
}

/** The shift of `b` that best matches `a` in a box: coarse every 2 pixels, then each pixel around the best. */
function bestShift(a: Float32Array, b: Float32Array, w: number, h: number, box: number[]): { dx: number; dy: number; s: number } {
  let best = { dx: 0, dy: 0, s: -Infinity };
  for (let dy = -REACH; dy <= REACH; dy += 2)
    for (let dx = -REACH; dx <= REACH; dx += 2) {
      const s = corr(a, b, w, h, box, dx, dy, 3);
      if (s > best.s) best = { dx, dy, s };
    }
  const c = best;
  best = { ...c, s: -Infinity };
  for (let dy = c.dy - 1; dy <= c.dy + 1; dy++)
    for (let dx = c.dx - 1; dx <= c.dx + 1; dx++) {
      const s = corr(a, b, w, h, box, dx, dy, 1);
      if (s > best.s) best = { dx, dy, s };
    }
  return best;
}

/** Weighted least squares of v ≈ k·[1, x, y]. */
function fit(pts: { x: number; y: number; v: number; wt: number }[]): [number, number, number] {
  const A = [[0, 0, 0], [0, 0, 0], [0, 0, 0]], r = [0, 0, 0];
  for (const p of pts) {
    const f = [1, p.x, p.y];
    for (let i = 0; i < 3; i++) {
      r[i]! += p.wt * f[i]! * p.v;
      for (let j = 0; j < 3; j++) A[i]![j]! += p.wt * f[i]! * f[j]!;
    }
  }
  // Gaussian elimination on the 3 × 3 normal equations.
  for (let i = 0; i < 3; i++) {
    let m = i;
    for (let k = i + 1; k < 3; k++) if (Math.abs(A[k]![i]!) > Math.abs(A[m]![i]!)) m = k;
    [A[i], A[m]] = [A[m]!, A[i]!];
    [r[i], r[m]] = [r[m]!, r[i]!];
    if (Math.abs(A[i]![i]!) < 1e-12) return [0, 0, 0];
    for (let k = i + 1; k < 3; k++) {
      const f = A[k]![i]! / A[i]![i]!;
      for (let j = i; j < 3; j++) A[k]![j]! -= f * A[i]![j]!;
      r[k]! -= f * r[i]!;
    }
  }
  const k = [0, 0, 0];
  for (let i = 2; i >= 0; i--) {
    let s = r[i]!;
    for (let j = i + 1; j < 3; j++) s -= A[i]![j]! * k[j]!;
    k[i] = s / A[i]![i]!;
  }
  return k as [number, number, number];
}

/** Per tile of the plan, the shift of its edges that best matches the painting's, and how well it matched. */
async function tileShifts(painting: Buffer, plan: Buffer, across = TILES) {
  const { width: w, height: h } = (await sharp(plan).metadata()) as { width: number; height: number };
  const [A, B] = await Promise.all([edges(painting, w, h), edges(plan, w, h)]);
  const side = Math.max(w, h) / across, tx = Math.max(1, Math.round(w / side)), ty = Math.max(1, Math.round(h / side));
  const tiles: { x: number; y: number; dx: number; dy: number; s: number }[] = [];
  for (let j = 0; j < ty; j++)
    for (let i = 0; i < tx; i++) {
      const box = [Math.round((i * w) / tx), Math.round((j * h) / ty), Math.round(((i + 1) * w) / tx), Math.round(((j + 1) * h) / ty)];
      const s = bestShift(A, B, w, h, box);
      tiles.push({ x: (box[0]! + box[2]!) / 2, y: (box[1]! + box[3]!) / 2, ...s });
    }
  return { w, h, tx, ty, tiles };
}

/**
 * Where the plan lies against the painting: an affine map fitted to the tiles' shifts, weighted by how well each tile
 * matched. Tiles that match poorly (plain floor, or edges the plan leaves out) and tiles far off the first fit are left
 * out of the second.
 */
export async function planFrame(painting: Buffer, plan: Buffer): Promise<Affine> {
  const { tiles } = await tileShifts(painting, plan);
  const solve = (use: typeof tiles): Affine => {
    const wt = (t: (typeof tiles)[number]) => Math.max(0, t.s) ** 2;
    const ax = fit(use.map((t) => ({ x: t.x, y: t.y, v: t.dx, wt: wt(t) })));
    const ay = fit(use.map((t) => ({ x: t.x, y: t.y, v: t.dy, wt: wt(t) })));
    return { ax: [ax[0], 1 + ax[1], ax[2]], ay: [ay[0], ay[1], 1 + ay[2]] };
  };
  const good = tiles.filter((t) => t.s > 0.1);
  if (good.length < 4) return { ax: [0, 1, 0], ay: [0, 0, 1] };
  const first = solve(good);
  const off = (t: (typeof tiles)[number]) => Math.hypot(first.ax[0] + first.ax[1] * t.x + first.ax[2] * t.y - (t.x + t.dx), first.ay[0] + first.ay[1] * t.x + first.ay[2] * t.y - (t.y + t.dy));
  const kept = good.filter((t) => off(t) <= 3);
  return kept.length >= 4 ? solve(kept) : first;
}

/** The plan redrawn in the painting's frame (nearest pixel, so its flat colors stay flat; outside it is transparent). */
export async function alignPlan(painting: Buffer, plan: Buffer): Promise<Buffer> {
  const f = await planFrame(painting, plan);
  const { data, info } = await sharp(plan).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, out = Buffer.alloc(w * h * 4);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const sx = Math.round(f.ax[0] + f.ax[1] * x + f.ax[2] * y), sy = Math.round(f.ay[0] + f.ay[1] * x + f.ay[2] * y);
      if (sx < 0 || sy < 0 || sx >= w || sy >= h) continue;
      data.copy(out, (y * w + x) * 4, (sy * w + sx) * 4, (sy * w + sx) * 4 + 4);
    }
  return sharp(out, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
}
