/**
 * Engine facts: what the build knows before any model call, worked out from the owner's input. Templates and
 * schemas read them under `input`, `map` and `game`; they carry ready-made labels so templates need no logic.
 *
 *   input   the owner's input as templates read it (each prompt with what its topic is `about`, and what each
 *           optional system may be), and what its size and length give: the level cap, the classes' shape, and the
 *           map tiles all places share (`mapTiles`)
 *   map     the world's structure: its places in the order they are reached, the arcs and their stretches, and the
 *           slots every later step fills (the story's people, each town's residents and side quests, each wild
 *           place's notes, the creature families), so answers are keyed by what the engine made and nothing is
 *           left out or doubled
 *   game    what the engine fixes for every world (the sounds it plays, the shapes fights are drawn with, and the
 *           fixed lists the rules choose from)
 *
 * Items refer to each other by object (a dungeon's `off` is the place it opens from, a town's `links` the places
 * next to it, a resident's `town` where they live), so a path can go from one to another and a step's entries
 * joined to an item are found from wherever it is reached. The references go both ways, so the facts are written
 * out with `plain` (an item inside another is its id).
 */
import { FX_BLASTS, FX_MOTIONS, FX_RUSHES, FX_SHAPES, FX_SHOTS, FX_TRAILS, LENGTH_PROFILES, Rng, SIZE_PROFILES, MOMENTS, classShape, type Moment } from '@daydream/shared';
import { RULES_VOCABULARY } from '../rules/vocabulary.ts';
import { MOMENT_PROMPTS } from '../sound/prompts.ts';
import { TILE_RANGE } from '../worldgen/mapdraw.ts';
import { buildSkeleton, type WorldSkeleton } from '../worldgen/structure.ts';
import { STORAGES } from './records.ts';
import { TOPIC_ABOUT, type Example } from './types.ts';

export interface Slot {
  id: string;
}

export interface Place extends Slot {
  kind: 'town' | 'wilderness' | 'dungeon';
  /** "a town", "wilds", "a dungeon". */
  label: string;
  /** Its number in the order places are reached, from 1. */
  n: number;
  /** For a dungeon: the place it opens from; otherwise null. */
  off: Place | null;
  /** The places a path leads to from here. */
  links: Place[];
  first: boolean;
  last: boolean;
  /** The sizes its map may have, in tiles, each as "columns x rows" ("3x2"): every size its kind of place allows. */
  sizes: string[];
  /** A town's people of the story. */
  cast: CastSlot[];
  /** A town's other residents, each with the part they play for visitors. */
  residents: Resident[];
  /** A town's side quests. */
  quests: QuestSlot[];
  /** The writings found in a wild place or a dungeon. */
  notes: Slot[];
  /** For the game, never shown to a model (numbers get copied into the text): its levels, region, and map position. */
  levels: [number, number];
  region: number;
  mapPos: { x: number; y: number };
}

export interface Arc extends Slot {
  n: number;
  first: boolean;
  last: boolean;
  /** The places this arc is told across, in order. */
  stretch: Place[];
  /** Every place this arc may use: its stretch and all before it. */
  reach: Place[];
  /** The people of the story it may use: those of the towns in its reach. */
  cast: CastSlot[];
}

interface CastSlot extends Slot {
  town: Place;
}

/** A town's side quest. */
interface QuestSlot extends Slot {
  town: Place;
}

/** A resident of a town who is not in the story. */
interface Resident extends Slot {
  town: Place;
  /** What they are for visitors, in words ("someone who sells weapons", "someone who lives here"). */
  label: string;
  /** What a merchant sells, or null for a resident. */
  merchant: string | null;
}

export interface Facts {
  input: Record<string, unknown>;
  map: {
    places: Place[];
    towns: Place[];
    wilds: Place[];
    dungeons: Place[];
    /** The wilds and dungeons, in order. */
    areas: Place[];
    arcs: Arc[];
    cast: CastSlot[];
    residents: Resident[];
    families: Slot[];
  };
  game: {
    moments: { id: Moment; purpose: string; tonal: boolean; source: string | null }[];
    /** The vocabulary fights are drawn with. */
    fx: { shapes: readonly string[]; motions: readonly string[]; trails: readonly string[]; rushes: readonly string[]; shots: readonly string[]; blasts: readonly string[] };
    /** Every other choice the rules make from a fixed list, and the interface's look (rules/vocabulary.ts). */
    rules: typeof RULES_VOCABULARY;
  };
}

const LABEL: Record<Place['kind'], string> = { town: 'a town', wilderness: 'wilds', dungeon: 'a dungeon' };

/** Every size a kind of place's map may have (worldgen/mapdraw.ts, TILE_RANGE), smallest first, as "columns x rows". */
function sizesOf(kind: Place['kind']): string[] {
  const { min, max } = TILE_RANGE[kind];
  const out: [number, number][] = [];
  for (let c = min[0]; c <= max[0]; c++) for (let r = min[1]; r <= max[1]; r++) out.push([c, r]);
  return out.sort((a, b) => a[0] * a[1] - b[0] * b[1]).map(([c, r]) => `${c}x${r}`);
}

/** How many people of the story live in each town. */
const CAST_PER_TOWN = 3;

/**
 * The merchants every town needs, one for each kind of thing players buy: supplies, weapons, armor, and materials
 * where something can be made at the workbench. Everyone else is a resident.
 */
function townRoles(crafting: boolean): Omit<Resident, 'id' | 'town'>[] {
  return [
    { label: 'someone who sells supplies', merchant: 'general' },
    { label: 'someone who sells weapons', merchant: 'weapons' },
    { label: 'someone who sells armor', merchant: 'armor' },
    ...(crafting ? [{ label: 'someone who sells crafting materials', merchant: 'materials' }] : []),
  ];
}
const RESIDENT = { label: 'someone who lives here', merchant: null };

/** The optional systems a world may have; the owner may have fixed some of them. */
const SYSTEMS = ['crafting', 'upgrades', 'enchanting', 'control', 'crit', 'dodge', 'fastTravel', 'lifeSteal', 'thorns', 'regeneration', 'healing', 'shields', 'magic'] as const;
const POTIONS = ['healing', 'cleansing', 'buffs', 'debuffs', 'bombs'] as const;
const DEFEATS = ['loseExperience', 'loseMoney', 'recoverBody'] as const;

/**
 * For each optional system, what may be chosen: the owner's choice, or either when they left it open; and how a
 * downed hero gets up and where items are stored in towns, likewise.
 */
function systemChoices(rules: Example['input']['rules']) {
  const on = Object.fromEntries(SYSTEMS.map((s) => [s, rules?.[s] === undefined ? [true, false] : [rules[s]!]])) as Record<(typeof SYSTEMS)[number], boolean[]>;
  // What a party's defeat costs, each on its own: some experience, some money, a walk back to where they fell.
  const defeat = Object.fromEntries(DEFEATS.map((d) => [d, rules?.defeat?.[d] === undefined ? [true, false] : [rules.defeat[d]!]])) as Record<(typeof DEFEATS)[number], boolean[]>;
  // Which kinds of potion a world has, each on its own.
  const potions = Object.fromEntries(POTIONS.map((p) => [p, rules?.potions?.[p] === undefined ? [true, false] : [rules.potions[p]!]])) as Record<(typeof POTIONS)[number], boolean[]>;
  return { ...on, potions, revive: rules?.revive ? [rules.revive] : [...RULES_VOCABULARY.revives], storage: rules?.storage ? [rules.storage] : [...STORAGES], defeat };
}

/** The facts of an example: its map is laid out from its id, as a build lays out a world's from the world's. */
export function exampleFacts(ex: Example): Facts {
  const seed = ex.id;
  return facts(ex.input, buildSkeleton(ex.input, new Rng(seed)), seed);
}

export function facts(input: Example['input'], sk: WorldSkeleton, seed: string): Facts {
  const size = SIZE_PROFILES[input.size];
  // The order places are reached: outward from the first town, along the links.
  const order = [sk.startSlot];
  for (let i = 0; i < order.length; i++) for (const l of sk.slots.find((s) => s.slotId === order[i])!.links) if (!order.includes(l)) order.push(l);
  const slots = order.map((id) => sk.slots.find((s) => s.slotId === id)!);
  const places: Place[] = slots.map((s, i) => ({
    id: s.slotId, kind: s.kind, label: LABEL[s.kind], n: i + 1, off: null, links: [], first: i === 0, last: i === slots.length - 1, sizes: sizesOf(s.kind),
    cast: [], residents: [], quests: [], notes: [], levels: s.levelRange, region: s.regionIndex, mapPos: s.mapPos,
  }));
  const byId = new Map(places.map((p) => [p.id, p]));
  slots.forEach((s, i) => {
    const p = places[i]!;
    p.links = s.links.map((l) => byId.get(l)!);
    if (s.kind === 'dungeon') p.off = p.links.find((l) => l.kind !== 'dungeon') ?? null;
    if (s.kind !== 'town') p.notes = Array.from({ length: s.kind === 'dungeon' ? 2 : 1 }, (_, k) => ({ id: `${p.id}_n${k + 1}` }));
  });
  const towns = places.filter((p) => p.kind === 'town');
  // The workshop is for every craft: making and upgrading gear, enchanting it, and making consumables. Facts come
  // before the rules, so a town has its seller of materials unless the owner turned every craft off.
  const r = input.rules;
  const crafting = [r?.crafting, r?.upgrades, r?.enchanting, ...POTIONS.map((p) => r?.potions?.[p])].some((on) => on !== false);
  for (const town of towns) {
    // As many residents as the town has room for besides its people of the story, at least those it needs and two more.
    const rng = new Rng(`${seed}:residents:${town.id}`);
    const needed = townRoles(crafting);
    const count = Math.max(needed.length + 2, rng.int(size.npcsPerTown[0], size.npcsPerTown[1]) - CAST_PER_TOWN);
    town.cast = Array.from({ length: CAST_PER_TOWN }, (_, i) => ({ id: `${town.id}_p${i + 1}`, town }));
    town.residents = Array.from({ length: count }, (_, i) => ({ id: `${town.id}_r${i + 1}`, town, ...(needed[i] ?? RESIDENT) }));
    town.quests = Array.from({ length: rng.int(size.sideQuestsPerTown[0], size.sideQuestsPerTown[1]) }, (_, i) => ({ id: `${town.id}_q${i + 1}`, town }));
  }
  const cast = towns.flatMap((t) => t.cast);
  const arcCount = LENGTH_PROFILES[input.length].arcs;
  const arcs = stretches(places, arcCount).map((stretch, k): Arc => {
    const reach = places.slice(0, places.indexOf(stretch.at(-1)!) + 1);
    return { id: `arc${k + 1}`, n: k + 1, first: k === 0, last: k === arcCount - 1, stretch, reach, cast: cast.filter((c) => reach.includes(c.town)) };
  });
  const prompts = (input.prompts ?? []).filter((p) => p.text.trim()).map((p) => ({ topic: p.topic, about: TOPIC_ABOUT[p.topic], text: p.text.trim() }));
  return {
    input: { theme: input.theme.trim(), size: input.size, length: input.length, maxLevel: LENGTH_PROFILES[input.length].maxLevel, mapTiles: size.tiles, ...classShape(LENGTH_PROFILES[input.length].maxLevel), prompts, systems: systemChoices(input.rules) },
    map: {
      places,
      towns,
      wilds: places.filter((p) => p.kind === 'wilderness'),
      dungeons: places.filter((p) => p.kind === 'dungeon'),
      areas: places.filter((p) => p.kind !== 'town'),
      arcs,
      cast,
      residents: towns.flatMap((t) => t.residents),
      families: Array.from({ length: size.monsterFamilies }, (_, i) => ({ id: `f${i + 1}` })),
    },
    game: {
      moments: (Object.keys(MOMENTS) as Moment[]).map((id) => ({ id, purpose: MOMENT_PROMPTS[id].purpose, tonal: !!MOMENT_PROMPTS[id].tonal, source: MOMENT_PROMPTS[id].source ?? null })),
      fx: { shapes: FX_SHAPES, motions: FX_MOTIONS, trails: FX_TRAILS, rushes: FX_RUSHES, shots: FX_SHOTS, blasts: FX_BLASTS },
      rules: RULES_VOCABULARY,
    },
  };
}

/**
 * Facts as plain data, to write out or fingerprint: an item inside another item (a dungeon's `off`, a resident's
 * `town`, an arc's places) is its id, so references that go both ways end.
 */
export function plain(v: unknown, inItem = false): unknown {
  if (Array.isArray(v)) return v.map((x) => plain(x, inItem));
  if (!v || typeof v !== 'object') return v;
  const o = v as Record<string, unknown>;
  const item = typeof o.id === 'string';
  if (inItem && item) return o.id;
  return Object.fromEntries(Object.entries(o).map(([k, x]) => [k, plain(x, inItem || item)]));
}

/**
 * The map cut into one stretch per arc, in order and as even as can be, so the story's levels rise with the map.
 * A cut that falls one place from a town moves to just before it, so a town stays in the arc of what lies around it.
 */
export function stretches(places: Place[], arcs: number): Place[][] {
  const n = places.length;
  const cuts = [0];
  for (let k = 1; k < arcs; k++) {
    let c = Math.round((k * n) / arcs);
    const town = [c, c - 1, c + 1].find((i) => places[i]?.kind === 'town');
    if (town !== undefined && town > cuts.at(-1)! && town < n) c = town;
    cuts.push(Math.max(cuts.at(-1)! + 1, Math.min(c, n - (arcs - k))));
  }
  cuts.push(n);
  return cuts.slice(0, -1).map((c, k) => places.slice(c, cuts[k + 1]));
}
