/**
 * Animated actors: which clip an actor plays and which cell of its sheet to draw (see shared world/anim.ts).
 *
 * Dead or downed actors fall and stay down, and one getting up plays its fall backwards; attacks (spells too) and hits
 * play once over whatever else is going on; moving actors walk at a frame rate that keeps their feet with the ground;
 * otherwise idle, breathing in code over a standing frame. The row is the screen
 * direction the actor faces, or the nearest painted one (east-facing rows are the west-facing ones mirrored). Standing
 * and walking cut from one to the other, a walk starting on its first frame; other clip changes cross-fade over
 * FADE seconds.
 */
import { IDLE, clipDuration, dirRow, floats, paintedRow, sheetFrame, type ActorAnim, type AnimClip, type ClipName } from '@daydream/shared';
import type { Sheet } from './sheets';

export interface Motion {
  /** The clip playing and how long it has played (seconds). */
  clip: ClipName;
  t: number;
  /** A gait's phase in loops (walk and run share it, so switching between them keeps the step). */
  phase: number;
  /** A one-shot clip playing over the base motion (attack, cast, hit). */
  once?: ClipName;
  /** Ground speed, smoothed (meters per second). */
  speed: number;
  /** The frame showing when the clip last changed, fading out over FADE seconds (`t` since the change). */
  from?: { clip: ClipName; frame: number; t: number };
}

/**
 * Seconds a clip change cross-fades over: the painted clips differ a little in size and placement however carefully
 * they are fitted, and a cut shows that where a short blend hides it. Between standing and walking the blend showed two
 * poses at once (a stride over a standing figure, every time a figure set off or stopped), which looked blurred; a cut
 * there, with the walk starting on its first frame, reads cleanly.
 */
export const FADE = 0.12;
/** How much faster than the fall getting up plays. */
const RISE = 1.3;
const GAITS: ReadonlySet<ClipName> = new Set(['idle', 'walk']);

export const newMotion = (): Motion => ({ clip: 'idle', t: 0, phase: 0, speed: 0 });

/** Change to another clip, keeping the frame that showed to fade out. */
function change(m: Motion, clip: ClipName, anim: ActorAnim) {
  const old = anim.clips[m.clip];
  const gait = GAITS.has(m.clip) && GAITS.has(clip);
  m.from = old && !gait ? { clip: m.clip, frame: frameOf(m, old), t: 0 } : undefined;
  if (m.clip === 'idle' && clip !== 'idle' && gait) m.phase = 0;
  m.clip = clip;
  m.t = 0;
}

/** How far a clip change has faded (0 just changed, 1 done): the old frame's and the new frame's opacity. */
export function fadeOf(m: Motion): { from: number; to: number } | undefined {
  if (!m.from) return undefined;
  const a = m.from.t / FADE;
  return { from: Math.min(1, 2 * (1 - a)), to: Math.min(1, 2 * a) };
}

/** Start a one-shot clip (a blow, a flinch), unless the actor is down. */
export function playOnce(m: Motion, clip: ClipName, anim: ActorAnim | undefined) {
  if (m.clip === 'die' || !anim?.clips[clip]) return;
  // A flinch does not interrupt the actor's own blow or spell.
  if (clip === 'hit' && m.once && m.once !== 'hit') return;
  m.once = clip;
  change(m, clip, anim);
}

/**
 * Advance a motion by `dt` seconds. `moving` and `speed` (ground meters per second) come from the actor's
 * displayed position; `down` is dead or downed.
 */
export function advance(m: Motion, anim: ActorAnim, dt: number, moving: boolean, speed: number, down: boolean) {
  m.speed += (speed - m.speed) * Math.min(1, dt * 8);
  let want: ClipName;
  if (down && anim.clips.die) want = 'die';
  else if (m.clip === 'die' && anim.clips.die && m.t > 0) {
    // Getting up: the fall played backwards, a little quicker, from wherever it had got to.
    m.t = Math.min(m.t, clipDuration(anim.clips.die)) - dt * RISE;
    if (m.from && (m.from.t += dt) >= FADE) m.from = undefined;
    if (m.t > 0) return;
    m.t = 0;
    want = 'idle';
  } else if (m.once && m.t + dt < clipDuration(anim.clips[m.once]!)) want = m.once;
  else {
    m.once = undefined;
    want = moving ? 'walk' : 'idle';
    if (!anim.clips[want]) want = 'idle';
  }
  if (m.from && (m.from.t += dt) >= FADE) m.from = undefined;
  if (want !== m.clip) change(m, want, anim);
  else m.t += dt;
  const c = anim.clips[want];
  if (c?.stride) m.phase += (dt * Math.max(m.speed, 0.4)) / c.stride;
}

/** The sheet column for a motion. */
export function frameOf(m: Motion, c: AnimClip): number {
  if (c.stride) return Math.floor((((m.phase % 1) + 1) % 1) * c.frames) % c.frames;
  const f = Math.floor(m.t * c.fps);
  return c.loop ? f % c.frames : Math.min(c.frames - 1, f);
}

/** The sheet row to draw for a ground facing angle (radians, as the game's `facing`): the painted one, or its mirror. */
export function rowOf(face: number, clip?: AnimClip): { row: number; flip: boolean } {
  const row = dirRow(Math.cos(face), Math.sin(face));
  return (clip && paintedRow(clip, row)) || { row, flip: false };
}

/**
 * Draw one frame of a clip's sheet with its anchor at the current origin (the actor's feet), mirrored when `flip`.
 * `size` is the actor's size scale; the sheet is `anim.scale` times the game's picture resolution. `breath` (seconds)
 * draws the idle's breath over the frame (IDLE): the upper body rises and leans, the feet stay; a floater bobs.
 */
export function drawCell(ctx: CanvasRenderingContext2D, sheet: Sheet, anim: ActorAnim, clip: AnimClip, frame: number, at: { row: number; flip: boolean }, size: number, breath?: number) {
  const { sx, sy, w, h, dx, dy } = sheetFrame(clip, frame, at.row);
  if (!w) return;
  const [ax, ay] = anim.anchor, k = size / anim.scale;
  ctx.save();
  if (at.flip) ctx.scale(-1, 1);
  const src = (y: number, hh: number) => [sheet.bitmap, sx * sheet.kx, (sy + y) * sheet.ky, w * sheet.kx, hh * sheet.ky] as const;
  if (breath === undefined) ctx.drawImage(...src(0, h), (dx - ax) * k, (dy - ay) * k, w * k, h * k);
  else {
    const phase = (breath / IDLE.period) * 2 * Math.PI, rise = (1 - Math.cos(phase)) / 2;
    if (floats(anim.body)) ctx.drawImage(...src(0, h), (dx - ax) * k, (dy - ay) * k - Math.sin(phase) * IDLE.bob * h * k, w * k, h * k);
    else {
      // The lower body as it is; the part above the split stretched up from it and leaning with the breath.
      const split = Math.round(h * IDLE.split), x = (dx - ax) * k, ys = (dy - ay + split) * k;
      ctx.drawImage(...src(split, h - split), x, ys, w * k, (h - split) * k);
      // Sheared about the split line: nothing moves there, the head leans `sway` picture pixels. It reaches one sheet
      // row past the split, over the lower body: two edges meeting on a part-covered pixel row let the ground show.
      const up = split * k * (1 + IDLE.lift * rise), over = Math.min(1, h - split);
      ctx.translate(0, ys);
      ctx.transform(1, 0, (-IDLE.sway * size * Math.sin(phase)) / Math.max(1, up), 1, 0, 0);
      ctx.drawImage(...src(0, split + over), x, -up, w * k, (up * (split + over)) / split);
    }
  }
  ctx.restore();
}

/**
 * Picture pixels a figure reaches left/right of its feet, above them, and below them: in any frame of any clip
 * (the full cell, for hit boxes and lighting), or in one direction of one clip (the box drawn).
 */
export function cellBounds(anim: ActorAnim, size: number, clip?: AnimClip, row = 0) {
  const k = size / anim.scale, [ax, ay] = anim.anchor;
  const [, w, h, x0, y0] = clip ? clip.rows[row]! : [0, anim.cell[0], anim.cell[1], 0, 0];
  return { half: Math.max(ax - x0, x0 + w - ax, 0) * k, above: Math.max(0, ay - y0) * k, below: Math.max(0, y0 + h - ay) * k };
}
