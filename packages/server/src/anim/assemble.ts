/**
 * From the painted sheets to the clip sheets the game plays (see shared world/anim.ts). The model places and sizes
 * each frame a little differently, so frames are steadied:
 *  - one scale for the whole actor, from the painting: its standing figure is drawn as tall as the still sprite;
 *  - each clip sheet sized to match: the model paints the frames larger than the figure it was shown (by up to
 *    80%, differently each time), so a sheet's move frames are given its view's standing figure's height (not its
 *    area: a stride and a swinging arm cover a third more of it in a side view, and matching that shrank the walk);
 *  - each move frame given its row's height, within 15%; an attack or hit row sized so its last frame, the recovery,
 *    is as tall as the move, within 10%, its frames keeping their own heights (a crouch is lower); a death keeps its
 *    sheet's scale;
 *  - things that stand: the feet (lowest solid row) on the ground point and the upper body's center over it;
 *    things that float: the figure's center half its standing height above the ground point.
 * The idle is one standing frame per view (its breath is drawn in code). Directions not painted stay empty: the game
 * mirrors the west-facing ones for the east and plays the nearest painted one for the rest.
 */
import sharp, { type OverlayOptions } from 'sharp';
import { ANIM_DIRS, PX_PER_METER, floats as floating, type ActorAnim, type AnimClip, type ClipName, type Locomotion } from '@daydream/shared';
import { packSheet, type PackedSheet } from './pack.ts';
import { gridOf, SHEET_FRAMES, type ClipRow, type View } from './paint.ts';

/** Sheet pixels per game picture pixel, and the standing figure's height in meters (as still sprites are drawn). */
const SCALE = 2;
const ACTOR_HEIGHT = 1.75;

/** Game clips painted from each motion of the brief, with their timing. */
const CLIPS: Record<ClipRow, ClipName> = { move: 'walk', attack: 'attack', hit: 'hit', death: 'die' };
const STRIDE: Partial<Record<Locomotion, number>> = { walks: 1.4, hops: 1.2, crawls: 0.9, slithers: 1, rolls: 1, swarms: 0.9 };
/** A clip's timing for its number of frames: a walk cycle lasts two thirds of a second however many it has. */
function timing(c: ClipName, body: Locomotion, frames: number): Omit<AnimClip, 'rows'> {
  if (c === 'walk') return { frames, fps: frames * 1.5, loop: true, ...(STRIDE[body] ? { stride: STRIDE[body] } : {}) };
  if (c === 'attack') return { frames, fps: 8, loop: false, event: 2 };
  if (c === 'hit') return { frames, fps: 8, loop: false };
  if (c === 'die') return { frames, fps: 6, loop: false };
  return { frames: 1, fps: 1, loop: true };
}

interface Frame {
  png: Buffer;
  w: number;
  h: number;
  area: number;
  /** Center, feet (lowest solid row), and upper-body center, in its own pixels. */
  cx: number;
  cy: number;
  foot: number;
  ux: number;
  bh: number;
}

/** One cell of an answered sheet: alpha cleaned (the faint haze the model leaves goes, solid pixels go opaque), measured. */
export async function cell(sheet: Buffer, cols: number, rows: number, i: number): Promise<Frame> {
  const { width: W, height: H } = (await sharp(sheet).metadata()) as { width: number; height: number };
  const cw = Math.floor(W / cols), ch = Math.floor(H / rows);
  const { data, info } = await sharp(sheet).extract({ left: (i % cols) * cw, top: Math.floor(i / cols) * ch, width: cw, height: ch }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height;
  for (let p = 3; p < data.length; p += 4) data[p] = data[p]! < 24 ? 0 : data[p]! > 240 ? 255 : data[p]!;
  dropSpecks(data, w, h);
  let area = 0, sx = 0, sy = 0, foot = 0, top = h, x0 = w, x1 = -1;
  const perRow = new Uint32Array(h);
  for (let y = 0; y < h; y++)
    for (let x = 0; x < w; x++) {
      const p = (y * w + x) * 4 + 3;
      if (data[p]! > 128) {
        area++, (sx += x), (sy += y), perRow[y]!++;
        if (y < top) top = y;
        if (x < x0) x0 = x;
        if (x > x1) x1 = x;
      }
    }
  // The feet: the lowest row with more than a stray pixel or two.
  for (let y = h - 1; y >= 0; y--) if (perRow[y]! > 2) { foot = y; break; }
  // The upper body's center: the median of its columns, which an arm, weapon, or effect reaching out hardly moves.
  const colN = new Uint32Array(w);
  let un = 0;
  for (let y = top; y < top + (foot - top) * 0.45; y++) for (let x = Math.max(0, x0); x <= x1; x++) if (data[(y * w + x) * 4 + 3]! > 128) colN[x]!++, un++;
  let ux = 0;
  for (let x = 0, seen = 0; x < w; x++) if ((seen += colN[x]!) >= un / 2) { ux = x + 0.5; break; }
  const png = await sharp(data, { raw: { width: w, height: h, channels: 4 } }).png().toBuffer();
  const n = Math.max(1, area);
  return { png, w, h, area: n, cx: sx / n, cy: sy / n, foot, ux: un ? ux : sx / n, bh: Math.max(1, foot - top + 1) };
}

/**
 * Clear the specks the model leaves round a figure (a few pixels apart from it, which would be taken for its feet or
 * top): pieces under 0.3% of the solid pixels. An attack's effect, apart from the figure but larger, stays.
 */
function dropSpecks(data: Buffer, w: number, h: number) {
  const label = new Int32Array(w * h).fill(-1);
  const pieces: number[][] = [];
  let total = 0;
  for (let i = 0; i < w * h; i++) {
    if (label[i] !== -1 || data[i * 4 + 3]! <= 128) continue;
    const piece = [i];
    label[i] = pieces.length;
    for (let j = 0; j < piece.length; j++) {
      const q = piece[j]!, x = q % w, y = (q - x) / w;
      for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy, r = ny * w + nx;
        if (nx >= 0 && ny >= 0 && nx < w && ny < h && label[r] === -1 && data[r * 4 + 3]! > 128) (label[r] = pieces.length), piece.push(r);
      }
    }
    pieces.push(piece);
    total += piece.length;
  }
  const drop = new Set(pieces.flatMap((p, k) => (p.length < Math.max(12, total * 0.003) ? [k] : [])));
  if (!drop.size) return;
  for (const k of drop) for (const q of pieces[k]!) data[q * 4 + 3] = 0;
}

/**
 * The share of a picture's visible pixels that are pale, gray, and half transparent: the haze of a backdrop the model
 * sometimes paints behind the figure despite the transparent canvas (light clouds round every frame). A figure
 * itself has hardly any (under 2% in the sheets studied, a glowing one included).
 */
export async function paleHaze(png: Buffer): Promise<number> {
  const { data } = await sharp(png).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  let seen = 0, pale = 0;
  for (let p = 0; p < data.length; p += 4) {
    const a = data[p + 3]!;
    if (a < 24) continue;
    seen++;
    const r = data[p]!, g = data[p + 1]!, b = data[p + 2]!;
    if (a < 230 && r + g + b > 570 && Math.max(r, g, b) - Math.min(r, g, b) < 30) pale++;
  }
  return seen ? pale / seen : 0;
}

/**
 * The share of a GIF's frame edges that is solid, in its worst frame: a backdrop painted behind the figure despite
 * the transparent canvas (a GIF has no half-transparent haze to tell it by). A figure stands clear of the edges.
 */
export async function gifBackdrop(gif: Buffer): Promise<number> {
  const pages = (await sharp(gif, { animated: true }).metadata()).pages ?? 1;
  let worst = 0;
  for (let page = 0; page < pages; page++) {
    const { data, info } = await sharp(gif, { page }).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const { width: w, height: h } = info;
    let edge = 0, solid = 0;
    for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
      if (x > 0 && y > 0 && x < w - 1 && y < h - 1) continue;
      edge++;
      if (data[(y * w + x) * 4 + 3]! > 128) solid++;
    }
    worst = Math.max(worst, solid / edge);
  }
  return worst;
}

/** A GIF's frames laid out as a single clip's sheet (gridOf(1, frames)), with how many there are. */
export async function gifSheet(gif: Buffer): Promise<{ png: Buffer; frames: number }> {
  const meta = await sharp(gif, { animated: true }).metadata();
  const frames = meta.pages ?? 1, w = meta.width!, h = meta.pageHeight ?? meta.height!;
  const g = gridOf(1, frames);
  const comp = await Promise.all(Array.from({ length: frames }, async (_, i) => ({ input: await sharp(gif, { page: i }).png().toBuffer(), left: (i % g.cols) * w, top: Math.floor(i / g.cols) * h })));
  const png = await sharp({ create: { width: w * g.cols, height: h * g.rows, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comp).png().toBuffer();
  return { png, frames };
}

/** A painted sheet as the assembly reads it: its picture and how its pixels relate to the painting's. */
export interface Painted {
  png: Buffer;
  view: View;
  rows: ClipRow[];
  /** Frames of each clip (laid out as gridOf says); a walk GIF's sheet has more than a painted sheet. */
  frames?: number;
  /** Sheet pixels per painting pixel (from how the figure was placed and how much the model scaled the canvas). */
  perPainting: number;
}

/** A frame placed: its picture at final size and the ground point in it. */
interface Placed { png: Buffer; w: number; h: number; ax: number; ay: number }

async function place(f: Frame, k: number, float: boolean, standHeight: number): Promise<Placed> {
  const w = Math.max(1, Math.round(f.w * k)), h = Math.max(1, Math.round(f.h * k));
  const png = await sharp(f.png).resize(w, h).png().toBuffer();
  return float ? { png, w, h, ax: f.cx * k, ay: f.cy * k + standHeight / 2 } : { png, w, h, ax: f.ux * k, ay: (f.foot + 1) * k };
}

export interface Assembled {
  anim: ActorAnim;
  sheets: Partial<Record<ClipName, PackedSheet>>;
}

/**
 * Assemble an actor's clips. `idle`: its standing view per painted direction (the painting for its own view, the
 * turnaround's cells for the rest), each with its sheet pixels per painting pixel; `painted`: the clip sheets;
 * `paintingHeight`: the painting's height in pixels (drawn ACTOR_HEIGHT tall, as the still sprite).
 */
export async function assemble(body: Locomotion, from: string, paintingHeight: number, idle: { view: View; png: Buffer; perPainting: number }[], painted: Painted[]): Promise<Assembled> {
  const float = floating(body);
  // Final sheet pixels per painting pixel: the standing painting is drawn ACTOR_HEIGHT tall.
  const target = (ACTOR_HEIGHT * PX_PER_METER * SCALE) / paintingHeight;
  const frames: Partial<Record<ClipName, Partial<Record<View, Placed[]>>>> = {};
  // The standing figure's height (final pixels), for placing floaters.
  const stand = await Promise.all(idle.map(async (s) => ({ s, f: await cell(s.png, 1, 1, 0) })));
  const standHeight = stand.length ? stand.map(({ s, f }) => f.bh * (target / s.perPainting)).sort((a, b) => a - b)[Math.floor(stand.length / 2)]! : 0;
  // The standing figure's height (final pixels) per view, which each clip sheet's move frames are given.
  const standTall: Partial<Record<View, number>> = {};
  for (const { s, f } of stand) {
    (frames.idle ??= {})[s.view] = [await place(f, target / s.perPainting, float, standHeight)];
    standTall[s.view] = f.bh * (target / s.perPainting);
  }
  const median = (cells: Frame[]) => {
    const hs = cells.map((c) => c.bh).sort((a, b) => a - b), m = hs.length / 2;
    return hs.length % 2 ? hs[Math.floor(m)]! : (hs[m - 1]! + hs[m]!) / 2;
  };
  const within = (v: number, d: number) => Math.max(1 - d, Math.min(1 + d, v));
  for (const p of painted) {
    const n = p.frames ?? SHEET_FRAMES, g = gridOf(p.rows.length, n);
    const rows = await Promise.all(p.rows.map((_, r) => Promise.all(Array.from({ length: n }, (_, i) => cell(p.png, g.cols, g.rows, r * g.cols + i)))));
    // From where the figure was placed on the canvas, unless the move frames say otherwise (within a factor of two:
    // further off, a frame is broken rather than resized).
    let k = target / p.perPainting;
    const move = rows[p.rows.indexOf('move')], want = standTall[p.view];
    if (move && want) {
      const fit = want / median(move);
      if (fit > k / 2 && fit < k * 2) k = fit;
    }
    for (const [r, row] of p.rows.entries()) {
      const cells = rows[r]!;
      // A move frame keeps its row's height; an attack or hit row is sized so its last frame (the recovery, back in
      // stance) stands as tall as the move, within 10%, and its frames keep their own heights (a crouch is lower).
      const scale = (c: Frame) =>
        row === 'move' ? k * within(median(cells) / c.bh, 0.15)
        : (row === 'attack' || row === 'hit') && move ? k * within(median(move) / cells[cells.length - 1]!.bh, 0.1)
        : k;
      (frames[CLIPS[row]] ??= {})[p.view] = await Promise.all(cells.map((c) => place(c, scale(c), float, standHeight)));
    }
  }
  // One cell for every clip: round the ground point, as far as any frame reaches.
  const all = Object.values(frames).flatMap((v) => Object.values(v!).flat());
  if (!all.length) throw new Error('nothing painted to assemble');
  const left = Math.ceil(Math.max(...all.map((f) => f.ax))), right = Math.ceil(Math.max(...all.map((f) => f.w - f.ax)));
  const up = Math.ceil(Math.max(...all.map((f) => f.ay))), down = Math.ceil(Math.max(0, ...all.map((f) => f.h - f.ay)));
  const cw = left + right, ch = up + down;
  const anim: ActorAnim = { body, scale: SCALE, cell: [cw, ch], anchor: [left, up], height: ACTOR_HEIGHT, from, clips: {} };
  const sheets: Assembled['sheets'] = {};
  for (const [clip, byView] of Object.entries(frames) as [ClipName, Partial<Record<View, Placed[]>>][]) {
    const counts = new Set(Object.values(byView).map((f) => f!.length));
    if (counts.size > 1) throw new Error(`the ${clip}'s views have different numbers of frames (${[...counts].join(', ')})`);
    const t = timing(clip, body, [...counts][0]!);
    // A full sheet: a cell per frame, a row per direction (ANIM_DIRS order); unpainted directions stay empty.
    const comp: OverlayOptions[] = [];
    for (const [view, fs] of Object.entries(byView) as [View, Placed[]][]) {
      const r = ANIM_DIRS.indexOf(view);
      fs.forEach((f, i) => comp.push({ input: f.png, left: i * cw + Math.round(left - f.ax), top: r * ch + Math.round(up - f.ay) }));
    }
    const full = await sharp({ create: { width: cw * t.frames, height: ch * 8, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comp).png().toBuffer();
    const packed = await packSheet(full, [cw, ch], t.frames);
    anim.clips[clip] = { ...t, rows: packed.rows };
    sheets[clip] = packed;
  }
  return { anim, sheets };
}

