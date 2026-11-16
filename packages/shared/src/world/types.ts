/** The saved, pre-generated world. Adventures (playthroughs) reference a world by id. */
import type { CommunicationLevel, GameLength, WorldSize } from '../rules/progression.ts';
import type { ActorAnim } from './anim.ts';
import type { Fighter, FighterKind, NpcRole, MerchantKind } from '../rules/actors.ts';
export type { Fighter };
import type { QuestDef } from '../rules/quests.ts';
import type { Modifier, Ruleset } from '../ruleset/types.ts';
import type { NavDef } from './nav.ts';
import type { SoundDef, SoundKey } from '../sound.ts';

/**
 * The optional systems a world's owner fixed: each one the build's rules systems step decides (pipeline/steps/
 * rulesSystems.yaml), in the same shape as its answer, so a choice made on the review before the build holds by
 * construction. Anything unset the step decides from the theme.
 */
export interface RulesChoices {
  /** How a downed hero gets up: with any healing, only by revive effects, or only once the fight is won. */
  revive?: 'heal' | 'special' | 'after_combat';
  /** What a party's defeat costs, each on its own. */
  defeat?: { loseExperience?: boolean; loseMoney?: boolean; recoverBody?: boolean };
  crit?: boolean;
  dodge?: boolean;
  control?: boolean;
  crafting?: boolean;
  upgrades?: boolean;
  enchanting?: boolean;
  /** Signature effects of passives and gear: healing by damage dealt, hurting whoever hits, health back every turn of a fight. */
  lifeSteal?: boolean;
  thorns?: boolean;
  regeneration?: boolean;
  /** Heroes heal one another with skills (healer classes); without it they recover by resting and with items. */
  healing?: boolean;
  /** Weapons held in one hand leave the other for a shield; others take both. Without it every weapon simply fills the weapon slot. */
  shields?: boolean;
  /** A power beyond the physical exists, magic or its like, and some skill trees use it. */
  magic?: boolean;
  /** Travel between visited cities from their waypoints: off unless chosen. */
  fastTravel?: boolean;
  /** The kinds of potion heroes use, each fixed on or off; any left out the build decides. */
  potions?: { healing?: boolean; cleansing?: boolean; buffs?: boolean; debuffs?: boolean; bombs?: boolean };
  /** Where items can be stored in towns: nowhere, a bank in each town holding only what was left there, or one storage every town reaches. */
  storage?: 'none' | 'each_town' | 'shared';
}

/** The rules systems step's whole answer: every optional system decided, and how much a hit's damage varies. */
export interface RuleSystems extends Required<Omit<RulesChoices, 'defeat' | 'potions'>> {
  defeat: Required<NonNullable<RulesChoices['defeat']>>;
  potions: Required<NonNullable<RulesChoices['potions']>>;
  swing: 'low' | 'medium' | 'high';
}

/**
 * A world before it exists, as its owner reviews it on the creation page: the concept and rule systems the build's
 * first steps wrote from their description (server: worldgen/review.ts). Created from it, the world's build keeps them.
 */
export interface ReviewView {
  /** The review, to write again or create the world from. */
  id: string;
  concept?: { title: string; genre: string; tone: string; setting: string };
  systems?: RuleSystems;
  /** OpenAI dollars the review has spent. */
  usd: number;
  /** A step that could not be written, and why. */
  failed?: { step: string; error: string };
}

/** Things made so far, of how many there will be (or how far along, when the count is not known ahead). */
export interface Made {
  done: number;
  total?: number;
  frac?: number;
}

/**
 * What a world's build has done so far, in counts alone (nothing of the world itself, so nothing is spoiled), for
 * the page that shows it being dreamed (server: worldgen/build.ts, `activity`).
 */
export interface BuildActivity {
  /** The world written: the build's text steps done, of all, and about how many words they wrote. */
  writing: Made & { words: number };
  /** Places painted, read and furnished; paintings tried, set aside (cut up or seen from the side), and layouts redrawn. */
  places: Made & { paintings: number; setAside: number; relaid: number };
  /** Pictures: heroes and townspeople; creatures and bosses; items and the things that stand on the maps. */
  characters: Made;
  creatures: Made;
  items: Made;
  /** Image prompts written, and pictures painted again because one did not pass the art check. */
  prompts: number;
  redrawn: number;
  /** Fights simulated to balance the rules. */
  balance: Made & { fights: number };
  /** Voices designed, and the lines known before play spoken (how far along). */
  voices: Made;
  sounds: Made;
  /** Every model call, and the GPU's minutes. */
  calls: number;
  gpuMinutes: number;
}

/** The parts of a build an extra prompt can be aimed at. */
export const PROMPT_TOPICS = ['story', 'places', 'people', 'monsters', 'rules', 'art'] as const;
export type PromptTopic = (typeof PROMPT_TOPICS)[number];

export interface WorldInput {
  /** What the world is: its setting and feel. */
  theme: string;
  /** Extra prompts, each read only by the steps of the build it is aimed at. */
  prompts?: { topic: PromptTopic; text: string }[];
  size: WorldSize;
  length: GameLength;
  communication: CommunicationLevel;
  rules?: RulesChoices;
  /** Its characters get painted animations once it is built (docs/world-art.md); without, the simple motion drawn in code. */
  animate?: boolean;
}

interface WorldConcept {
  title: string;
  pitch: string;
  genre: string;
  tone: string;
  /** Appended to every image prompt for a consistent look. */
  artStyle: string;
  /** Opening narration shown when a new adventure begins. */
  intro: string;
  /** How the narrator who reads the world's story aloud sounds (for designing its voice). */
  narratorVoice: string;
  /** How the owner wants people to talk, in their words; people talk plainly when it is empty. */
  speech?: string;
  palette: { primary: string; secondary: string; accent: string; ui: string };
}

/** How a place feels to be in: its light, sky, and weather (decided with its art direction). */
export interface ZoneLook {
  /** Ambient light: 0 pitch dark .. 1 bright day. */
  ambient: number;
  lightColor: string;
  /** Tint of the fog over unexplored ground. */
  fogColor: string;
  /** Under the open sky: the day/night cycle and weather apply. */
  outdoor: boolean;
  weather: 'none' | 'rain' | 'snow' | 'ash' | 'spores' | 'embers' | 'dust' | 'fireflies';
  /** Asset key of the place's tileable mist (brightness is density): over unexplored ground and past the painting. */
  mist?: string;
  /**
   * The light the painting carries, measured from its pixels: the color of its lit parts and of its shadows, and
   * its mean brightness (0..1). Characters take it, so they stand in the place's light.
   */
  painted?: { light: string; shade: string; level: number };
}

/** A place painted as one picture of its ground (see nav.ts for the projection). */
export interface Painting {
  /** Asset key of the image, already at game scale. */
  image: string;
  width: number;
  height: number;
  /** Picture position (px) of the ground origin. */
  ox: number;
  oy: number;
}

/** How many days a deleted world waits in the trash before it is removed for good. */
export const TRASH_DAYS = 30;

export type ZoneKind = 'town' | 'wilderness' | 'dungeon';
/** A way down into a dungeon is drawn inside its town or wilds (a door, a cave mouth); every other way crosses the map's edge. */
export const wayDrawnInside = (from: { kind: ZoneKind }, to?: { kind: ZoneKind }) => to?.kind === 'dungeon' && from.kind !== 'dungeon';

type FeatureKind = 'exit' | 'chest' | 'sign' | 'lore' | 'craft_station' | 'storage' | 'waypoint';

/** Something in a place people interact with. Positions are ground meters. */
export interface FeatureDef {
  id: string;
  kind: FeatureKind;
  x: number;
  y: number;
  name?: string;
  /** exit: where it leads. */
  targetZoneId?: string;
  targetFeatureId?: string;
  /** chest */
  lootTier?: number;
  items?: string[];
  /** A stash: unseen until a person who knows of it tells a hero (`NpcSecret.leadsTo`). */
  hidden?: boolean;
  /** Where a quest's thing is found: unseen until the quest has begun. */
  questId?: string;
  /** sign / lore */
  text?: string;
  loreId?: string;
}

export interface SpawnDef {
  id: string;
  kind: 'monster';
  familyId: string;
  /** The family member it is (by index), which gives its kind of fighter and class. */
  member: number;
  level: number;
  x: number;
  y: number;
  groupId: string;
  bossId?: string;
}

export interface ZoneDef {
  id: string;
  name: string;
  kind: ZoneKind;
  description: string;
  regionIndex: number;
  levelRange: [number, number];
  look: ZoneLook;
  /** The painted map's size in tiles of 1024 px (columns, rows; at most 4 × 4). */
  tiles: [number, number];
  /** Ground size in meters (set when painted). */
  width: number;
  height: number;
  /** The picture of the place, and where people can walk and see in it (set when painted). */
  painting?: Painting;
  nav?: NavDef;
  /** The painting's art direction and layout (kept for repaints). */
  design?: { style: string; layout: string };
  features: FeatureDef[];
  spawns: SpawnDef[];
  /** Inside a structure (a cave, a hall): no sky, no weather. */
  indoor?: boolean;
  /** Position on the world map (0..1). */
  mapPos: { x: number; y: number };
  /** Zones directly connected (for the world map). */
  links: string[];
  /** Arrival point when entering without a specific exit (ground meters). */
  entry: { x: number; y: number };
  /** A town's buildings: painted on its map, not entered; the people who work in one stand outside its entrance. */
  buildings?: { id: string; name: string; purpose: string; npcId: string }[];
  /** Hidden flavor used in NPC/LLM context. */
  lore?: string;
  /** Local monster families. */
  familyIds: string[];
}

export interface MonsterMember extends Fighter {
  name: string;
  description: string;
  appearance: string;
  asset?: string;
}

export interface MonsterFamily {
  id: string;
  name: string;
  description: string;
  members: MonsterMember[];
}

export interface BossDef {
  id: string;
  name: string;
  description: string;
  familyId: string;
  fighter: FighterKind;
  /** The classes it fights as (one, or two it mixes). */
  classIds: string[];
  level: number;
  zoneId: string;
  appearance: string;
  /**
   * For a named foe, the name of the family's member it is one of: it is drawn as that creature and fought as a strong
   * one of them, not as a boss.
   */
  member?: string;
  /** Unique item ids dropped on defeat. */
  drops: string[];
  asset?: string;
  /** Spoken when combat begins. */
  taunt?: string;
  /** How it sounds when it speaks (for designing its voice). */
  voice: string;
}

interface NpcSecret {
  text: string;
  /** What would make them tell, in plain words ("only someone who has helped her family"). */
  tellsWhen: string;
  /** The stash this secret tells of (a hidden chest's feature id): telling it shows the stash to the heroes who heard. */
  leadsTo?: string;
}

interface NpcOpinion {
  npcId: string;
  text: string;
}

export interface NpcDef {
  id: string;
  name: string;
  title: string;
  role: NpcRole;
  merchantKind?: MerchantKind;
  zoneId: string;
  x: number;
  y: number;
  pronouns: string;
  personality: string;
  appearance: string;
  backstory: string;
  /** What they want right now, ideally as something that can happen in the world. */
  want: string;
  /** Concrete details of their days, their current trouble among them. */
  life: string[];
  /** How they talk, in plain words ("short sentences, dry jokes, calls everyone by their trade"). */
  manner: string;
  /** What wins them over and what they cannot stand. */
  values: { likes: string[]; dislikes: string[] };
  /** What they think of people they know. */
  opinions: NpcOpinion[];
  /** Things this NPC knows and may share. */
  knowledge: string[];
  /** Things this NPC keeps to themselves. Never sent to clients. */
  secrets: NpcSecret[];
  /** How they sound when they speak aloud (for designing their voice; docs/voices.md). */
  voice: string;
  greeting: string;
  /** What they say to a hero they know, by how they feel about them. */
  returning?: { warm: string; plain: string; cold: string };
  /** Short remarks to heroes walking past. */
  barks: string[];
  level: number;
  essential: boolean;
  /** Quest ids this NPC can hand out. */
  questIds: string[];
  /** People this one talks with (their opinions' people, and those whose opinions name them): news travels along these. */
  relations?: string[];
  faction?: string;
  asset?: string;
  /** Wanders around its spawn point. */
  wanders: boolean;
}

export interface UniqueItemDef {
  id: string;
  baseId: string;
  name: string;
  description: string;
  rarityId: string;
  /** Compiled modifiers (priced like a legendary). */
  mods: Modifier[];
  /** Quest items are bound (can't be sold) and weigh nothing. */
  questItem?: boolean;
}

export interface LoreNote {
  id: string;
  title: string;
  text: string;
  arcIndex?: number;
}

export interface ArcDef {
  index: number;
  title: string;
  /** Narration revealed when the arc completes (twists). */
  revelation: string;
  questIds: string[];
  regionIndex: number;
}

export interface AssetRecord {
  key: string;
  /** painting: a place's map; texture: a place's mist; sprite: a character or creature's standing view; sheet: one
   *  animation clip of a sprite (`ref`); object: something drawn over the maps; icon: an item's. */
  kind: 'painting' | 'texture' | 'sprite' | 'sheet' | 'object' | 'icon';
  file?: string;
  /** Short brief of what to depict. */
  prompt: string;
  /** Full prompt in the image model's preferred style (written by the image.prompt LLM). */
  imagePrompt?: string;
  status: 'pending' | 'ok' | 'failed' | 'skipped';
  score?: number;
  attempts?: number;
  width?: number;
  height?: number;
  /** Anchor (0..1) of the feet within the image for sprites. */
  anchorY?: number;
  error?: string;
  /** A sheet: the sprite it animates. */
  ref?: string;
  /** Actors: the base view painted (front for people and upright figures, side for animals and other body plans), the one their animation starts from. */
  view?: 'front' | 'side';
  /** The chroma-key backdrop it was painted on (picked by the prompt writer; another one when the colors clash). */
  backdrop?: 'green' | 'blue' | 'magenta';
  /** Seed offset: a repair pass paints with fresh seeds. */
  roll?: number;
  /** A character or creature's animation: its clip sheets are the assets `<key>@anim-<clip>` (see world/anim.ts). */
  anim?: ActorAnim;
}

/** A class's look, and its heroes' sprites: one per kin (`spr_hero_<classId>_<kinId>`). */
interface OriginFlavor {
  id: string;
  name: string;
  description: string;
  /** Sprite per kin id. */
  assets?: Record<string, string>;
  appearance: string;
}

export interface WorldDefinition {
  id: string;
  ownerId: string;
  ownerName: string;
  public: boolean;
  createdAt: number;
  updatedAt: number;
  status: 'generating' | 'ready' | 'failed';
  input: WorldInput;
  concept: WorldConcept;
  /** The world's generated rules (pure data). */
  ruleset: Ruleset;
  maxLevel: number;
  /** Look of each class (id = ruleset class id), used for art. */
  origins: OriginFlavor[];
  uniqueItems: Record<string, UniqueItemDef>;
  families: MonsterFamily[];
  bosses: BossDef[];
  zones: ZoneDef[];
  npcs: NpcDef[];
  quests: QuestDef[];
  arcs: ArcDef[];
  finalQuestId: string;
  ending: string;
  lore: LoreNote[];
  assets: Record<string, AssetRecord>;
  startZoneId: string;
  /** Free-form facts the generator decided, fed to NPC prompts. */
  generationLog?: string[];
  /** Quests the build's last check found cannot be finished (worldgen/questcheck.ts), for the world viewer. */
  questProblems?: { questId: string; objectiveId?: string; text: string }[];
  /**
   * The voices made for it (docs/voices.md), by speaker: an NPC's or boss's id, or `narrator`. Each has a reference
   * clip, `assets/voices/<id>.wav`, and a gain per engine that brings it to the game's loudness.
   */
  voices?: Record<string, VoiceDef>;
  /**
   * The sounds made for it (docs/sound.md), by key (`tap`, `cast:<element id>`, `ambience:<place id>`, …). One the world
   * lacks is played from the game's own copy, or not at all (shared/sound.ts, `standIn`).
   */
  sounds?: Record<SoundKey, SoundDef>;
}

export interface VoiceDef {
  /** Linear gain for each speech engine (`cpu`: Pocket TTS; `gpu`: the VoxCPM2 runner). */
  gain: { cpu: number; gpu: number };
}

/** World data that is safe to send to a client (spoilers removed). */
export type ClientWorld = Omit<WorldDefinition, 'zones' | 'npcs' | 'concept' | 'arcs' | 'quests' | 'ending' | 'generationLog' | 'questProblems' | 'voices'> & {
  concept: Omit<WorldConcept, 'secret'>;
  zones: Omit<ZoneDef, 'nav' | 'design' | 'spawns' | 'lore'>[];
  npcs: Pick<NpcDef, 'id' | 'name' | 'title' | 'role' | 'zoneId' | 'asset' | 'pronouns' | 'appearance'>[];
  arcs: Pick<ArcDef, 'index' | 'title'>[];
};
