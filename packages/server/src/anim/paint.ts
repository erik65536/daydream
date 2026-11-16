/**
 * What the image model is asked to paint for an actor (see docs/world-art.md, "Animation"). All on transparent
 * canvases, answered on transparent backgrounds: no backdrop to key out, so glows and soft edges stay clean.
 *
 * 1. The turnaround: a 3 × 2 sheet with the painting in the cell of its own view (front for people, left profile for
 *    animals and other bodies); the model paints the other views: S, SW, W, NW, N (E, NE, and SE are their mirrors).
 * 2. Clip sheets, one per painted view, each from that view in its first cell: a row per clip, four frames each.
 *    SW, W, and NW carry the move, attack, and hit (W the death too), S and N the move alone (as 2 × 2 sheets: a single
 *    row would be wider than the model paints, and two views on one sheet came out facing the same way). Blows are
 *    painted in the views that face the picture's left, which the game mirrors for the other side: told to strike
 *    toward the viewer or away from it, the model drew most blows side-on, and from behind nearly all toward the
 *    picture's right; toward the left, it drew them the way they were asked for, and facing.ts mirrors a frame that
 *    still turns right. Townspeople who never fight have the move alone in every view.
 * 3. Walk GIFs (with the `image.walk` purpose, GPT Image 2.6): one looping GIF of eight frames per painted view, from
 *    that view's standing figure. They walk more evenly and keep the painting's look better than a sheet's walk, so
 *    they replace it; a view whose sheet would hold the move alone then has no sheet.
 * Painted at low quality: it moved the most (medium and high barely moved); 288 px rows are plenty for figures the
 * game draws about 164 sheet pixels tall, and a GIF's 256 px frames for the same reason (larger cost more and look
 * the same in the game). Studied in November 2026: docs/experiments/gpt-image-2.6.
 */
import sharp from 'sharp';
import { floats as floating } from '@daydream/shared';
import type { ImageEditRequest } from '../genai/types.ts';
import type { AnimBrief } from './brief.ts';

/** The five painted views, as turnaround cells (S, SW, W / NW, N). */
export const VIEWS = ['S', 'SW', 'W', 'NW', 'N'] as const;
export type View = (typeof VIEWS)[number];

/**
 * Each view's facing, by the picture's own corners and edges ("facing left" was read as the character's own left now
 * and then), with the whole body (a head turned one way could sit on a body facing the other). facing.ts mirrors a
 * view that still comes out facing right.
 */
const FACE: Record<View, string> = {
  S: 'facing the viewer (front view)',
  SW: 'in a three-quarter front view turned toward the lower-left corner of the picture, its head and whole body pointing toward the left edge of the picture',
  W: 'in side view, its head and whole body pointing toward the left edge of the picture',
  NW: 'in a three-quarter back view turned away toward the upper-left corner of the picture, the back mostly visible, its head and whole body pointing toward the left edge of the picture',
  N: 'facing away from the viewer (back view)',
};
/** Where each view's actions go on the picture: its steps, blows, shots, and spells. */
const AIM: Record<View, string> = {
  S: 'toward the viewer, at the bottom of the picture',
  SW: 'toward the lower-left corner of the picture',
  W: 'toward the left edge of the picture',
  NW: 'toward the upper-left corner of the picture',
  N: 'away from the viewer, at the top of the picture',
};
const GOES = (v: View) => `Everything it does goes ${AIM[v]}: every step, and every blow, shot, throw, or spell.`;

/** Clips painted per row, by index into the brief's four motions. */
const CLIP_ROWS = ['move', 'attack', 'hit', 'death'] as const;
export type ClipRow = (typeof CLIP_ROWS)[number];

/**
 * The clip sheets to paint: each view with its rows. With `walkGifs` the walk comes from the GIFs, so a view whose
 * sheet would hold the move alone has none; the move rows left beside attack and hit measure how large the model
 * drew that sheet (assemble.ts).
 */
export function sheetsFor(fights: boolean, walkGifs: boolean): Partial<Record<View, ClipRow[]>> {
  const all: Partial<Record<View, ClipRow[]>> = fights
    ? { S: ['move'], SW: ['move', 'attack', 'hit'], W: ['move', 'attack', 'hit', 'death'], NW: ['move', 'attack', 'hit'], N: ['move'] }
    : { S: ['move'], SW: ['move'], W: ['move'], NW: ['move'], N: ['move'] };
  return walkGifs ? Object.fromEntries(Object.entries(all).filter(([, rows]) => rows.length > 1)) : all;
}

/** Row height of every sheet (input pixels). */
const ROW = 288;

/** Frames of a sheet's clip, and of a walk GIF. */
export const SHEET_FRAMES = 4;
export const GIF_FRAMES = 8;

/** A sheet's grid: `frames` per row, or two rows of half as many for a single clip. */
export const gridOf = (rows: number, frames = SHEET_FRAMES) => (rows === 1 ? { cols: Math.ceil(frames / 2), rows: 2 } : { cols: frames, rows });

/** Cell width for an actor's painting: room for its widest pose (a side view of a long body, an attack's reach). */
export function cellWidth(width: number, height: number): number {
  const snap = (v: number) => Math.round(v / 16) * 16;
  return Math.min(snap(ROW * 1.55), Math.max(snap(ROW * 0.9), snap(ROW * Math.max(width / height, 1) * 1.3)));
}

export interface Sheet {
  req: ImageEditRequest;
  /** Input pixels per pixel of the figure placed (painting or turnaround pixels). */
  k: number;
  /** The input canvas's width (the answer's own width says how much the model scaled it). */
  inWidth: number;
}

/** A figure fitted into one cell (the first by default) of a transparent sheet of cw × ch cells. */
async function placed(fig: Buffer, cw: number, cols: number, rows: number, floats: boolean, cell = 0, ch = ROW) {
  const { width: w, height: h } = (await sharp(fig).metadata()) as { width: number; height: number };
  const k = Math.min((cw * 0.7) / w, (ch * (floats ? 0.65 : 0.75)) / h);
  const fw = Math.max(1, Math.round(w * k)), fh = Math.max(1, Math.round(h * k));
  const input = await sharp(fig).resize(fw, fh).png().toBuffer();
  const left = (cell % cols) * cw + Math.round((cw - fw) / 2);
  const top = Math.floor(cell / cols) * ch + (floats ? Math.round((ch - fh) / 2) : Math.round(ch * 0.92 - fh));
  const png = await sharp({ create: { width: cw * cols, height: ch * rows, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite([{ input, left, top }]).png().toBuffer();
  return { png, k };
}

/** A brief's words without their closing full stop, for use inside a sentence. */
const words = (t: string) => t.trim().replace(/[.\s]+$/, '');

const SAME = (floats: boolean) => `Every view is exactly the same character: same body, proportions, colors, markings, clothing and gear, art style and size, the whole body visible inside its cell${floats ? '' : ', resting on the same ground line'}.`;
const CLEAN = 'The background is fully transparent everywhere: no backdrop, shadows, ground, grid lines, labels, numbers, or text, and no motion lines or marks except an attack\'s own effect.';

/** The turnaround: the painting in its own view's cell, the model painting the other four. */
export async function turnaround(painting: Buffer, view: 'S' | 'W', brief: AnimBrief): Promise<Sheet> {
  const { width: w, height: h } = (await sharp(painting).metadata()) as { width: number; height: number };
  const cw = cellWidth(w, h), floats = floating(brief.locomotion);
  const slot = VIEWS.indexOf(view);
  const { png, k } = await placed(painting, cw, 3, 2, floats, slot);
  const cells = VIEWS.map((v, i) => `cell ${i + 1} (${i < 3 ? 'top' : 'bottom'} row): ${FACE[v]}`).join('; ');
  const prompt = `Picture 1 is a character turnaround sheet for a 2D top-down game, a 3 × 2 grid read left to right, top to bottom. Cell ${slot + 1} already shows the character: ${words(brief.body)}. Paint the same character in the other cells, one view each, seen from slightly above like the game's camera: ${cells}. Leave the sixth cell (bottom right) empty. ${SAME(floats).replace('exactly', 'in a neutral pose, exactly')} ${CLEAN}`;
  return { req: { prompt, images: [png], width: cw * 3, height: ROW * 2, quality: 'low', transparent: true }, k, inWidth: cw * 3 };
}

/** A clip sheet of one view: `fig` (the painting itself, or that view cut from the turnaround) in its first cell. */
export async function clipSheet(fig: Buffer, cw: number, view: View, rows: ClipRow[], brief: AnimBrief): Promise<Sheet> {
  const floats = floating(brief.locomotion);
  const g = gridOf(rows.length);
  const { png, k } = await placed(fig, cw, g.cols, g.rows, floats);
  const motion = (r: ClipRow) => words(brief[r]);
  const head = rows.length === 1
    ? `Picture 1 is a 2 × 2 animation sprite sheet for a 2D top-down game: one animation of four frames, read left to right, then top to bottom. The top-left cell shows the character: ${words(brief.body)}. Fill all four cells: the character ${FACE[view]}; ${motion(rows[0]!)}. ${GOES(view)}`
    : `Picture 1 is a 4 × ${rows.length} animation sprite sheet for a 2D top-down game: one animation per row, four frames each from left to right. The top-left cell shows the character: ${words(brief.body)}. Fill all ${rows.length * 4} cells, the character always ${FACE[view]}:\n${rows.map((r, i) => `- Row ${i + 1}: ${motion(r)}.`).join('\n')}\n${GOES(view)}`;
  const prompt = `${head}\nEvery frame shows exactly the same character: same body, colors, markings, clothing and gear (held the same way), proportions, art style and size, facing the direction given, the whole body visible inside its cell${floats ? '' : ', resting on the same ground line in every cell'}. Make each frame a clearly different pose so the motion reads at a glance. ${CLEAN}`;
  return { req: { prompt, images: [png], width: cw * g.cols, height: ROW * g.rows, quality: 'low', transparent: true }, k, inWidth: cw * g.cols };
}

/**
 * A walk GIF's frame height (its width follows the actor's cell), and each frame's length as it was studied (the
 * game plays the frames at its own rate).
 */
const GIF_HEIGHT = 256;
const GIF_FRAME_MS = 120;

/**
 * One view's walk as a looping GIF: `fig` (the painting itself, or that view cut from the turnaround) on its first
 * frame. Moderation is low: a gun or a blade carried in a game is not violence, but strict moderation refused some.
 */
export async function walkGif(fig: Buffer, cw: number, view: View, brief: AnimBrief): Promise<Sheet> {
  const floats = floating(brief.locomotion);
  const fh = GIF_HEIGHT, fw = Math.max(fh, Math.round((cw * fh) / ROW / 16) * 16);
  const { png, k } = await placed(fig, fw, 1, 1, floats, 0, fh);
  const cycle = floats ? 'movement cycle in place' : 'walk cycle on the spot, as on a treadmill';
  const prompt = `Animate this character of a 2D top-down game: a seamless looping ${cycle}: ${words(brief.move)}. The last frame leads smoothly back into the first. The character: ${words(brief.body)}. It stays ${FACE[view]} the whole time, seen from slightly above like the game's camera. Every frame shows exactly the same character: same body, colors, markings, clothing and gear (held the same way), proportions, art style and size, the whole body always in view${floats ? '' : ', resting on the same ground line'}, static camera. Each frame a clearly different pose so the motion reads. Fully transparent background: no backdrop, ground, shadows, text, or motion lines.`;
  return { req: { prompt, images: [png], width: fw, height: fh, quality: 'low', transparent: true, gif: { frames: GIF_FRAMES, frameMs: GIF_FRAME_MS }, moderation: 'low' }, k, inWidth: fw };
}
