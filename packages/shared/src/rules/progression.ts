/** Fixed progression tables: world size, game length, experience, and level scaling. */

export const WORLD_SIZES = ['tiny', 'small', 'medium', 'large'] as const;
export type WorldSize = (typeof WORLD_SIZES)[number];

export const GAME_LENGTHS = ['brief', 'short', 'medium', 'long', 'epic'] as const;
export type GameLength = (typeof GAME_LENGTHS)[number];

/** The most heroes in the game at once in an adventure, all players' together (docs/multiplayer.md). */
export const MAX_HEROES = 6;
/** The most heroes one player may have made in an adventure, those who wait outside the game counted. */
export const MAX_OWN_HEROES = 24;

/** 0 = NPCs keep things to themselves, 3 = everything ripples through the world. */
export type CommunicationLevel = 0 | 1 | 2 | 3;

/** A world's places: each city is a region of its own (a level band) with its wilds and dungeons around it. */
interface SizeProfile {
  towns: number;
  wilds: number;
  dungeons: number;
  /**
   * Map tiles (1024 px, about 25 m square) all places together may use: the planner sizes each place within it. Each
   * budget fits every place at its kind's usual size with about a third of the way to its largest to spare, so a
   * place the story lingers in can be big without another being cut small.
   */
  tiles: number;
  npcsPerTown: [number, number];
  sideQuestsPerTown: [number, number];
  monsterFamilies: number;
}

export const SIZE_PROFILES: Record<WorldSize, SizeProfile> = {
  // Tiny is for demos and a game in an evening: one of each place.
  tiny: { towns: 1, wilds: 1, dungeons: 1, tiles: 26, npcsPerTown: [6, 8], sideQuestsPerTown: [2, 3], monsterFamilies: 2 },
  small: { towns: 1, wilds: 2, dungeons: 2, tiles: 44, npcsPerTown: [7, 9], sideQuestsPerTown: [3, 4], monsterFamilies: 3 },
  medium: { towns: 2, wilds: 3, dungeons: 3, tiles: 70, npcsPerTown: [7, 10], sideQuestsPerTown: [3, 4], monsterFamilies: 4 },
  large: { towns: 3, wilds: 5, dungeons: 4, tiles: 106, npcsPerTown: [8, 11], sideQuestsPerTown: [3, 5], monsterFamilies: 6 },
};

interface LengthProfile {
  maxLevel: number;
  arcs: number;
  mainQuestsPerArc: [number, number];
}

export const LENGTH_PROFILES: Record<GameLength, LengthProfile> = {
  // Brief goes with a tiny world: one arc, over its one town, wild and dungeon, and a level cap that still opens every
  // tier of a class.
  brief: { maxLevel: 5, arcs: 1, mainQuestsPerArc: [2, 3] },
  short: { maxLevel: 8, arcs: 2, mainQuestsPerArc: [2, 3] },
  medium: { maxLevel: 14, arcs: 3, mainQuestsPerArc: [2, 4] },
  long: { maxLevel: 20, arcs: 4, mainQuestsPerArc: [3, 4] },
  epic: { maxLevel: 30, arcs: 5, mainQuestsPerArc: [3, 5] },
};

export const REAL_MS_PER_GAME_MINUTE = 1000; // 1 game hour = 1 real minute, 1 day = 24 real minutes
export const GAME_MINUTES_PER_DAY = 24 * 60;
/** Slain non-boss monsters return this long after death (6 game hours = 6 real minutes), when their zone is next entered. */
export const RESPAWN_GAME_MINUTES = 6 * 60;
