/**
 * Edge-aware refinement of a soft per-cell reading: a color guided filter (He, Sun, and Tang) with the painting as the
 * guide. Qwen reads the map at about a third of its size, so its edges are soft and a little off; filtered against the
 * painting, the walkable share follows the painted edges (a street curb, a wall face) instead of the cell grid.
 */
import sharp from 'sharp';
import { CELL, type Grid } from './mapgrid.ts';

function box(src: Float32Array, w: number, h: number, r: number): Float32Array {
  // Mean over a (2r+1)² window, clipped at the borders, via an integral image.
  const I = new Float64Array((w + 1) * (h + 1));
  for (let y = 0; y < h; y++) {
    let row = 0;
    for (let x = 0; x < w; x++) {
      row += src[y * w + x]!;
      I[(y + 1) * (w + 1) + x + 1] = I[y * (w + 1) + x + 1]! + row;
    }
  }
  const out = new Float32Array(w * h);
  for (let y = 0; y < h; y++) {
    const y0 = Math.max(0, y - r), y1 = Math.min(h, y + r + 1);
    for (let x = 0; x < w; x++) {
      const x0 = Math.max(0, x - r), x1 = Math.min(w, x + r + 1);
      const s = I[y1 * (w + 1) + x1]! - I[y0 * (w + 1) + x1]! - I[y1 * (w + 1) + x0]! + I[y0 * (w + 1) + x0]!;
      out[y * w + x] = s / ((x1 - x0) * (y1 - y0));
    }
  }
  return out;
}

/** Guided filter of `p` (w×h) with RGB guide channels in 0..1. */
function guidedFilter(R: Float32Array, G: Float32Array, B: Float32Array, p: Float32Array, w: number, h: number, r: number, eps: number): Float32Array {
  const n = w * h, mul = (a: Float32Array, b: Float32Array) => Float32Array.from(a, (v, i) => v * b[i]!);
  const mR = box(R, w, h, r), mG = box(G, w, h, r), mB = box(B, w, h, r), mp = box(p, w, h, r);
  const cRp = box(mul(R, p), w, h, r), cGp = box(mul(G, p), w, h, r), cBp = box(mul(B, p), w, h, r);
  const vRR = box(mul(R, R), w, h, r), vRG = box(mul(R, G), w, h, r), vRB = box(mul(R, B), w, h, r), vGG = box(mul(G, G), w, h, r), vGB = box(mul(G, B), w, h, r), vBB = box(mul(B, B), w, h, r);
  const aR = new Float32Array(n), aG = new Float32Array(n), aB = new Float32Array(n), b = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    const r0 = mR[i]!, g0 = mG[i]!, b0 = mB[i]!;
    const covR = cRp[i]! - r0 * mp[i]!, covG = cGp[i]! - g0 * mp[i]!, covB = cBp[i]! - b0 * mp[i]!;
    const s11 = vRR[i]! - r0 * r0 + eps, s12 = vRG[i]! - r0 * g0, s13 = vRB[i]! - r0 * b0, s22 = vGG[i]! - g0 * g0 + eps, s23 = vGB[i]! - g0 * b0, s33 = vBB[i]! - b0 * b0 + eps;
    // Inverse of the symmetric 3×3 covariance.
    const i11 = s22 * s33 - s23 * s23, i12 = s13 * s23 - s12 * s33, i13 = s12 * s23 - s13 * s22, i22 = s11 * s33 - s13 * s13, i23 = s13 * s12 - s11 * s23, i33 = s11 * s22 - s12 * s12;
    const det = s11 * i11 + s12 * i12 + s13 * i13;
    aR[i] = (i11 * covR + i12 * covG + i13 * covB) / det;
    aG[i] = (i12 * covR + i22 * covG + i23 * covB) / det;
    aB[i] = (i13 * covR + i23 * covG + i33 * covB) / det;
    b[i] = mp[i]! - aR[i]! * r0 - aG[i]! * g0 - aB[i]! * b0;
  }
  const maR = box(aR, w, h, r), maG = box(aG, w, h, r), maB = box(aB, w, h, r), mb = box(b, w, h, r);
  return Float32Array.from(p, (_, i) => maR[i]! * R[i]! + maG[i]! * G[i]! + maB[i]! * B[i]! + mb[i]!);
}

/** Refine soft cells (0..1) on the painting: filtered at `pxm` px per meter over a window of about `rM` meters, averaged back per cell. */
export async function refine(png: Buffer, soft: Float32Array, g: Grid, pxm = 20, rM = 0.5, eps = 0.01): Promise<Float32Array> {
  const cellM = CELL;
  const w = Math.round(g.cols * cellM * pxm), h = Math.round(g.rows * cellM * pxm);
  const { data } = await sharp(png).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer({ resolveWithObject: true });
  const R = new Float32Array(w * h), G = new Float32Array(w * h), B = new Float32Array(w * h);
  for (let i = 0; i < w * h; i++) (R[i] = data[i * 3]! / 255), (G[i] = data[i * 3 + 1]! / 255), (B[i] = data[i * 3 + 2]! / 255);
  // The soft mask brought up to the guide's size (bilinear, from cell centers).
  const k = g.cols / w, p = new Float32Array(w * h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const fx = Math.max(0, Math.min(g.cols - 1, (x + 0.5) * k - 0.5)), fy = Math.max(0, Math.min(g.rows - 1, (y + 0.5) * k - 0.5));
      const x0 = Math.floor(fx), y0 = Math.floor(fy), x1 = Math.min(g.cols - 1, x0 + 1), y1 = Math.min(g.rows - 1, y0 + 1), tx = fx - x0, ty = fy - y0;
      const v = (c: number, r: number) => soft[r * g.cols + c]!;
      p[y * w + x] = (1 - ty) * ((1 - tx) * v(x0, y0) + tx * v(x1, y0)) + ty * ((1 - tx) * v(x0, y1) + tx * v(x1, y1));
    }
  const q = guidedFilter(R, G, B, p, w, h, Math.max(1, Math.round(rM * pxm)), eps);
  const out = new Float32Array(g.cols * g.rows), cnt = new Float32Array(g.cols * g.rows);
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = Math.min(g.rows - 1, Math.floor(y * k)) * g.cols + Math.min(g.cols - 1, Math.floor(x * k));
    out[i]! += q[y * w + x]!;
    cnt[i]!++;
  }
  for (let i = 0; i < out.length; i++) out[i] = out[i]! / Math.max(1, cnt[i]!);
  return out;
}
