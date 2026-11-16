/** WebSocket protocol between the browser and the authoritative game server. */
import type { ActiveStatus, AdventureState, CharacterState, ItemInstance, JournalEntry, LootPile, PlayerState, DamageEvent } from './world/adventure.ts';
import type { ClientWorld, ZoneDef } from './world/types.ts';
import type { QuestDef } from './rules/quests.ts';
import type { CraftId, DifficultyId } from './ruleset/types.ts';
import type { LineCodec } from './speech.ts';
import type { Moment } from './sound.ts';

export interface Motion {
  /** Waypoints in ground meters, starting from the position at `t0`. */
  path: { x: number; y: number }[];
  from: { x: number; y: number };
  /** Meters per second. */
  speed: number;
  /** Server timestamp (ms) when movement began. */
  t0: number;
}

export type EntityKind = 'character' | 'npc' | 'monster';

export interface EntityView {
  id: string;
  kind: EntityKind;
  name: string;
  title?: string;
  x: number;
  y: number;
  motion?: Motion;
  facing: number;
  /** Asset key of its painting (its clip sheets are `<key>@anim-<clip>`). */
  sprite?: string;
  scale: number;
  level: number;
  hp: number;
  maxHp: number;
  statuses: ActiveStatus[];
  hostile: boolean;
  ownerUserId?: string;
  /** A hero played by the AI. */
  ai?: boolean;
  downed?: boolean;
  dead?: boolean;
  /** A boss or a named foe: which one (its battle music is its own). */
  bossId?: string;
  /** A named foe: one of its kind with a name of its own, fought as one of them (not a boss). */
  named?: boolean;
  inCombat?: string;
  /** NPC bark currently shown. */
  bark?: { text: string; until: number };
  /** The kind of damage it deals (boss glow, projectiles). */
  element?: string;
  /** A creature's family (its cry and its death are the family's). */
  familyId?: string;
}

export interface FeatureState {
  id: string;
  /** Not there for this player (yet): a stash nobody told them of, a quest's find before the quest. */
  unseen?: boolean;
  opened?: boolean;
  empty?: boolean;
}

export type ZoneView = Omit<ZoneDef, 'spawns' | 'lore' | 'design'>;

export interface CombatantView {
  id: string;
  name: string;
  team: 'players' | 'enemies';
  ap: number;
  maxAp: number;
  /** The player whose hero this is. */
  ownerUserId?: string;
  /** The player commanding it now (none while it fights on its own). */
  controllerUserId?: string;
  movementLeft: number;
}

export interface CombatView {
  id: string;
  round: number;
  order: CombatantView[];
  /** The first of those acting now. */
  activeId: string;
  /** Everyone acting now: one actor, or heroes sharing a turn. */
  actingIds: string[];
  turnStartedAt: number;
  /** Seconds a human has before auto end turn (multiplayer only). */
  turnLimit?: number;
}

export interface FxEvent {
  /** `relocate`: a figure fades out where it stood (x, y) and in again elsewhere (tx, ty), as after a retreat. */
  kind: 'damage' | 'skill' | 'projectile' | 'death' | 'text' | 'levelup' | 'relocate';
  sourceId?: string;
  targetId?: string;
  x?: number;
  y?: number;
  tx?: number;
  ty?: number;
  skillId?: string;
  fx?: string;
  damage?: DamageEvent;
  text?: string;
  color?: string;
  radius?: number;
  element?: string;
  /** A text: the status it announces (applied to its target), or a blow its target dodged. */
  statusId?: string;
  dodged?: boolean;
  /** A skill that rushes: where its user lands, beside the target. */
  land?: { x: number; y: number };
}

/** A line a text is spoken as: its id, and where its words end in the text (for pacing the text to the voice). */
export interface SpokenLine {
  id: string;
  to: number;
}

export interface DialogMessage {
  speaker: 'player' | 'npc' | 'narrator';
  text: string;
  /** Who said a player's line: their hero's name and the player (a conversation is shared by those in it). */
  name?: string;
  userId?: string;
  /** The lines it is spoken as (docs/voices.md), in order. */
  lines?: SpokenLine[];
  /** It could not be voiced (no engine could start it in time, or it failed). */
  unvoiced?: boolean;
  /** Still being written: the text grows. */
  pending?: boolean;
  /** Its speaker has a voice: players with voices on see the words as they are heard. */
  voiced?: boolean;
}

/** A conversation going on in the place: who is talking with whom (friends nearby may listen in and speak). */
export interface SceneView {
  npcId: string;
  npcName: string;
  /** The players in it. */
  userIds: string[];
  /** The heroes they speak through. */
  heroes: string[];
}

export interface DialogState {
  npcId: string;
  npcName: string;
  npcTitle: string;
  sprite?: string;
  messages: DialogMessage[];
  thinking: boolean;
  canTrade: boolean;
  /** Quick suggestions the player can click. */
  suggestions: string[];
  ended?: boolean;
}

export interface TradeState {
  npcId: string;
  npcName: string;
  stock: (ItemInstance & { price: number })[];
  sellMult: number;
  npcGold: number;
  /** Bag upgrade offered by this merchant (if any left to buy). */
  bagUpgrade?: { cost: number; slots: number };
}

export interface LootView {
  id: string;
  label: string;
  items: ItemInstance[];
  gold: number;
  /** Feature id or loot pile id. */
  sourceKind: 'chest' | 'pile';
}

export interface ClockView {
  minute: number;
  day: number;
  hour: number;
  paused: boolean;
}

/** The parts of the adventure's shared story a player sees. */
/**
 * What a notice is about, which decides how it shows: `pickup` is what a hero just picked up (its text the things
 * taken), shown quietly over the hero; `loot` is a find worth a notice at the top of the screen.
 */
export type ToastKind = 'info' | 'good' | 'bad' | 'quest' | 'loot' | 'pickup';

type StoryView = Pick<AdventureState, 'quests' | 'journal' | 'visitedZones' | 'knownZones' | 'pouch'>;

/** A player's own state and the story they share, with quest definitions resolved (only quests the party knows about). */
export interface PlayerView extends PlayerState, StoryView {
  questDefs: Record<string, QuestDef>;
  /** Quest markers over people. */
  npcMarkers: Record<string, 'quest' | 'turnin' | 'progress'>;
  /** Items created during play (adaptive quests). */
  dynamicItems: Record<string, { name: string; description: string }>;
  /** Visited towns available for fast travel. */
  waypoints: { zoneId: string; name: string }[];
  difficulty: DifficultyId;
  /** The friend whose party this player's walks after (`follow`), or null. */
  following: string | null;
}

/** A player in the adventure, for finding each other: their color, where their party is, and whether they are in a fight. */
export interface RosterEntry {
  userId: string;
  name: string;
  /** Their color: names, rings at their heroes' feet, arrows toward them. */
  color: string;
  /** In the game now. `away`: dropped out a moment ago, their heroes kept by the AI for a while. */
  online: boolean;
  away?: boolean;
  zoneId: string;
  /** The hero they steer (or the first of their party). */
  leaderId: string;
  /** Their heroes as the party display shows them, wherever they are (live from the entities when in the same place). */
  heroes: RosterHero[];
  fighting: boolean;
}

/** A friend's hero in the roster: enough for a party frame (portrait, Health, statuses, who plays them). */
export interface RosterHero {
  id: string;
  name: string;
  sprite: string;
  level: number;
  hp: number;
  maxHp: number;
  statuses: ActiveStatus[];
  downed?: boolean;
  /** Fights on their own (the AI decides their turns). */
  ai?: boolean;
}

/** Where a player aims a hero's skill, item, or walk during their turn, shown to their friends. */
export interface Aim {
  charId: string;
  skillId?: string;
  itemId?: string;
  /** A walk being planned (no skill or item). */
  move?: boolean;
  x: number;
  y: number;
}

/** A line said to everyone in the adventure; `at` is the server's time. */
export interface ChatLine { from: string; text: string; userId?: string; at: number }

export type ServerMessage =
  /** `chat`: what was said lately, oldest first, so someone joining or reloading can read back. */
  | { t: 'welcome'; world: ClientWorld; adventureId: string; adventureName: string; userId: string; serverTime: number; isOwner: boolean; chat: ChatLine[] }
  | { t: 'zone'; zone: ZoneView; entities: EntityView[]; features: FeatureState[]; loot: LootPile[]; explored: string }
  | { t: 'entities'; upsert: EntityView[]; remove: string[] }
  | { t: 'features'; features: FeatureState[] }
  | { t: 'loot_piles'; loot: LootPile[] }
  | { t: 'player'; player: PlayerView }
  /** The fight the player's heroes are in (null: none). */
  | { t: 'combat'; combat: CombatView | null }
  /** The fights in the player's place that their heroes are not in, which they watch. */
  | { t: 'fights'; fights: CombatView[] }
  | { t: 'fx'; events: FxEvent[] }
  | { t: 'dialog'; dialog: DialogState | null }
  | { t: 'trade'; trade: TradeState | null }
  | { t: 'loot'; loot: LootView | null }
  | { t: 'clock'; clock: ClockView }
  /** A story card. One with the `id` of a card already shown replaces it (its text grows while `pending`). */
  | { t: 'narration'; id: string; title: string; text: string; style?: 'intro' | 'arc' | 'ending' | 'quest' | 'death'; lines?: SpokenLine[]; pending?: boolean; voiced?: boolean }
  /** Open one of the player's windows (using a waypoint opens the map, a workbench the crafting window). */
  | { t: 'open'; panel: 'map' | 'craft' | 'storage' }
  /** A short notice. `sound`: the moment it is heard as, when not its kind's own (bad: refusal, good: success, loot and pickup: take, quest: success). */
  | { t: 'toast'; text: string; kind?: ToastKind; sound?: Moment | null }
  | { t: 'journal'; entry: JournalEntry }
  | { t: 'log'; text: string; color?: string }
  | ({ t: 'chat' } & ChatLine)
  /** The conversations going on in the player's place. */
  | { t: 'scenes'; scenes: SceneView[] }
  /** A friend's aim (null: they stopped aiming). */
  | { t: 'aim'; userId: string; aim: Aim | null }
  /** Who plays the adventure, where, and in what color (sent when anyone joins, leaves, travels or fights). */
  | { t: 'roster'; players: RosterEntry[] }
  | { t: 'saved'; adventureId: string; name: string }
  /**
   * The game cannot go on: `heroes` (make your heroes for this adventure first), `full` (too many heroes in the
   * game for this party), `removed` (no longer allowed in). The client takes the player to the adventure's page.
   */
  | { t: 'error'; message: string; code?: 'heroes' | 'full' | 'removed' | 'gone' }
  | { t: 'pong'; serverTime: number; clientTime: number }
  /**
   * A spoken line (see shared/speech.ts): announced when its text is ready, so the client keeps its place in its queue
   * (lines of a queue play one after another); `at` places it in the world (heard from nearby, quieter with distance).
   */
  | { t: 'line'; id: string; queue: string; at?: { x: number; y: number } }
  /** Its audio begins: binary messages follow, Opus packets or 16-bit PCM at `rate`. */
  | { t: 'line_start'; id: string; rate: number; codec: LineCodec }
  /** It is over: all its audio was sent (`done`), or it was not spoken (`expired`, `failed`) or stopped (`cancelled`). */
  | { t: 'line_end'; id: string; status: 'done' | 'expired' | 'failed' | 'cancelled' }
  | { t: 'dev_result'; reqId?: number; ok: boolean; text: string; info?: DevInfo };

export type ClientMessage =
  /** How this player hears speech: the codec their browser decodes, or null with voices off (nothing is sent). */
  | { t: 'audio'; codec: LineCodec | null }
  /** Stop hearing a line (the player skipped it). */
  | { t: 'skip_line'; id: string }
  | { t: 'ping'; clientTime: number }
  | { t: 'move'; x: number; y: number; charId?: string }
  /** `inspect` opens the loot window instead of taking everything. */
  | { t: 'interact'; targetId: string; charId?: string; inspect?: boolean }
  | { t: 'talk'; text: string; giveItemId?: string; giveGold?: number; useSkillId?: string }
  | { t: 'end_dialog' }
  /** Ask the NPC in the current conversation to trade: the shop opens at once, the reply follows. */
  | { t: 'request_trade' }
  | { t: 'use_skill'; charId: string; skillId: string; targetId?: string; x?: number; y?: number }
  | { t: 'use_item'; charId: string; itemId: string; targetId?: string; x?: number; y?: number }
  | { t: 'equip'; charId: string; itemId: string }
  | { t: 'unequip'; charId: string; slot: string }
  | { t: 'drop_item'; itemId: string; qty?: number }
  /** Hand an item from the pack to another player standing near (`qty`: how many of a stack; all when not given). */
  | { t: 'give_item'; itemId: string; toUserId: string; qty?: number }
  /** Move an item between the bag and the store of the town the leader stands at (`to`: where it goes). */
  | { t: 'store_item'; itemId: string; to: 'storage' | 'bag'; qty?: number }
  /** End a hero's turn (`charId`: which of the player's heroes sharing it; the first when not given). */
  | { t: 'end_turn'; charId?: string }
  | { t: 'flee' }
  | { t: 'buy'; npcId: string; itemId: string; qty?: number }
  | { t: 'sell'; npcId: string; itemId: string; qty?: number }
  | { t: 'end_trade' }
  /** `baseId`: for a recipe that makes gear, which of the gear it can make (craftBases). */
  | { t: 'craft'; recipeId: string; baseId?: string }
  | { t: 'take_loot'; sourceId: string; itemId?: string; all?: boolean }
  | { t: 'close_loot' }
  /** Spend a tree point on a node. */
  | { t: 'allocate'; charId: string; nodeId: string }
  | { t: 'upgrade_item'; itemId: string; charId?: string }
  | { t: 'enchant_item'; itemId: string; affixIndex: number; charId?: string }
  /** Spend a craft point on the next rank of a craft (the utility tree, the player's own). */
  | { t: 'learn_craft'; craft: CraftId }
  | { t: 'buy_inventory_upgrade'; npcId: string }
  | { t: 'set_difficulty'; difficulty: DifficultyId }
  | { t: 'set_hotbar'; charId: string; hotbar: (string | null)[] }
  | { t: 'set_leader'; charId: string }
  | { t: 'fast_travel'; zoneId: string }
  | { t: 'save_copy'; name: string }
  /** Join a conversation a friend is having close by, to listen and speak. */
  | { t: 'listen'; npcId: string }
  /** Where the player aims now during a fight (null: no longer), for their friends to see. */
  | { t: 'aim'; aim: Aim | null }
  /** Walk after a friend's party in the same place (null stops). */
  | { t: 'follow'; userId: string | null }
  /** Go to a friend in another place (neither in a fight). */
  | { t: 'join_friend'; userId: string }
  /** Switch one of the player's heroes between themselves and the AI. */
  | { t: 'set_ai'; charId: string; ai: boolean }
  /** The player leaves on purpose (not a dropped connection): their heroes leave the game at once. */
  | { t: 'leave' }
  | { t: 'abandon_quest'; questId: string }
  | { t: 'pin_quest'; questId: string }
  /**
   * Controller walking: keep moving the leader this way (a direction; 0,0 stops). x,y is where the player's own
   * screen has the leader: the server takes it (the walker's view decides), so stopping never snaps back.
   */
  | { t: 'steer'; dx: number; dy: number; x?: number; y?: number }
  /** Developer commands (administrators only; the server checks). Answered by `dev_result` with the same `reqId`. */
  | ({ t: 'dev'; reqId?: number } & DevCommand)
  | { t: 'chat'; text: string };

/**
 * Developer commands, for testing any part of the game without playing up to it. Only administrators may send them.
 * They act on the sender's own party unless `charId` names one hero. A script drives them with
 * `await window.__gd.dev({ action: 'level', level: 5 })`, which resolves to the server's `dev_result`.
 */
export type DevCommand =
  /** Go to a place (at a point of it, or its arrival point). */
  | { action: 'goto'; zoneId: string; x?: number; y?: number }
  /** See the whole map of the current place. */
  | { action: 'reveal' }
  /** Creatures leave the party alone. */
  | { action: 'peace'; on: boolean }
  /** The party takes no damage. */
  | { action: 'god'; on: boolean }
  /** Load the world again from disk (the client reconnects). */
  | { action: 'reload' }
  /** Full health, statuses gone, the downed back up. */
  | { action: 'heal' }
  /** Set the level (experience to match). Points already spent are kept while they fit, else the tree is refunded. */
  | { action: 'level'; level: number; charId?: string }
  | { action: 'xp'; amount: number }
  /** Grant (or take) unspent talent points. */
  | { action: 'points'; amount: number; charId?: string }
  | { action: 'gold'; amount: number }
  /** An item into the bag: a unique item's id or a ruleset item's id. */
  | { action: 'item'; ref: string; qty?: number; level?: number }
  /** A creature beside the leader: of a family (a member by index, or the first), or a boss. */
  | { action: 'spawn'; familyId?: string; bossId?: string; member?: number; level?: number; count?: number }
  /** Defeat the creatures fighting the party, or every hostile creature in the place (`all`), as if the party had. */
  | { action: 'kill'; all?: boolean }
  /** Bring back every creature of the current place (bosses too). */
  | { action: 'respawn' }
  /** A quest: start it, finish its current objective, complete it (rewards and all), fail it, or forget it. */
  | { action: 'quest'; questId: string; op: 'start' | 'advance' | 'complete' | 'fail' | 'reset' }
  /** Jump the main story to a quest: every main quest before it done, it started, the ones after not begun. */
  | { action: 'story'; questId: string }
  /** Set the clock: a day (from 1) and an hour (0 to 23). */
  | { action: 'time'; day?: number; hour?: number }
  /** What the commands can name: quests (with this party's progress) and bosses. */
  | { action: 'info' };

export interface DevInfo {
  quests: { id: string; title: string; main: boolean; arcIndex?: number; status?: 'active' | 'completed' | 'failed'; current?: string }[];
  bosses: { id: string; name: string; zoneId: string; familyId: string }[];
  god: boolean;
  peace: boolean;
}

/** Character creation choices. */
export interface CharacterSpec {
  name: string;
  classId: string;
  kinId: string;
}

export type { CharacterState };
