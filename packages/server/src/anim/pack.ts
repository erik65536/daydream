/**
 * Packing a rendered clip sheet (a full cell per frame, a row per direction) into the saved layout (see shared
 * world/anim.ts): each direction keeps only the box its frames ever touch, as a strip of frames a few lines deep
 * when long. Most of a cell is empty (it holds the widest reach of any clip in any direction), so a packed sheet
 * is about a third of the pixels: the game decodes and holds far less.
 */
import sharp from 'sharp';
import { SHEET_PAD, type SheetRow } from '@daydream/shared';

/** Widest and tallest a packed sheet gets (pixels), well inside every GPU's texture limit. */
const MAX_WIDTH = 4096;
const MAX_HEIGHT = 8192;

export interface PackedSheet {
  webp: Buffer;
  width: number;
  height: number;
  rows: SheetRow[];
}

/** Pack a sheet of `frames` columns and 8 direction rows of `cell` pixels each (any image sharp reads). */
export async function packSheet(image: Buffer, cell: [number, number], frames: number): Promise<PackedSheet> {
  const { data, info } = await sharp(image).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const [cw, ch] = cell, P = SHEET_PAD;
  if (info.width < cw * frames || info.height < ch * 8) throw new Error(`sheet is ${info.width}x${info.height}, expected ${cw * frames}x${ch * 8}`);
  // Each direction's box: everything any of its frames draws.
  const boxes = Array.from({ length: 8 }, (_, r) => {
    let x0 = cw, y0 = ch, x1 = -1, y1 = -1;
    for (let f = 0; f < frames; f++)
      for (let y = 0; y < ch; y++) {
        const o = ((r * ch + y) * info.width + f * cw) * 4 + 3;
        for (let x = 0; x < cw; x++)
          if (data[o + x * 4]) {
            if (x < x0) x0 = x;
            if (x > x1) x1 = x;
            if (y < y0) y0 = y;
            if (y > y1) y1 = y;
          }
      }
    return x1 < 0 ? { x: 0, y: 0, w: 0, h: 0 } : { x: x0, y: y0, w: x1 - x0 + 1, h: y1 - y0 + 1 };
  });
  // One width for the sheet, each direction's strip wrapping to fit it: the width that wastes least (and keeps the
  // sheet short enough).
  const layout = (width: number) => {
    let height = 0;
    const rows = boxes.map((b): SheetRow => {
      const cols = Math.max(1, Math.min(frames, Math.floor(width / (b.w + 2 * P))));
      const row: SheetRow = [height, b.w, b.h, b.x, b.y, cols];
      height += Math.ceil(frames / cols) * (b.h + 2 * P);
      return row;
    });
    return { width, height: Math.max(1, height), rows };
  };
  const widest = Math.max(...boxes.map((b) => b.w + 2 * P));
  const fits = (l: { height: number }) => l.height <= MAX_HEIGHT;
  let best = layout(widest);
  for (const b of boxes)
    for (let c = 1; c <= frames && c * (b.w + 2 * P) <= MAX_WIDTH; c++) {
      const l = layout(Math.max(widest, c * (b.w + 2 * P)));
      if ((fits(l) && !fits(best)) || (fits(l) === fits(best) && l.width * l.height < best.width * best.height)) best = l;
    }
  const { width, height, rows } = best;
  const out = Buffer.alloc(width * height * 4);
  rows.forEach(([y, w, h, dx, dy, cols], r) => {
    for (let f = 0; f < frames; f++) {
      const sx = P + (f % cols) * (w + 2 * P), sy = y + P + Math.floor(f / cols) * (h + 2 * P);
      for (let j = 0; j < h; j++) {
        const from = ((r * ch + dy + j) * info.width + f * cw + dx) * 4;
        data.copy(out, ((sy + j) * width + sx) * 4, from, from + w * 4);
      }
    }
  });
  const webp = await sharp(out, { raw: { width, height, channels: 4 } }).webp({ quality: 92, alphaQuality: 100, effort: 5 }).toBuffer();
  return { webp, width, height, rows };
}
