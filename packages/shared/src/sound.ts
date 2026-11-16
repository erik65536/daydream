/**
 * The game's sounds (docs/sound.md): what each one is for, how it is heard, and how a world's set is named.
 *
 * A world is built with its own sounds: the game's moments (a tap, a quest accepted, a hit) made from what that world
 * is made of, one spell, hit, and heavy hit per element, a cry and a death per creature family, an ambience and an
 * arrival cue per place, a battle loop per boss, its theme, and defeat. The game's own copies of the moments, made
 * once and neutral (`/sounds/<id>.opus` in the client), stand in for any the world could not make; places, deaths and
 * music never have a stand-in, since a neutral one would contradict the world.
 */

/** Where a sound is heard in the player's Settings: interface feedback, the game's effects, music, ambience. */
export type SoundBus = 'interface' | 'effects' | 'music' | 'ambience';

/**
 * A loudness group: every sound of a group is brought to the same level when it is made (short sounds by their
 * loudest 100 ms, long ones by integrated loudness), so a world's sounds sit together the way a mix would put them.
 */
export type SoundKind = 'interface' | 'reward' | 'loot' | 'spell' | 'combat' | 'creature' | 'stinger' | 'loop' | 'ambience';

/** How a sound is made into its final shape: one sound, a music loop with an intro, or an endless texture. */
export type SoundShape = 'oneshot' | 'loop' | 'texture';

export interface SoundSpec {
  kind: SoundKind;
  bus: SoundBus;
  shape: SoundShape;
  /** How many different takes a world keeps, one picked at random each time (sounds heard often vary). */
  variants: number;
  /** Heard often: each play is pitched a little up or down, so repeats do not sound mechanical. */
  vary?: boolean;
  /**
   * Moments that may land together (a quest reward that levels a hero up): within a moment, only the highest rank
   * plays. Sounds without a rank (combat, music) always play.
   */
  rank?: number;
}

const ui = (rank: number, variants = 1): SoundSpec => ({ kind: 'interface', bus: 'interface', shape: 'oneshot', variants, rank });
const stinger = (rank: number): SoundSpec => ({ kind: 'stinger', bus: 'effects', shape: 'oneshot', variants: 1, rank });
const combat = (variants: number, kind: SoundKind = 'combat'): SoundSpec => ({ kind, bus: 'effects', shape: 'oneshot', variants, vary: true });

/** The game's moments: the same in every world, each world making them from its own materials. */
export const MOMENTS = {
  tap: ui(0),
  panel_open: ui(2),
  panel_close: ui(2),
  refusal: ui(3),
  success: stinger(4),
  level_up: stinger(9),
  gold: { ...combat(2, 'loot'), rank: 3 },
  take: { ...ui(3, 2), vary: true },
  put: { ...ui(3, 2), vary: true },
  legendary: { kind: 'reward', bus: 'effects', shape: 'oneshot', variants: 1, rank: 7 },
  craft: { kind: 'loot', bus: 'effects', shape: 'oneshot', variants: 1, rank: 4 },
  improve: { kind: 'loot', bus: 'effects', shape: 'oneshot', variants: 1, rank: 4 },
  enchant: { kind: 'reward', bus: 'effects', shape: 'oneshot', variants: 1, rank: 4 },
  learn: { kind: 'reward', bus: 'effects', shape: 'oneshot', variants: 1, rank: 4 },
  chest_open: { kind: 'loot', bus: 'effects', shape: 'oneshot', variants: 1, rank: 5 },
  quest_accept: stinger(6),
  quest_complete: stinger(8),
  quest_failed: stinger(7),
  friend: ui(2),
  chat: ui(1),
  timer_tick: ui(1),
  my_turn: ui(4),
  hit: combat(3),
  swing: combat(3),
  dodge: combat(2),
  heal: combat(1, 'spell'),
  status_harmful: combat(1, 'spell'),
  status_helpful: combat(1, 'spell'),
  hero_falls: combat(1),
} as const satisfies Record<string, SoundSpec>;
export type Moment = keyof typeof MOMENTS;

/** The sounds a world makes for each of its elements, creature families, places, and bosses, and its music. */
const WORLD_SOUNDS = {
  cast: combat(2, 'spell'),
  hit: combat(3),
  heavy: combat(2),
  cry: combat(2, 'creature'),
  death: combat(2, 'creature'),
  ambience: { kind: 'ambience', bus: 'ambience', shape: 'texture', variants: 1 },
  place: { kind: 'stinger', bus: 'music', shape: 'oneshot', variants: 1 },
  boss: { kind: 'loop', bus: 'music', shape: 'loop', variants: 1 },
  theme: { kind: 'stinger', bus: 'music', shape: 'oneshot', variants: 1 },
  defeat: { kind: 'stinger', bus: 'music', shape: 'oneshot', variants: 1 },
} as const satisfies Record<string, SoundSpec>;
type WorldSoundKind = keyof typeof WORLD_SOUNDS;

/**
 * A sound's name in a world's set: a moment by its own name, the rest as `<kind>:<id>` (`cast:fire`, `cry:<family id>`,
 * `ambience:<place id>`, `boss:<boss id>`); the theme and defeat are `theme` and `defeat`.
 */
export type SoundKey = string;
export const soundKey = (kind: Exclude<WorldSoundKind, 'theme' | 'defeat'>, id: string): SoundKey => `${kind}:${id}`;

/** What a key is: its spec, and the moment or world sound it is. */
export function soundSpec(key: SoundKey): SoundSpec | undefined {
  if (key in MOMENTS) return MOMENTS[key as Moment];
  const kind = key.split(':')[0]!;
  return kind in WORLD_SOUNDS ? WORLD_SOUNDS[kind as WorldSoundKind] : undefined;
}

/**
 * The game's own sound that stands in for a world's when the world has none (null: silence). Every moment has one;
 * a spell an abstract whoosh, a hit or heavy hit the world's plain hit, then the game's; a fight's opening cry an
 * abstract fight-start sound. Places, deaths, and music have none: a neutral one would contradict the world.
 */
export function standIn(key: SoundKey): { world?: SoundKey; game?: GameSound } | null {
  if (key in MOMENTS) return { game: key as Moment };
  const kind = key.split(':')[0];
  if (kind === 'cast') return { game: 'cast' };
  if (kind === 'hit') return { world: 'hit', game: 'hit' };
  if (kind === 'heavy') return { world: 'hit', game: 'hit' };
  if (kind === 'cry') return { game: 'fight' };
  return null;
}

/** The game's own sounds (made once, `/sounds/<id>.opus`): every moment, a spell, a fight starting, and its theme. */
export const GAME_SOUNDS = [...(Object.keys(MOMENTS) as Moment[]), 'cast', 'fight', 'theme'] as const;
export type GameSound = (typeof GAME_SOUNDS)[number];

/** A game sound's spec (`cast` and `fight` are made like a world's spell and cry, the theme like a world's). */
export function gameSoundSpec(id: GameSound): SoundSpec {
  if (id === 'cast') return WORLD_SOUNDS.cast;
  if (id === 'fight') return WORLD_SOUNDS.cry;
  if (id === 'theme') return WORLD_SOUNDS.theme;
  return MOMENTS[id];
}

/** One sound of a world: its takes in the world's `sounds` folder, and a loop's intro, played once before it. */
export interface SoundDef {
  files: string[];
  intro?: string;
}

/** A file's name in the sounds folder: the key, `:` made `-`, and the take's number. */
export const soundFile = (key: SoundKey, take: number, part?: 'intro') => `${key.replace(/[^\w-]+/g, '-')}${part ? `.${part}` : ''}.${take}.opus`;

/** The sound files a world serves: what `soundFile` makes. */
export const SOUND_FILE = /^[\w-]+(\.intro)?\.\d+\.opus$/;
