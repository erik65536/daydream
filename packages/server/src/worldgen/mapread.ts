/**
 * Reading a big top-down map (see docs/places.md): where people can walk, where its buildings are (for sight) and
 * what blocks sight; the spots things are placed on (entrances, named landmarks) are found in mapspots.ts. Studied
 * in October 2026: first against 400 hand-labeled points on five maps, then (walkability v2) against 810 points on
 * 21 places of three worlds, a fantasy town, a drowned town, and a modern office.
 *
 * 1. Qwen-Image 2.1 edit redraws the whole map (at about 1.4 or 2.4 MP: tiles lose the context that tells a roof
 *    from a floor) as flat plans, three ways (WALK_READINGS): white walkable, black solid (filled, not outlined),
 *    blue water, pits, and the outside. A fourth plan also paints buildings red (BUILDING_PLAN), and a fifth names
 *    what each thing is in six colors (KIND_PLAN).
 * 2. Each plan is read per cell as shares (planCells): of the pixels Qwen answered, how many are walkable or water.
 *    Qwen sometimes answers in the transparency channel, leaving part of its picture transparent over junk colors
 *    (on Thimblebrook two plans left all the ground transparent); a transparent or off-palette pixel is no answer, so
 *    the plans that did answer decide there (combine).
 * 3. The walkable share is snapped to the painting's own edges with a guided filter (mapedge.ts), so the walk area
 *    follows a street's curb or a wall's face rather than the plans' soft, slightly shifted edges.
 * 4. Where the kind plan paints a cell solid, the walk plans' doubt is cleared (quiet), so Luna is not asked to open it.
 *    Areas the plans left in doubt are judged by Luna on the painting, one look per area within a budget per place
 *    (judgeDoubts): blocked areas a plan painted blue (a dark road, a rug, or flooded floor as often as a canal) and
 *    blocked areas a plan painted walkable (an office one plan saw as floor and the others as a building). The area
 *    keeps the shape the plan drew; Luna only says whether it is ground.
 * 5. mapfix.ts then joins what is cut off, crossing what a plan saw as a bridge, stairs, or a door when Luna, shown
 *    the route, sees a way across (judgeRoute).
 *
 * With the image.read purpose configured, GPT Image reads the map instead (docs/experiments/gpt-read): two kind plans,
 * one each from GPT Image 2.5 and 2.6 Sunburst (gptPlans), are lined up with the painting (mapalign.ts: GPT Image
 * redraws a map shifted and stretched by up to a meter) and voted as the walk plans (combine), their red is the
 * buildings, and Luna is not asked about doubts nor seams opened. Its plans are clean enough that her looks, which can only open,
 * opened more water, lava, and solid than they fixed. On the 3,574 points marked by eye on 24 places it gets 96.3%
 * right, against 95.7% for Qwen's plans with Luna (95.7% too before its plans were lined up and its seams left shut:
 * docs/experiments/plan-align); a third plan added nothing.
 *
 * The earlier reader had Luna settle every cell where the plans split, at points every 2 m; it leaned to "blocked"
 * on half-ground patches and cut straight-edged chunks out of yards, and asking at more points was costly without
 * being more accurate. SAM 3 with Luna's names was weaker still (its names drift; it read a dungeon almost wholly
 * wrong), and Sol on crops was no better than Luna at forty times the price.
 */
import sharp from 'sharp';
import { batchAnswers } from '../genai/images.ts';
import { genai } from '../genai/service.ts';
import type { ImageEditRequest } from '../genai/types.ts';
import { qwenEdit } from './comfy.ts';
import { CELL, components, opening, type Grid } from './mapgrid.ts';
import type { Spot } from './mapspots.ts';

/** Qwen prompts for the walk readings, and the megapixels each map is read at. */
export const WALK_READINGS: { prompt: string; mp: number }[] = [
  {
    mp: 2.4,
    prompt: 'Convert this top-down map into a flat three-color plan with exactly the same layout, shapes, and positions. Paint pure white every open floor area where a person can walk: floors, corridors, paths, streets, plazas, lawns, carpet, bridges, and stairs. Paint pure blue all water (sea, rivers, pools, channels), pits and the empty darkness, fog, or land outside the place. Paint pure black everything solid that blocks walking: walls, buildings, and roofs, furniture, desks, cars, machines, statues, rocks, cliffs, trees, hedges, and bushes. Only white, blue, and black, no texture, no outlines.',
  },
  {
    mp: 1.4,
    prompt: 'Convert this top-down game map into a flat walkability mask for the game, with exactly the same layout, shapes, and positions. Paint pure white all ground the player can walk on: floors, streets, paths, plazas, decks, bridges, stairs, grass, snow, and sand, including patterns, rugs, and decorations lying flat on the ground. Paint pure black, filled solid, everything the player cannot walk through: buildings and roofs, walls, fences, hedges, furniture, tables, crates, carts, statues, rocks, trees, bushes, and unlit dark areas. Paint pure blue all water, pits, and the area outside the place. Fill every shape completely: no outlines, no texture, no gray.',
  },
  {
    mp: 1.4,
    prompt: 'Convert this top-down view into a game pathing mask with exactly the same layout. Fill areas the player is allowed to stand in white. Fill areas the player is blocked from standing in black. Fill all water, pits, and the area outside the place with blue. Fill all objects, buildings, trees, rocks, and tables with black rather than outlining them. Only flat white, black, and blue.',
  },
];

/** The plan that marks buildings (red), for sight. */
export const BUILDING_PLAN = {
  mp: 1.4,
  prompt: 'Convert this top-down game map into a flat four-color plan for the game, with exactly the same layout, shapes, and positions. Paint pure white all ground the player can walk on: floors, streets, paths, plazas, decks, bridges, stairs, grass, snow, and sand, including patterns, rugs, and decorations lying flat on the ground. Paint pure red every building and roof. Paint pure black, filled solid, everything else the player cannot walk through: walls, fences, hedges, furniture, tables, crates, carts, statues, rocks, trees, bushes, and unlit dark areas. Paint pure blue all water, pits, and the area outside the place. Fill every shape completely: no outlines, no texture, no gray.',
};

/**
 * The plan that names what each thing is rather than whether it is walkable (KIND_COLORS). It is not voted with the
 * walk plans (its own mistakes, such as lava painted as a way or a rug in its own color, would then count); it only
 * keeps Luna from opening what it paints solid (quiet). Read by the nearest of its colors, so it needs no thresholds.
 */
export const KIND_PLAN = {
  mp: 1.4,
  prompt: 'Convert this top-down map into a flat six-color plan with exactly the same layout, shapes, and positions, each thing filled solid in one flat color by what it is, never by its own color. Paint pure white the floors and open ground, together with the carpets, rugs, and mats lying on them: rooms, corridors, tiles, plazas, yards, lawns, grass, dirt, sand, snow, and ice. Paint pure magenta the ways people walk along: roads, streets, asphalt, parking lots, sidewalks, curbs, paths, trails, stairs, steps, ramps, bridges, boardwalks, docks, catwalks, and grates. Paint pure green the trees, bushes, hedges, reeds, and other plants too dense to walk through. Paint pure red the buildings and roofs seen from above. Paint pure black, whatever their color, the walls, fences, railings, furniture, desks, tables, chairs, shelves, machines, vehicles, rocks, cliffs, and every other object a person must walk around. Paint pure blue only what a person would fall into or drown in: water, lava, molten metal, pits, chasms, and the area outside the place; a carpet or rug is never blue. Only these six flat colors, no texture, no outlines, no text.',
};

/**
 * The kind plan's colors and what each says (as planPixel: 0 no answer, 1 walkable, 2 solid, 3 water, 4 building).
 * Yellow and orange, which Qwen sometimes paints for hazards or warning lines, are no answer.
 */
const KIND_COLORS: [number, number, number, number][] = [
  [255, 255, 255, 1], [255, 0, 255, 1], [255, 255, 0, 0], [255, 140, 0, 0], [0, 160, 0, 2], [220, 0, 0, 4], [0, 0, 0, 2], [0, 0, 255, 3],
];

/**
 * A plan read back as cells. `known` is the share of the cell's pixels Qwen answered; `walk` and `water` are the shares
 * of those that are walkable (near white) and water (blue); `building` is set where most are red.
 */
export interface PlanCells {
  walk: Float32Array;
  water: Float32Array;
  known: Float32Array;
  building: Uint8Array;
}

/** What a plan pixel says: 0 no answer, 1 walkable, 2 solid, 3 water, 4 building. */
export function planPixel(r: number, g: number, b: number, a: number): number {
  // Qwen sometimes leaves part of its picture transparent (more often when asked for a "mask"), with colors of no
  // meaning under it; what transparency stands for varies (the outside on one map, all the ground on another), so it
  // is no answer, as is any color outside the plan's.
  if (a < 128) return 0;
  if (r > 150 && g > 150 && b > 150) return 1;
  if (b > 140 && r < 110) return 3;
  if (r > 150 && g < 100 && b < 100) return 4;
  if (r < 100 && g < 100 && b < 100) return 2;
  return 0;
}

/** What a kind plan pixel says, as planPixel: its nearest KIND_COLORS color, or no answer when none is near. */
export function kindPixel(r: number, g: number, b: number, a: number): number {
  if (a < 128) return 0;
  let best = 0, d = 120 * 120;
  for (const [pr, pg, pb, k] of KIND_COLORS) {
    const e = (r - pr) ** 2 + (g - pg) ** 2 + (b - pb) ** 2;
    if (e < d) (d = e), (best = k);
  }
  return best;
}

/** A plan picture (any size) as cells, each pixel read by `pixel`. */
export async function planCells(pic: Buffer, g: Grid, pixel = planPixel): Promise<PlanCells> {
  const { data, info } = await sharp(pic).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
  const w = info.width, h = info.height, n = g.cols * g.rows;
  const walk = new Float32Array(n), water = new Float32Array(n), known = new Float32Array(n), building = new Uint8Array(n);
  for (let r = 0; r < g.rows; r++)
    for (let c = 0; c < g.cols; c++) {
      const x0 = Math.floor((c * w) / g.cols), x1 = Math.max(x0 + 1, Math.floor(((c + 1) * w) / g.cols));
      const y0 = Math.floor((r * h) / g.rows), y1 = Math.max(y0 + 1, Math.floor(((r + 1) * h) / g.rows));
      const count = [0, 0, 0, 0, 0];
      for (let y = y0; y < y1; y++) for (let x = x0; x < x1; x++) {
        const i = (y * w + x) * 4;
        count[pixel(data[i]!, data[i + 1]!, data[i + 2]!, data[i + 3]!)]!++;
      }
      const all = (x1 - x0) * (y1 - y0), answered = all - count[0]!, i = r * g.cols + c;
      known[i] = answered / all;
      if (answered) (walk[i] = count[1]! / answered), (water[i] = count[3]! / answered);
      building[i] = 2 * count[4]! > answered && answered > 0 ? 1 : 0;
    }
  return { walk, water, known, building };
}

/** The map shrunk to about `mp` megapixels, its sides multiples of 16, as the plans read it. */
export async function atSize(png: Buffer, mp: number): Promise<Buffer> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const k = Math.sqrt((mp * 1e6) / (W * H));
  return sharp(png).resize(Math.round((W * k) / 16) * 16, Math.round((H * k) / 16) * 16).png().toBuffer();
}

/** Qwen's picture of the plan (the map read at about `mp` megapixels). */
export async function planPicture(png: Buffer, plan: { prompt: string; mp: number }, seed = 1): Promise<Buffer> {
  return qwenEdit(await atSize(png, plan.mp), plan.prompt, seed);
}

/** The GPT Image models whose kind plans are voted when the image.read purpose reads the maps. */
const GPT_READ_MODELS = ['gpt-image-2.5-sunburst', 'gpt-image-2.6-sunburst'];
export const gptReading = () => genai().configured('image.read');
export const gptReadModels = () => genai().purpose('image.read').models ?? GPT_READ_MODELS;

/**
 * The request for a GPT Image plan of the map, the kind plan unless another is given (low quality: the plans are flat
 * colors; higher was no more accurate).
 */
async function planRequest(png: Buffer, plan: { prompt: string; mp: number } = KIND_PLAN): Promise<ImageEditRequest> {
  return { prompt: plan.prompt, images: [await sharp(await atSize(png, plan.mp)).removeAlpha().png().toBuffer()], quality: 'low' };
}
/** A GPT Image model's plan of the map (the kind plan unless another is given), asked directly. */
async function gptPlan(png: Buffer, model: string, plan?: { prompt: string; mp: number }): Promise<Buffer> {
  return genai().editImage('image.read', await planRequest(png, plan), model);
}

/** Batches asked for one plan before the reading fails (to be tried again as a step). */
const BATCH_TRIES = 3;
/** Where a map's reading batches are noted (the place's draft), so a resumed build reads their answers. */
interface BatchNotes {
  get(model: string): string | undefined;
  set(model: string, id: string | undefined): void;
}
/** How a map's plans are asked for and kept. */
interface PlanRun {
  /** Where batches out are noted. */
  notes: BatchNotes;
  /** Each plan as it arrives (saved before its batch's note is cleared, so no answer paid for is lost to a stop). */
  keep: (model: string, pic: Buffer) => void;
  /** Another plan than the kind plan. */
  plan?: { prompt: string; mp: number };
  /** The build has stopped: a batch still out is left noted, to be read when the build resumes. */
  stopped?: () => boolean;
}

/**
 * GPT Image's plans of a map (the kind plan unless another is given), one per model: through the Batch API at half
 * price, one batch per model (a batch takes one model), unless the purpose says `batch: false`. A batch that fails or
 * expires is asked again as a batch, never directly at the full price.
 */
export async function gptPlans(png: Buffer, models: string[], run: PlanRun): Promise<Buffer[]> {
  const g = genai();
  const kept = (model: string, pic: Buffer) => {
    run.keep(model, pic);
    return pic;
  };
  if (g.purpose('image.read').batch === false) {
    // Every plan is waited for, so one that fails does not leave another's answer unkept.
    const all = await Promise.allSettled(models.map(async (m) => kept(m, await gptPlan(png, m, run.plan))));
    return all.map((a) => {
      if (a.status === 'rejected') throw a.reason;
      return a.value;
    });
  }
  const api = g.imageBatch('image.read');
  const req = await planRequest(png, run.plan);
  return Promise.all(
    models.map(async (model) => {
      for (let n = 1; ; n++) {
        let id = run.notes.get(model);
        if (!id) {
          id = await api.submit([{ id: 'plan', body: await api.body(req, model) }]);
          run.notes.set(model, id);
        }
        const back = await batchAnswers(api, id, run.stopped);
        if (!back) throw new Error('stopped');
        const answer = back.answers.get('plan');
        if (answer?.image) kept(model, answer.image);
        run.notes.set(model, undefined);
        if (answer?.image) return answer.image;
        if (n >= BATCH_TRIES) throw new Error(`${model} drew no plan in ${BATCH_TRIES} batches (last: ${answer?.error ?? `the batch ${back.detail}`})`);
      }
    }),
  );
}

/** What Luna is told about the place she judges. */
export interface PlaceBrief {
  name: string;
  description: string;
}

const CONTEXT = (p: PlaceBrief) => `We are turning a painted top-down map into the walkability mask of a 2D top-down RPG. The game draws this painting as the place, and lets the player character (about half a meter across, seen from above) walk only where the mask allows; everything else blocks movement like a wall.
The place: ${p.name}. As designed: ${p.description.slice(0, 1400)}`;

/** Images for Luna: the whole map with a box round the close-up, and the close-up (`S` map px square, shown at `C`). */
async function views(png: Buffer, W: number, H: number, cx: number, cy: number, S: number, C: number, overlay: (s: number, left: number, top: number) => string) {
  const left = Math.round(Math.max(0, Math.min(W - S, cx - S / 2))), top = Math.round(Math.max(0, Math.min(H - S, cy - S / 2)));
  const s = C / S;
  const crop = await sharp(png).extract({ left, top, width: S, height: S }).resize(C, C).composite([{ input: Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${C}" height="${C}">${overlay(s, left, top)}</svg>`) }]).png().toBuffer();
  const o = 1024 / W;
  const box = `<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="${Math.round(H * o)}"><rect x="${left * o}" y="${top * o}" width="${S * o}" height="${S * o}" fill="none" stroke="#ff00ff" stroke-width="3"/></svg>`;
  const overview = await sharp(png).resize(1024).composite([{ input: Buffer.from(box) }]).jpeg({ quality: 85 }).toBuffer();
  return [overview, crop];
}

const yesNo = (yes: string, no: string) => ({ yes, no });
const probYes = (a: Record<string, { type: string; probabilities?: Record<string, number> }>, q: string) => a[q]?.probabilities?.yes ?? 0.5;

/** The questions Luna answers about an outlined area. */
const AREA = {
  water: {
    note: 'a magenta outline marks an area one of our readers painted as water, a pit, or empty void.',
    instructions: 'In this place, can the character walk across the outlined area? Answer yes if it is ground of any color the design means people to walk on: a floor, road, corridor, or path (dark ones and rugs included), flooded or wet floor, a puddle, ice meant for walking, or shallow water the design or painting means people to wade through (a ford, a flooded path, shallow pools between paths, a pool maze, water with stepping stones). Answer no if it is a barrier: deep water, a pond, fountain basin, pool, river, canal, lake, or sea kept as a feature or an edge (even a shallow one), a pit or chasm, unlit void, or the land outside the place. Judge by the place as designed and how the painting shows it.',
    criteria: yesNo('the character can walk across it', 'a barrier'),
  },
  seen: {
    note: 'a magenta outline marks an area one of our readers painted as walkable ground and the others as solid.',
    instructions: 'Is the outlined area ground the character can walk on: a floor, room, corridor, road, path, yard, lawn, park, deck, bridge, or stairs, of any color (rugs and patterns lying flat count as ground)? Answer no if it is mostly a roof or building, the top of a wall, furniture, or other solid objects, dense plants, water, a pit, or darkness, or the land outside the place.',
    criteria: yesNo('ground the character can walk on', 'solid or not ground'),
  },
  thin: {
    note: 'a magenta outline marks a narrow strip (under about a meter wide) our readers disagree about.',
    instructions: 'Can a person step across or walk along the outlined strip: a curb, a painted line, a gutter, a low step or ledge, a threshold, a doorway, a plank, or a narrow path? Answer no if it is a wall, a fence, a railing, a hedge, the edge of a building or roof, or a drop.',
    criteria: yesNo('a person can step across or along it', 'it blocks like a wall'),
  },
};

/** Luna's probability of yes to an area question about some cells, outlined (just outside them) on a close-up. */
async function judgeArea(png: Buffer, W: number, H: number, cells: number[], g: Grid, p: PlaceBrief, kind: keyof typeof AREA): Promise<number> {
  const kx = W / g.cols, ky = H / g.rows;
  let c0 = Infinity, c1 = -Infinity, r0 = Infinity, r1 = -Infinity;
  for (const i of cells) {
    const c = i % g.cols, r = Math.floor(i / g.cols);
    (c0 = Math.min(c0, c)), (c1 = Math.max(c1, c)), (r0 = Math.min(r0, r)), (r1 = Math.max(r1, r));
  }
  const pxm = kx / CELL;
  const S = Math.min(Math.max(Math.round(8 * pxm), Math.round(Math.max((c1 - c0 + 1) * kx, (r1 - r0 + 1) * ky) + 6 * pxm)), W, H);
  const set = new Set(cells), ring = new Set<number>();
  for (const i of cells) for (const j of [i - 1, i + 1, i - g.cols, i + g.cols]) if (j >= 0 && j < g.cols * g.rows && !set.has(j)) ring.add(j);
  const outline = (s: number, left: number, top: number) => [...ring].map((i) => `<rect x="${((i % g.cols) * kx - left) * s}" y="${(Math.floor(i / g.cols) * ky - top) * s}" width="${Math.max(2, kx * s)}" height="${Math.max(2, ky * s)}" fill="#ff00ff"/>`).join('');
  const q = AREA[kind];
  const a = await genai().decide('image.check', {
    state: `${CONTEXT(p)}\nImage 1 is the whole map (the magenta box marks image 2). In image 2, about ${Math.round(S / pxm)} meters across, ${q.note}`,
    questions: { a: { type: 'choice', instructions: q.instructions, criteria: q.criteria } },
    images: await views(png, W, H, ((c0 + c1 + 1) / 2) * kx, ((r0 + r1 + 1) / 2) * ky, S, 768, outline),
  });
  return probYes(a, 'a');
}

/** Luna's probability that a person can cross along a route (cells) we would carve between two cut-off areas. */
export async function judgeRoute(png: Buffer, W: number, H: number, route: number[], g: Grid, p: PlaceBrief): Promise<number> {
  const k = W / g.cols, pxm = k / CELL;
  const xs = route.map((i) => ((i % g.cols) + 0.5) * k), ys = route.map((i) => (Math.floor(i / g.cols) + 0.5) * k);
  const x0 = Math.min(...xs), x1 = Math.max(...xs), y0 = Math.min(...ys), y1 = Math.max(...ys);
  const S = Math.min(W, H, Math.max(Math.round(10 * pxm), Math.round(Math.max(x1 - x0, y1 - y0) + 8 * pxm)));
  const line = (s: number, left: number, top: number) => `<polyline points="${xs.map((x, i) => `${((x - left) * s).toFixed(1)},${((ys[i]! - top) * s).toFixed(1)}`).join(' ')}" fill="none" stroke="#ff00ff" stroke-width="3" stroke-dasharray="10 6"/>`;
  const a = await genai().decide('image.check', {
    state: `${CONTEXT(p)}\nImage 1 is the whole map (the magenta box marks image 2). Image 2, about ${Math.round(S / pxm)} meters across, shows two walkable areas our reader found cut off from each other, and a dashed magenta line where we would open a passage between them.`,
    questions: { a: { type: 'choice', instructions: 'Does the painting show a way for a person to cross along the dashed line: a bridge, stairs, a ramp, an open or closed door, a doorway or opening, stepping stones, or a path or floor that continues? Answer no if the line crosses a wall, a building, a roof, deep water, a cliff, a pit, or dense plants with no way through.', criteria: yesNo('a person can cross here', 'no way across here') } },
    images: await views(png, W, H, (x0 + x1) / 2, (y0 + y1) / 2, S, 768, line),
  });
  return probYes(a, 'a');
}

/** Run tasks a few at a time. */
export async function pool<T, R>(items: T[], n: number, fn: (t: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]!);
    }
  }));
  return out;
}

/**
 * Luna's looks per place while reading it, a hard cap on its OpenAI calls (a look is one decision call with two
 * images, about 2,200 input tokens): areas the readings left in doubt, and crossings between cut-off areas (kept apart
 * so a map with many doubtful areas still gets its bridges checked).
 */
export const DOUBT_LOOKS = 60, CROSS_LOOKS = 15;

/**
 * Where the walk plan opens before Luna looks: the walkable share (edges snapped to the painting) over half, but over
 * WET_CLEAR where any plan painted the cell water, so water one plan drew as ground (a garden pond one plan drew as
 * lawn) waits for Luna's water question instead of opening on a tie.
 */
export function openOf(share: Float32Array, read: Combined): Uint8Array {
  return Uint8Array.from(share, (v, i) => (v > (read.blue[i]! > 0.5 ? WET_CLEAR : 0.5) ? 1 : 0));
}

/**
 * Seams, after the doubtful areas are settled: a blocked line one cell wide with ground on both sides that some plan
 * saw as ground or water is a painted line, a curb, or a gutter, not a wall (every plan draws a wall solid), so it
 * opens; the character's clearance would otherwise make it a barrier three cells wide. Returns how many opened.
 */
export function openSeams(open: Uint8Array, read: Combined, g: Grid): number {
  const seams: number[] = [];
  for (let r = 1; r < g.rows - 1; r++)
    for (let c = 1; c < g.cols - 1; c++) {
      const i = r * g.cols + c;
      if (open[i] || (read.evidence[i]! <= 0.25 && read.blue[i]! <= 0.5)) continue;
      if ((open[i - 1] && open[i + 1]) || (open[i - g.cols] && open[i + g.cols])) seams.push(i);
    }
  for (const i of seams) open[i] = 1;
  return seams.length;
}
const WET_CLEAR = 2 / 3;

/** Doubtful patches smaller than this (m²) are left as read. */
const DOUBT_MIN = 2;
/** Doubtful ground narrower than this (m) is asked about as a strip to step across, not as ground to stand on. */
const WIDE = 1.25;

/** A budget of Luna's looks for one place: once it is spent, every further question takes its default answer. */
export class Looks {
  used = 0;
  readonly max: number;
  constructor(max: number) {
    this.max = max;
  }
  /** Ask, or answer `fallback` without asking when the budget is spent. */
  async ask(fallback: number, q: () => Promise<number>): Promise<number> {
    if (this.used >= this.max) return fallback;
    this.used++;
    return q().catch(() => fallback);
  }
}

/** The walk plans combined per cell. */
interface Combined {
  /** Share of the answering readings' pixels that are walkable (readings weighted by how much of the cell they answered). */
  walk: Float32Array;
  /** The same for water. */
  water: Float32Array;
  /** The most any reading that answered saw the cell as walkable: what tells a bridge one plan drew from a wall. */
  evidence: Float32Array;
  /** The most any reading that answered painted the cell water or void (blue). */
  blue: Float32Array;
  /** Cells some reading painted as part of a thin solid line (narrower than WIDE): a wall, railing, fence, or curb. */
  line: Uint8Array;
}

export function combine(plans: PlanCells[], g: Grid): Combined {
  const n = g.cols * g.rows, line = new Uint8Array(n);
  for (const p of plans) {
    const solid = Uint8Array.from(p.walk, (w, i) => (p.known[i]! > 0.5 && w < 0.5 && p.water[i]! < 0.5 ? 1 : 0));
    const thick = opening(solid, g, Math.floor(WIDE / CELL / 2));
    for (let i = 0; i < n; i++) if (solid[i] && !thick[i]) line[i] = 1;
  }
  const walk = new Float32Array(n), water = new Float32Array(n), evidence = new Float32Array(n), blue = new Float32Array(n);
  for (let i = 0; i < n; i++) {
    let w = 0, s = 0, wet = 0, best = 0, most = 0;
    for (const p of plans) {
      const k = p.known[i]!;
      (w += k), (s += k * p.walk[i]!), (wet += k * p.water[i]!);
      if (k > 0.5) (best = Math.max(best, p.walk[i]!)), (most = Math.max(most, p.water[i]!));
    }
    // A cell no reading answered for is blocked.
    if (w > 0.25) (walk[i] = s / w), (water[i] = wet / w);
    (evidence[i] = best), (blue[i] = most);
  }
  return { walk, water, evidence, blue, line };
}

/**
 * Quiet: where the kind plan paints a cell solid (a plant, a building, or an object), the walk plans' evidence that it
 * might be ground or water is cleared, so Luna is not asked about it and no seam or crossing opens through it. Luna
 * only ever opens cells, so this can only keep her from opening rooftops, tables, and tree crowns.
 */
export function quiet(read: Combined, kinds: PlanCells): void {
  for (let i = 0; i < read.walk.length; i++)
    if (kinds.known[i]! > 0.5 && kinds.walk[i]! < 0.5 && kinds.water[i]! < 0.5) (read.evidence[i] = 0), (read.blue[i] = 0);
}

/**
 * Areas the readings left in doubt, judged on the painting: every blocked patch inside the barrier band and at least
 * DOUBT_MIN m² where a reading saw something the vote did not, one look each, the biggest first while `looks` lasts;
 * those Luna calls walkable open. The patch keeps the shape the reading drew (its furniture stays blocked); Luna only
 * decides whether it is ground. Two kinds:
 * - water: any reading painted it blue (water, a pit, or void). Qwen paints dark floors, corridors, and rugs blue as
 *   often as flooded floor or shallow water, while another plan paints them black, so only a look tells a dark road
 *   from a canal;
 * - seen: a reading painted it walkable but the vote blocked it (an office whose floor one plan saw while the others
 *   filled the room as a building).
 * An area is split by width: its parts at least WIDE across are asked about as above, and the narrower rest (a curb,
 * a gutter, a wall top one plan drew white, or any line another plan drew solid) is asked whether a person can step
 * across it, so a network of thin walls never opens with the rooms it encloses. Returns how many opened.
 */
export async function judgeDoubts(png: Buffer, open: Uint8Array, read: Combined, g: Grid, band: number, p: PlaceBrief, looks: Looks): Promise<number> {
  const { width: W, height: H } = (await sharp(png).metadata()) as { width: number; height: number };
  const inside = (i: number) => Math.min(Math.floor(i / g.cols), i % g.cols, g.rows - 1 - Math.floor(i / g.cols), g.cols - 1 - (i % g.cols)) >= band;
  const doubt = { water: (i: number) => read.blue[i]! > 0.5, seen: (i: number) => read.evidence[i]! > 0.5 };
  const n = g.cols * g.rows, patches: { cells: number[]; kind: keyof typeof AREA }[] = [];
  for (const kind of ['water', 'seen'] as const) {
    const area = Uint8Array.from({ length: n }, (_, i) => (doubt[kind](i) && !open[i] && inside(i) ? 1 : 0));
    // A thin solid line some reading drew (a wall top another reading painted white) is never part of the ground.
    const wide = opening(Uint8Array.from(area, (v, i) => v & (read.line[i] ? 0 : 1)), g, Math.floor(WIDE / CELL / 2));
    for (const cells of components(g, (i) => !!wide[i])) if (cells.length * CELL * CELL >= DOUBT_MIN) patches.push({ cells, kind });
    for (const cells of components(g, (i) => !!area[i] && !wide[i])) if (cells.length * CELL * CELL >= DOUBT_MIN) patches.push({ cells, kind: 'thin' });
  }
  patches.sort((a, b) => b.cells.length - a.cells.length);
  const votes = await pool(patches, 8, (q) => looks.ask(0, () => judgeArea(png, W, H, q.cells, g, p, q.kind)));
  let opened = 0;
  patches.forEach((q, i) => {
    if (votes[i]! <= 0.5) return;
    opened++;
    for (const c of q.cells) open[c] = 1;
  });
  return opened;
}

/** The walkable cell nearest a grid point, within `max` cells. */
function nearestWalk(walk: Uint8Array, g: Grid, cx: number, cy: number, max: number): [number, number] | null {
  let best: [number, number] | null = null, bd = Infinity;
  for (let r = Math.max(0, Math.floor(cy - max)); r <= Math.min(g.rows - 1, Math.ceil(cy + max)); r++)
    for (let c = Math.max(0, Math.floor(cx - max)); c <= Math.min(g.cols - 1, Math.ceil(cx + max)); c++) {
      if (!walk[r * g.cols + c]) continue;
      const d = Math.hypot(c - cx, r - cy);
      if (d < bd && d <= max) (bd = d), (best = [c, r]);
    }
  return best;
}

/** Unnamed landmarks, when Sol names none: the largest solid things (not buildings or water, 0.5 to 40 m²) standing in walkable ground, each at the walkable ground beside it. */
export function landmarks(open: Uint8Array, walk: Uint8Array, building: Uint8Array, water: Uint8Array, g: Grid, W: number, H: number, max = 10): Spot[] {
  const kx = W / g.cols, ky = H / g.rows, out: { spot: Spot; size: number }[] = [];
  for (const q of components(g, (i) => !open[i] && !building[i] && !water[i])) {
    const m2 = q.length * CELL * CELL;
    if (m2 < 0.5 || m2 > 40) continue;
    let sx = 0, sy = 0;
    for (const i of q) (sx += i % g.cols), (sy += Math.floor(i / g.cols));
    const mx = sx / q.length, my = sy / q.length;
    const at = nearestWalk(walk, g, mx, my, 1.5 / CELL + Math.sqrt(q.length / Math.PI));
    if (at) out.push({ spot: { x: (at[0] + 0.5) * kx, y: (at[1] + 0.5) * ky, label: 'a landmark' }, size: q.length });
  }
  return out.sort((a, b) => b.size - a.size).slice(0, max).map((o) => o.spot);
}
