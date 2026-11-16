/** The saved state of an adventure: one playthrough of a world. A world can have any number of them. */
import type { QuestProgress } from '../rules/quests.ts';
import type { CraftId, DifficultyId, Modifier } from '../ruleset/types.ts';
import { Rng } from '../util/rng.ts';

/** A concrete item. Mechanics derive from the ruleset base + level + rarity + affixes. */
export interface ItemInstance {
  id: string;
  baseId: string;
  level: number;
  rarityId: string;
  affixes: { affixId: string; value: number }[];
  qty: number;
  /** World-defined unique item. */
  uniqueId?: string;
  /** Modifiers of a unique item. */
  uniqueMods?: Modifier[];
  /** Quest items can't be sold or dropped. */
  bound?: boolean;
}

export interface ActiveStatus {
  id: string;
  turns: number;
  /** Skill power of the applier (for damage-over-time). */
  power: number;
  /** How strongly its stat changes apply: the potency of the skill that put it on (1 for a potion). */
  strength?: number;
  sourceId?: string;
}

export type Presentation = 'feminine' | 'masculine' | 'androgynous';

/** The pronouns that go with each presentation. */
export const PRONOUNS: Record<Presentation, string> = { feminine: 'she/her', masculine: 'he/him', androgynous: 'they/them' };

/**
 * The genders of a world's kins (each kin is one), in order: picked at random from the world's seed but balanced,
 * about a quarter androgynous (at least one of three or more kins), the rest split between feminine and masculine.
 */
export function kinPresentations(n: number, seed: string): Presentation[] {
  const rng = new Rng(`kins:${seed}`);
  const a = n >= 3 ? Math.max(1, Math.round(n / 4)) : 0;
  const first: Presentation = rng.chance(0.5) ? 'feminine' : 'masculine', second: Presentation = first === 'feminine' ? 'masculine' : 'feminine';
  const all: Presentation[] = [...Array<Presentation>(a).fill('androgynous'), ...Array.from({ length: n - a }, (_, i) => (i % 2 ? second : first))];
  return rng.shuffle(all);
}

export interface CharacterState {
  id: string;
  name: string;
  classId: string;
  kinId: string;
  /** As the character's kin is (each kin is one gender). */
  presentation: Presentation;
  /** Asset key for the sprite. */
  sprite: string;
  level: number;
  xp: number;
  /** Upgrade tree: node id -> rank. */
  tree: Record<string, number>;
  /** Unspent tree points. */
  treePoints: number;
  hotbar: (string | null)[];
  hp: number;
  statuses: ActiveStatus[];
  /** Slot id -> item. */
  equipment: Record<string, ItemInstance | undefined>;
  cooldowns: Record<string, number>;
  downed: boolean;
  /** Played by the AI, as its player chose (a hero is also played by the AI while its player is away from the game). */
  ai?: boolean;
}

export interface JournalEntry {
  day: number;
  minute: number;
  kind: 'quest' | 'story' | 'discovery' | 'combat' | 'social' | 'loot' | 'system';
  text: string;
}

interface ConversationTurn {
  speaker: 'player' | 'npc' | 'narrator';
  /** The hero who spoke (player turns). */
  hero?: string;
  text: string;
  day: number;
}

/** One player in an adventure: their heroes, bag, and purse. The story itself is the adventure's (AdventureState). */
export interface PlayerState {
  userId: string;
  name: string;
  /** The heroes this player brings into the game. */
  party: CharacterState[];
  /** Heroes this player made who stay out of the game for now. */
  bench: CharacterState[];
  /** The hero the player steers; the rest of the party follows it. */
  leaderId: string;
  gold: number;
  inventory: ItemInstance[];
  /** Inventory upgrades bought (each adds the ruleset's slotsPerUpgrade). */
  inventoryUpgrades: number;
  /** What the player left in storage, by town (or 'shared' when every town reaches one store): see storageKey. */
  storage?: Record<string, ItemInstance[]>;
  /** Ranks learned in each craft (the utility tree, shared by the player's heroes). */
  crafts?: Partial<Record<CraftId, number>>;
  zoneId: string;
  x: number;
  y: number;
  /** Where the party wakes after losing a fight. */
  lastTownZoneId: string;
  /** Quest shown on the HUD: unset follows the main story, '' shows none. */
  pinnedQuestId?: string;
  stats: { kills: number; deaths: number; questsCompleted: number; goldEarned: number; itemsCrafted: number };
  /** Has seen the world's introduction (on their first time in). */
  introduced?: boolean;
  /** The adventure's clock (game minutes) when they last left: the story so far is told from there. */
  leftAt?: number;
  createdAt: number;
}

/** Something personal a person chose to remember about a hero (a birthday, a name, a promise). */
export interface Memory {
  id: string;
  text: string;
  /** The hero it concerns. */
  about: string;
  aboutName?: string;
  day: number;
  /** A day it is about (a birthday tomorrow): the person brings it up then. */
  dueDay?: number;
  /** For dated memories: has the person acted on it yet. */
  fulfilled?: boolean;
}

/** What a person thinks of a hero: a number the game reads, and the reasons the person would give, newest last. */
export interface Regard {
  value: number;
  reasons: string[];
}

/**
 * Something people may hear about heroes: a deed (a quest done for someone, a threat, a lie found out) or news (a
 * birthday tomorrow). Nobody holds a copy; who knows it is worked out from who saw it and how far and how long it has
 * traveled since (game/news.ts).
 */
export interface NewsItem {
  id: string;
  day: number;
  /** One sentence, naming the heroes, as people would pass it on. */
  text: string;
  heroIds: string[];
  /** Where it happened. */
  zoneId: string;
  /** People who saw it or were told first-hand. */
  witnesses: string[];
  /** How far it can travel: to the witnesses' friends, the whole town, or everywhere. */
  reach: 'friends' | 'town' | 'world';
  /** Whether people think better or worse of the heroes for it (each in their own way). */
  tone: 'good' | 'bad' | 'neutral';
}

export interface NpcRuntime {
  npcId: string;
  zoneId: string;
  x: number;
  y: number;
  /** What this person thinks of each hero (hero id). */
  regard: Record<string, Regard>;
  memories: Memory[];
  /** What each hero has told this person about themselves, to be believed or found out later. */
  claims?: Record<string, string[]>;
  /** The day each hero last talked with this person (news since then is new to bring up). */
  lastTalk?: Record<string, number>;
  stock: ItemInstance[];
  stockDay: number;
  gold: number;
  /** Day this NPC last gave each hero a gift (gifts are occasional). */
  giftDay?: Record<string, number>;
  /** Secrets (indexes into the NPC's secrets) already told to each hero. */
  secretsTold?: Record<string, number[]>;
}

export interface MonsterRuntime {
  spawnId: string;
  hp: number;
  dead: boolean;
  x: number;
  y: number;
  /** Game-clock minute after which it may respawn (non-boss); packs return together once all are due. */
  respawnAt?: number;
  /** Pack fitting (decided when the pack spawns): left out for a smaller party. */
  absent?: boolean;
  /** Threat multiplier that fits the pack to the party (1 = as designed). */
  scale?: number;
  /** How many heroes its pack was last sized to (kept on the pack's own spawns): sized again when that changes, while never fought. */
  fitFor?: number;
  /** It has been in a fight: its pack keeps the size it has until it comes back. */
  fought?: boolean;
  /** An extra member added by the difficulty: the spawn it copies. */
  extraOf?: string;
  /** A creature made during play (a developer's spawn): its own spawn. It never comes back. */
  def?: import('./types.ts').SpawnDef;
}

interface FeatureRuntime {
  opened?: boolean;
  /** A chest's loot for each player who opened it (user id): each opens it for themselves. */
  lootBy?: Record<string, { items: ItemInstance[]; gold: number }>;
}

export interface LootPile {
  id: string;
  x: number;
  y: number;
  items: ItemInstance[];
  gold: number;
  /** Visible only to this user (personal loot), or everyone if absent. */
  ownerUserId?: string;
  label: string;
  /** The adventure's clock (game minutes) when it was left: an ordinary pile is gone a few days later. */
  createdAt: number;
  /** The party's remains after a defeat (the pack's contents to recover). */
  corpse?: boolean;
  /** Put down by its owner: like remains, taking it back is no find for the journal. */
  dropped?: boolean;
}

export interface ZoneRuntime {
  zoneId: string;
  monsters: Record<string, MonsterRuntime>;
  features: Record<string, FeatureRuntime>;
  loot: LootPile[];
}

interface ScheduledEvent {
  id: string;
  day: number;
  kind: 'gathering';
  zoneId: string;
  x: number;
  y: number;
  /** Id of the hero the gathering is for. */
  about: string;
  reason: string;
  npcIds: string[];
  done?: boolean;
}

export interface AdventureState {
  id: string;
  worldId: string;
  ownerId: string;
  name: string;
  createdAt: number;
  updatedAt: number;
  /** Game minutes since start. */
  clock: number;
  /** Set when this adventure began as a copy of another (Save a copy). */
  copyOf?: string;
  /** Players other than the creator who may join (user ids). */
  members: string[];
  players: Record<string, PlayerState>;
  // The story, shared by everyone in the adventure.
  quests: Record<string, QuestProgress>;
  journal: JournalEntry[];
  /** zoneId -> base64 bitset of explored tiles. */
  explored: Record<string, string>;
  visitedZones: string[];
  knownZones: string[];
  /** Arcs whose revelation has been shown. */
  revealedArcs: number[];
  completedGame?: boolean;
  /** What was said with each person (npc id), by any hero. */
  conversations: Record<string, ConversationTurn[]>;
  /** Quest and key items, held for everyone so a quest never waits on who carries them. */
  pouch: ItemInstance[];
  /** The bosses and named foes defeated (boss ids): they stay defeated, and count for a quest that comes to them later. */
  defeated: string[];
  npcs: Record<string, NpcRuntime>;
  zones: Record<string, ZoneRuntime>;
  events: ScheduledEvent[];
  /** Deeds and news people may hear of. */
  news: NewsItem[];
  /** Unique items created during play. */
  dynamicItems?: Record<string, import('./types.ts').UniqueItemDef>;
  difficulty: DifficultyId;
}

export interface AdventureSummary {
  id: string;
  worldId: string;
  name: string;
  ownerId: string;
  ownerName?: string;
  updatedAt: number;
  createdAt: number;
  copyOf?: string;
  day: number;
  players: { userId: string; name: string; level: number; zone: string }[];
  /** Every hero in it, with the file of their painted figure (when there is one). */
  heroes: { name: string; figure?: string }[];
  /** Who besides the creator may play it. */
  members: { userId: string; name: string }[];
  /** Players in the game now. */
  online?: number;
  difficulty: DifficultyId;
  /** Set when the adventure can't be played with the current engine/rules. */
  incompatible?: string;
}

export interface DamageEvent {
  targetId: string;
  amount: number;
  /** Damage type id, or 'heal'. */
  type: string;
  crit?: boolean;
  miss?: boolean;
  /** How much it matters: the amount as a share of the target's most Health (effects scale with it). */
  share?: number;
  /** The hit took the target to 0 Health. */
  fatal?: boolean;
  /** It follows another hit or comes from no one (damage over time, thorns, an extra on-hit): no sound of its own. */
  minor?: boolean;
}
