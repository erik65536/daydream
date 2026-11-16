/**
 * Actor animation: sprite sheets painted by an image model from each actor's standing view (see server anim/).
 *
 * One sheet per clip. Every frame sits in a cell of the same size with the ground point under the actor at the same
 * anchor (`cell`, `anchor`); the saved sheet keeps of each direction only the box its frames ever touch (`rows`, in
 * `ANIM_DIRS` order), packed in a strip of frames, `SHEET_PAD` apart. Not every direction is painted: east-facing
 * ones are the west-facing ones mirrored, and a clip painted in fewer facings (an attack in four, a death in one)
 * plays the nearest one painted (`paintedRow`). Sheets are drawn at `scale` sheet pixels per game picture pixel.
 */

/** Screen directions, clockwise from straight down the screen (toward the viewer). */
export const ANIM_DIRS = ['S', 'SW', 'W', 'NW', 'N', 'NE', 'E', 'SE'] as const;

/** What gameplay plays: standing, walking, a blow (a spell too), taking a hit, falling. */
export const ACTOR_CLIPS = ['idle', 'walk', 'attack', 'hit', 'die'] as const;
export type ClipName = (typeof ACTOR_CLIPS)[number];

/** How an actor gets about (from its animation brief). */
export const LOCOMOTIONS = ['walks', 'hops', 'crawls', 'slithers', 'swims', 'floats', 'flies', 'rolls', 'swarms'] as const;
export type Locomotion = (typeof LOCOMOTIONS)[number];

/** Actors that do not stand on the ground: they hover at their height, and bob while idle. */
export const floats = (l: Locomotion) => l === 'floats' || l === 'flies' || l === 'swims';

export interface AnimClip {
  frames: number;
  fps: number;
  loop: boolean;
  /** Ground meters the body travels in one loop of a gait: playback keeps pace with movement. */
  stride?: number;
  /** The frame where the blow lands or the spell leaves (0-based). */
  event?: number;
  /** Where each direction's frames are in the sheet (see `SheetRow`), in `ANIM_DIRS` order. */
  rows: SheetRow[];
}

/**
 * One direction of a clip in its sheet (sheet pixels): its strip starts `y` down; every frame is a `w` x `h` box,
 * `cols` to a line, and the box sits `dx`, `dy` into the full cell. A direction not painted is 0 x 0.
 */
export type SheetRow = [y: number, w: number, h: number, dx: number, dy: number, cols: number];

/** Transparent sheet pixels around every frame, so a scaled-down sheet never bleeds one frame into the next. */
export const SHEET_PAD = 4;

/** Where frame `frame` of direction `row` is in a clip's sheet, and where that box sits in the full cell. */
export function sheetFrame(clip: AnimClip, frame: number, row: number) {
  const [y, w, h, dx, dy, cols] = clip.rows[row]!;
  return { sx: SHEET_PAD + (frame % cols) * (w + 2 * SHEET_PAD), sy: y + SHEET_PAD + Math.floor(frame / cols) * (h + 2 * SHEET_PAD), w, h, dx, dy };
}

/** A direction's mirror across the screen's vertical (W and E, SW and SE...): S and N are their own. */
const mirrorRow = (row: number) => (8 - row) % 8;

/**
 * The painted direction to draw for direction `row`: itself, or its mirror drawn flipped, or else the nearest
 * painted one (or its mirror) around the compass. Null when the clip has no painted direction.
 */
export function paintedRow(clip: AnimClip, row: number): { row: number; flip: boolean } | null {
  const painted = (r: number) => !!clip.rows[r]?.[1];
  for (let d = 0; d <= 4; d++)
    for (const r of d ? [(row + d) % 8, (row + 8 - d) % 8] : [row]) {
      if (painted(r)) return { row: r, flip: false };
      if (painted(mirrorRow(r))) return { row: mirrorRow(r), flip: true };
    }
  return null;
}

/** On a sprite's asset record: how to read its clip sheets (each saved as asset `<key>@anim-<clip>`). */
export interface ActorAnim {
  body: Locomotion;
  /** Sheet pixels per game picture pixel. */
  scale: number;
  /** Cell size in sheet pixels. */
  cell: [number, number];
  /** The ground point under the actor within a cell, in sheet pixels. */
  anchor: [number, number];
  /** Height of the figure in meters when standing. */
  height: number;
  /** A hash of the standing view's image the sheets were made from (a repainted actor keeps its file name and is animated again). */
  from: string;
  clips: Partial<Record<ClipName, AnimClip>>;
}

/** The asset key of one clip's sheet. */
export const clipKey = (spriteKey: string, clip: ClipName) => `${spriteKey}@anim-${clip}`;

/**
 * The sheet row for a ground direction (meters: x and y as in the game, y down the screen): "down the screen" is S.
 */
export function dirRow(dx: number, dy: number): number {
  if (!dx && !dy) return 0;
  const deg = (Math.atan2(dy, dx) * 180) / Math.PI; // 90 = straight down the screen
  return (((Math.round((deg - 90) / 45) % 8) + 8) % 8);
}

/**
 * The frame to show `t` seconds into a clip: looping clips wrap, others hold their last frame. A gait's `pace`
 * (ground meters per second) sets its speed through the stride.
 */
export function clipFrame(clip: AnimClip, t: number, pace?: number): number {
  const rate = clip.stride && pace ? (pace / clip.stride) * clip.frames : clip.fps;
  const f = Math.floor(Math.max(0, t) * rate);
  return clip.loop ? f % clip.frames : Math.min(clip.frames - 1, f);
}

/** How long a one-shot clip plays, in seconds. */
export const clipDuration = (clip: AnimClip) => clip.frames / clip.fps;

/**
 * The idle's breath, drawn in code over a standing frame (painted idles jitter): the lower body stays still and the
 * part above `split` (a share of the figure's height from its top) rises up to `lift` of its height on the in-breath,
 * leaning up to `sway` picture pixels at the head; an actor that floats bobs `bob` of its height instead.
 */
export const IDLE = { period: 2.4, split: 0.55, lift: 0.012, sway: 1.2, bob: 0.035 };
