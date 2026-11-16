/**
 * What building a world takes, as the creation page tells its owner before they begin: the hours until it can be
 * played, the hours more while its actors learn to move, and the OpenAI dollars of each. It is a count of what a world
 * of the size and length chosen holds (`worldCounts`) times what each thing costs (`BuildRates`), with a margin, so
 * the estimate errs high: a build that ends sooner and cheaper than said is a pleasant surprise, one that ends later
 * is a broken promise.
 *
 * Every build records what it took (server/src/worldgen/metrics.ts), and once an installation has finished enough
 * builds its estimates are priced from its own records (`measuredRates`); until then, from the rates below.
 */
import { LENGTH_PROFILES, SIZE_PROFILES, type GameLength, type WorldSize } from './progression.ts';

/** What a world of a size and length holds, on average, as the build makes it. */
interface WorldCounts {
  towns: number;
  /** Wilds and dungeons. */
  areas: number;
  /** Map tiles of 1024 px painted, all places together. */
  tiles: number;
  /** Townspeople: three people of the story and their residents in each town. */
  people: number;
  /** Hero paintings: one for each class and race. */
  heroes: number;
  creatures: number;
  /** Bosses drawn: one an arc at most (named foes are drawn as their creature). */
  bosses: number;
  /** Item icons and the objects drawn on maps. */
  items: number;
  /** Sound effects and music pieces. */
  sounds: number;
}

/** What each part of a build costs: dollars of OpenAI, minutes of the GPU, minutes of everything else. */
export interface BuildRates {
  /** Dollars of the text steps for a world. */
  textUsd: number;
  /** Minutes a build takes besides its GPU time: the text steps first, then waits for the GPU and reading. */
  textMinutes: number;
  /** GPU minutes for each tile painted (all paintings tried, and the ways out), each sound, and a world's voices. */
  gpu: { tile: number; sound: number; voices: number };
  /** Dollars for each place: reading its paintings for walkable ground, finding its spots and landmarks. */
  placeUsd: number;
  /** Dollars for each picture of art, retries included: an actor, an icon or object. */
  artUsd: { actor: number; item: number };
  /** Minutes of art batches that do not use the GPU; they run while places are painted. */
  artMinutes: number;
  /** Animation: dollars for an actor that fights (sheets and walks), and for a townsperson (walks); hours of batches. */
  animationUsd: { fighter: number; townsperson: number };
  animationHours: number;
}

/**
 * The rates of today's build, measured from the records of the three worlds built on the development machine by
 * 15 November 2026 (a tiny and two small worlds, two of them animated), as `measuredRates` measures them.
 */
export const BUILD_RATES: BuildRates = {
  textUsd: 0.011,
  textMinutes: 12.6,
  gpu: { tile: 0.56, sound: 0.126, voices: 0.73 },
  placeUsd: 0.078,
  artUsd: { actor: 0.0027, item: 0.0027 },
  // Art batches answered within minutes in those builds; this leaves room for a slow one.
  artMinutes: 15,
  animationUsd: { fighter: 0.07, townsperson: 0.07 },
  // From the first animation run to the last: 20 and 36 minutes.
  animationHours: 0.47,
};

/** How much more the estimate says than the rates give: those three builds came within a quarter of their sum. */
export const ESTIMATE_MARGIN = 1.2;

/** Story people and residents a town has (pipeline/facts.ts: three of the story, and about seven others). */
const PEOPLE_PER_TOWN = 10;
/** Classes times races: 3 to 24 in the worlds built so far. */
const HEROES = 20;
/** Creatures in a family: two to five, three or four in the examples. */
const PER_FAMILY = 3.5;
/** Item icons (about 40 to 50 in the examples) and up to four kinds of object. */
const ITEMS = 50;
/**
 * The share of a size's tiles a planner uses: about every place at its kind's usual size (the budget leaves room
 * above that for the places a story lingers in). A guess until builds are measured, which then replace the rates.
 */
const TILES_USED = 0.85;

/** What a world of a size and length holds, on average (sounds: docs/sound.md, "What a world's sounds are"). */
function worldCounts(size: WorldSize, length: GameLength): WorldCounts {
  const s = SIZE_PROFILES[size], arcs = LENGTH_PROFILES[length].arcs;
  const places = s.towns + s.wilds + s.dungeons;
  // About thirty moments, three for each of about three kinds of damage, two for each family and place, one a boss,
  // a theme, and a defeat.
  const sounds = 30 + 9 + 2 * s.monsterFamilies + 2 * places + arcs + 2;
  return {
    towns: s.towns, areas: s.wilds + s.dungeons, tiles: s.tiles * TILES_USED, people: s.towns * PEOPLE_PER_TOWN, heroes: HEROES,
    creatures: s.monsterFamilies * PER_FAMILY, bosses: arcs, items: ITEMS, sounds,
  };
}

export interface BuildEstimate {
  /** Hours until the world can be played. */
  hours: number;
  /** Hours more while its actors learn to move (they stand still in the meantime). */
  animationHours: number;
  /** OpenAI dollars until it can be played, and for the animation. */
  usd: number;
  animationUsd: number;
}

/** What a world of a size and length takes to build, at the rates given, with the margin. */
export function buildEstimate(size: WorldSize, length: GameLength, rates: BuildRates = BUILD_RATES): BuildEstimate {
  const c = worldCounts(size, length), r = rates, m = ESTIMATE_MARGIN;
  const places = c.towns + c.areas;
  const fighters = c.heroes + c.creatures + c.bosses;
  // The GPU paints the places, then makes the voices and sounds; art, balancing, and reading run beside it.
  const gpu = c.tiles * r.gpu.tile + c.sounds * r.gpu.sound + r.gpu.voices;
  return {
    hours: (m * (r.textMinutes + Math.max(gpu, r.artMinutes))) / 60,
    animationHours: m * r.animationHours,
    usd: m * (r.textUsd + places * r.placeUsd + (c.people + fighters) * r.artUsd.actor + c.items * r.artUsd.item),
    animationUsd: m * (fighters * r.animationUsd.fighter + c.people * r.animationUsd.townsperson),
  };
}
