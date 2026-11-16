/**
 * Painting a place as a big top-down 2D map (see docs/places.md):
 * 1. Luna plans the place: the whole-map layout with one dominant area, its ground described in the world's art
 *    style, the barrier that closes it off, and what a way out through that barrier looks like.
 * 2. FLUX 3 Image Klein paints the whole place at its full size, closed all round by the barrier (asked for as layout
 *    boxes along each edge), one painting at a time. Each is read by the walk reader (mapread.ts, the same reading
 *    the finished map gets) and Luna checks the view; the first in which at least WALK_MIN of the map is walkable
 *    and almost all of that is one joined region is kept. After two that are not, Luna rewrites the plan's layout,
 *    shown both paintings, what was read as walkable and cut off, and which checks each failed. At most TRIES
 *    paintings; the one failing fewest checks is kept.
 * 3. Exits: each planned way out goes where the reading's main region comes closest to its side (near where it was
 *    planned). Luna, shown the window there, says what the ground just inside looks like and how the barrier's cut
 *    ends should look, and Klein's box edit cuts the way out through the barrier from that, from the edge to 1.5 m past
 *    where the open ground starts. The box is pasted back whole: the walk area opens every way out whatever the
 *    painting shows, so the look need not be perfect, and a cut-off fade looked less real than Klein's own drawing.
 * 4. Unplanned ways off the map (the reading's main region reaching the edge anywhere else) are closed: the barrier's
 *    texture is laid across the opening, then Klein's box edit makes the barrier whole there.
 * The map is read as PAINT_PXM pixels per meter: there a character fits the narrowest passages comfortably while
 * looking only a little short. Why this route:
 * docs/experiments/flux3-klein/README.md.
 */
import sharp from 'sharp';
import { atStep, retries } from '../genai/meter.ts';
import { z } from 'zod';
import type { ZoneKind } from '@daydream/shared';
import { genai } from '../genai/service.ts';
import { kleinEdit, kleinPaint } from './comfy.ts';
import { CELL, walkOf, type Grid, type Side, type Walk } from './mapgrid.ts';

/** The map is sized in squares this many pixels across. */
export const TILE = 1024;
/** Painted pixels per ground meter. */
export const PAINT_PXM = 40;
/** A map's size in tiles (columns, rows). */
export type Tiles = [number, number];
/** The sizes each kind of place may have, in tiles (never more than 4 × 4), and its usual size. */
export const TILE_RANGE: Record<ZoneKind, { min: Tiles; max: Tiles; usual: Tiles }> = {
  town: { min: [2, 2], max: [3, 3], usual: [3, 2] },
  wilderness: { min: [2, 2], max: [4, 4], usual: [3, 3] },
  dungeon: { min: [2, 1], max: [4, 3], usual: [3, 2] },
};
/** A size held to its kind's range. */
export function fitTiles(kind: ZoneKind, t?: readonly number[]): Tiles {
  const r = TILE_RANGE[kind];
  if (!t || t.length < 2) return [...r.usual];
  return [0, 1].map((i) => Math.max(r.min[i]!, Math.min(r.max[i]!, Math.round(t[i]!)))) as Tiles;
}
/** Paintings of a place at most, and how many fail before Luna rewrites its layout. */
const TRIES = 4, REWRITE_AFTER = 2;
/** A painting is sound when less than this share of its walkable ground is cut off from the main region, */
const SOUND = 0.04;
/** and at least this share of the whole map is walkable (a place read as mostly blocked is repainted). */
const WALK_MIN = 0.4;
/** Cut-off regions smaller than this (m²) are specks of the reading, not areas. */
const AREA_MIN = 4;
/** Barrier band (the reader blocks it), its boxes in the painting prompt, exit gap, way-out width, and soft edges, in painted pixels (3.2, 4, 3.6, 4, and 1.2 m). */
const BAND = 128, FRAME = 160, GAP = 144, PATH = 160, FEATHER = 48;
/** An exit is placed at most this far along its side from where it was planned (fraction), and two on one side keep this far apart. */
const EXIT_SHIFT = 0.2, EXIT_APART = 0.15;
/** How deep into the place an exit is looked for (m), and how near its middle the open ground must be (m). */
const EXIT_DEPTH_M = 16, EXIT_AIM_M = 0.5;
/** A way out's box runs this far past where the open ground starts (m). */
const EXIT_BOX_M = 1.5;
/** Main-region ground this close to the edge (m) is a way off the map. */
const EDGE_M = 1;
/** Edit windows (px): exits and closings are cut in a square window at the edge. */
const WIN = 1024;

/** Picture size and ground (m) of a map of this many tiles. */
export function mapPixels([cols, rows]: Tiles): { W: number; H: number; X: number; Y: number; cols: number; rows: number } {
  const W = cols * TILE, H = rows * TILE;
  return { W, H, X: W / PAINT_PXM, Y: H / PAINT_PXM, cols, rows };
}

/** The plan grid of a map of this many tiles: quarter-meter cells (mapgrid.ts). */
export function mapGrid(tiles: Tiles): Grid {
  const { X, Y } = mapPixels(tiles);
  return { cols: Math.round(X / CELL), rows: Math.round(Y / CELL) };
}

/** Where the ways out on one side sit along it when not chosen (fractions): one in the middle, two at thirds. */
function gapsAlong(n: number): number[] {
  return Array.from({ length: n }, (_, i) => (i + 1) / (n + 1));
}

/** What painting a place needs to know. */
export interface MapBrief {
  world: string;
  artStyle: string;
  name: string;
  kind: ZoneKind;
  /** The map's size. */
  tiles: Tiles;
  indoor: boolean;
  description: string;
  lore?: string;
  buildings: { name: string; purpose: string }[];
  /** Ways out across the edge, by side (two on one side are spread along it). */
  sides: Side[];
  /** Ways down or in drawn inside the map (a cave mouth, stairs down, a door). */
  inner: string[];
}

/** A way out across the edge: its side and where along it (0 at the left or top end). */
export interface MapExit {
  side: Side;
  at: number;
}

const PlanSchema = z.object({
  plan: z.string().min(200).max(1400).describe('The whole map at once: where each area and landmark lies (upper left, middle...), how the main routes run between them, with counts'),
  ground: z.string().min(100).max(900).describe("The walkable ground of the place and what is scattered over it, seen from above, every surface described in the world's art style"),
  style: z.string().min(60).max(500).describe('Art style, light, and palette of the painting'),
  floor: z.string().min(3).max(80).describe('The main ground people walk on, in a few plain visual words ("worn gray cobblestones")'),
  barrier: z.string().min(3).max(80).describe('What closes off the edges of this place, in a few plain visual words'),
  barrierLook: z.string().min(30).max(300).describe('How that barrier looks from above and how it meets the ground inside'),
  barrierSurface: z.string().min(20).max(300).describe("Only the barrier's surface material as a close-up texture seen from above"),
  exitLook: z.string().min(20).max(300).describe('What a way out through the barrier looks like from above'),
  look: z.object({
    ambient: z.number().min(0.15).max(1).describe('How bright the place is: 0.2 a dark cave, 0.5 dim, 0.85 daylight'),
    lightColor: z.string().max(24).describe('Color of the light, as hex'),
    fogColor: z.string().max(24).describe('A dark color for unexplored ground that suits the place, as hex'),
    outdoor: z.boolean().describe('Under the open sky'),
    weather: z.enum(['none', 'rain', 'snow', 'ash', 'spores', 'embers', 'dust', 'fireflies']),
  }),
});
export type MapPlan = z.infer<typeof PlanSchema>;

const KIND_WORDS: Record<ZoneKind, string> = { town: 'a town or settlement', wilderness: 'a stretch of wild country', dungeon: 'a dungeon, cave, or other dangerous inner place' };

const PAINTER = 'The painter takes every word literally and paints each word\'s most common picture: describe things only by what they look like (material, shape, color), never by their names (it writes names on the map as labels). The view is from high above, looking straight down: describe roofs, ground, floors, paths, and the tops of things, never facades, how tall things are, or views.';

/** Luna plans the map, knowing how it will be painted. */
export async function planMap(b: MapBrief): Promise<MapPlan> {
  const { X, Y } = mapPixels(b.tiles);
  return genai().structured('world.design', {
    system: 'You are the level designer and art director of a 2D top-down RPG. Its places are painted by an image model (FLUX 3 Image Klein) as big top-down maps, like tabletop battle maps, and players explore them on foot. Every place should be a memorable, fun level, not a generic one.',
    prompt: `WORLD: ${b.world}
Art style: ${b.artStyle}
PLACE: ${b.name}, ${KIND_WORDS[b.kind]}${b.indoor ? ', indoors' : ''}: ${b.description}
${b.lore ? `History: ${b.lore}\n` : ''}${b.buildings.length ? `Buildings people visit: ${b.buildings.map((x) => `${x.name} (${x.purpose})`).join('; ')}.\n` : ''}${b.inner.length ? `Ways in or down drawn inside the map: ${b.inner.join('; ')}.\n` : ''}
THE GOAL: one big top-down map of this place, about ${Math.round(X)} by ${Math.round(Y)} meters, that players walk around. A fun level to explore: distinct areas with their own character, landmarks, varied routes, and a strong, unmistakable theme, while reading as one coherent place. Most of it walkable, with every path, street, or floor in view (nothing walkable hidden behind tall buildings, trees, or walls) and passages at least about 1.5 m wide.
HOW IT IS MADE (so you know what each answer is for):
1. The image model paints the whole place at once from "plan", "ground" and "style", closed all round its outer edge by a narrow belt of your "barrier".
2. Ways out are then cut through that belt where the place's open ground comes closest to the edge, each painted from "exitLook". So never describe the edge of the place or its ways out in "plan" or "ground".
3. ${PAINTER}

Write:
- plan: the whole map at once: where each area and landmark lies (upper left, middle, lower right...), how the main routes run between them, with counts ("about thirty houses"). Choose the arrangement that suits this place (winding and organic for caves, ruins, or wild country; regular rows for a barracks, a planned district, or row houses), but never uniform repetition: areas of different sizes and shapes, joined by clear, open routes so every area can be reached, with one dominant landmark area much larger than the rest${b.kind === 'dungeon' ? ' (the great chamber where the strongest foe or the secret of the place waits)' : ''}.
- ground: the walkable ground and what is scattered over it. Go all-in on the theme, and describe every surface and material in the world's art style's own terms (for a claymation world, "smooth gray-green modeling-clay plates, softly scuffed with faint fingerprints"; for pixel art, "chunky square gray flagstone pixels"), so the painting holds the style.
- style: art style, light, and palette, bold and true to the theme and the world's art style.
- floor: the main walkable ground in a few plain visual words; barrier, barrierLook: a natural barrier that suits the place and clearly reads as impassable.
- barrierSurface: only the surface material of the barrier as a close-up texture filling a picture (e.g. "churning dark teal water with white foam streaks"), even across the whole picture: never banks, edges, trim, strips, buildings, or ground.
- exitLook: what a way out through the barrier looks like from above, about 4 m wide (a stone bridge, a gravel path through a gap cut in a hedge, a paved ramp through a cut in a cliff). It must plainly read as open walkable ground all the way: never a tunnel mouth, gate, door, arch, hole, or dark opening (the painter draws those as black shapes that look like pits).
- look: how the place feels to be in, for the game's lighting.
The game draws its own people, creatures, chests, and signs, so leave them out. No text or lettering anywhere.`,
    schema: PlanSchema,
    name: 'map_plan',
    maxTokens: 8000,
  });
}

// ------------------------------------------------------------------------------------------------------------- prompts

/**
 * The lead of every painting prompt, for every kind of place: seen from straight above, everything walkable in view.
 * It names no things (roofs, treetops, or streets belong to some places and not others; naming them painted a forest
 * round a space station), and the orthographic sentence is what keeps towns of pitched roofs from a three-quarter
 * view: words taken out of a plan did not, words added did (docs/experiments/flux3-klein, "Coast towns").
 */
const LEAD =
  'A top-down game map seen from high above, looking almost straight down like a tabletop battle map: the tops of everything that stands are in plain view, and all the ground a person can walk on is clearly visible. No horizon. An orthographic overhead view with no perspective, like a satellite image: the camera points straight down.';
/** The art style of a map painting: the view first (no medium named, so a photograph or claymation style is not fought), then the plan's style. */
const mapStyle = (p: Pick<MapPlan, 'style'>) => `Art style: Flat top-down map, ${p.style.trim().replace(/\.$/, '')}.`;
const TAIL = 'No grid, no text, no labels, no people, no creatures.';

/** A layout box for Klein: [top, left, bottom, right] on a 0–1000 grid of the picture, cited in the prompt as <id>. */
interface Box {
  id: string;
  bbox: [number, number, number, number];
  desc: string;
}
const rows = (boxes: Box[]) => JSON.stringify(boxes.map((b) => ({ ...b, bbox: b.bbox.map((v) => Math.round(Math.max(0, Math.min(1000, v)))) })));

/** The whole place, closed all round by its barrier (one box per side: Klein frames a place anyway, and boxes make the frame the barrier). */
const wholePrompt = (b: MapBrief, p: Pick<MapPlan, 'plan' | 'ground' | 'style' | 'barrier' | 'barrierLook'>) => {
  const { W, H, X, Y } = mapPixels(b.tiles);
  const bx = (FRAME / W) * 1000, by = (FRAME / H) * 1000;
  const band: Box[] = (['top', 'right', 'bottom', 'left'] as Side[]).map((side, i) => ({
    id: `barrier_${i + 1}`,
    bbox: side === 'top' ? [0, 0, by, 1000] : side === 'bottom' ? [1000 - by, 0, 1000, 1000] : side === 'left' ? [0, 0, 1000, bx] : [0, 1000 - bx, 1000, 1000],
    desc: `A solid, unbroken belt of ${p.barrier} along the ${side} edge: ${p.barrierLook} Nobody can pass through it.`,
  }));
  return `${LEAD} The whole of ${b.name} in one picture, the entire place seen at once from high above, about ${Math.round(X)} by ${Math.round(Y)} meters across, so everything in it is small and there are many of each thing: ${p.plan} ${p.ground} Every area is joined to the others by open walkable ground: one connected network with no cut-off areas. Round the whole outer edge of the picture runs a narrow, solid belt of ${p.barrier} (${band.map((x) => `<${x.id}>`).join(' ')}) that closes the place off, unbroken all the way round: no gap, gate, path, or opening anywhere along it. Nowhere does a road, path, or passage reach the edge. ${mapStyle(p)} ${TAIL} ${rows(band)}`;
};

// ------------------------------------------------------------------------------------------------------------- raster

/** Raw RGB pixels of a picture, for cutting windows and pasting results back. */
class Raster {
  W: number;
  H: number;
  px: Buffer;
  constructor(W: number, H: number, px: Buffer) {
    this.W = W;
    this.H = H;
    this.px = px;
  }
  static async of(png: Buffer): Promise<Raster> {
    const { data, info } = await sharp(png).removeAlpha().raw().toBuffer({ resolveWithObject: true });
    return new Raster(info.width, info.height, Buffer.from(data));
  }
  clone(): Raster {
    return new Raster(this.W, this.H, Buffer.from(this.px));
  }
  png(): Promise<Buffer> {
    return sharp(this.px, { raw: { width: this.W, height: this.H, channels: 3 } }).png().toBuffer();
  }
  crop(x: number, y: number, w: number, h: number): Promise<Buffer> {
    return sharp(this.px, { raw: { width: this.W, height: this.H, channels: 3 } }).extract({ left: x, top: y, width: w, height: h }).png().toBuffer();
  }
  /** Paste a window's pixels (resized to w × h), blended by `weight(x, y)` (window coordinates, 0 keeps what is there). */
  async paste(win: Buffer, x0: number, y0: number, w: number, h: number, weight: (x: number, y: number) => number) {
    const p = await sharp(win).resize(w, h, { fit: 'fill' }).removeAlpha().raw().toBuffer();
    for (let y = 0; y < h; y++)
      for (let x = 0; x < w; x++) {
        const a = Math.max(0, Math.min(1, weight(x, y)));
        if (!a) continue;
        const i = ((y0 + y) * this.W + x0 + x) * 3, j = (y * w + x) * 3;
        for (let c = 0; c < 3; c++) this.px[i + c] = Math.round(p[j + c]! * a + this.px[i + c]! * (1 - a));
      }
  }
}

const small = (png: Buffer, max = 1024) => sharp(png).resize({ width: max, height: max, fit: 'inside' }).png().toBuffer();
/** Rotate a crop so the given side of the map is at the top of the picture. */
const edgeUp = (png: Buffer, side: Side) => sharp(png).rotate(side === 'top' ? 0 : side === 'right' ? 270 : side === 'bottom' ? 180 : 90).png().toBuffer();
const along = (side: Side, W: number, H: number) => (side === 'top' || side === 'bottom' ? W : H);

/** A rectangle of the map (px) reaching in from one side: `a0..a1` along it, `depth` in from it. */
interface EdgeRect {
  x0: number;
  x1: number;
  y0: number;
  y1: number;
}
function edgeRect(side: Side, a0: number, a1: number, depth: number, W: number, H: number): EdgeRect {
  return side === 'top' ? { x0: a0, x1: a1, y0: 0, y1: depth } : side === 'bottom' ? { x0: a0, x1: a1, y0: H - depth, y1: H } : side === 'left' ? { x0: 0, x1: depth, y0: a0, y1: a1 } : { x0: W - depth, x1: W, y0: a0, y1: a1 };
}
/** Weight 1 inside the rectangle, fading to 0 over `f` px outside it. */
const soft = (r: EdgeRect, f: number) => (x: number, y: number) => {
  const d = Math.hypot(Math.max(r.x0 - x, x - (r.x1 - 1), 0), Math.max(r.y0 - y, y - (r.y1 - 1), 0));
  return d === 0 ? 1 : d < f ? 1 - d / f : 0;
};
/** The edit window round a rectangle at the edge (inside the map), and the rectangle as a box in its 0–1000 grid. */
function windowAt(r: EdgeRect, W: number, H: number) {
  const wx = Math.round(Math.max(0, Math.min(W - WIN, (r.x0 + r.x1) / 2 - WIN / 2))), wy = Math.round(Math.max(0, Math.min(H - WIN, (r.y0 + r.y1) / 2 - WIN / 2)));
  const k = 1000 / WIN;
  const bbox: Box['bbox'] = [(r.y0 - wy) * k, (r.x0 - wx) * k, (r.y1 - wy) * k, (r.x1 - wx) * k];
  return { wx, wy, bbox };
}

// ------------------------------------------------------------------------------------------------------------- judges

const noul = (a: unknown) => (a && typeof a === 'object' && (a as { type: string }).type === 'noul' ? (a as { noul: number }).noul : 0.5);
const choice = (a: unknown) => (a && typeof a === 'object' && (a as { type: string }).type === 'choice' ? (a as { choice: string }).choice : '?');

/**
 * Luna's view check of a painting. Calibrated on labeled pictures: a painting is too steep only when it shows large
 * building fronts AND walkable ground hidden behind them (either answer alone misjudged good ones).
 */
async function viewCheck(png: Buffer, theme: string) {
  const a = await genai().decide('image.check', {
    state: `A top-down game map of ${theme}. Players walk on its streets, paths, and floors, so every walkable place must be in view. A slight viewing angle that shows some sides of buildings, walls, or objects is fine, as long as nothing hides the ground behind it.`,
    questions: {
      hidden: { type: 'noul', instructions: 'Because of the viewing angle, is any walkable ground (streets, paths, floors, open ground) hidden behind tall things such as buildings, trees, walls, or pillars, so that a person walking there would be out of sight?' },
      front: { type: 'choice', instructions: 'How much of the front or side faces of buildings, walls, and large objects can you see, compared with their roofs or tops?', criteria: { none: 'none: only roofs and tops', thin: 'a thin strip of front or side, much smaller than the roof', large: 'large fronts: as much or more front or side face as roof, with doors and windows clearly drawn' } },
      detail: { type: 'noul', instructions: 'Is this a finished, detailed painting with many distinct drawn things (not blank, flat, or a crude color field)?' },
      theme: { type: 'noul', instructions: `Does this look strongly and unmistakably like ${theme}?` },
    },
    images: [await small(png)],
  });
  const steep = choice(a.front) === 'large' && noul(a.hidden) > 0.5;
  return { steep, detailed: noul(a.detail) > 0.5, theme: +noul(a.theme).toFixed(2), hidden: +noul(a.hidden).toFixed(2), front: choice(a.front) };
}

// ------------------------------------------------------------------------------------------------------------- reading

/** Share of a reading's walkable ground cut off from its main region (regions under AREA_MIN m² are specks). */
export function cutOff(w: Walk): number {
  const min = AREA_MIN / (CELL * CELL);
  let all = 0, cut = 0;
  w.sizes.forEach((s, i) => {
    if (s < min && i !== w.main) return;
    all += s;
    if (i !== w.main) cut += s;
  });
  return all ? cut / all : 1;
}

/**
 * Where each planned exit goes: within EXIT_SHIFT of its planned spot (and EXIT_APART from another on the same side),
 * the spot where the main region comes closest to the edge within EXIT_AIM_M of the way out's middle; nearer the
 * plan on a tie.
 * `depth` is how far in (m) the main region starts there (EXIT_DEPTH_M when it is not found that close).
 */
export function exitSpots(w: Walk, g: Grid, planned: MapExit[]): (MapExit & { depth: number })[] {
  const out: (MapExit & { depth: number })[] = [];
  const half = Math.round(EXIT_AIM_M / CELL), maxD = Math.round(EXIT_DEPTH_M / CELL);
  const main = (r: number, c: number) => r >= 0 && c >= 0 && r < g.rows && c < g.cols && w.label[r * g.cols + c] === w.main;
  for (const e of planned) {
    const n = e.side === 'top' || e.side === 'bottom' ? g.cols : g.rows;
    let best: { at: number; d: number; off: number } | undefined;
    for (let k = -10; k <= 10; k++) {
      const at = Math.max(0.1, Math.min(0.9, e.at + (k / 10) * EXIT_SHIFT));
      if (out.some((o) => o.side === e.side && Math.abs(o.at - at) < EXIT_APART)) continue;
      const a = Math.round(at * n);
      let d = maxD;
      for (let depth = 0; depth < maxD && d === maxD; depth++)
        for (let s = a - half; s <= a + half; s++) {
          const [r, c] = e.side === 'top' ? [depth, s] : e.side === 'bottom' ? [g.rows - 1 - depth, s] : e.side === 'left' ? [s, depth] : [s, g.cols - 1 - depth];
          if (main(r, c)) (d = depth), (s = a + half);
        }
      const off = Math.abs(at - e.at);
      if (!best || d < best.d || (d === best.d && off < best.off)) best = { at, d, off };
    }
    best ??= { at: e.at, d: maxD, off: 0 };
    out.push({ side: e.side, at: +best.at.toFixed(3), depth: best.d * CELL });
  }
  return out;
}

/**
 * Ways off the map nobody planned: stretches of an edge (gaps under EDGE_M joined) where the main region comes within
 * EDGE_M of it, away from the exits. Each is its side, center, and length along it (fractions).
 */
export function strayOpenings(w: Walk, g: Grid, exits: MapExit[]): { side: Side; at: number; len: number }[] {
  const e = Math.round(EDGE_M / CELL), keep = Math.round(PATH / PAINT_PXM / 2 / CELL) + e;
  const out: { side: Side; at: number; len: number }[] = [];
  for (const side of ['top', 'right', 'bottom', 'left'] as Side[]) {
    const n = side === 'top' || side === 'bottom' ? g.cols : g.rows;
    const hit = new Uint8Array(n);
    for (let s = 0; s < n; s++)
      for (let depth = 0; depth < e; depth++) {
        const [r, c] = side === 'top' ? [depth, s] : side === 'bottom' ? [g.rows - 1 - depth, s] : side === 'left' ? [s, depth] : [s, g.cols - 1 - depth];
        if (w.label[r * g.cols + c] === w.main) hit[s] = 1;
      }
    for (const x of exits) if (x.side === side) hit.fill(0, Math.max(0, Math.round(x.at * n) - keep), Math.min(n, Math.round(x.at * n) + keep));
    for (let s = 0; s < n; ) {
      if (!hit[s]) {
        s++;
        continue;
      }
      let end = s;
      for (let t = s; t < n && t - end <= e; t++) if (hit[t]) end = t;
      out.push({ side, at: (s + end + 1) / 2 / n, len: (end - s + 1) / n });
      s = end + 1;
    }
  }
  return out;
}

// ------------------------------------------------------------------------------------------------------------- make

/** Where making a map keeps its steps (a resumed build picks up where it stopped). */
interface MapDraft {
  json<T>(name: string): T | undefined;
  saveJson(name: string, v: unknown): void;
  png(name: string): Buffer | undefined;
  savePng(name: string, b: Buffer): void;
}

/** What making a map runs with: the GPU queue (Klein calls take their turn), the walk reader, its draft, and progress. */
interface MapRun {
  gpu: <T>(model: 'klein', fn: () => Promise<T>) => Promise<T>;
  /** The walk reader's open cells for a painting, saved in the draft under `name`. */
  read: (png: Buffer, name: string) => Promise<{ open: Uint8Array; g: Grid }>;
  draft: MapDraft;
  report: (msg: string) => void;
  /** Steps done of MAP_STEPS. */
  step?: (done: number) => void;
  /** A painting tried, set aside (not sound), or the layout redrawn after paintings failed. */
  noted?: (what: 'tried' | 'setAside' | 'relaid') => void;
}
export const MAP_STEPS = 3;

interface MadeMap {
  png: Buffer;
  /** The plan it was painted from (Luna's rewrite when the first paintings were cut up). */
  plan: MapPlan;
  exits: MapExit[];
  /** Whether the kept painting was sound (almost all one region, seen from above), and its share cut off. */
  sound: boolean;
  cutOff: number;
  /** The draft name of the kept painting, whose walk reading the finished map's reading reuses. */
  judged: string;
}

/** Paint a place's map from its plan (every step saved in the draft). */
export async function makeMap(b: MapBrief, p: MapPlan, seed: number, io: MapRun): Promise<MadeMap> {
  const theme = `${b.name}, ${KIND_WORDS[b.kind]}: ${b.description.slice(0, 200)}`;
  const chosen = await choosePainting(b, p, theme, seed, io);
  io.step?.(1);
  const planned: MapExit[] = [];
  for (const s of new Set(b.sides)) for (const at of gapsAlong(b.sides.filter((x) => x === s).length)) planned.push({ side: s, at });
  const spots = io.draft.json<(MapExit & { depth: number })[]>('exitspots') ?? exitSpots(chosen.walk, chosen.g, planned);
  io.draft.saveJson('exitspots', spots);
  const exits = spots.map(({ side, at }) => ({ side, at }));
  let map = io.draft.png('exits') ?? (await atStep('places.paint.exits', () => openExits(b, chosen.plan, chosen.png, spots, seed, io)));
  io.draft.savePng('exits', map);
  io.step?.(2);
  if (!io.draft.png('final')) {
    const strays = strayOpenings(chosen.walk, chosen.g, exits);
    if (strays.length) map = await atStep('places.paint.close', () => closeStrays(b, chosen.plan, map, strays, seed, io));
    io.report(`${b.name}: ${spots.length} ways out cut${strays.length ? `, ${strays.length} unplanned ways off the map closed` : ''}`);
  }
  map = io.draft.png('final') ?? map;
  io.draft.savePng('final', map);
  io.step?.(3);
  return { png: map, plan: chosen.plan, exits, sound: chosen.sound, cutOff: chosen.cut, judged: chosen.name };
}

/** A painting tried for a place, and how it fared. */
type Tried = { name: string; png: Buffer; plan: MapPlan; open: Uint8Array; walk: Walk; g: Grid; cut: number; share: number; steep: boolean; sound: boolean };
/** How many of a painting's checks failed: the fewer the better. */
export const faults = (t: Pick<Tried, 'cut' | 'share' | 'steep'>) => +(t.cut >= SOUND) + +(t.share < WALK_MIN) + +t.steep;

/**
 * Klein paints the place closed at full size, one painting at a time, until one is sound (see the file comment);
 * after REWRITE_AFTER that are not, Luna rewrites the layout. The painting failing fewest checks is kept, the least
 * cut off among equals.
 */
async function choosePainting(b: MapBrief, p: MapPlan, theme: string, seed: number, io: MapRun) {
  const { W, H } = mapPixels(b.tiles);
  let plan = p, best: Tried | undefined;
  const failed: Tried[] = [];
  const tries = retries('quality', 'sound place painting');
  for (let t = 0; t < TRIES; t++) {
    if (t === REWRITE_AFTER && failed.length) {
      plan = io.draft.json<MapPlan>('plan_rewrite') ?? { ...p, ...(await atStep('places.paint.rewrite', () => rewriteLayout(b, p, failed))) };
      io.draft.saveJson('plan_rewrite', plan);
      io.noted?.('relaid');
    }
    const name = `paint_${seed + t}`;
    const png = io.draft.png(name) ?? (await atStep('places.paint.whole', () => io.gpu('klein', () => kleinPaint(wholePrompt(b, plan), W, H, seed + t))));
    io.draft.savePng(name, png);
    const { view, open, g } = await atStep('places.paint.check', async () => {
      const view = io.draft.json<{ steep: boolean }>(`${name}_view`) ?? (await viewCheck(png, theme));
      io.draft.saveJson(`${name}_view`, view);
      return { view, ...(await io.read(png, name)) };
    });
    const walk = walkOf(open, g), cut = cutOff(walk), share = open.reduce((a, v) => a + (v ? 1 : 0), 0) / open.length;
    const tried: Tried = { name, png, plan, open, walk, g, cut, share, steep: view.steep, sound: false };
    tried.sound = faults(tried) === 0;
    io.report(`${b.name}: painting ${t + 1} ${tried.sound ? 'sound' : faultText(tried)}`);
    io.noted?.('tried');
    if (!tried.sound && t < TRIES - 1) io.noted?.('setAside');
    if (!best || faults(tried) < faults(best) || (faults(tried) === faults(best) && cut < best.cut)) best = tried;
    tries.try(tried.sound, tried.sound || t === TRIES - 1, undefined, { place: b.name, cut: +cut.toFixed(4), walkable: +share.toFixed(4), steep: view.steep });
    if (tried.sound) break;
    if (t < REWRITE_AFTER) failed.push(tried);
  }
  if (!best!.sound) io.report(`${b.name}: no painting fully sound; kept the best (${faultText(best!)})`);
  return best!;
}

/** What a painting failed, in words (for the build log and Luna's rewrite). */
function faultText(t: Tried): string {
  const out: string[] = [];
  if (t.share < WALK_MIN) out.push(`only ${Math.round(t.share * 100)}% of the map walkable (at least ${WALK_MIN * 100}% needed)`);
  if (t.cut >= SOUND) out.push(`${Math.round(t.cut * 100)}% of its walkable ground cut off from the main open ground`);
  if (t.steep) out.push('seen from too low an angle, hiding ground behind buildings');
  return out.join('; ');
}

/**
 * Luna rewrites the plan's layout and ground, shown the paintings that failed (each with the ground the reader found
 * walkable tinted green and what was cut off red) and told which checks each failed: too little walkable ground,
 * ground cut off, too steep a view.
 */
async function rewriteLayout(b: MapBrief, p: MapPlan, failed: Tried[]) {
  const min = AREA_MIN / (CELL * CELL);
  const shown = await Promise.all(
    failed.map(async (t, k) => {
      const { walk: w, g } = t;
      const where = (cells: number[]) => {
        let sx = 0, sy = 0;
        for (const i of cells) (sx += i % g.cols), (sy += Math.floor(i / g.cols));
        const fx = sx / cells.length / g.cols, fy = sy / cells.length / g.rows;
        return `${fy < 0.33 ? 'upper' : fy > 0.67 ? 'lower' : 'middle'} ${fx < 0.33 ? 'left' : fx > 0.67 ? 'right' : 'center'}`;
      };
      const regions = new Map<number, number[]>();
      w.label.forEach((l, i) => l >= 0 && l !== w.main && w.sizes[l]! >= min && (regions.get(l) ?? regions.set(l, []).get(l)!).push(i));
      const list = [...regions.values()].sort((a, c) => c.length - a.length).slice(0, 8);
      const view = await small(t.png, 1536);
      const vm = await sharp(view).metadata();
      const tint = Buffer.alloc(g.cols * g.rows * 4);
      t.open.forEach((v, i) => v && tint.set([40, 230, 80, 70], i * 4));
      for (const cells of list) for (const i of cells) tint.set([255, 0, 0, 150], i * 4);
      const layer = await sharp(tint, { raw: { width: g.cols, height: g.rows, channels: 4 } }).resize(vm.width!, vm.height!, { kernel: 'nearest' }).png().toBuffer();
      const found = list.map((c) => `about ${Math.round(c.length * CELL * CELL)} m² in the ${where(c)}`).join('; ');
      const text = `Painting ${k + 1} failed: ${faultText(t)}${t.cut >= SOUND ? ` (red: ${found || 'small pockets'})` : ''}.`;
      return { img: await sharp(view).composite([{ input: layer }]).png().toBuffer(), text };
    }),
  );
  const fixes: string[] = [];
  if (failed.some((t) => t.share < WALK_MIN))
    fixes.push('make open walkable ground most of the place, with obstacles as separate pieces standing on it, and describe that ground so it plainly reads as a floor a person walks on, distinct in color and texture from the obstacles, the barrier and anything a person would fall into');
  if (failed.some((t) => t.cut >= SOUND)) fixes.push('join every area to the rest by wide, open routes of walkable ground (no walls, fences, water, or buildings closing an area off)');
  if (failed.some((t) => t.steep)) fixes.push('keep the view straight down, so no ground is hidden');
  return genai().structured('world.design', {
    system: 'You are the level designer of a 2D top-down RPG whose places are painted by an image model from a written plan.',
    prompt: `${failed.length > 1 ? 'These are paintings' : 'This is a painting'} of ${b.name}, made from the plan and ground below; a reader of where people can walk tinted green the ground it found walkable. ${shown.map((x) => x.text).join(' ')} Rewrite "plan" and "ground" so the painter will ${fixes.join('; ')}, keeping the place's areas, landmarks, theme, and style. ${PAINTER} Never describe the edge of the place or ways out.
PLAN: ${p.plan}
GROUND: ${p.ground}`,
    schema: PlanSchema.pick({ plan: true, ground: true }),
    name: 'map_rewrite',
    maxTokens: 6000,
    images: shown.map((x) => x.img),
  });
}

// ------------------------------------------------------------------------------------------------------------- exits

const Blend = z.object({
  floor: z.string().max(300).describe('The open ground just inside the barrier, as it should carry on through the gap: material, color, pattern, and wear, in a few plain visual words'),
  ends: z.string().max(300).describe("How the barrier's cut ends look on either side of the gap, matching the barrier"),
});

/**
 * Cut each way out through the barrier (see the file comment, step 3). Each cut is saved as it is made (its window as
 * Klein redrew it, `exit_<n>`), so a build stopped between two of them makes only those still missing.
 */
async function openExits(b: MapBrief, p: MapPlan, map: Buffer, spots: (MapExit & { depth: number })[], seed: number, io: MapRun): Promise<Buffer> {
  const cv = await Raster.of(map);
  const looks = io.draft.json<z.infer<typeof Blend>[]>('exits_looks') ?? [];
  for (const [k, e] of spots.entries()) {
    const a = e.at * along(e.side, cv.W, cv.H);
    const rect = (m: number) => edgeRect(e.side, Math.round(a - PATH / 2), Math.round(a + PATH / 2), Math.round(Math.min(WIN - 32, Math.max(BAND + 16, m * PAINT_PXM))), cv.W, cv.H);
    const box = rect(e.depth + EXIT_BOX_M);
    const { wx, wy, bbox } = windowAt(box, cv.W, cv.H);
    const paste = (out: Buffer) => cv.paste(out, wx, wy, WIN, WIN, soft({ x0: box.x0 - wx, x1: box.x1 - wx, y0: box.y0 - wy, y1: box.y1 - wy }, FEATHER));
    const made = io.draft.png(`exit_${k}`);
    if (made) {
      await paste(made);
      continue;
    }
    const win = await cv.crop(wx, wy, WIN, WIN);
    const look = await genai().structured('world.design', {
      prompt: `A piece of a top-down game map of ${b.name}; the top edge of this picture is the outer edge of the map, closed off by ${p.barrier}. A way out about four meters wide will be cut through the barrier near the middle of the top edge, and it must blend with the map round it. Say what the open ground just inside the barrier there looks like, as the painter should carry it on through the gap, and how the barrier's cut ends should look on either side. Describe only by appearance, never by name.`,
      schema: Blend,
      name: 'exit_blend',
      maxTokens: 4000,
      images: [await edgeUp(win, e.side)],
    });
    looks[k] = look;
    io.draft.saveJson('exits_looks', looks);
    const desc = `${look.floor}, about four meters wide, carried on from the open ground of the place through a clean gap in the ${p.barrier} and off the ${e.side} edge. ${look.ends}`;
    const prompt = `In <ref_image_0>, a piece of a top-down game map of ${b.name} at its ${e.side} edge, closed off by ${p.barrier}. The open ground of the place carries on straight through a gap cut in the barrier <way_out_1> and off the ${e.side} edge of the picture, so anyone can walk out of the place there: ${desc} Everything else stays exactly as it is, in the same art style: ${p.style} ${rows([{ id: 'way_out_1', bbox, desc }])}`;
    const out = await io.gpu('klein', () => kleinEdit(win, prompt, seed + 400 + k));
    io.draft.savePng(`exit_${k}`, out);
    await paste(out);
  }
  return cv.png();
}

// ------------------------------------------------------------------------------------------------------------- closing

/** The barrier's surface as a texture (Luna checks it is one even surface matching barrierSurface; up to four tries). */
async function barrierTexture(p: MapPlan, seed: number, io: MapRun): Promise<Raster> {
  const saved = io.draft.png('barrier_texture');
  if (saved) return Raster.of(saved);
  let best: { v: number; png: Buffer } | undefined;
  const tries = retries('quality', 'barrier texture');
  for (let t = 0; t < 4; t++) {
    const png = await io.gpu('klein', () => kleinPaint(`A texture seen from directly above, filling the whole picture edge to edge: ${p.barrierSurface} Nothing else at all. In this style: ${p.style}`, WIN, WIN, seed + 30 + t));
    const a = await genai().decide('image.check', { state: 'A texture for the barrier round the edge of a top-down game map.', questions: { only: { type: 'noul', instructions: `Is the whole picture one even surface, edge to edge, matching this texture: ${p.barrierSurface} With no objects, paths, or border?` } }, images: [await small(png)] });
    if (!best || noul(a.only) > best.v) best = { v: noul(a.only), png };
    tries.try(best.v > 0.8, best.v > 0.8 || t === 3);
    if (best.v > 0.8) break;
  }
  io.draft.savePng('barrier_texture', best!.png);
  return Raster.of(best!.png);
}

/**
 * Close each unplanned way off the map: the barrier's texture laid in the band across the opening, then Klein's box
 * edit makes the barrier whole there with the ground ending before it (texture first: painting alone left most
 * openings half closed, docs/experiments/flux3-klein, "Fixes by editing"). An opening longer than one edit window is
 * closed stretch by stretch.
 */
async function closeStrays(b: MapBrief, p: MapPlan, map: Buffer, strays: { side: Side; at: number; len: number }[], seed: number, io: MapRun): Promise<Buffer> {
  const cv = await Raster.of(map);
  const { W, H } = cv;
  const tex = await barrierTexture(p, seed, io);
  const DEEP = BAND + 192, M = 64, F = 64;
  const stretches = strays.flatMap((o) => {
    const n = along(o.side, W, H);
    const from = Math.max(0, Math.round((o.at - o.len / 2) * n) - M), to = Math.min(n, Math.round((o.at + o.len / 2) * n) + M);
    const out: { side: Side; a0: number; a1: number }[] = [];
    for (let a0 = from; a0 < to; a0 += WIN - 2 * M) out.push({ side: o.side, a0, a1: Math.min(to, a0 + WIN - 2 * M) });
    return out;
  });
  for (const [j, o] of stretches.entries()) {
    const r = edgeRect(o.side, o.a0, o.a1, DEEP, W, H);
    const { wx, wy, bbox } = windowAt(r, W, H);
    const weight = soft(r, F);
    const depth = (x: number, y: number) => (o.side === 'top' ? y : o.side === 'bottom' ? H - 1 - y : o.side === 'left' ? x : W - 1 - x);
    const src = cv.clone();
    for (let y = wy; y < wy + WIN; y++)
      for (let x = wx; x < wx + WIN; x++)
        if (weight(x, y) > 0 && depth(x, y) < BAND) tex.px.copy(src.px, (y * W + x) * 3, ((y % WIN) * WIN + (x % WIN)) * 3, ((y % WIN) * WIN + (x % WIN)) * 3 + 3);
    const box: Box = { id: 'wall_1', bbox, desc: `A solid stretch of ${p.barrier} joining the barrier on both sides without a gap: ${p.barrierLook} The ground of the place ends just before it.` };
    const prompt = `In <ref_image_0>, a piece of a top-down game map of ${b.name} at its ${o.side} edge: the outer ${p.barrier} along the ${o.side} edge is made whole <wall_1>, the new stretch matching the barrier on either side of it exactly, and the ${p.floor} that led to the edge ends before it. Everything else stays exactly as it is, in the same art style: ${p.style} ${rows([box])}`;
    const out = await io.gpu('klein', async () => kleinEdit(await src.crop(wx, wy, WIN, WIN), prompt, seed + 700 + j));
    await cv.paste(out, wx, wy, WIN, WIN, (x, y) => weight(x + wx, y + wy));
  }
  return cv.png();
}

/** The barrier band's depth in meters (the walk plan blocks it except at the exits). */
export const BARRIER_DEPTH_M = BAND / PAINT_PXM;
/** An exit's gap width in meters. */
export const EXIT_GAP_M = GAP / PAINT_PXM;
