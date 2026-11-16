/**
 * A place, from design to game data: Luna plans it, it is painted as a big top-down map (mapdraw.ts: the whole place
 * closed at full size, each painting judged by the walk reader, then its exits cut), it is read (where people can
 * walk, made usable without repainting: mapread.ts, mapfix.ts), Luna decides where everything goes, and the map is resampled to game scale and
 * turned into ground meters (the navigation grid, every door, exit, person, chest, and monster pack). See
 * docs/places.md.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import {
  BitSet, NAV_CELL, Nav, PX_PER_METER, Rng, pictureToGround,
  type AssetRecord, type FeatureDef, type NavDef, type Vec2, type WorldDefinition, type ZoneDef, type ZoneKind,
  wayDrawnInside,
} from '@daydream/shared';
import { DESIGN_PARTY, buildPack } from '../rules/encounters.ts';
import { worldAssetDir, worldDir, writeJsonAtomic } from '../storage.ts';
import type { GpuQueue } from './gpu.ts';
import { atStep } from '../genai/meter.ts';
import { BARRIER_DEPTH_M, EXIT_GAP_M, MAP_STEPS, PAINT_PXM, makeMap, mapGrid, mapPixels, planMap, type MapBrief, type MapExit, type MapPlan, type Tiles } from './mapdraw.ts';
import { CELL, type Grid, type Side } from './mapgrid.ts';
import { fixMap } from './mapfix.ts';
import { BUILDING_PLAN, combine, gptPlans, gptReading, gptReadModels, judgeRoute, judgeDoubts, KIND_PLAN, kindPixel, landmarks, Looks, DOUBT_LOOKS, CROSS_LOOKS, openOf, openSeams, planCells, planPicture, quiet, WALK_READINGS, type PlanCells } from './mapread.ts';
import { refine } from './mapedge.ts';
import { alignPlan } from './mapalign.ts';
import { doorMarks, dropSameBuilding, findEntrances, fuseDoors, GPT_DOOR_MODEL, GPT_DOOR_PLAN, nameLandmarks, ontoWalk, readDoorPlan, type DoorMark, type Spot } from './mapspots.ts';
import { candidates, edgeExits, place, type Candidate, type MapReading, type PlaceNeeds } from './placement.ts';
import { MIST_SIZE, makeMist, measureLight, type MistBrief } from './atmosphere.ts';

/** A color as the game draws it: '#a1b2c3' from '#a1b2c3', 'a1b2c3', '#abc', or a color name. */
const NAMED: Record<string, string> = {
  black: '#202020', white: '#f0f0f0', gray: '#808080', grey: '#808080', red: '#b03030', crimson: '#a01830', green: '#4a8a3a', blue: '#3a5aa0',
  yellow: '#d8c040', gold: '#d0a040', orange: '#d07a30', purple: '#7a4a9a', violet: '#8a5ac0', brown: '#7a5232', pink: '#d880a0', teal: '#3a8a8a',
  cyan: '#40c0d0', silver: '#c0c0c8', beige: '#d8c8a0', tan: '#c0a070', navy: '#283868', olive: '#6a7a30', maroon: '#702028', ivory: '#f0ead0',
};

function normColor(c: string | undefined): string | undefined {
  if (!c) return undefined;
  const t = c.trim().toLowerCase();
  const m6 = t.match(/^#?([0-9a-f]{6})$/);
  if (m6) return `#${m6[1]}`;
  const m3 = t.match(/^#?([0-9a-f])([0-9a-f])([0-9a-f])$/);
  if (m3) return `#${m3[1]}${m3[1]}${m3[2]}${m3[2]}${m3[3]}${m3[3]}`;
  for (const [name, v] of Object.entries(NAMED)) if (t.includes(name)) return v;
  return undefined;
}

/** Monster packs keep their distance so fighting one never drags in the next (aggro reaches about 6.5 m). */
const PACK_SPACING = 13;
/** And from the ways in: a party arriving stands out of reach of every member (aggro 6.5 m, packs about 3 m across). */
const PACK_FROM_DOOR = 11;
/** A pack's center keeps this far (m) from anything blocked where the map has room: in a room or clearing, not a passage. */
const PACK_CLEARANCE = 2;

const THING_KINDS = new Set(['chest', 'sign', 'lore', 'waypoint', 'craft_station', 'storage']);

/** A place as far as painting and reading it go: what it is, its buildings, and its ways out (ids are the world's). */
interface PlaceSketch extends Pick<PlaceNeeds, 'name' | 'description' | 'buildings'> {
  id: string;
  kind: ZoneKind;
  /** The map's size (chosen when the world is planned). */
  tiles: Tiles;
  indoor: boolean;
  lore?: string;
  /** Ways out. Those across the edge (not `into`) leave on a side of the map, toward where they lead on the world map. */
  exits: { id: string; to: string; into?: boolean; side?: Side }[];
}

/** The world as every place's design sees it. */
interface WorldLook {
  id: string;
  /** Title and pitch. */
  story: string;
  artStyle: string;
}

export const worldLook = (w: WorldDefinition): WorldLook => ({ id: w.id, story: `${w.concept.title}. ${w.concept.pitch}`, artStyle: w.concept.artStyle });

/** The side of a map facing another place on the world map (y runs down the map, as on the screen). */
function sideToward(from: { x: number; y: number }, to: { x: number; y: number } | undefined): Side {
  if (!to) return 'bottom';
  const dx = to.x - from.x, dy = to.y - from.y;
  return Math.abs(dx) > Math.abs(dy) ? (dx > 0 ? 'right' : 'left') : dy < 0 ? 'top' : 'bottom';
}

export function sketchOf(w: WorldDefinition, z: ZoneDef): PlaceSketch {
  const target = (f: FeatureDef) => w.zones.find((x) => x.id === f.targetZoneId);
  return {
    id: z.id,
    name: z.name,
    kind: z.kind,
    tiles: z.tiles,
    indoor: !!z.indoor,
    description: z.description,
    lore: z.lore,
    buildings: (z.buildings ?? []).map((b) => ({ id: b.id, name: b.name, purpose: b.purpose })),
    exits: z.features.filter((f) => f.kind === 'exit').map((f) => {
      // A way down into a dungeon is drawn inside the map; other ways out face where they lead.
      const into = wayDrawnInside(z, target(f));
      return { id: f.id, to: target(f)?.name ?? 'elsewhere', into, side: into ? undefined : sideToward(z.mapPos, target(f)?.mapPos) };
    }),
  };
}

/** What a person is for visitors, in words. */
const roleWords = (n: WorldDefinition['npcs'][number]) =>
  n.role === 'merchant' ? `sells ${n.merchantKind === 'general' || !n.merchantKind ? 'supplies' : n.merchantKind}` : n.role === 'story' ? 'in the story' : 'lives here';

/** What the place must hold: its entrances, ways out, people, and things (by world id). */
function placeNeeds(w: WorldDefinition, z: ZoneDef): PlaceNeeds {
  return {
    ...sketchOf(w, z),
    people: w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ id: n.id, name: n.name, title: n.title, role: roleWords(n), works: z.buildings?.find((b) => b.npcId === n.id)?.name })),
    things: z.features.filter((f) => THING_KINDS.has(f.kind)).map((f) => ({ id: f.id, what: thingText(f) })),
    bosses: w.bosses.filter((b) => b.zoneId === z.id).map((b) => ({ id: b.id, name: b.name, what: b.description.slice(0, 200) })),
  };
}

function thingText(f: FeatureDef): string {
  switch (f.kind) {
    case 'chest':
      if (f.questId) return `${f.name}: something a quest sends travelers here to find (where such a thing would be kept, dropped or hidden)`;
      return f.hidden ? 'a stash someone tucked away, out of the way of passers-by' : 'a treasure chest';
    case 'sign': return 'a signpost greeting travelers';
    case 'lore': return f.text ? `a note or inscription, ${f.text}: "${f.name}"` : `a note or inscription: "${f.name}"`;
    case 'waypoint': return 'the waypoint travelers use (central, easy to find)';
    case 'craft_station': return 'the workbench everyone crafts at (in plain view by a main street or square, easy to find)';
    case 'storage': return 'the store where travelers keep their belongings (in plain view by a main street or square, easy to find)';
    default: return f.name ?? 'something to look at';
  }
}

/** The ways out across the edge, as sides of the map. */
const edgeSides = (s: PlaceSketch): Side[] => s.exits.filter((e) => !e.into).map((e) => e.side ?? 'bottom');

function mapBrief(w: WorldLook, s: PlaceSketch): MapBrief {
  return {
    world: w.story,
    artStyle: w.artStyle,
    name: s.name,
    kind: s.kind,
    tiles: s.tiles,
    indoor: s.indoor,
    description: s.description,
    lore: s.lore,
    buildings: s.buildings.map((b) => ({ name: b.name, purpose: b.purpose })),
    sides: edgeSides(s),
    inner: s.exits.filter((e) => e.into).map((e) => `a way down or in to ${e.to}`),
  };
}

/** Saved steps of one place's making, so a resumed build picks up where it stopped. */
class PlaceDraft {
  readonly dir: string;
  constructor(worldId: string, zoneId: string) {
    this.dir = path.join(worldDir(worldId), 'draft', 'places', zoneId);
  }
  json<T>(name: string): T | undefined {
    const f = path.join(this.dir, `${name}.json`);
    return fs.existsSync(f) ? (JSON.parse(fs.readFileSync(f, 'utf8')) as T) : undefined;
  }
  saveJson(name: string, v: unknown) {
    writeJsonAtomic(path.join(this.dir, `${name}.json`), v);
  }
  file(name: string): Buffer | undefined {
    const f = path.join(this.dir, name);
    return fs.existsSync(f) ? fs.readFileSync(f) : undefined;
  }
  saveFile(name: string, b: Buffer) {
    fs.mkdirSync(this.dir, { recursive: true });
    fs.writeFileSync(path.join(this.dir, name), b);
  }
  png(name: string): Buffer | undefined {
    return this.file(`${name}.png`);
  }
  savePng(name: string, b: Buffer) {
    this.saveFile(`${name}.png`, b);
  }
  /** A per-cell mask, saved as a gray PNG one pixel per cell. */
  async cells(name: string, g: Grid): Promise<Uint8Array | undefined> {
    const f = this.png(name);
    if (!f) return undefined;
    const raw = await sharp(f).greyscale().resize(g.cols, g.rows, { kernel: 'nearest' }).raw().toBuffer();
    return Uint8Array.from(raw, (v) => (v > 127 ? 1 : 0));
  }
  async saveCells(name: string, m: Uint8Array, g: Grid) {
    this.savePng(name, await sharp(Buffer.from(m.map((v) => (v ? 255 : 0))), { raw: { width: g.cols, height: g.rows, channels: 1 } }).png().toBuffer());
  }
}

export interface PlaceContext {
  gpu: GpuQueue;
  /** Lower paints first (the starting town before anything else). */
  priority: number;
  seed: number;
  /** The build has stopped: a reading batch still out is left for the build's resuming. */
  stopped?: () => boolean;
  report: (msg: string) => void;
  /** Steps done / total, for progress. */
  onPart?: (done: number, total: number) => void;
  /** A painting tried, set aside, or the layout redrawn (MapRun.noted). */
  noted?: (what: 'tried' | 'setAside' | 'relaid') => void;
}

/** A place painted and read, before anything is put in it. */
export interface Painted {
  plan: MapPlan;
  /** Which of the place's maps (its seed): what is placed in it is saved per map. */
  seed: number;
  /** The finished (repaired) map. */
  canvas: Buffer;
  reading: MapReading;
}

/**
 * Design and paint a place's map, and where people can walk on it: all it needs is what the place is, so it can start
 * before the world is assembled. Every step is saved in the place's draft, so a stopped build resumes.
 */
export async function paintAndRead(w: WorldLook, s: PlaceSketch, ctx: PlaceContext): Promise<Painted> {
  const draft = new PlaceDraft(w.id, s.id);
  const brief = mapBrief(w, s);
  const plan = draft.json<MapPlan>('plan') ?? (await atStep('places.plan', () => planMap(brief)));
  draft.saveJson('plan', plan);
  const g = mapGrid(s.tiles);
  const made = await atStep('places.paint', () => makeMap(brief, plan, ctx.seed, {
    gpu: (model, fn) => ctx.gpu.run(model, ctx.priority, fn),
    read: async (png, name) => ({ open: (await readOpen(draft, png, name, s, ctx)).open, g }),
    draft,
    report: ctx.report,
    step: (k) => ctx.onPart?.(k, MAP_STEPS),
    noted: ctx.noted,
  }));
  ctx.report(`${s.name}: map made (${made.sound ? 'sound' : `${Math.round(made.cutOff * 100)}% cut off`})`);
  const reading = await atStep('places.read', () => readPlace(draft, made.png, s, made.exits, ctx, made.judged));
  return { plan: made.plan, seed: ctx.seed, canvas: made.png, reading };
}

/**
 * The walk reader's open cells for a painting (mapread.ts). With the image.read purpose GPT Image reads it
 * (readOpenGpt), and its plans' buildings stand in for `more`. Without it Qwen does, on the GPU (steps 1 to 4): its
 * walk and kind plans (and `more`), combined, snapped to the painting's edges, and Luna's looks where they left doubt.
 * Saved in the draft under `tag`, so a resumed build or a second look at the same painting asks nothing again.
 */
async function readOpen(draft: PlaceDraft, map: Buffer, tag: string, s: PlaceSketch, ctx: PlaceContext, more: (typeof BUILDING_PLAN)[] = []) {
  const g = mapGrid(s.tiles);
  if (gptReading()) return readOpenGpt(draft, map, tag, s, ctx, g);
  const band = Math.ceil(BARRIER_DEPTH_M / CELL), place = { name: s.name, description: s.description };
  // Qwen's plan pictures are kept whole in the draft: the reader uses their transparency, and a later change to how
  // they are read needs no GPU. All are queued at once, so Qwen paints them back to back without a model switch.
  const all = [...WALK_READINGS, KIND_PLAN, ...more];
  const pics = await Promise.all(
    all.map(async (plan, i) => {
      const name = `${tag}_plan${i}`;
      let pic = draft.png(name);
      if (!pic) {
        pic = await ctx.gpu.run('reader', ctx.priority, () => planPicture(map, plan, ctx.seed));
        draft.savePng(name, pic);
      }
      return pic;
    }),
  );
  const plans: PlanCells[] = [];
  for (const [i, plan] of all.entries()) plans.push(await planCells(pics[i]!, g, plan === KIND_PLAN ? kindPixel : undefined));
  const read = combine(plans.slice(0, WALK_READINGS.length), g);
  quiet(read, plans[WALK_READINGS.length]!);
  let open = await draft.cells(`${tag}_open`, g);
  if (!open) {
    const share = await refine(map, read.walk, g);
    open = openOf(share, read);
    const wet = await judgeDoubts(map, open, read, g, band, place, new Looks(DOUBT_LOOKS));
    openSeams(open, read, g);
    ctx.report(`${s.name}: read from ${WALK_READINGS.length} plans${wet ? `; Luna opened ${wet} areas the plans disagreed on` : ''}`);
    await draft.saveCells(`${tag}_open`, open, g);
  }
  return { open, read, plans: plans.slice(WALK_READINGS.length + 1) };
}

/**
 * The GPT reader's open cells (mapread.ts): one kind plan per model, each lined up with the painting, voted as the walk
 * plans are and snapped to the painting's edges, with no Luna and no seams (GPT's plans draw no curbs or painted lines
 * as solid; opening one-cell lines only reopened walls one plan missed). A cell is a building where at least half the plans paint it red. The pictures are
 * saved per model, each as it arrives, and the open cells per set of models, so changing the models reads the painting
 * again.
 */
async function readOpenGpt(draft: PlaceDraft, map: Buffer, tag: string, s: PlaceSketch, ctx: PlaceContext, g: Grid) {
  const models = gptReadModels();
  const missing = models.filter((m) => !draft.png(`${tag}_${m}`));
  if (missing.length) {
    const noted = () => draft.json<Record<string, string>>(`${tag}_batches`) ?? {};
    const notes = { get: (m: string) => noted()[m], set: (m: string, id: string | undefined) => draft.saveJson(`${tag}_batches`, { ...noted(), [m]: id }) };
    await gptPlans(map, missing, { notes, keep: (m, pic) => draft.savePng(`${tag}_${m}`, pic), stopped: ctx.stopped });
  }
  // Each plan is moved back onto the painting before it is read: GPT Image redraws the map shifted and stretched by up
  // to a meter, and two plans that disagree that much vote every thin wall away (mapalign.ts).
  const pics = models.map((m) => draft.png(`${tag}_${m}`)!);
  const plans = await Promise.all(pics.map(async (pic) => planCells(await alignPlan(map, pic), g, kindPixel)));
  const read = combine(plans, g);
  const set = crypto.createHash('sha1').update(models.join('|')).digest('hex').slice(0, 8);
  let open = await draft.cells(`${tag}_gpt${set}a_open`, g);
  if (!open) {
    open = openOf(await refine(map, read.walk, g), read);
    ctx.report(`${s.name}: read from ${plans.length} GPT Image plans`);
    await draft.saveCells(`${tag}_gpt${set}a_open`, open, g);
  }
  const building = Uint8Array.from(plans[0]!.building, (_, i) => (2 * plans.reduce((a, p) => a + p.building[i]!, 0) >= plans.length ? 1 : 0));
  return { open, read, plans: [{ ...plans[0]!, building }] };
}

/**
 * GPT Image's door marks of a map (mapspots.ts, GPT_DOOR_PLAN). Its picture is saved in the draft under `tag`, so a
 * resumed build pays for it once; a batch it waits on is noted there too.
 */
async function gptDoors(draft: PlaceDraft, map: Buffer, tag: string, W: number, H: number, ctx: PlaceContext): Promise<DoorMark[]> {
  const name = `${tag}_doors`;
  let pic = draft.png(name);
  if (!pic) {
    const noted = () => draft.json<Record<string, string>>(`${name}_batches`) ?? {};
    const notes = { get: (m: string) => noted()[m], set: (m: string, id: string | undefined) => draft.saveJson(`${name}_batches`, { ...noted(), [m]: id }) };
    pic = (await gptPlans(map, [GPT_DOOR_MODEL], { notes, keep: (_, p) => draft.savePng(name, p), plan: GPT_DOOR_PLAN, stopped: ctx.stopped }))[0]!;
  }
  return doorMarks(await alignPlan(map, pic), W, H, PAINT_PXM);
}

/**
 * Read a painted map (mapread.ts, then mapfix.ts): the reader's plans of it (GPT Image's, or Qwen's with Luna where
 * they split and on its water), the fixes that make it usable, and its entrances, named landmarks, and ways out (mapspots.ts). Every step is saved per
 * map, so a resumed build picks up where it stopped. `judged` names the painting the map was made from, already read
 * when it was judged: the map differs from it only where ways out were cut and stray openings closed, which the fixes
 * open and block anyway, so its walk reading is used and Qwen paints only the building plan (GPT Image's plans have
 * the buildings already, so it paints nothing).
 */
async function readPlace(draft: PlaceDraft, map: Buffer, s: PlaceSketch, exits: MapExit[], ctx: PlaceContext, judged?: string): Promise<MapReading> {
  const { W, H, X, Y } = mapPixels(s.tiles);
  const g = mapGrid(s.tiles);
  // The reading's steps carry the reader and its version (r4 Qwen, g2 GPT Image with its plans lined up), so a place
  // read by another reader is read again.
  const rtag = `${gptReading() ? 'g2' : 'r4'}_${ctx.seed}`, place = { name: s.name, description: s.description };
  const band = Math.ceil(BARRIER_DEPTH_M / CELL), gap = EXIT_GAP_M / CELL;
  const { open, read, plans } = await readOpen(draft, map, judged ?? rtag, s, ctx, [BUILDING_PLAN]);
  const building = plans[0]!.building;
  const crossLooks = new Looks(CROSS_LOOKS);
  let walk = await draft.cells(`walk_${rtag}`, g);
  let fixedOpen = await draft.cells(`fixed_${rtag}`, g);
  if (!walk || !fixedOpen) {
    const confirm = async (route: number[]) => (await crossLooks.ask(0, () => judgeRoute(map, W, H, route, g, place))) > 0.5;
    const f = await fixMap(open, g, exits, band, gap, { evidence: read.evidence, confirm });
    ctx.report(`${s.name}: ${f.joined} cut-off areas joined, ${f.left} left out${f.exits ? `, ${f.exits} ways out opened` : ''} (Luna: ${crossLooks.used} looks at crossings)`);
    walk = f.walk;
    fixedOpen = f.open;
    await draft.saveCells(`walk_${rtag}`, walk, g);
    await draft.saveCells(`fixed_${rtag}`, fixedOpen, g);
  }
  const water = Uint8Array.from(read.water, (v) => (v > 0.5 ? 1 : 0));
  let spots = draft.json<{ doors: Spot[]; landmarks: Spot[] }>(`spots_${rtag}`);
  if (!spots) {
    const pxm = PAINT_PXM;
    // Entrances only where the place has buildings: Luna's finds, moved onto the door plan's marks (marks she missed
    // are kept too), onto the walkable ground, then one per building.
    const doors = async () => {
      // The door plan (Qwen on the GPU, or GPT Image when it reads the maps) and Luna's search at once.
      const [marks, entrances] = await Promise.all([gptReading() ? gptDoors(draft, map, rtag, W, H, ctx) : ctx.gpu.run('reader', ctx.priority, () => readDoorPlan(map, pxm, ctx.seed)), findEntrances(map, pxm, place)]);
      const found = fuseDoors(entrances, marks, pxm);
      const missed = marks.filter((m) => m.building && found.every((f) => Math.hypot(f.x - m.x, f.y - m.y) >= 2 * pxm)).map((m) => ({ x: m.x, y: m.y, label: 'a building' }));
      return dropSameBuilding(map, pxm, place, ontoWalk([...found, ...missed], walk!, g, W, H));
    };
    const [d, named] = await Promise.all([s.buildings.length ? doors() : Promise.resolve([]), nameLandmarks(map, pxm, place).catch((): Spot[] => [])]);
    // People stand on the walkable ground nearest a landmark (a pond's shore, a statue's foot).
    const sights = named.length ? ontoWalk(named, walk, g, W, H, 15) : landmarks(fixedOpen, walk, building, water, g, W, H);
    spots = { doors: d, landmarks: sights };
    ctx.report(`${s.name}: ${d.length} entrances; landmarks: ${sights.map((m) => m.label).join(', ')}`);
    draft.saveJson(`spots_${rtag}`, spots);
  }
  const inset = (BARRIER_DEPTH_M + 2) * PAINT_PXM;
  const edges: Spot[] = exits.map((e) => {
    const a = e.at * (e.side === 'top' || e.side === 'bottom' ? W : H);
    return { x: e.side === 'left' ? inset : e.side === 'right' ? W - inset : a, y: e.side === 'top' ? inset : e.side === 'bottom' ? H - inset : a, label: e.side };
  });
  return {
    width: W, height: H, X, Y, grid: g, walk,
    // Buildings block sight; the rest of what blocks walking is mostly low (props, rocks) or seen through (trees' gaps).
    sight: Uint8Array.from(building, (v) => (v ? 0 : 1)),
    doors: spots.doors,
    edges,
    landmarks: spots.landmarks,
    area: walk.reduce((a, v) => a + v, 0) * CELL * CELL,
  };
}

/**
 * Put everything in a made place (Luna decides where), bring the map to game scale and turn it into game data:
 * mutates the zone, the world's NPCs, and its assets.
 */
export async function settlePlace(w: WorldDefinition, z: ZoneDef, { plan, seed, canvas, reading }: Painted, ctx: PlaceContext): Promise<void> {
  const draft = new PlaceDraft(w.id, z.id);
  const needs = placeNeeds(w, z);
  z.design = { style: plan.style, layout: plan.plan };
  z.look = { ambient: plan.look.ambient, lightColor: normColor(plan.look.lightColor) ?? '#ffe8c0', fogColor: normColor(plan.look.fogColor) ?? '#101418', outdoor: plan.look.outdoor && !z.indoor, weather: z.indoor ? 'none' : plan.look.weather };
  const cands = candidates(reading);
  // A way out across the edge stands at the gap cut for it on its side; Luna places the rest.
  const edge = edgeExits(sketchOf(w, z).exits, cands);
  const rest = { ...needs, exits: needs.exits.filter((x) => !edge.has(x.id)) };
  // Spots are picture positions, so a saved placement belongs to one map (a resumed build may pick another).
  const placed = draft.json<[string, Candidate][]>(`placement_${seed}`);
  // The place's mist is designed while Luna places everything.
  const [spots, mist] = await Promise.all([
    placed ? new Map(placed) : atStep('places.furnish', () => place(canvas, rest, cands)).then((p) => new Map([...edge, ...p.spots])),
    atStep('places.mist', () => makeMist(mistBrief(z), draft, ctx.seed)),
  ]);
  draft.saveJson(`placement_${seed}`, [...spots.entries()]);

  // The painted maps are drawn about 1.2× (PAINT_PXM to PX_PER_METER), which plain resampling handles.
  const k = GAME_SCALE;
  const FW = Math.round(reading.width * k), FH = Math.round(reading.height * k);
  const image = await sharp(canvas).resize(FW, FH, { kernel: 'lanczos3' }).webp({ quality: 90 }).toBuffer();
  const key = saveAsset(w, `place_${z.id}`, image, { kind: 'painting', prompt: `map of ${z.name}`, width: FW, height: FH });
  await setAir(w, z, image, mist);

  furnish(w, z, reading, spots, { k, width: FW, height: FH, image: key });
}

/**
 * Write a place's image into the world's assets (replacing its earlier file) and record it; returns its key. The file
 * is named by its content: the same picture keeps its name when a resumed build lays the place out again (pages
 * showing it go on finding it, browsers keep it cached), and a new one gets a new name.
 */
function saveAsset(w: WorldDefinition, key: string, image: Buffer, rec: Pick<AssetRecord, 'kind' | 'prompt' | 'width' | 'height'>): string {
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  const file = `${key}_${crypto.createHash('sha256').update(image).digest('hex').slice(0, 12)}.webp`;
  for (const f of fs.readdirSync(dir)) if (f.startsWith(`${key}_`) && f !== file) fs.rmSync(path.join(dir, f));
  if (!fs.existsSync(path.join(dir, file))) fs.writeFileSync(path.join(dir, file), image);
  w.assets[key] = { key, file, status: 'ok', ...rec };
  return key;
}

const mistBrief = (z: ZoneDef): MistBrief => ({
  name: z.name, kind: z.kind, indoor: !!z.indoor, description: z.description, style: z.design?.style,
  weather: z.look.weather, fogColor: z.look.fogColor, lightColor: z.look.lightColor,
});

/** A place's air and light: its mist tile saved with its assets, and the light measured from its map. */
async function setAir(w: WorldDefinition, z: ZoneDef, painting: Buffer, mist: Buffer): Promise<void> {
  z.look.mist = saveAsset(w, `mist_${z.id}`, mist, { kind: 'texture', prompt: `mist of ${z.name}`, width: MIST_SIZE, height: MIST_SIZE });
  z.look.painted = await measureLight(painting);
}

/** Game scale: the map is resized by this so a meter is PX_PER_METER pixels, the scale figures are drawn at. */
const GAME_SCALE = PX_PER_METER / PAINT_PXM;

/** The map laid on the ground at game scale `k`: its size, where the ground origin sits (its top left) and its navigation grid. */
function groundOf(r: MapReading, k: number): { width: number; height: number; ox: number; oy: number; nav: NavDef } {
  const width = Math.round(r.width * k), height = Math.round(r.height * k);
  const cols = Math.ceil(r.X / NAV_CELL), rows = Math.ceil(r.Y / NAV_CELL);
  const walk = new BitSet(cols * rows), sight = new BitSet(cols * rows);
  const cell = (x: number, y: number) => {
    const c = Math.floor(x / CELL), rr = Math.floor(y / CELL);
    return c < 0 || rr < 0 || c >= r.grid.cols || rr >= r.grid.rows ? -1 : rr * r.grid.cols + c;
  };
  // A cell is walkable when any part of it is (its center and eight points 0.2 m out): the plan already keeps a
  // character's center CLEARANCE from obstacles, and the pathfinder never cuts corners, so a diagonal passage sampled at
  // cell centers alone would break into corner-touching cells.
  const Q = NAV_CELL / 2.5, AROUND = [-Q, 0, Q].flatMap((dx) => [-Q, 0, Q].map((dy) => [dx, dy] as const));
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL, y = (cy + 0.5) * NAV_CELL, i = cell(x, y);
      if (i >= 0 && r.sight[i]) sight.set(cy * cols + cx);
      if (AROUND.some(([dx, dy]) => {
        const j = cell(x + dx, y + dy);
        return j >= 0 && r.walk[j];
      })) walk.set(cy * cols + cx);
    }
  return { width, height, ox: 0, oy: 0, nav: { cols, rows, walk: walk.encode(), sight: sight.encode() } };
}

/**
 * Lay the map on the ground: the navigation grid, and positions in ground meters for everything placed. What Luna
 * could not place is set down by rule (people and things at open spots, monster packs by depth).
 */
function furnish(w: WorldDefinition, z: ZoneDef, r: MapReading, spots: Map<string, Candidate>, pic: { k: number; width: number; height: number; image: string }) {
  const rng = new Rng(`${w.id}:${z.id}:furnish`);
  const { ox, oy, nav: grid } = groundOf(r, pic.k);
  z.painting = { image: pic.image, width: pic.width, height: pic.height, ox, oy };
  z.nav = grid;
  z.width = grid.cols * NAV_CELL;
  z.height = grid.rows * NAV_CELL;
  const nav = new Nav(z.nav);

  const taken: Vec2[] = [];
  const free = (cx: number, cy: number) => {
    if (!nav.walkableCell(cx, cy)) return false;
    const c = nav.center(cx, cy);
    return taken.every((t) => Math.hypot(t.x - c.x, t.y - c.y) >= 0.9);
  };
  const at = (c: Candidate) => pictureToGround(c.x * pic.k, c.y * pic.k, ox, oy);
  /** A free walkable point near a spot (people and things never share a point). */
  const settle = (p: Vec2): Vec2 => {
    const q = nav.nearestWalkable(p, 8, free) ?? nav.nearestWalkable(p, 400) ?? p;
    taken.push(q);
    return q;
  };
  const openSpots = [...new Set([...spots.values()].filter((c) => c.id[0] === 'P' || c.id[0] === 'L'))];
  const allOpen = candidates(r).filter((c) => c.id[0] === 'P' || c.id[0] === 'L');
  const fallbackSpot = () => at(rng.pick(allOpen.length ? allOpen : openSpots.length ? openSpots : candidates(r)));

  // Ways out stand where the map has them. A way out at the map's edge stands two meters inside the barrier (its spot,
  // readPlace), on ground the mist at the edge leaves clear; a way down drawn inside the map stands at its foot.
  for (const f of z.features) {
    if (f.kind !== 'exit') continue;
    const c = spots.get(f.id);
    // (A spot the reading left off the walkable ground still gets the nearest point people can reach; placement
    // insists on every way out, so a missing one only guards a resumed draft.)
    const p = c ? nav.nearestWalkable(at(c), 6) ?? nav.nearestWalkable(at(c), 400) ?? at(c) : settle(fallbackSpot());
    f.x = p.x;
    f.y = p.y;
    taken.push(p);
  }
  // People who work in a building stand outside its entrance; everyone else where Luna put them.
  for (const n of w.npcs.filter((x) => x.zoneId === z.id)) {
    const work = z.buildings?.find((b) => b.npcId === n.id);
    const c = (work && spots.get(work.id)) || spots.get(n.id);
    const p = settle(c ? at(c) : fallbackSpot());
    n.x = p.x;
    n.y = p.y;
  }
  for (const f of z.features.filter((x) => THING_KINDS.has(x.kind))) {
    const c = spots.get(f.id);
    const p = settle(c ? at(c) : fallbackSpot());
    f.x = p.x;
    f.y = p.y;
  }

  // Arrival (where a new party starts, and a party with no way in to come by): in a town its heart, among its people;
  // elsewhere the main way in (the waypoint, else the first way out).
  const people = w.npcs.filter((n) => n.zoneId === z.id);
  const heart = z.kind === 'town' ? heartOf(nav, [...people, ...z.features.filter((f) => THING_KINDS.has(f.kind))], z.features) : null;
  const entryFeature = z.features.find((f) => f.kind === 'waypoint') ?? z.features.find((f) => f.kind === 'exit');
  z.entry = heart ?? (entryFeature ? { x: entryFeature.x, y: entryFeature.y } : settle(fallbackSpot()));

  // A boss waits in the lair Luna chose for it (its spot), else deep in (populate).
  const lairs = new Map([...spots].filter(([id]) => w.bosses.some((b) => b.id === id)).map(([id, c]) => [id, at(c)]));
  if (z.kind === 'wilderness' || z.kind === 'dungeon') populate(w, z, nav, rng, r.area, taken, lairs);
}

/**
 * Monster packs and the bosses, spread by walking distance from the way in (deeper = harder, except around what a
 * quest sends the party to find, which nothing above the quest's level guards). Packs gather in open ground (rooms,
 * clearings, squares), never passages: their centers keep PACK_CLEARANCE from anything blocked. A boss waits in its
 * lair (a spot placement chose), else as deep in as it can, apart from the other bosses.
 */
export function populate(w: WorldDefinition, z: ZoneDef, nav: Nav, rng: Rng, area: number, taken: Vec2[], lairs = new Map<string, Vec2>()) {
  const r = w.ruleset;
  const costs = nav.reach(z.entry, 1e6);
  if (!costs.size) return;
  const far = Math.max(...costs.values());
  const cells = [...costs.keys()].map((i) => ({ i, p: nav.center(i % nav.cols, Math.floor(i / nav.cols)), depth: costs.get(i)! / far }));
  rng.shuffle(cells);
  // The ways in, and where a party coming through each stands (no pack within sight of an arriving party).
  const doors = z.features.filter((f) => f.kind === 'exit').flatMap((f) => [f, nav.arrival(f)]);
  const nearDoor = (p: Vec2, d: number) => doors.some((f) => Math.hypot(f.x - p.x, f.y - p.y) < d) || Math.hypot(p.x - z.entry.x, p.y - z.entry.y) < d;
  const families = z.familyIds.map((id) => w.families.find((f) => f.id === id)!).filter(Boolean);
  const around = (center: Vec2, radius: number, n: number): Vec2[] => {
    const out: Vec2[] = [];
    for (const i of rng.shuffle(nav.cellsWithin(center, radius))) {
      if (out.length >= n) break;
      const c = nav.center(i % nav.cols, Math.floor(i / nav.cols));
      if ([...out, ...taken].every((o) => Math.hypot(o.x - c.x, o.y - c.y) >= 0.9)) out.push(c);
    }
    return out;
  };
  // A group's creatures are `<group>_<n>`: the adventure keeps who is dead by these ids, so groups are named apart.
  const spawnAt = (groupId: string, members: { member: number; level: number; boss?: boolean }[], center: Vec2, familyId: string, bossId?: string) => {
    const pts = around(center, members.length > 3 ? 3.2 : 2.6, members.length);
    members.forEach((m, i) => {
      const p = pts[i] ?? center;
      taken.push(p);
      z.spawns.push({ id: `${groupId}_${i}`, kind: 'monster', familyId, member: m.member, level: m.level, x: p.x, y: p.y, groupId, ...(m.boss && bossId ? { bossId } : {}) });
    });
  };

  // Each boss waits in its lair; one without a lair it can be reached in waits in open ground as deep in as it can, a
  // pack's spacing from the other bosses (so two fights never stand on one spot) while there is room.
  const bosses = w.bosses.filter((b) => b.zoneId === z.id);
  const clear = clearance(nav);
  const byDepth = [...cells].sort((a, b) => b.depth - a.depth);
  const open = byDepth.filter((c) => clear[c.i]! >= PACK_CLEARANCE);
  const ground = open.length ? open : byDepth;
  const reached = (p: Vec2) => costs.has(nav.cellOf(p.x, p.y)[1] * nav.cols + nav.cellOf(p.x, p.y)[0]);
  const lair = new Map<string, Vec2>();
  for (const b of bosses) if (lairs.has(b.id) && reached(lairs.get(b.id)!)) lair.set(b.id, lairs.get(b.id)!);
  for (const b of bosses) {
    if (lair.has(b.id)) continue;
    const apart = ground.find((c) => [...lair.values()].every((q) => Math.hypot(q.x - c.p.x, q.y - c.p.y) >= PACK_SPACING));
    lair.set(b.id, (apart ?? ground[0]!).p);
  }
  const lairOf = (id: string) => lair.get(id)!;
  for (const b of bosses) {
    const fam = w.families.find((f) => f.id === b.familyId) ?? families[0];
    if (!fam) continue;
    // A boss stands for itself (its own kind of fighter and classes) with a few of its family about it. A named foe is
    // one of its family's members with a name of its own, leading an ordinary pack of its kind at its level.
    const own = b.member ? Math.max(0, fam.members.findIndex((m) => m.name === b.member)) : 0;
    const rest = b.member
      ? buildPack(r, rng.fork(`boss:${b.id}`), { heroes: DESIGN_PARTY, level: b.level, kind: 'normal', members: fam.members, depth: 1 }).slice(1)
      : buildPack(r, rng.fork(`boss:${b.id}`), { heroes: DESIGN_PARTY, level: b.level, kind: 'boss', members: fam.members }).filter((m) => !m.boss).map((m) => ({ ...m, level: Math.max(1, b.level - 1) }));
    spawnAt(`${z.id}_${b.id}`, [{ member: own, level: b.level, boss: true }, ...rest], lairOf(b.id), fam.id, b.id);
  }

  // Packs: about one per 160 m² of walkable ground, spaced apart, away from the ways in and out.
  if (families.length) {
    const want = Math.max(3, Math.min(12, Math.round(area / (z.kind === 'dungeon' ? 130 : 160))));
    const packs: Vec2[] = bosses.map((b) => lairOf(b.id));
    // Only open ground, best clearance first (with some chance): fewer packs rather than packs in passages. A map with no
    // open ground at all takes the shuffled order.
    const roomy = cells.filter((c) => clear[c.i]! >= PACK_CLEARANCE);
    const order = roomy.length ? roomy.map((c) => ({ c, s: clear[c.i]! * (0.6 + 0.8 * rng.next()) })).sort((a, b) => b.s - a.s).map((x) => x.c) : cells;
    const chosen: typeof cells = [];
    for (const c of order) {
      if (chosen.length >= want) break;
      if (nearDoor(c.p, PACK_FROM_DOOR) || packs.some((p) => Math.hypot(p.x - c.p.x, p.y - c.p.y) < PACK_SPACING)) continue;
      packs.push(c.p);
      chosen.push(c);
    }
    // How deep a pack stands counts from the nearest pack to the deepest, so the pack a party meets first is of the
    // place's lowest level whatever its range and wherever bosses and ways in leave room: each level holds an equal
    // band of depth.
    const near = Math.min(...chosen.map((c) => c.depth)), deep = Math.max(...chosen.map((c) => c.depth));
    const [lo, hi] = z.levelRange;
    // Something a quest sends the party here to find is guarded by nothing above that quest's level: packs within a
    // pack's spacing of it are capped there, wherever the planner put it (deep in or not).
    const finds = z.features.flatMap((f) => {
      const q = f.questId ? w.quests.find((x) => x.id === f.questId) : undefined;
      return q ? [{ x: f.x, y: f.y, level: Math.round(q.level) }] : [];
    });
    const capAt = (p: Vec2) => Math.min(hi, ...finds.filter((f) => Math.hypot(f.x - p.x, f.y - p.y) < PACK_SPACING).map((f) => f.level));
    chosen.forEach((c, n) => {
      // Every creature family of the place gets a pack first (a quest may send the party to fight it here), then any.
      const fam = families[n] ?? rng.pick(families);
      const depth = deep > near ? (c.depth - near) / (deep - near) : 0;
      const level = Math.max(1, Math.min(capAt(c.p), lo + Math.floor((hi - lo + 1) * depth)));
      spawnAt(`${z.id}_g${n}`, buildPack(r, rng.fork(`pack:${n + 1}`), { heroes: DESIGN_PARTY, level, kind: 'normal', members: fam.members, depth }), c.p, fam.id);
    });
  }
}

/**
 * The heart of a town: the open ground with the shortest walk, all told, to everyone and everything in it (its
 * people, its workbench, its sign), so a party starting there sees the town around it, not the road out. It keeps
 * clear of walls (a square, not a lane) and stands a few meters from anyone or anything, so nobody is stood on.
 */
function heartOf(nav: Nav, places: Vec2[], features: Vec2[]): Vec2 | null {
  if (!places.length) return null;
  const sum = new Float64Array(nav.cols * nav.rows), seen = new Uint16Array(nav.cols * nav.rows);
  for (const p of places)
    for (const [i, c] of nav.reach(p, 1e6)) (sum[i] = sum[i]! + c), (seen[i] = seen[i]! + 1);
  const clear = clearance(nav);
  const near = [...places, ...features];
  for (const room of [PACK_CLEARANCE, 1, 0]) {
    let best = -1;
    for (let i = 0; i < sum.length; i++) {
      if (seen[i] !== places.length || clear[i]! < room) continue;
      const c = nav.center(i % nav.cols, Math.floor(i / nav.cols));
      if (near.some((q) => Math.hypot(q.x - c.x, q.y - c.y) < 2.5)) continue;
      if (best < 0 || sum[i]! < sum[best]!) best = i;
    }
    if (best >= 0) return nav.center(best % nav.cols, Math.floor(best / nav.cols));
  }
  return null;
}

/** Each navigation cell's distance (m) to the nearest blocked cell or the map's edge (city-block steps). */
function clearance(nav: Nav): Float32Array {
  const n = nav.cols * nav.rows, d = new Float32Array(n).fill(Infinity), queue: number[] = [];
  for (let i = 0; i < n; i++) {
    const cx = i % nav.cols, cy = Math.floor(i / nav.cols);
    if (!nav.walkableCell(cx, cy)) (d[i] = 0), queue.push(i);
    else if (cx === 0 || cy === 0 || cx === nav.cols - 1 || cy === nav.rows - 1) (d[i] = NAV_CELL), queue.push(i);
  }
  for (let h = 0; h < queue.length; h++) {
    const i = queue[h]!, cx = i % nav.cols, cy = Math.floor(i / nav.cols);
    for (const [x, y] of [[cx - 1, cy], [cx + 1, cy], [cx, cy - 1], [cx, cy + 1]] as const) {
      const j = y * nav.cols + x;
      if (nav.inside(x, y) && d[j]! > d[i]! + NAV_CELL) (d[j] = d[i]! + NAV_CELL), queue.push(j);
    }
  }
  return d;
}
