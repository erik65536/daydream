/** One running save-state of a world: authoritative simulation for every connected player. */
import {
  BitSet, listing, DIFFICULTIES, SIGHT_RADIUS, STEER_TIMEOUT_MS, currentWays, onLastStep, EARSHOT_M, MAX_HEROES,
  PRONOUNS, GAME_MINUTES_PER_DAY, REAL_MS_PER_GAME_MINUTE, RESPAWN_GAME_MINUTES, Rng, xpForLevel, outsideFights,
  fogSize, knownSkills, rx, sampleMotion, skillAp, skillRange, tilesInRadius, uid, type CharacterSpec,
  type ClientMessage, type CombatView, type DialogState, type DifficultyId, type EntityView, type FeatureDef,
  type FeatureState, type FxEvent, type AdventureState, type ItemInstance, type LineCodec, type JournalEntry,
  type Memory, type NewsItem, type PlayerState, type PlayerView, type QuestDef, type Ruleset, type SceneView,
  type ServerMessage, type Vec2, type WorldDefinition, type ZoneDef, type ZoneRuntime, type CharacterState,
  type Moment, type ToastKind, type ChatLine,
} from '@daydream/shared';
import { Actor, CharActor, MonsterActor, NpcActor } from './actors.ts';
import { killXpFor } from '../rules/bind.ts';
import { isTopRarity } from './legends.ts';
import { withCallContext } from '../genai/context.ts';
import { reportError } from '../log.ts';
import { recapWorthy, storySoFar } from './recap.ts';
import { WorldCtx, type ZoneMap } from './worldctx.ts';
import { bodyAt, fightPositions, isFree, nearestFree } from './space.ts';
import { Combat, type CombatHost, type CombatOutcome } from './combat.ts';
import { checkItemUse, checkSkill, executeSkill, isHostileTo, useConsumable } from './effects.ts';
import { QuestEngine } from './quests.ts';
import { DialogueEngine } from './dialogue.ts';
import { AdventureVoices, NARRATOR, SpokenText } from './voices.ts';
import { addToInventory, makeItem, makeUnique, mergeStacks, removeFromInventory, rollRandomItem, topRarity } from './loot.ts';
import { allocateNode, clampHealth, createCharacter, grantXp, regenerate, restoreFully, startAtLevel } from './characters.ts';
import { Presence } from './presence.ts';
import { Following } from './following.ts';
import { Walking } from './walking.ts';
import { Places } from './places.ts';
import { Items, LOOT_REACH, opener } from './items.ts';
import { DevCommands } from './dev.ts';

type NarrationStyle = Extract<ServerMessage, { t: 'narration' }>['style'];

export interface Conn {
  userId: string;
  /** The name the player goes by now (their account's display name): the adventure takes it up on joining. */
  name?: string;
  send(msg: ServerMessage): void;
  /** Binary data: a spoken line's audio (shared/speech.ts). */
  sendBinary?(data: Uint8Array): void;
  /** How the player hears speech, as they connected (null: voices off, or the browser has not allowed sound yet). */
  audio?: LineCodec | null;
  /** End the connection (a player removed from the adventure). */
  close?(): void;
}

export interface LiveZone {
  id: string;
  map: ZoneMap;
  rt: ZoneRuntime;
  actors: Map<string, Actor>;
  lootDirty: boolean;
  featuresDirty: Set<string>;
}

/**
 * What a player's hero is walking over to do, done on arrival: use something (talk to a person, open a chest, take a
 * pile, look at a sign or take a way out), or use a skill aimed beyond reach, at someone or at a point on the ground.
 * `payer`: whose AI budget pays for what it sets off (a person's reply), as when the order was given.
 */
export type Errand = ({ kind: 'use'; charId: string; targetId: string; inspect?: boolean } | { kind: 'skill'; charId: string; skillId: string; targetId?: string; point?: Vec2 }) & { payer?: string };

const TICK_MS = 100;
/** A skill's refusal that walking closer can answer: the hero then walks into reach and uses it. */
const beyondReach = (err: string) => err === 'Out of range.' || err === 'No line of sight.';
/** How many lines of chat a player joining or reloading can read back. */
const CHAT_KEPT = 50;
const AGGRO_RADIUS = 6.5;
/** How far a creature notices a party's leader (a boss further). */
const aggroRadius = (m: MonsterActor) => (m.isBoss ? AGGRO_RADIUS + 2 : AGGRO_RADIUS);
/** How long (ms) a party member down out of a fight stays down before getting up. */
const DOWNED_GET_UP_MS = 3000;
/**
 * How close a hero must come to anyone in a fight, in sight of them, to be in it: the same whether the fight is
 * starting or under way, so a hero is never pulled in from behind a wall or kept out while standing beside it.
 */
const JOIN_DISTANCE = 8;
/** What waits while a person's reply is on its way (holdNotices). */
const HELD_NOTICES = new Set<ServerMessage['t']>(['toast', 'journal', 'narration']);
/** How many things a person remembers about heroes: the oldest go first. */
const MEMORIES_KEPT = 40;
/** The level a hero made now starts at among these players: that of their lowest hero (1 with none). */
export const lowestHeroLevel = (players: PlayerState[]): number => {
  const levels = players.flatMap((p) => p.party.map((c) => c.level));
  return levels.length ? Math.min(...levels) : 1;
};

/** A new adventure's state: the story not begun, nobody in it yet. */
export function blankAdventure(id: string, worldId: string, ownerId: string, name: string, difficulty: DifficultyId = 'normal'): AdventureState {
  return {
    id,
    worldId,
    ownerId,
    name,
    createdAt: Date.now(),
    updatedAt: Date.now(),
    clock: 8 * 60,
    members: [],
    players: {},
    quests: {},
    journal: [],
    explored: {},
    visitedZones: [],
    knownZones: [],
    revealedArcs: [],
    conversations: {},
    pouch: [],
    defeated: [],
    npcs: {},
    zones: {},
    events: [],
    news: [],
    difficulty,
  };
}

export class Adventure implements CombatHost {
  /** How long (ms) a dropped player's heroes stay in the game, played by the AI, before they leave too (tests shorten it). */
  static awayMs = 60_000;
  readonly ctx: WorldCtx;
  readonly world: WorldDefinition;
  readonly r: Ruleset;
  readonly rng: Rng;
  readonly quests: QuestEngine;
  readonly dialogue: DialogueEngine;
  readonly voices: AdventureVoices;
  conns = new Map<string, Set<Conn>>();
  /** The last lines said, for whoever joins or reloads (kept while the adventure is open, not saved). */
  chat: ChatLine[] = [];
  /** Notices waiting for a reply to be out, by player (holdNotices). */
  private heldNotices = new Map<string, ServerMessage[]>();
  zones = new Map<string, LiveZone>();
  combats = new Map<string, Combat>();
  private dirtyPlayers = new Set<string>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private lastTick = Date.now();
  private lastClockSent = 0;
  private lastAggro = 0;
  private lastRegen = 0;
  /** How many times Health has come back (once a second): statuses that help wear off one turn every third. */
  private regens = 0;
  private lastFollow = 0;
  private dirtySince = 0;
  onSave?: (s: AdventureState) => void;
  /** Called when the adventure has no connected players. */
  onEmpty?: () => void;
  state: AdventureState;

  readonly presence = new Presence(this);
  readonly follow = new Following(this);
  readonly walking = new Walking(this);
  readonly places = new Places(this);
  readonly items = new Items(this);
  readonly dev = new DevCommands(this);

  constructor(state: AdventureState, world: WorldDefinition) {
    this.state = state;
    this.world = world;
    this.r = world.ruleset;
    this.ctx = new WorldCtx(world);
    this.rng = new Rng(`${state.id}:${Date.now()}`);
    this.items.mergeDynamicItems();
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    this.quests = new QuestEngine({
      ctx: this.ctx,
      rng: this.rng,
      get story() {
        return self.state;
      },
      day: () => this.day(),
      questDef: (id) => this.questDef(id),
      present: () => this.present(),
      give: (p, items) => this.items.give(p, items),
      holdings: (first) => [this.state.pouch, ...(first ? [first.inventory] : []), ...Object.values(this.state.players).filter((p) => p !== first).map((p) => p.inventory)],
      journal: (kind, text) => this.journal(kind, text),
      toast: (text, kind, sound) => this.toastAll(text, kind, sound),
      narrate: (title, text, style) => this.narrate(this.present().map((p) => p.userId), title, text, style),
      grantXp: (p, amount) => this.grantPartyXp(p, amount),
      talkingWith: (npcId) => !!this.dialogue?.scenes().some((s) => s.npcId === npcId),
      grantGold: (p, amount) => {
        p.gold += amount;
        p.stats.goldEarned += amount;
      },
      changed: () => this.markAll(),
      begun: (questId) => this.places.questBegun(questId),
      questEvent: (q, kind) => this.questGossip(q, kind),
    });
    this.voices = new AdventureVoices({
      adventureId: state.id,
      world,
      sendTo: (u, m) => this.sendTo(u, m),
      sendBinaryTo: (u, d) => {
        for (const c of this.conns.get(u) ?? []) c.sendBinary?.(d);
      },
    });
    this.dialogue = new DialogueEngine(this.dialogueHost());
    for (const n of world.npcs) state.npcs[n.id] ??= this.places.initNpc(n.id);
  }

  // =================================================================== lifecycle

  start() {
    if (this.timer) return;
    this.lastTick = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
  }

  stop() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const kept of this.presence.away.values()) clearTimeout(kept.timer);
    this.presence.away.clear();
  }

  save() {
    this.onSave?.(this.state);
    this.dirtySince = 0;
  }

  onlineUsers(): string[] {
    return [...this.conns.keys()];
  }

  isPaused() {
    return this.conns.size === 0;
  }

  day() {
    return Math.floor(this.state.clock / GAME_MINUTES_PER_DAY) + 1;
  }

  hour() {
    return Math.floor((this.state.clock % GAME_MINUTES_PER_DAY) / 60);
  }

  timeOfDay() {
    const h = this.hour();
    return h < 5 ? 'the dead of night' : h < 8 ? 'early morning' : h < 12 ? 'morning' : h < 14 ? 'midday' : h < 18 ? 'afternoon' : h < 21 ? 'evening' : 'night';
  }

  now() {
    return Date.now();
  }

  // =================================================================== players & connections

  /**
   * The level a hero made now starts at: that of the lowest hero in the game (of everyone's heroes, when nobody is
   * playing; 1 in a new adventure). Catch-up experience brings it the rest of the way.
   */
  newHeroLevel(): number {
    return lowestHeroLevel(this.present().length ? this.present() : Object.values(this.state.players));
  }

  /** A player's first heroes in this adventure (they arrive where the story began). */
  addPlayer(userId: string, name: string, specs: CharacterSpec[]): PlayerState {
    const w = this.world;
    const level = this.newHeroLevel();
    const prng = new Rng(`${this.state.id}:${userId}`);
    const party: CharacterState[] = [];
    const inventory: ItemInstance[] = [];
    for (const spec of specs.slice(0, MAX_HEROES)) {
      const { ch, inventory: inv } = createCharacter(this.r, spec, prng);
      startAtLevel(this.r, ch, level, prng);
      party.push(ch);
      addToInventory(this.r, inventory, inv);
    }
    if (!party.length) party.push(createCharacter(this.r, { name, classId: this.r.classes[0]!.id, kinId: this.r.kins[0]!.id }, prng).ch);
    for (const ch of party) restoreFully(this.r, ch);
    const start = this.ctx.zones.get(w.startZoneId)!;
    const p: PlayerState = {
      userId,
      name,
      party,
      bench: [],
      leaderId: party[0]!.id,
      gold: 60,
      inventory: mergeStacks(this.r, inventory),
      inventoryUpgrades: 0,
      zoneId: start.id,
      x: start.entry.x,
      y: start.entry.y,
      lastTownZoneId: start.id,
      stats: { kills: 0, deaths: 0, questsCompleted: 0, goldEarned: 0, itemsCrafted: 0 },
      createdAt: Date.now(),
    };
    this.state.players[userId] = p;
    for (const l of [start.id, ...start.links]) if (!this.state.knownZones.includes(l)) this.state.knownZones.push(l);
    return p;
  }

  /** Another hero for a player who already has some (outside the game): it joins their party. */
  makeHero(userId: string, spec: CharacterSpec): CharacterState {
    const p = this.state.players[userId]!;
    const rng = new Rng(`${this.state.id}:${userId}:${p.party.length + p.bench.length}:${Date.now()}`);
    const { ch, inventory } = createCharacter(this.r, spec, rng);
    startAtLevel(this.r, ch, this.newHeroLevel(), rng);
    p.party.push(ch);
    addToInventory(this.r, p.inventory, inventory);
    this.markDirty();
    return ch;
  }

  /** Players in the game now. */
  present(): PlayerState[] {
    return [...this.conns.keys()].map((u) => this.state.players[u]).filter((p): p is PlayerState => !!p);
  }

  /** Players whose heroes are in the game: those connected, and those who dropped out a moment ago. */
  inGame(): PlayerState[] {
    return Object.values(this.state.players).filter((p) => this.conns.has(p.userId) || this.presence.away.has(p.userId));
  }

  /** Heroes in the game now, all players' together (`except` one player's). */
  heroesInGame(except?: string): number {
    return this.inGame().reduce((n, p) => n + (p.userId === except ? 0 : p.party.length), 0);
  }

  /** The adventure is gone for good (its world was deleted): everyone in it is told why and let go. */
  endFor(message: string) {
    for (const set of [...this.conns.values()])
      for (const c of [...set]) {
        c.send({ t: 'error', message, code: 'gone' });
        c.close?.();
      }
  }

  /**
   * This running copy gives way to a fresh one (a developer's reload): each party is kept where it stands and every
   * connection ends without a word, so each player's client connects again by itself, to the new copy.
   */
  handOver() {
    for (const p of this.inGame()) {
      const lead = this.leader(p);
      if (lead) [p.x, p.y] = [lead.x, lead.y];
    }
    this.save();
    this.stop();
    this.onSave = this.onEmpty = this.saveCopy = undefined;
    for (const set of [...this.conns.values()]) for (const c of [...set]) c.close?.();
  }

  /** A connection joins. Returns false when it cannot: no heroes yet, or too many heroes in the game for its party. */
  join(conn: Conn): boolean {
    this.presence.leaving.delete(conn.userId);
    const p = this.state.players[conn.userId];
    if (!p) {
      conn.send({ t: 'error', message: 'Make your heroes for this adventure first.', code: 'heroes' });
      return false;
    }
    // A name changed on the account since the player last played shows to their friends from now on.
    if (conn.name?.trim() && conn.name !== p.name) {
      p.name = conn.name;
      this.markDirty();
    }
    if (!this.conns.has(conn.userId)) {
      const others = this.heroesInGame(conn.userId);
      if (others + p.party.length > MAX_HEROES) {
        const room = MAX_HEROES - others;
        conn.send({ t: 'error', message: `${others} heroes are in the game and at most ${MAX_HEROES} can be: ${room > 0 ? `bring ${room === 1 ? 'one hero' : `up to ${room} heroes`}` : 'there is no room until someone leaves'}.`, code: 'full' });
        return false;
      }
    }
    let set = this.conns.get(conn.userId);
    const firstConn = !set;
    if (!set) this.conns.set(conn.userId, (set = new Set()));
    set.add(conn);
    if (conn.audio) this.voices.setCodec(conn.userId, conn.audio);
    conn.send({
      t: 'welcome',
      world: this.clientWorld(),
      adventureId: this.state.id,
      adventureName: this.state.name,
      userId: conn.userId,
      serverTime: Date.now(),
      isOwner: this.state.ownerId === conn.userId,
      chat: this.chat,
    });
    if (firstConn) {
      // Back within the minute: the heroes the AI kept are theirs again.
      const kept = this.presence.away.get(p.userId);
      if (kept) {
        clearTimeout(kept.timer);
        this.presence.away.delete(p.userId);
      }
      if (this.charActors(p).length) for (const a of this.charActors(p)) (a.playerAway = false), (a.dirty = true);
      else this.spawnParty(p);
    }
    this.sendZone(conn.userId);
    this.sendPlayer(conn.userId);
    this.sendClock(true);
    const own = this.fightOf(p);
    if (own) conn.send({ t: 'combat', combat: own.view() });
    // A player's first time in: the introduction. The adventure's first time: the story begins.
    if (!p.introduced) {
      p.introduced = true;
      this.narrate([p.userId], this.world.concept.title, this.world.concept.intro, 'intro');
    }
    if (!this.state.visitedZones.length) {
      this.enteredZone(p, p.zoneId, true);
      this.quests.autoStart();
    }
    if (firstConn) void withCallContext({ priority: 'interactive', userId: p.userId }, () => this.tellStorySoFar(p));
    this.presence.sendRoster();
    this.sendScenes();
    this.start();
    return true;
  }

  /** A player coming back after the story moved on hears what happened meanwhile. */
  private async tellStorySoFar(p: PlayerState) {
    const since = p.leftAt;
    p.leftAt = undefined;
    if (since === undefined) return;
    const missed = this.state.journal.filter((e) => e.minute > since && recapWorthy(e));
    if (missed.length < 2) return;
    const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0];
    const live = this.liveNarration([p.userId], 'The story so far', 'arc');
    live.end(await storySoFar(this.world, missed, lead?.name ?? p.name, live.grow));
  }

  /**
   * A connection ends. With the player's last one, their heroes pass to the AI for a minute (a dropped connection
   * comes back without anything happening), then leave the game; see goAway. A player who left on purpose takes
   * them out at once (still not in the middle of a fight with another player).
   */
  leave(conn: Conn) {
    const set = this.conns.get(conn.userId);
    if (!set) return;
    set.delete(conn);
    if (set.size) return;
    this.conns.delete(conn.userId);
    this.endDialog(conn.userId);
    this.voices.left(conn.userId);
    this.items.lootOpen.delete(conn.userId);
    this.follow.following.delete(conn.userId);
    // Whoever followed them stops: their heroes are the AI's now, and walk after a friend themselves.
    for (const [u, friend] of this.follow.following) {
      if (friend !== conn.userId) continue;
      this.follow.following.delete(u);
      this.markPlayer(u);
    }
    const p = this.state.players[conn.userId];
    if (p) {
      p.leftAt = this.state.clock;
      this.walking.steering.delete(p.userId);
      this.walking.stopSteering(p);
      const actors = this.charActors(p);
      for (const a of actors) (a.playerAway = true), (a.dirty = true);
      const fight = this.fightOf(p);
      if (fight) {
        this.broadcastCombat(fight);
        for (const a of actors) if (fight.isActing(a)) fight.aiTakeOver(a);
      }
      const wait = this.presence.leaving.delete(p.userId) ? 0 : Adventure.awayMs;
      if (actors.length) this.presence.away.set(p.userId, { timer: setTimeout(() => this.presence.goAway(p.userId), wait) });
    }
    this.save();
    this.presence.sendRoster();
    if (!this.conns.size && !this.presence.away.size) this.onEmpty?.();
  }

  // What the server and its tools call of the parts kept in their own files (presence.ts, items.ts).

  kick(userId: string, message: string) {
    this.presence.kick(userId, message);
  }

  settleAway(userId: string): string | null {
    return this.presence.settleAway(userId);
  }

  openTrade(userId: string, npcId: string) {
    this.items.openTrade(userId, npcId);
  }

  clientWorld() {
    const w = this.world;
    const { zones, npcs, concept, arcs, quests, ending, generationLog, voices, ...rest } = w;
    void quests, ending, generationLog, voices;
    return {
      ...rest,
      concept,
      // A place's walkable ground comes with the place itself, when the player enters it.
      zones: zones.map(({ nav, design, spawns, lore, ...z }) => (void nav, void design, void spawns, void lore, z)),
      npcs: npcs.map((n) => ({ id: n.id, name: n.name, title: n.title, role: n.role, zoneId: n.zoneId, asset: n.asset, pronouns: n.pronouns, appearance: n.appearance })),
      arcs: arcs.map((a) => ({ index: a.index, title: a.title })),
    } as ServerMessage extends never ? never : Extract<ServerMessage, { t: 'welcome' }>['world'];
  }

  /** The conversations going on in each player's place (friends close by may listen in). */
  sendScenes() {
    const all = this.dialogue.scenes();
    for (const u of this.conns.keys()) {
      const p = this.state.players[u];
      if (!p) continue;
      const scenes: SceneView[] = all
        .filter((s) => this.state.npcs[s.npcId]?.zoneId === p.zoneId)
        .map((s) => ({ npcId: s.npcId, npcName: this.ctx.npcs.get(s.npcId)?.name ?? 'someone', userIds: s.userIds, heroes: s.userIds.map((m) => this.speakerOf(m)?.name ?? '') }));
      this.sendTo(u, { t: 'scenes', scenes });
    }
  }

  /** Join a friend's conversation close by: walk over if need be, then listen and speak. */
  private cmdListen(p: PlayerState, npcId: string) {
    if (!this.dialogue.scenes().some((s) => s.npcId === npcId)) return this.sendError(p.userId, 'That conversation is over.');
    const npc = this.zones.get(p.zoneId)?.actors.get(npcId);
    if (!(npc instanceof NpcActor)) return;
    this.walking.cmdInteract(p, npc.id);
  }

  sendTo(userId: string, msg: ServerMessage) {
    const held = this.heldNotices.get(userId);
    if (held && HELD_NOTICES.has(msg.t)) return void held.push(msg);
    for (const c of this.conns.get(userId) ?? []) c.send(msg);
  }

  /**
   * Notices for these players (toasts, the journal, narration) wait until `release` is called, so a person's reply
   * reaches them before what it did: the sound of a quest taken or a step done follows the words, not over them.
   */
  private holdNotices(userIds: string[]): () => void {
    const mine = userIds.filter((u) => !this.heldNotices.has(u));
    for (const u of mine) this.heldNotices.set(u, []);
    return () => {
      for (const u of mine) {
        const held = this.heldNotices.get(u) ?? [];
        this.heldNotices.delete(u);
        for (const m of held) this.sendTo(u, m);
      }
    };
  }

  /**
   * Someone says a short line out loud where they stand (a bark, a taunt): the players whose hero is within earshot
   * hear it, quieter with distance, or those given. Nobody is told when it could not be voiced.
   */
  sayAloud(a: Actor, speakerId: string, text: string, userIds?: string[]) {
    const hearers = userIds ?? this.present().filter((p) => {
      const lead = this.leader(p);
      return lead && lead.zoneId === a.zoneId && Math.hypot(lead.x - a.x, lead.y - a.y) < EARSHOT_M;
    }).map((p) => p.userId);
    const spoken = new SpokenText(() => this.voices.reply(speakerId, hearers, `aloud:${speakerId}`, undefined, { x: a.x, y: a.y }));
    spoken.end(text);
  }

  /**
   * Narration shown to these players, read by the world's narrator to those who have voices on. A player talking with
   * someone hears it once they leave the conversation, not over the person's words.
   */
  narrate(userIds: string[], title: string, text: string, style: NarrationStyle) {
    const now = userIds.filter((u) => !this.dialogue?.talking(u));
    for (const u of userIds) if (!now.includes(u)) this.afterTalk.set(u, [...(this.afterTalk.get(u) ?? []), { title, text, style }]);
    if (now.length) this.liveNarration(now, title, style).end(text);
  }

  /** Narration waiting for each player's conversation to end (narrate). */
  private afterTalk = new Map<string, { title: string; text: string; style: NarrationStyle }[]>();

  /** Tell the narration that waited for players now out of their conversations. */
  private tellAfterTalk() {
    for (const [u, list] of this.afterTalk) {
      if (this.dialogue.talking(u)) continue;
      this.afterTalk.delete(u);
      for (const n of list) this.narrate([u], n.title, n.text, n.style);
    }
  }

  /**
   * Narration whose text grows as it is written (the story so far): `grow` takes the text so far (shown at most a few
   * times a second, and read sentence by sentence), `end` the whole of it.
   */
  liveNarration(userIds: string[], title: string, style: NarrationStyle) {
    const id = uid('nr');
    const spoken = new SpokenText(() => this.voices.reply(NARRATOR, userIds, 'narrator'));
    let sentAt = 0;
    const send = (text: string, pending: boolean) => {
      sentAt = Date.now();
      for (const u of userIds) this.sendTo(u, { t: 'narration', id, title, text, style, lines: spoken.lines.length ? spoken.lines : undefined, pending: pending || undefined, voiced: this.voices.has(NARRATOR) || undefined });
    };
    return {
      grow: (text: string) => {
        if (spoken.grow(text) || Date.now() - sentAt > 200) send(text, true);
      },
      end: (text: string) => {
        spoken.end(text);
        send(text, false);
      },
    };
  }

  broadcastZone(zoneId: string, msg: ServerMessage | ((userId: string) => ServerMessage | null)) {
    for (const [userId] of this.conns) {
      const p = this.state.players[userId];
      if (!p || p.zoneId !== zoneId) continue;
      const m = typeof msg === 'function' ? msg(userId) : msg;
      if (m) this.sendTo(userId, m);
    }
  }

  markPlayer(userId: string) {
    this.dirtyPlayers.add(userId);
    this.markDirty();
  }

  /** The story changed: everyone's view of it. */
  markAll() {
    for (const u of Object.keys(this.state.players)) this.dirtyPlayers.add(u);
    this.markDirty();
  }

  /** A notice for everyone; the same words again at once (two quests sharing a step) are shown once. */
  toastAll(text: string, kind?: ToastKind, sound?: Moment | null) {
    const now = Date.now();
    if (this.lastToast.text === text && now - this.lastToast.at < 1000) return;
    this.lastToast = { text, at: now };
    for (const u of this.conns.keys()) this.sendTo(u, { t: 'toast', text, kind, sound });
  }
  private lastToast = { text: '', at: 0 };

  markDirty() {
    if (!this.dirtySince) this.dirtySince = Date.now();
  }

  // =================================================================== zones

  zoneMap(zoneId: string): ZoneMap {
    return this.ctx.map(zoneId);
  }

  actorsInZone(zoneId: string): Actor[] {
    return [...(this.zones.get(zoneId)?.actors.values() ?? [])];
  }

  /** Walkable ground (meters). */
  passable(zoneId: string, x: number, y: number): boolean {
    return this.ctx.map(zoneId).nav.walkable(x, y);
  }

  nearestFree(zoneId: string, p: Vec2, ignoreId?: string): Vec2 {
    return nearestFree(this.ctx.map(zoneId).nav, this.actorsInZone(zoneId), p, ignoreId) ?? p;
  }

  // =================================================================== party spawning & zone transfer

  charActors(p: PlayerState): CharActor[] {
    const z = this.zones.get(p.zoneId);
    if (!z) return [];
    return p.party.map((c) => z.actors.get(c.id)).filter((a): a is CharActor => a instanceof CharActor);
  }

  leader(p: PlayerState): CharActor | undefined {
    const all = this.charActors(p);
    return all.find((a) => a.id === p.leaderId && a.alive()) ?? all.find((a) => a.alive()) ?? all[0];
  }

  /** The fight a player's heroes are in, if any (a party joins a fight whole, so it is in one at a time). */
  fightOf(p: PlayerState): Combat | undefined {
    return this.charActors(p).map((a) => this.combatOf(a)).find((c): c is Combat => !!c);
  }

  inFight(p: PlayerState): boolean {
    return this.charActors(p).some((a) => a.combatId);
  }

  spawnParty(p: PlayerState, at?: Vec2) {
    const wasLive = this.zones.has(p.zoneId);
    const z = this.places.live(p.zoneId);
    // A party comes into a place others are in already: its packs never fought are sized again, to everyone there now.
    if (wasLive) this.places.populate(z, undefined, true);
    // (A position off the place's ground, saved before it was laid out again, arrives at the way in instead.)
    const base = nearestFree(z.map.nav, this.actorsInZone(p.zoneId), at ?? { x: p.x, y: p.y }) ?? this.nearestFree(p.zoneId, z.map.def.entry);
    // Followers stand clear of ways out: one standing on a way out covers it, and a click on it picks them.
    const doors = z.map.def.features.filter((f) => f.kind === 'exit');
    const clearOfDoors = (cx: number, cy: number) => {
      const c = z.map.nav.center(cx, cy);
      return z.map.nav.walkableCell(cx, cy) && !bodyAt(this.actorsInZone(p.zoneId), c) && doors.every((f) => Math.hypot(f.x - c.x, f.y - c.y) >= 1.2);
    };
    p.party.forEach((ch, i) => {
      const near = { x: base.x + ((i % 2) ? 1 : -1), y: base.y + (i > 1 ? 1 : 0) };
      const spot = i === 0 ? base : z.map.nav.nearestWalkable(near, 4, clearOfDoors) ?? this.nearestFree(p.zoneId, near);
      const a = new CharActor(ch, p.userId, p.zoneId, spot.x, spot.y, this.r);
      z.actors.set(a.id, a);
      a.dirty = true;
    });
    p.x = base.x;
    p.y = base.y;
  }

  despawnParty(p: PlayerState) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const leader = this.leader(p);
    if (leader) {
      p.x = leader.x;
      p.y = leader.y;
    }
    for (const c of p.party) {
      const a = z.actors.get(c.id);
      if (!a) continue;
      if (a.combatId) this.combats.get(a.combatId)?.remove(a);
      z.actors.delete(c.id);
      this.broadcastZone(p.zoneId, { t: 'entities', upsert: [], remove: [c.id] });
    }
    this.places.maybeUnloadZone(p.zoneId);
  }

  /** Move a player's party to another zone, arriving next to `targetFeatureId` or at the entry. */
  transfer(p: PlayerState, zoneId: string, targetFeatureId?: string, at?: Vec2) {
    if (!this.ctx.zones.has(zoneId)) return;
    if (this.inFight(p)) return this.sendError(p.userId, 'You cannot leave during a fight.');
    this.endDialog(p.userId);
    this.items.closeLoot(p.userId);
    this.walking.errands.delete(p.userId);
    const fromZone = p.zoneId;
    this.despawnParty(p);
    const def = this.ctx.zones.get(zoneId)!;
    let arrive = at ?? def.entry;
    const tf = targetFeatureId ? def.features.find((f) => f.id === targetFeatureId) : undefined;
    // Off the door or way out, onto open ground (the place's packs keep their distance from there).
    if (tf && !at) arrive = this.ctx.map(zoneId).nav.arrival(tf);
    p.zoneId = zoneId;
    p.x = arrive.x;
    p.y = arrive.y;
    // (A party out of the game, gone between a defeat and its walk home, is only moved.)
    if (!this.conns.has(p.userId) && !this.presence.away.has(p.userId)) return this.places.maybeUnloadZone(fromZone);
    this.spawnParty(p, arrive);
    this.sendZone(p.userId);
    this.enteredZone(p, zoneId, false);
    this.sendPlayer(p.userId);
    this.places.maybeUnloadZone(fromZone);
    this.presence.sendRoster();
    this.sendScenes();
  }

  enteredZone(p: PlayerState, zoneId: string, silent: boolean) {
    const def = this.ctx.zones.get(zoneId)!;
    const story = this.state;
    if (!story.visitedZones.includes(zoneId)) {
      story.visitedZones.push(zoneId);
      if (!silent) {
        this.journal('discovery', `Discovered ${def.name}.`);
        this.toastAll(`Discovered: ${def.name}`, 'info');
      }
    }
    for (const l of [zoneId, ...def.links]) if (!story.knownZones.includes(l)) story.knownZones.push(l);
    if (def.kind === 'town') p.lastTownZoneId = zoneId;
    // Community gatherings happening today, for one of these heroes.
    const ev = this.state.events.find((e) => !e.done && e.day === this.day() && e.zoneId === zoneId && p.party.some((c) => c.id === e.about));
    if (ev && def.kind === 'town') {
      ev.done = true;
      const hero = p.party.find((c) => c.id === ev.about)!;
      this.narrate([p.userId], def.name, `The townsfolk have gathered in the square. As ${hero.name} arrives, faces turn toward them — and someone starts to cheer. They remembered: ${ev.reason}`, 'quest');
      this.journal('social', `The people of ${def.name} gathered for ${hero.name}: ${ev.reason}`);
    }
    this.markAll();
  }

  // =================================================================== views

  /** The state of a place's features as a player sees them (a chest is open, and empty, for whoever opened it). */
  private featureStates(zoneId: string, userId: string): FeatureState[] {
    const rt = this.places.zoneRuntime(zoneId);
    return this.ctx.map(zoneId).def.features.map((f) => {
      if (!this.sees(f, userId)) return { id: f.id, unseen: true };
      const r = rt.features[f.id] ?? {};
      const mine = r.lootBy?.[opener(f, userId)];
      const opened = f.kind === 'chest' ? !!mine : r.opened;
      return { id: f.id, opened, empty: f.kind === 'chest' && !!mine && !(mine.items.length || mine.gold) };
    });
  }

  /** Whether a feature is there for a player: a stash once someone told one of their heroes of it, a quest's find once the quest has begun. */
  sees(f: FeatureDef, userId: string): boolean {
    return (!f.hidden || this.toldOf(f.id, userId)) && (!f.questId || !!this.state.quests[f.questId]);
  }

  /** What players see of places' features may have changed (a stash told of, a quest begun): send it again. */
  refreshFeatures() {
    for (const z of this.zones.values()) z.featuresDirty.add('*');
  }

  /** Whether someone has told one of a player's heroes of a stash. */
  private toldOf(featureId: string, userId: string): boolean {
    const heroes = this.state.players[userId]?.party.map((c) => c.id) ?? [];
    return this.world.npcs.some((n) => n.secrets.some((s, i) => s.leadsTo === featureId && heroes.some((h) => this.state.npcs[n.id]?.secretsTold?.[h]?.includes(i))));
  }

  sendZone(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    this.sendTo(userId, { t: 'zone', ...this.zonePayload(userId) });
    this.sendTo(userId, { t: 'fights', fights: this.fightsWatchedBy(userId, p.zoneId) });
  }

  private playerView(p: PlayerState): PlayerView {
    const s = this.state;
    const questDefs: Record<string, QuestDef> = {};
    for (const id of Object.keys(s.quests)) {
      const d = this.questDef(id);
      if (d) questDefs[id] = d;
    }
    // Over a person: "?" when a quest ends with them, "!" when they have work to give (a side job to ask for, or a
    // story quest that starts by going to them), and a quieter mark when someone on the way is to be seen.
    const npcMarkers: PlayerView['npcMarkers'] = {};
    const rank = { progress: 0, quest: 1, turnin: 2 } as const;
    const mark = (npcId: string, m: keyof typeof rank) => {
      const had = npcMarkers[npcId];
      if (!had || rank[m] > rank[had]) npcMarkers[npcId] = m;
    };
    for (const n of this.world.npcs) {
      if (this.dialogue.availableQuests(n).length) mark(n.id, 'quest');
    }
    for (const [qid, prog] of Object.entries(s.quests)) {
      if (prog.status !== 'active') continue;
      const def = questDefs[qid];
      if (!def) continue;
      const last = onLastStep(def, prog);
      for (const o of currentWays(def, prog)) {
        if (!o.npcId) continue;
        if (last) mark(o.npcId, 'turnin');
        else mark(o.npcId, o.type === 'talk' && o.npcId === def.giverNpcId ? 'quest' : 'progress');
      }
    }
    const dynamicItems: PlayerView['dynamicItems'] = {};
    for (const [k, v] of Object.entries(this.state.dynamicItems ?? {})) dynamicItems[k] = { name: v.name, description: v.description };
    const waypoints = s.visitedZones
      .map((id) => this.ctx.zones.get(id)!)
      .filter((z) => z && z.kind === 'town' && this.r.systems.fastTravel)
      .map((z) => ({ zoneId: z.id, name: z.name }));
    const story = { quests: s.quests, journal: s.journal, visitedZones: s.visitedZones, knownZones: s.knownZones, pouch: s.pouch };
    return { ...p, ...story, questDefs, npcMarkers, dynamicItems, waypoints, difficulty: s.difficulty, following: this.follow.following.get(p.userId) ?? null };
  }

  sendPlayer(userId: string) {
    const p = this.state.players[userId];
    if (!p) return;
    this.sendTo(userId, { t: 'player', player: this.playerView(p) });
  }

  sendClock(force = false) {
    const now = Date.now();
    if (!force && now - this.lastClockSent < 5000) return;
    this.lastClockSent = now;
    const msg: ServerMessage = { t: 'clock', clock: { minute: this.state.clock, day: this.day(), hour: this.hour(), paused: this.isPaused() } };
    for (const userId of this.conns.keys()) this.sendTo(userId, msg);
  }

  fx(zoneId: string, events: FxEvent[]) {
    if (events.length) this.broadcastZone(zoneId, { t: 'fx', events });
  }

  log(zoneId: string, text: string, color?: string) {
    this.broadcastZone(zoneId, { t: 'log', text, color });
  }

  /** The shared journal: everyone in the game hears of it, and has it in their own view of the story. */
  journal(kind: JournalEntry['kind'], text: string) {
    const entry: JournalEntry = { day: this.day(), minute: Math.round(this.state.clock), kind, text };
    this.state.journal.push(entry);
    if (this.state.journal.length > 300) this.state.journal.shift();
    for (const u of this.conns.keys()) this.sendTo(u, { t: 'journal', entry });
    this.markAll();
  }

  // =================================================================== tick

  private tick() {
    const now = Date.now();
    const dt = now - this.lastTick;
    this.lastTick = now;
    if (!this.isPaused()) {
      const before = this.day();
      this.state.clock += dt / REAL_MS_PER_GAME_MINUTE;
      if (this.day() !== before) this.newDay();
    }
    for (const [userId, s] of this.walking.steering) {
      const p = this.state.players[userId];
      if (!p || now - s.at > STEER_TIMEOUT_MS) {
        // The controller went quiet (released, disconnected): stop where we are.
        this.walking.steering.delete(userId);
        if (p) this.walking.stopSteering(p);
      } else this.walking.steerStep(p, s, now);
    }
    const doAggro = now - this.lastAggro > 250;
    if (doAggro) this.lastAggro = now;
    const doRegen = now - this.lastRegen > 1000;
    if (doRegen) {
      this.lastRegen = now;
      this.regens++;
    }
    if (now - this.lastFollow > 500) {
      this.lastFollow = now;
      this.follow.followFriends(now);
    }
    for (const z of this.zones.values()) {
      for (const a of z.actors.values()) {
        if (a.motion && !a.combatId) this.advanceMotion(z, a, now);
        if (!a.combatId) {
          if (a instanceof MonsterActor && a.alive()) this.places.monsterIdle(z, a, now);
          if (a instanceof NpcActor && a.alive()) this.places.npcIdle(z, a, now);
        }
        if (a.bark && a.bark.until < now) {
          a.bark = undefined;
          a.dirty = true;
        }
      }
      if (doAggro) this.checkAggro(z);
      if (doRegen) this.regen(z);
      this.flushZone(z);
    }
    for (const userId of this.dirtyPlayers) this.sendPlayer(userId);
    this.dirtyPlayers.clear();
    // Friends far apart see each other's Health and statuses in the party display: the roster follows them.
    if (doRegen && this.conns.size > 1) this.presence.sendRoster(true);
    this.sendClock();
    if (this.dirtySince && now - this.dirtySince > 30_000) this.save();
  }

  newDay() {
    this.markDirty();
    this.places.endGatherings();
    this.items.expireLoot();
    for (const z of this.zones.values()) this.places.applyGatherings(z);
  }

  private flushZone(z: LiveZone) {
    const changed: EntityView[] = [];
    for (const a of z.actors.values())
      if (a.dirty) {
        a.dirty = false;
        changed.push(a.view());
      }
    if (changed.length) this.broadcastZone(z.id, { t: 'entities', upsert: changed, remove: [] });
    if (z.featuresDirty.size) {
      z.featuresDirty.clear();
      this.broadcastZone(z.id, (userId) => ({ t: 'features', features: this.featureStates(z.id, userId) }));
    }
    if (z.lootDirty) {
      z.lootDirty = false;
      this.broadcastZone(z.id, (userId) => ({ t: 'loot_piles', loot: this.items.visibleLoot(userId, z.id) }));
    }
  }

  private advanceMotion(z: LiveZone, a: Actor, now: number) {
    const m = a.motion!;
    const s = sampleMotion(m, now);
    const before = { x: a.x, y: a.y };
    a.x = s.x;
    a.y = s.y;
    a.facing = s.facing;
    this.onStep(z, a, before);
    if (s.done) {
      const last = m.path[m.path.length - 1] ?? m.from;
      a.x = last.x;
      a.y = last.y;
      a.motion = null;
      a.dirty = true;
      if (a instanceof CharActor) this.walking.arrived(a);
    }
  }

  /**
   * A character moved (from `before`, when it walked there): the ground it now sees, and a pile or chest its player was
   * looking into is closed once the leader has left it behind. Ways to other places are taken only when used (clicked,
   * or A on a controller), never by walking near.
   */
  onStep(z: LiveZone, a: Actor, before?: Vec2) {
    if (!(a instanceof CharActor)) return;
    const p = this.state.players[a.userId];
    if (!p) return;
    const newSquare = !before || Math.round(a.x) !== Math.round(before.x) || Math.round(a.y) !== Math.round(before.y);
    if (newSquare) this.explore(z.map.def, a);
    const open = this.items.lootOpen.get(p.userId);
    if (open && a === this.leader(p)) {
      const src = this.items.lootSource(p, open);
      if (!src || Math.hypot(src.at.x - a.x, src.at.y - a.y) > LOOT_REACH) this.items.closeLoot(p.userId);
    }
  }

  /**
   * The ground a character sees around it is remembered (per square meter): all of it within sight range, as the
   * client shows at once. (The sight plan reads trees and bushes as walls; fog by it hid fights a few meters away.
   * Aiming in a fight still needs a clear line.)
   */
  private explore(def: ZoneDef, at: Vec2) {
    const { w, h } = fogSize(def);
    const bs = new BitSet(w * h, this.state.explored[def.id]);
    let changed = false;
    for (const t of tilesInRadius(Math.round(at.x), Math.round(at.y), SIGHT_RADIUS, w, h)) if (bs.set(t.y * w + t.x)) changed = true;
    if (!changed) return;
    this.state.explored[def.id] = bs.encode();
    this.markDirty();
  }

  zonePayload(userId: string) {
    const p = this.state.players[userId]!;
    const z = this.places.live(p.zoneId);
    const { spawns, lore, design, ...zoneView } = z.map.def;
    void spawns, lore, design;
    const { w, h } = fogSize(z.map.def);
    return {
      zone: zoneView,
      entities: [...z.actors.values()].map((a) => a.view()),
      features: this.featureStates(z.id, userId),
      loot: this.items.visibleLoot(userId, z.id),
      explored: this.state.explored[z.id] ?? new BitSet(w * h).encode(),
    };
  }

  /** Party members down out of a fight (since when), to get up once DOWNED_GET_UP_MS has passed. */
  private downedSince = new Map<string, number>();

  /**
   * Out of combat, health always refills (every fight starts fresh), and anyone down gets up with 1 health a moment
   * later while a hero stands in the place, theirs or a friend's: after a retreat that carried the fallen off, after a
   * restart.
   */
  private regen(z: LiveZone) {
    const now = Date.now();
    const standing = [...z.actors.values()].some((a) => a instanceof CharActor && a.alive() && !a.combatId);
    for (const a of z.actors.values()) {
      if (a.combatId || !(a instanceof CharActor)) continue;
      if (a.ch.downed) {
        if (!standing) continue;
        const since = this.downedSince.get(a.id) ?? now;
        this.downedSince.set(a.id, since);
        if (now - since < DOWNED_GET_UP_MS) continue;
        this.downedSince.delete(a.id);
        a.ch.downed = false;
        a.ch.hp = 1;
        a.dirty = true;
        this.markPlayer(a.userId);
        continue;
      }
      let changed = regenerate(this.r, a.ch, 1);
      for (const k of Object.keys(a.cooldowns)) if (--a.cooldowns[k]! <= 0) delete a.cooldowns[k];
      if (a.statuses.length) {
        // Outside a fight nobody takes turns, so every status wears off by the clock: one whole turn every third second,
        // whatever the status.
        if (this.regens % 3 === 0) {
          a.statuses = a.statuses.map((st) => ({ ...st, turns: st.turns - 1 })).filter((st) => st.turns > 0);
          changed = true;
        }
      }
      if (changed) {
        a.dirty = true;
        this.markPlayer(a.userId);
      }
    }
  }

  // =================================================================== aggro & combat

  /**
   * Creatures notice a party by its leader, the one the player moves (the followers trailing behind never start a
   * fight; they join one). A party whose leader comes within JOIN_DISTANCE of anyone in a fight under way, in sight of
   * them, joins it (startCombat), so friends walking over to help are in it as soon as they are close.
   */
  private checkAggro(z: LiveZone) {
    const chars = [...z.actors.values()].filter((a): a is CharActor => {
      if (!(a instanceof CharActor) || !a.alive() || a.combatId || this.dev.devPeace.has(a.userId)) return false;
      const p = this.state.players[a.userId];
      return !!p && a === this.leader(p);
    });
    if (!chars.length) return;
    for (const c of chars) {
      const fight = [...z.actors.values()].find((a) => a.alive() && a.combatId && this.combats.get(a.combatId)?.ended === false && this.joins(z, c, a));
      if (!fight) continue;
      const foe = this.combats.get(fight.combatId!)!.participants().find((a) => a.alive() && isHostileTo(a, c));
      if (foe) return void this.startCombat(z, foe, c);
    }
    for (const a of z.actors.values()) {
      if (!(a instanceof MonsterActor) || !a.alive() || a.combatId) continue;
      for (const c of chars) {
        if (!isHostileTo(a, c) || Math.hypot(a.x - c.x, a.y - c.y) > aggroRadius(a) || !z.map.nav.sees(a, c)) continue;
        this.startCombat(z, a, c);
        return;
      }
    }
  }

  /** Whether a hero is close enough to a fighter, and in sight of them, to be in their fight. */
  private joins(z: LiveZone, hero: Actor, fighter: Actor): boolean {
    return Math.hypot(hero.x - fighter.x, hero.y - fighter.y) <= JOIN_DISTANCE && z.map.nav.sees(hero, fighter);
  }

  /** Start (or join) combat between `enemy` (and its group) and `trigger`'s side. */
  startCombat(z: LiveZone, enemy: Actor, trigger: Actor): Combat | null {
    const existingId = enemy.combatId ?? trigger.combatId;
    const existing = existingId ? this.combats.get(existingId) : undefined;
    const combat = existing ?? new Combat(uid('cb'), z.id, this);
    const enemies = new Set<Actor>();
    const seen = new Set<Actor>();
    const addEnemy = (e: Actor) => {
      if (seen.has(e)) return;
      seen.add(e);
      if (e.alive()) enemies.add(e);
      // The whole pack fights together, even if the one that was hit is already dead (one-shot).
      if (e instanceof MonsterActor) {
        for (const o of z.actors.values()) if (o instanceof MonsterActor && o.alive() && o.spawn.groupId === e.spawn.groupId) addEnemy(o);
      }
    };
    addEnemy(enemy);
    // Only stragglers standing right next to the pack join; other packs stay put.
    for (const e of [...enemies]) for (const o of z.actors.values()) if (o.alive() && o instanceof MonsterActor && !o.combatId && !enemies.has(o) && Math.hypot(o.x - e.x, o.y - e.y) < 2.2) addEnemy(o);
    // Every party whose leader is close to the fight and in sight of someone in it joins, and the party of whoever set
    // it off. A party joins whole: its followers come with it, wherever they stand, and never without it.
    const fighters = [...enemies, trigger, ...(existing?.participants() ?? [])];
    const players = new Set<Actor>();
    for (const p of this.inGame()) {
      if (p.zoneId !== z.id || this.dev.devPeace.has(p.userId)) continue;
      const all = this.charActors(p);
      const party = all.filter((c) => c.alive() && !c.combatId);
      const lead = this.leader(p);
      const near = !!lead && party.includes(lead) && fighters.some((f) => f.alive() && this.joins(z, lead, f));
      // (One who got up outside a fight the rest of the party is in goes into it too.)
      if (near || party.some((c) => c === trigger) || all.some((c) => c.combatId === combat.id)) for (const c of party) players.add(c);
    }
    if (!players.size || !enemies.size) return null;
    const isNew = !existing;
    if (isNew) this.combats.set(combat.id, combat);
    // Each player's heroes joining now step out of their walking formation into fighting positions facing the foes.
    const foes = [...enemies];
    const toward = { x: foes.reduce((s, e) => s + e.x, 0) / foes.length, y: foes.reduce((s, e) => s + e.y, 0) / foes.length };
    for (const p of Object.values(this.state.players)) {
      const lead = this.leader(p);
      const party = this.charActors(p).filter((c) => players.has(c) && c.combatId !== combat.id).sort((a, b) => Number(b === lead) - Number(a === lead));
      for (const a of party) a.motion = null;
      for (const [a, at] of fightPositions(z.map.nav, [...z.actors.values()], party, toward)) [a.x, a.y] = [at.x, at.y];
    }
    for (const a of [...players, ...enemies]) {
      if (a.combatId === combat.id) continue;
      a.motion = null;
      const spot = this.nearestFree(z.id, a, a.id);
      a.x = spot.x;
      a.y = spot.y;
      // Whoever opened the fight already acted (and pays for it on their first turn); everyone rolls initiative.
      combat.add(a);
      if (a instanceof MonsterActor) a.rt.fought = true;
      if (a instanceof CharActor) {
        this.endDialog(a.userId);
        this.walking.errands.delete(a.userId);
      }
    }
    if (isNew) {
      const boss = [...enemies].find((e) => e instanceof MonsterActor && e.isBoss) as MonsterActor | undefined;
      if (boss?.boss?.taunt) {
        boss.bark = { text: boss.boss.taunt, until: Date.now() + 5000 };
        boss.dirty = true;
        // Everyone in the fight hears it, wherever they stand.
        this.sayAloud(boss, boss.boss.id, boss.boss.taunt, this.playersInCombat(combat));
      }
      this.log(z.id, 'Combat begins!', '#ff8060');
      combat.start();
    } else this.broadcastCombat(combat);
    this.presence.sendRoster();
    return combat;
  }

  broadcastCombat(c: Combat) {
    const view = c.view();
    for (const userId of this.playersInCombat(c)) this.sendTo(userId, { t: 'combat', combat: view });
    this.sendFights(c.zoneId);
    for (const a of c.participants()) if (a instanceof CharActor) this.markPlayer(a.userId);
  }

  /** The fights going on in a place that a player's heroes are not in. */
  private fightsWatchedBy(userId: string, zoneId: string): CombatView[] {
    return [...this.combats.values()].filter((c) => c.zoneId === zoneId && !c.ended && !this.playersInCombat(c).includes(userId)).map((c) => c.view());
  }

  /** Everyone in a place is told the fights there they watch (each player's own fight comes as `combat`). */
  private sendFights(zoneId: string) {
    this.broadcastZone(zoneId, (u) => ({ t: 'fights', fights: this.fightsWatchedBy(u, zoneId) }));
  }

  playersInCombat(c: Combat): string[] {
    return [...new Set(c.participants().filter((a): a is CharActor => a instanceof CharActor).map((a) => a.userId))];
  }

  isMultiplayer(c: Combat): boolean {
    return this.playersInCombat(c).length > 1;
  }

  sendError(userId: string, msg: string) {
    this.sendTo(userId, { t: 'toast', text: msg, kind: 'bad' });
  }

  combatEnded(c: Combat, outcome: CombatOutcome) {
    this.combats.delete(c.id);
    const z = this.zones.get(c.zoneId);
    const users = this.playersInCombat(c);
    for (const a of c.participants()) a.dirty = true;
    if (outcome === 'victory') {
      for (const a of c.participants()) {
        if (a instanceof CharActor) {
          // Downed allies always get up after a won fight (the ruleset's revive mode governs reviving *during* combat).
          if (a.ch.downed) {
            a.ch.downed = false;
            a.ch.hp = 1;
          }
          a.statuses = [];
          a.ch.cooldowns = {};
        }
      }
      // The fight's end is heard in the last death and the music; the notice needs no sound of its own.
      for (const u of users) this.sendTo(u, { t: 'toast', text: 'Victory!', kind: 'good', sound: null });
    } else {
      // (After a retreat nobody is left on the players' side to be defeated.)
      for (const u of users) this.defeat(u, c.zoneId);
      // Survivors heal up and return home.
      for (const a of c.participants()) {
        if (!(a instanceof MonsterActor) || !a.alive()) continue;
        a.restore();
        if (outcome === 'fled') this.walkHome(z, a);
      }
    }
    for (const u of users) {
      this.sendTo(u, { t: 'combat', combat: null });
      this.markPlayer(u);
    }
    this.sendFights(c.zoneId);
    this.markDirty();
    // Players who dropped out during the fight leave now that it is over.
    for (const [u, kept] of this.presence.away) if (kept.afterFight && users.includes(u)) this.after(100, () => this.presence.goAway(u));
    this.presence.sendRoster();
  }

  /**
   * Every hero of this player's in a fight fell: they wake in the last town at once, before anything near where they
   * fell can start another fight, and lose what the world's rules say (equipment and quest items always come along).
   */
  private defeat(userId: string, zoneId?: string) {
    const p = this.state.players[userId];
    if (!p) return;
    const { recover, goldLoss, xpLoss } = this.r.death;
    p.stats.deaths++;
    const leader = this.leader(p);
    const where = { zoneId: zoneId ?? p.zoneId, x: leader?.x ?? p.x, y: leader?.y ?? p.y };
    const dropped = recover ? p.inventory.filter((i) => !i.bound && rx(this.r).item.get(i.baseId)?.category !== 'quest' && rx(this.r).item.get(i.baseId)?.category !== 'key') : [];
    if (dropped.length) {
      p.inventory = p.inventory.filter((i) => !dropped.includes(i));
      this.places.zoneRuntime(where.zoneId).loot.push({ id: uid('lp'), x: where.x, y: where.y, items: dropped, gold: 0, label: `${p.name}’s remains`, ownerUserId: userId, createdAt: this.state.clock, corpse: true });
      const lz = this.zones.get(where.zoneId);
      if (lz) lz.lootDirty = true;
    }
    const goldLost = Math.floor(p.gold * goldLoss);
    p.gold -= goldLost;
    for (const ch of p.party) {
      ch.xp -= Math.floor((ch.xp - xpForLevel(this.r, ch.level)) * xpLoss);
      restoreFully(this.r, ch);
    }
    const t = this.r.terminology;
    const town = this.ctx.zones.get(p.lastTownZoneId)?.name ?? 'town';
    const place = this.ctx.zones.get(where.zoneId)?.name ?? 'the wilds';
    const losses = [
      dropped.length ? ` Your pack (${dropped.length} item${dropped.length > 1 ? 's' : ''}) still lies where you fell in ${place}; your gear is still on your back.` : '',
      goldLost ? ` ${goldLost} ${t.currency} is gone.` : '',
      xpLoss ? ` Some of your ${t.xp.toLowerCase()} is lost.` : '',
    ];
    this.journal('combat', `${listing(p.party.map((c) => c.name))} fell in ${place} and woke in ${town}.`);
    this.narrate([userId], 'Defeat', `Darkness takes you… and then, slowly, light. You wake in ${town}, sore but alive.${losses.join('')}`, 'death');
    this.toTown(p, p.lastTownZoneId);
  }

  /** A party goes to a town (waking there, called back, traveling between waypoints): it arrives by the town's waypoint. */
  private toTown(p: PlayerState, zoneId: string) {
    const waypoint = this.ctx.zones.get(zoneId)?.features.find((f) => f.kind === 'waypoint');
    this.transfer(p, zoneId, undefined, waypoint ? { x: waypoint.x, y: waypoint.y + 1 } : undefined);
  }

  // =================================================================== damage hooks

  onDamaged(target: Actor, source: Actor | null) {
    if (!source) return;
    // Real-time damage pulls the victim's side into combat.
    if (!target.combatId || !source.combatId) {
      const z = this.zones.get(target.zoneId);
      if (z && isHostileTo(source, target) && target.alive()) {
        const enemy = source.team() === 'players' ? target : source;
        const trig = source.team() === 'players' ? source : target;
        this.startCombat(z, enemy, trig);
      }
    }
  }

  onDowned(target: Actor, source: Actor | null) {
    const z = this.zones.get(target.zoneId);
    if (!z) return;
    if (target instanceof MonsterActor) {
      target.rt.dead = true;
      target.rt.respawnAt = target.boss ? undefined : this.state.clock + RESPAWN_GAME_MINUTES;
      target.motion = null;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const combat = target.combatId ? this.combats.get(target.combatId) : undefined;
      const participants = combat ? combat.participants() : source ? [source] : [];
      // The heroes who fought it (downed ones too), or, felled outside a fight, the party of whoever did it.
      let heroes = participants.filter((a): a is CharActor => a instanceof CharActor);
      if (!combat && source instanceof CharActor) heroes = this.charActors(this.state.players[source.userId]!);
      const killers = new Set(heroes.map((h) => h.userId));
      // The creature's experience is shared out among them.
      const xp = killXpFor(this.r, target.level, target.fighter, target.isBoss);
      const top = this.topLevel();
      for (const h of heroes) this.grantHeroXp(this.state.players[h.userId]!, h.ch, xp / heroes.length, top);
      for (const u of killers) {
        const p = this.state.players[u];
        if (!p) continue;
        p.stats.kills++;
        this.markPlayer(u);
      }
      if (target.boss && !this.state.defeated.includes(target.boss.id)) this.state.defeated.push(target.boss.id);
      this.quests.onKill({ familyId: target.family.id, bossId: target.boss?.id, zoneId: z.id });
      if (target.boss) {
        const heroes = participants.filter((a): a is CharActor => a instanceof CharActor);
        this.journal('combat', `Defeated ${target.boss.name}.`);
        if (heroes.length) this.news({ text: `${heroes.map((h) => h.name).join(', ')} defeated ${target.boss.name}.`, heroIds: heroes.map((h) => h.id), zoneId: z.id, witnesses: [], reach: 'world', tone: 'good' });
      }
      // Loot is each player's own and rolled for each of their heroes who fought: an ordinary creature's loot is shared
      // out among those heroes (packs grow with the party, so a hero's loot from a fight does not), and a boss leaves a
      // whole boss's loot for every one of them (what the story put on a boss or named foe, for the first player).
      const heroesOf = new Map<string, number>();
      for (const h of heroes) heroesOf.set(h.userId, (heroesOf.get(h.userId) ?? 0) + 1);
      // (A story item it carried is found whoever felled it, even no hero at all: a quest never waits on it.)
      const first = this.state.players[[...heroesOf.keys()][0] ?? ''];
      const drops = (target.boss?.drops ?? []).flatMap((id) => {
        const def = this.ctx.uniqueItems[id];
        return def ? [makeUnique(this.r, def, target.level)] : [];
      });
      const placed = this.items.found(drops, first ? this.leader(first)?.name ?? first.name : 'Someone');
      [...heroesOf].forEach(([u, n], i) => {
        const p = this.state.players[u];
        if (!p) return;
        const loot = this.items.rollLootFor(p, n, this.rng, target.level, { boss: target.isBoss, share: target.isBoss ? 1 : 1 / heroes.length });
        if (i === 0) loot.items.push(...placed);
        // A boss sometimes leaves a piece of legendary gear behind.
        if (target.isBoss && !loot.items.some((it) => isTopRarity(this.r, it)) && this.rng.chance(0.35)) loot.items.push(rollRandomItem(this.r, this.rng, target.level, { minRarity: this.r.rarities.indexOf(topRarity(this.r)) }));
        this.items.forgeLegendaries(loot.items, z.id, target.boss?.name ?? target.name, u, true);
        if (loot.items.length || loot.gold) {
          z.rt.loot.push({ id: uid('lp'), x: target.x, y: target.y, items: loot.items, gold: loot.gold, label: target.name, ownerUserId: u, createdAt: this.state.clock });
          z.lootDirty = true;
        }
      });
      this.after(2500, () => {
        if (z.actors.get(target.id) === target && !target.alive()) {
          z.actors.delete(target.id);
          // A developer's spawn never comes back.
          if (target.rt.def) delete z.rt.monsters[target.rt.spawnId];
          this.broadcastZone(z.id, { t: 'entities', upsert: [], remove: [target.id] });
        }
      });
      this.markDirty();
    } else if (target instanceof CharActor) {
      target.ch.downed = true;
      target.motion = null;
      target.dirty = true;
      this.fx(z.id, [{ kind: 'death', targetId: target.id, x: target.x, y: target.y }]);
      const p = this.state.players[target.userId];
      if (p && !target.combatId) {
        // Downed outside a fight: everyone else carries them (they get up in a moment, see regen); if all
        // are down it's a defeat.
        if (this.charActors(p).every((a) => !a.alive())) this.defeat(p.userId);
      }
      if (p && p.leaderId === target.id) {
        const next = this.charActors(p).find((a) => a.alive());
        if (next && !target.combatId) p.leaderId = next.id;
      }
      if (p) this.markPlayer(p.userId);
    }
  }

  isFree(zoneId: string, x: number, y: number, ignoreId?: string): boolean {
    return isFree(this.ctx.map(zoneId).nav, this.actorsInZone(zoneId), { x, y }, ignoreId);
  }

  actorMoved(a: Actor) {
    if (a instanceof CharActor) {
      const z = this.zones.get(a.zoneId);
      if (z) this.onStep(z, a);
    }
  }

  /** Experience for each of a player's heroes (a quest's: not split). Experience comes only from fights and quests, the content the curve is solved from. */
  grantPartyXp(p: PlayerState, amount: number) {
    const top = this.topLevel();
    for (const ch of p.party) this.grantHeroXp(p, ch, amount, top);
    this.markPlayer(p.userId);
  }

  /** The highest level of any hero in the game. */
  private topLevel(): number {
    return Math.max(1, ...this.inGame().flatMap((o) => o.party.map((c) => c.level)));
  }

  /**
   * Experience for one hero. A hero below the highest level in the game earns more, until it catches up: half again
   * for each level behind, at most three times as much (friends who play less, heroes brought back, new heroes).
   * `top` is the highest level before this reward, so a hero leveling up from it puts no one else behind.
   */
  private grantHeroXp(p: PlayerState, ch: CharacterState, amount: number, top: number) {
    const gained = grantXp(this.r, ch, amount * Math.min(3, 1 + 0.5 * Math.max(0, top - ch.level)));
    if (gained > 0) {
      const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
      if (a) {
        a.dirty = true;
        this.fx(p.zoneId, [{ kind: 'levelup', targetId: ch.id, text: `${this.r.terminology.level} ${ch.level}` }]);
      }
      this.journal('system', `${ch.name} reached ${this.r.terminology.level.toLowerCase()} ${ch.level}.`);
      this.sendTo(p.userId, { t: 'toast', text: `${ch.name} reached ${this.r.terminology.level} ${ch.level}!`, kind: 'good', sound: 'level_up' });
    }
    this.markPlayer(p.userId);
  }

  // =================================================================== message handling

  handle(userId: string, msg: ClientMessage, payer = userId) {
    // Whatever this message sets off (an NPC's reply, a legendary drop) is paid from this player's AI budget (an
    // administrator playing someone else's adventure pays from their own).
    return withCallContext({ priority: 'interactive', userId: payer }, () => this.handle_(userId, msg));
  }

  private handle_(userId: string, msg: ClientMessage) {
    const p = this.state.players[userId];
    if (!p) return;
    try {
      switch (msg.t) {
        case 'move': return this.walking.cmdMove(p, msg.x, msg.y, msg.charId);
        case 'steer': return this.walking.cmdSteer(p, msg.dx, msg.dy, msg.x, msg.y);
        case 'interact': return this.walking.cmdInteract(p, msg.targetId, msg.charId, msg.inspect);
        case 'request_trade': return void this.dialogue.requestTrade(userId);
        case 'talk': return void this.dialogue.say(userId, msg.text, { giveItemId: msg.giveItemId, giveGold: msg.giveGold, useSkillId: msg.useSkillId });
        case 'end_dialog': return this.endDialog(userId);
        case 'audio': return this.voices.setCodec(userId, msg.codec === 'opus' || msg.codec === 'pcm' ? msg.codec : null);
        case 'skip_line': return this.voices.leave(userId, { lineId: String(msg.id) });
        case 'use_skill': return this.cmdSkill(p, msg.charId, msg.skillId, msg.targetId, msg.x, msg.y);
        case 'use_item': return this.cmdItem(p, msg.charId, msg.itemId, msg.targetId, msg.x, msg.y);
        case 'equip': return this.items.cmdEquip(p, msg.charId, msg.itemId);
        case 'unequip': return this.items.cmdUnequip(p, msg.charId, msg.slot);
        case 'drop_item': return this.items.cmdDrop(p, msg.itemId, msg.qty);
        case 'give_item': return this.items.cmdGive(p, msg.itemId, msg.toUserId, msg.qty);
        case 'store_item': return this.items.cmdStore(p, msg.itemId, msg.to, msg.qty);
        case 'end_turn': return this.cmdEndTurn(p, msg.charId);
        case 'flee': return this.cmdFlee(p);
        case 'buy': return this.items.cmdBuy(p, msg.npcId, msg.itemId, msg.qty);
        case 'sell': return this.items.cmdSell(p, msg.npcId, msg.itemId, msg.qty);
        case 'end_trade': return this.items.closeTrade(userId);
        case 'craft': return this.items.cmdCraft(p, msg.recipeId, msg.baseId);
        case 'take_loot': return this.items.cmdTakeLoot(p, msg.sourceId, msg.itemId, msg.all);
        case 'close_loot': return this.items.closeLoot(userId, true);
        case 'allocate': return this.cmdAllocate(p, msg.charId, msg.nodeId);
        case 'upgrade_item': return this.items.cmdUpgrade(p, msg.itemId, msg.charId);
        case 'learn_craft': return this.items.cmdLearnCraft(p, msg.craft);
        case 'enchant_item': return this.items.cmdEnchant(p, msg.itemId, msg.affixIndex, msg.charId);
        case 'buy_inventory_upgrade': return this.items.cmdBuyBagSpace(p, msg.npcId);
        case 'set_difficulty': {
          if (this.state.ownerId !== userId || !DIFFICULTIES.includes(msg.difficulty)) return;
          this.state.difficulty = msg.difficulty;
          for (const z of this.zones.values()) for (const a of z.actors.values()) if (a instanceof MonsterActor) a.dirty = true;
          this.sendTo(userId, { t: 'toast', text: `Difficulty: ${this.r.difficulty[msg.difficulty]?.name ?? msg.difficulty}`, kind: 'info' });
          this.markDirty();
          return this.markPlayer(userId);
        }
        case 'set_hotbar': {
          const ch = p.party.find((c) => c.id === msg.charId);
          const known = ch ? knownSkills(this.r, ch) : [];
          if (ch) ch.hotbar = msg.hotbar.slice(0, 10).map((s) => (s && known.includes(s) ? s : null));
          return this.markPlayer(userId);
        }
        case 'set_leader': {
          if (p.party.some((c) => c.id === msg.charId)) p.leaderId = msg.charId;
          return this.markPlayer(userId);
        }
        case 'set_ai': return this.cmdSetAi(p, msg.charId, msg.ai);
        case 'leave': return void this.presence.leaving.add(userId);
        case 'follow': return this.follow.cmdFollow(p, msg.userId);
        case 'listen': return this.cmdListen(p, msg.npcId);
        case 'aim': {
          // Shown to friends in the same place: one of the player's heroes in a fight, a point on the ground.
          const a = msg.aim;
          const ok = !a || (p.party.some((c) => c.id === a.charId) && Number.isFinite(a.x) && Number.isFinite(a.y) && (!a.skillId || typeof a.skillId === 'string') && (!a.itemId || typeof a.itemId === 'string'));
          if (!ok) return;
          const aim = a && { charId: a.charId, skillId: a.skillId?.slice(0, 60), itemId: a.itemId?.slice(0, 60), move: !!a.move || undefined, x: a.x, y: a.y };
          return this.broadcastZone(p.zoneId, (u) => (u === p.userId ? null : { t: 'aim', userId: p.userId, aim }));
        }
        case 'join_friend': return this.follow.cmdJoinFriend(p, msg.userId);
        case 'fast_travel': return this.cmdFastTravel(p, msg.zoneId);
        case 'dev': return this.dev.cmdDev(p, msg);
        case 'save_copy': return this.saveCopy?.(p, msg.name);
        case 'abandon_quest': return this.quests.abandon(msg.questId);
        case 'pin_quest': {
          // An active quest's id, or '' for none shown: nothing else is kept.
          const id = typeof msg.questId === 'string' && this.state.quests[msg.questId]?.status === 'active' ? msg.questId : '';
          if (msg.questId && !id) return;
          p.pinnedQuestId = id;
          return this.markPlayer(p.userId);
        }
        case 'chat': {
          const text = msg.text.trim().slice(0, 300);
          if (!text) return;
          const line: ChatLine = { from: p.name, text, userId: p.userId, at: Date.now() };
          this.chat = [...this.chat.slice(1 - CHAT_KEPT), line];
          for (const u of this.conns.keys()) this.sendTo(u, { t: 'chat', ...line });
          // Said aloud, too: over the speaker's hero.
          const lead = this.leader(p);
          if (lead) {
            lead.bark = { text: text.length > 120 ? `${text.slice(0, 117)}…` : text, until: Date.now() + Math.min(9000, 3000 + text.length * 60) };
            lead.dirty = true;
          }
          return;
        }
        default:
          return;
      }
    } catch (e) {
      // The message as sent (what a player typed left out), and where the party was.
      const sent = Object.fromEntries(Object.entries(msg).filter(([k]) => k !== 'text'));
      const party = p.party.map((c) => `${c.name} (level ${c.level}${c.hp <= 0 ? ', down' : ''})`).join(', ');
      reportError(e, { message: JSON.stringify(sent).slice(0, 400), user: userId, adventure: this.state.id, world: this.world.id, zone: p.zoneId, at: `${Math.round(p.x)},${Math.round(p.y)}`, inCombat: [...this.combats.values()].some((c) => c.zoneId === p.zoneId), party });
      this.sendError(userId, 'Something went wrong.');
    }
  }

  saveCopy?: (p: PlayerState, name: string) => void;

  /** CombatHost: run later on a real timer (game time = real time here). */
  after(ms: number, fn: () => void) {
    setTimeout(fn, ms);
  }

  /** Heroes played by the AI may drink healing potions from their player's pack. */
  aiPotions(a: Actor): { item: ItemInstance; consume: () => void }[] {
    if (!(a instanceof CharActor) || !a.aiDriven()) return [];
    const p = this.state.players[a.userId];
    if (!p) return [];
    return p.inventory
      .filter((i) => rx(this.r).item.get(i.baseId)?.use?.effects.some((e) => e.kind === 'heal'))
      .map((item) => ({ item, consume: () => void removeFromInventory(p.inventory, item.id, 1) }));
  }

  /**
   * Switch a hero between its player and the AI. The leader is always one the player steers: switching it to the AI
   * hands the lead to another, and with none left the rest of the party waits for one.
   */
  private cmdSetAi(p: PlayerState, charId: string, ai: boolean) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch || !!ch.ai === ai) return;
    // Fights on their own, or takes their player's orders: in fights only (out of one the party follows its leader).
    ch.ai = ai || undefined;
    const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (a) a.dirty = true;
    const combat = a && this.combatOf(a);
    if (combat) {
      this.broadcastCombat(combat);
      // Handed to the AI on its own turn: the AI takes it from here.
      if (ai && combat.isActing(a)) combat.aiTakeOver(a);
    }
    this.markPlayer(p.userId);
  }

  charFor(p: PlayerState, charId?: string): CharActor | undefined {
    const all = this.charActors(p);
    return (charId ? all.find((a) => a.id === charId) : undefined) ?? this.leader(p);
  }

  combatOf(a: Actor): Combat | undefined {
    return a.combatId ? this.combats.get(a.combatId) : undefined;
  }

  performInteraction(p: PlayerState, a: CharActor, targetId: string, inspect?: boolean) {
    const z = this.zones.get(p.zoneId);
    if (!z) return;
    const actor = z.actors.get(targetId);
    if (actor instanceof NpcActor) {
      if (!actor.alive()) return;
      actor.talkingTo = p.userId;
      actor.motion = null;
      actor.facing = Math.atan2(a.y - actor.y, a.x - actor.x);
      actor.dirty = true;
      a.facing = Math.atan2(actor.y - a.y, actor.x - a.x);
      void this.dialogue.open(p.userId, actor.def.id);
      return;
    }
    if (actor instanceof MonsterActor && actor.alive()) {
      // Clicking an enemy attacks it.
      return this.cmdSkill(p, a.id, 'attack', actor.id, undefined, undefined, true);
    }
    const loot = this.items.pileFor(p.userId, z.id, targetId);
    if (loot) return inspect ? this.items.openLoot(p, loot.id) : this.items.lootAll(p, loot.id);
    const f = z.map.features.get(targetId);
    if (f && this.sees(f, p.userId)) this.useFeature(p, a, z, f, inspect);
  }

  private useFeature(p: PlayerState, a: CharActor, z: LiveZone, f: FeatureDef, inspect?: boolean) {
    const fr = (z.rt.features[f.id] ??= {});
    switch (f.kind) {
      case 'exit':
        if (f.targetZoneId) this.transfer(p, f.targetZoneId, f.targetFeatureId);
        return;
      case 'chest': {
        // Each player opens a chest for themselves; what the world put in it is the first opener's. A quest's find is
        // the adventure's, as its quests are: it holds what the quest sent the heroes for, and nothing besides.
        const lootBy = (fr.lootBy ??= {});
        const key = opener(f, p.userId);
        let found = false;
        if (!lootBy[key]) {
          const first = !Object.keys(lootBy).length;
          fr.opened = true;
          const roll = f.questId ? { items: [] as ItemInstance[], gold: 0 } : this.items.rollLootFor(p, p.party.length, new Rng(`${this.state.id}:${f.id}:${p.userId}`), f.lootTier ?? 1, { chest: true, share: 1 });
          const placed = (first ? f.items ?? [] : []).flatMap((u) => {
            const def = this.ctx.uniqueItems[u];
            return def ? [makeUnique(this.r, def, f.lootTier ?? 1)] : [];
          });
          const rest = this.items.found(placed, a.name);
          found = rest.length < placed.length;
          roll.items.unshift(...rest);
          lootBy[key] = { items: roll.items, gold: roll.gold };
          this.items.forgeLegendaries(roll.items, z.id, f.name ?? 'a sealed chest', p.userId, !f.questId);
          z.featuresDirty.add(f.id);
        }
        return inspect ? this.items.openLoot(p, f.id) : this.items.lootAll(p, f.id, found);
      }
      case 'sign':
        return this.narrate([p.userId], f.name ?? 'Sign', f.text ?? '', 'quest');
      case 'lore': {
        const note = this.world.lore.find((l) => l.id === f.loreId);
        if (!note) return;
        this.narrate([p.userId], note.title, note.text, 'quest');
        if (!fr.opened) {
          fr.opened = true;
          this.journal('story', `Read "${note.title}": ${note.text.slice(0, 220)}${note.text.length > 220 ? '…' : ''}`);
          z.featuresDirty.add(f.id);
        }
        return;
      }
      case 'waypoint':
        // The map: travel between the waypoints visited.
        this.sendTo(p.userId, { t: 'open', panel: 'map' });
        return;
      case 'craft_station':
        this.sendTo(p.userId, { t: 'open', panel: 'craft' });
        return;
      case 'storage':
        this.sendTo(p.userId, { t: 'open', panel: 'storage' });
        return;
    }
  }

  cmdSkill(p: PlayerState, charId: string, skillId: string, targetId?: string, x?: number, y?: number, afterApproach = false) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const skill = rx(this.r).skill.get(skillId);
    if (!skill || !a.skillIds().includes(skillId)) return this.sendError(p.userId, 'Unknown skill.');
    const target = targetId ? z.actors.get(targetId) : undefined;
    const point = x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
    const combat = this.fightOf(p);
    if (combat) {
      const active = combat.actingFor(p.userId, charId);
      if (!active) return this.sendError(p.userId, 'Not your turn.');
      let err = combat.useSkill(active, skillId, target, point);
      // Aimed beyond reach (someone, or a point on the ground): walk into reach first if there is enough left to act.
      if (err && beyondReach(err)) err = combat.approachAndUse(active, skillId, target, point);
      if (err) this.sendError(p.userId, err);
      this.markPlayer(p.userId);
      return;
    }
    const use = { user: a, skill, target, point };
    const err = checkSkill(this, use, { inCombat: false });
    if (err) {
      // Aimed beyond reach: walk closer first, then use it on arrival. Only one approach per command: if the walk
      // still left it out of reach, say so instead of walking again.
      const at = point ?? target;
      if (!afterApproach && at && beyondReach(err)) {
        const range = skillRange(skill, a.stats());
        return this.walking.goDo(p, a, { x: at.x, y: at.y }, Math.max(1.2, range - 0.6), { kind: 'skill', charId: a.id, skillId, targetId: target?.id, point });
      }
      return this.sendError(p.userId, err);
    }
    a.motion = null;
    const hostileUse = target && isHostileTo(a, target);
    // An opening shot is part of the attacker's first turn, not a free one: it is paid from that turn's AP.
    // (Otherwise ranged characters get a free hit before initiative that melee ones never do.)
    if (outsideFights(this.r, skill) === 'opener') a.openerAp = skillAp(skill, a.stats());
    executeSkill(this, use, false);
    if (!a.combatId) a.openerAp = 0;
    if (!hostileUse) this.markPlayer(p.userId);
  }

  private cmdItem(p: PlayerState, charId: string, itemId: string, targetId?: string, x?: number, y?: number) {
    const a = this.charFor(p, charId);
    const z = this.zones.get(p.zoneId);
    if (!a || !z) return;
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    const base = rx(this.r).item.get(item.baseId);
    if (!base) return;
    if (base.category === 'equipment') return this.items.cmdEquip(p, a.id, itemId);
    const tool = base.use?.tool;
    if (tool === 'recall') {
      // (The whole party goes, so none of it may be in a fight: checked before the item is used up.)
      if (this.inFight(p)) return this.sendError(p.userId, 'Not during a fight.');
      this.follow.stopFollowing(p);
      removeFromInventory(p.inventory, item.id, 1);
      this.toTown(p, p.lastTownZoneId);
      return;
    }
    if (!base.use) return this.sendError(p.userId, 'That cannot be used.');
    const target = targetId ? z.actors.get(targetId) : undefined;
    const point = x !== undefined && y !== undefined && Number.isFinite(x) && Number.isFinite(y) ? { x, y } : undefined;
    const consume = () => removeFromInventory(p.inventory, item.id, 1);
    const combat = this.fightOf(p);
    if (combat) {
      const active = combat.actingFor(p.userId, charId);
      if (!active) return this.sendError(p.userId, 'Not your turn.');
      const err = combat.useItem(active, item, target, point, consume);
      if (err) this.sendError(p.userId, err);
      return this.markPlayer(p.userId);
    }
    const err = checkItemUse(this, a, item, false, target, point);
    if (err) return this.sendError(p.userId, err);
    consume();
    useConsumable(this, a, item, false, target, point);
    this.markPlayer(p.userId);
  }

  private cmdEndTurn(p: PlayerState, charId?: string) {
    const combat = this.fightOf(p);
    if (!combat) return;
    const active = combat.actingFor(p.userId, charId);
    if (!active) return this.sendError(p.userId, 'Not your turn.');
    const err = combat.endTurn(active);
    if (err) this.sendError(p.userId, err);
  }

  /**
   * A retreat: the players' side leaves the fight together, as one player's party would, whoever calls it. Every hero
   * of it fades out and appears again at the nearest spot out of every creature's reach (safeSpot), gathered around
   * the one who called it, the fallen too, who get up there a moment later (see regen). The creatures heal and walk
   * back to where they keep. Getting away never depends on how fast anyone moves afterwards.
   */
  private cmdFlee(p: PlayerState) {
    const combat = this.fightOf(p);
    const z = this.zones.get(p.zoneId);
    if (!combat || !z) return;
    const mine = combat.acting.filter((a): a is CharActor => a instanceof CharActor && a.userId === p.userId && combat.isHumanControlled(a) && a.alive());
    if (!mine.length) return this.sendError(p.userId, 'Not your turn.');
    const clear = (a: Actor) => !combat.participants().some((e) => e.alive() && isHostileTo(a, e) && Math.hypot(e.x - a.x, e.y - a.y) < 7);
    const caller = mine.find(clear);
    if (!caller) return this.sendError(p.userId, 'Foes are too close to flee.');
    const side = combat.participants().filter((a): a is CharActor => a instanceof CharActor);
    const fought = combat.participants().filter((a) => a.alive() && isHostileTo(caller, a));
    const users = [...new Set(side.map((a) => a.userId))];
    combat.withdraw();
    const spot = this.safeSpot(z, caller, fought);
    // The caller first, then the others standing, then the fallen, each at the nearest free place to the spot.
    const order = [caller, ...side.filter((a) => a !== caller && a.alive()), ...side.filter((a) => !a.alive())];
    for (const a of order) {
      const from = { x: a.x, y: a.y };
      const at = this.nearestFree(z.id, spot, a.id);
      [a.x, a.y] = [at.x, at.y];
      a.motion = null;
      a.dirty = true;
      this.fx(z.id, [{ kind: 'relocate', targetId: a.id, x: from.x, y: from.y, tx: at.x, ty: at.y }]);
    }
    for (const u of users) {
      this.sendTo(u, { t: 'combat', combat: null });
      this.sendTo(u, { t: 'toast', text: u === p.userId ? 'You got away.' : `${caller.name} called the retreat. You got away.`, kind: 'info' });
      this.markPlayer(u);
    }
  }

  /**
   * Where a party that fled gathers: the nearest place `from` can walk to that lies out of every creature's reach, from
   * where it stands and from where it keeps (it walks back there and wanders about it), with room to spare. A place on
   * the far side of `from` from the creatures it fled wins over a nearer one past them, so the party goes on the way
   * it was backing off. The place's entrance when nowhere near is clear.
   */
  private safeSpot(z: LiveZone, from: Actor, fled: Actor[]): Vec2 {
    const MARGIN = 3;
    const foes = [...z.actors.values()].filter((a): a is MonsterActor => a instanceof MonsterActor && a.alive());
    const safe = (p: Vec2) => foes.every((m) => {
      const r = aggroRadius(m) + MARGIN;
      return Math.hypot(m.x - p.x, m.y - p.y) > r && Math.hypot(m.homeX - p.x, m.homeY - p.y) > r;
    });
    // Away from the fight: from the middle of the creatures fled, through `from`.
    const mid = fled.length ? { x: fled.reduce((t, a) => t + a.x, 0) / fled.length, y: fled.reduce((t, a) => t + a.y, 0) / fled.length } : { x: from.x, y: from.y };
    const away = (p: Vec2) => (p.x - from.x) * (from.x - mid.x) + (p.y - from.y) * (from.y - mid.y) >= 0;
    const nav = z.map.nav;
    const best = { onward: { p: undefined as Vec2 | undefined, cost: Infinity }, any: { p: undefined as Vec2 | undefined, cost: Infinity } };
    for (const [i, cost] of nav.reach(from, 60)) {
      if (cost >= best.any.cost && cost >= best.onward.cost) continue;
      const p = nav.center(i % nav.cols, Math.floor(i / nav.cols));
      if (!safe(p)) continue;
      if (cost < best.any.cost) best.any = { p, cost };
      if (cost < best.onward.cost && away(p)) best.onward = { p, cost };
    }
    return best.onward.p ?? best.any.p ?? z.map.def.entry;
  }

  /** A creature left by the fight it was in walks back to where it keeps. */
  private walkHome(z: LiveZone | undefined, a: MonsterActor) {
    if (!z) return;
    const path = z.map.nav.path(a, { x: a.homeX, y: a.homeY }, { maxNodes: 2000 });
    if (path?.length) {
      a.motion = { path, from: { x: a.x, y: a.y }, speed: 1.6, t0: Date.now() };
      a.nextWanderAt = Date.now() + 8000;
      a.dirty = true;
    }
  }

  /** EffectHost: god mode (a developer option, dev.ts). */
  invulnerable(a: Actor): boolean {
    return a instanceof CharActor && this.dev.devGod.has(a.userId);
  }

  private cmdFastTravel(p: PlayerState, zoneId: string) {
    if (!this.r.systems.fastTravel) return this.sendError(p.userId, 'There is no fast travel in this world.');
    const z = this.ctx.zones.get(zoneId);
    if (!z || z.kind !== 'town' || !this.state.visitedZones.includes(zoneId)) return this.sendError(p.userId, 'You have not found that waypoint.');
    const here = this.zones.get(p.zoneId);
    const leader = this.leader(p);
    const nearWaypoint = here?.map.def.features.some((f) => f.kind === 'waypoint' && leader && Math.hypot(f.x - leader.x, f.y - leader.y) < 3);
    if (!nearWaypoint) return this.sendError(p.userId, 'Stand next to a waypoint to travel.');
    this.follow.stopFollowing(p);
    this.toTown(p, zoneId);
  }

  private cmdAllocate(p: PlayerState, charId: string, nodeId: string) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch) return;
    const err = allocateNode(this.r, ch, nodeId);
    if (err) return this.sendError(p.userId, err);
    clampHealth(this.r, ch);
    const a = this.zones.get(p.zoneId)?.actors.get(ch.id);
    if (a) a.dirty = true;
    this.markPlayer(p.userId);
  }

  // =================================================================== dialogue host

  /** A player ends their conversation (the person turns to whoever is still talking with them: see sendDialog). */
  endDialog(userId: string) {
    this.dialogue.close(userId);
    this.items.closeTrade(userId);
  }

  private remember(npcId: string, mem: Memory) {
    const rt = this.state.npcs[npcId];
    if (!rt) return;
    rt.memories.push(mem);
    if (rt.memories.length > MEMORIES_KEPT) rt.memories.splice(0, rt.memories.length - MEMORIES_KEPT);
    this.markDirty();
  }

  /** Something people may hear about heroes (game/news.ts works out who has). */
  private news(item: Omit<NewsItem, 'id' | 'day'>) {
    this.state.news.push({ ...item, id: uid('nw'), day: this.day() });
    if (this.state.news.length > 300) this.state.news.splice(0, this.state.news.length - 300);
    this.markDirty();
  }

  /** The hero a player speaks through: their leader. */
  private speakerOf(userId: string): CharacterState | undefined {
    const p = this.state.players[userId];
    return p && (p.party.find((c) => c.id === p.leaderId) ?? p.party[0]);
  }

  /** The quest's giver thinks better (or worse) of the heroes in the game, and people hear of it. */
  private questGossip(q: QuestDef, kind: 'completed' | 'failed') {
    if (!q.giverNpcId) return;
    const giver = this.ctx.npcs.get(q.giverNpcId);
    const heroes = this.present().flatMap((p) => p.party);
    if (!heroes.length) return;
    const rt = this.state.npcs[q.giverNpcId];
    const reason = `${kind === 'completed' ? 'helped me with' : 'let me down over'} "${q.title}"`;
    if (rt) for (const h of heroes) this.dialogue.shift(rt, h.id, kind === 'completed' ? 20 : -20, `${h.name} ${reason}`);
    this.news({ text: `${heroes.map((h) => h.name).join(', ')} ${kind === 'completed' ? 'helped' : 'let down'} ${giver?.name ?? 'someone'} with "${q.title}".`, heroIds: heroes.map((h) => h.id), zoneId: rt?.zoneId ?? this.present()[0]!.zoneId, witnesses: [q.giverNpcId], reach: q.main ? 'world' : 'town', tone: kind === 'completed' ? 'good' : 'bad' });
  }

  private dialogueHost() {
    // eslint-disable-next-line @typescript-eslint/no-this-alias
    const self = this;
    return {
      ctx: this.ctx,
      get quests() {
        return self.quests;
      },
      get story() {
        return self.state;
      },
      get voices() {
        return self.voices;
      },
      day: () => this.day(),
      timeOfDay: () => this.timeOfDay(),
      player: (u: string) => this.state.players[u],
      speaker: (u: string) => this.speakerOf(u),
      npcRt: (id: string) => this.state.npcs[id],
      holdNotices: (us: string[]) => this.holdNotices(us),
      sendDialog: (u: string, d: DialogState | null) => {
        this.sendTo(u, { t: 'dialog', dialog: d });
        // Someone else may still be talking with them.
        if (!d) for (const z of this.zones.values()) for (const a of z.actors.values()) if (a instanceof NpcActor && a.talkingTo === u) a.talkingTo = this.dialogue.scenes().find((s) => s.npcId === a.id)?.userIds[0] ?? null;
      },
      scenesChanged: () => {
        this.sendScenes();
        this.tellAfterTalk();
      },
      openTrade: (u: string, npcId: string) => this.items.openTrade(u, npcId),
      giveItemsToPlayer: (u: string, items: ItemInstance[]) => {
        const p = this.state.players[u];
        if (!p) return;
        this.items.give(p, items);
        this.quests.refresh();
      },
      takeItemFromPlayer: (u: string, itemId: string) => {
        const p = this.state.players[u];
        if (!p) return null;
        const it = removeFromInventory(p.inventory, itemId, 1);
        this.markPlayer(u);
        return it;
      },
      revealZone: (zoneId: string) => {
        this.refreshFeatures();
        if (this.state.knownZones.includes(zoneId)) return false;
        this.state.knownZones.push(zoneId);
        this.markAll();
        return true;
      },
      remember: (npcId: string, mem: Memory) => this.remember(npcId, mem),
      news: (item: Omit<NewsItem, 'id' | 'day'>) => this.news(item),
      scheduleGathering: (npcId: string, about: string, day: number, reason: string) => {
        const rt = this.state.npcs[npcId];
        if (!rt) return;
        const town = this.ctx.townOf(rt.zoneId);
        if (!town) return;
        const tz = this.ctx.zones.get(town)!;
        const wp = tz.features.find((f) => f.kind === 'waypoint') ?? { x: tz.entry.x, y: tz.entry.y };
        const npcIds = Object.entries(this.state.npcs).filter(([id, r]) => this.ctx.townOf(r.zoneId) === town && this.ctx.npcs.get(id)?.role !== 'merchant').map(([id]) => id).slice(0, 10);
        if (this.state.events.some((e) => e.day === day && e.zoneId === town && e.about === about)) return;
        this.state.events.push({ id: uid('ev'), day, kind: 'gathering', zoneId: town, x: wp.x - 2, y: wp.y + 2, about, reason, npcIds });
      },
      playerChanged: (u: string) => this.markPlayer(u),
      journal: (kind: JournalEntry['kind'], text: string) => this.journal(kind, text),
      rollGift: (u: string, kind: 'supplies' | 'gear' | 'material' | 'keepsake', generous: boolean) => {
        const p = this.state.players[u];
        if (!p) return null;
        const level = Math.max(...p.party.map((c) => c.level));
        const of = (cat: string, filter: (b: { category: string; use?: unknown }) => boolean = () => true) => this.r.items.filter((b) => b.category === cat && b.price > 0 && filter(b));
        if (kind === 'gear') {
          // Equipment a person could spare: uncommon, or rare from someone who is fond of you, and never better.
          const rarity = Math.min(generous ? 2 : 1, this.r.rarities.length - 1);
          for (let i = 0; i < 8; i++) {
            const it = rollRandomItem(this.r, this.rng, level, { minRarity: rarity, maxRarity: rarity });
            if (rx(this.r).item.get(it.baseId)?.category === 'equipment') return it;
          }
          return null;
        }
        const pool = kind === 'supplies' ? [...of('potion'), ...of('tool')] : kind === 'material' ? of('material') : of('valuable');
        if (!pool.length) return null;
        const base = this.rng.pick(pool);
        return makeItem(this.r, this.rng, base.id, level, this.r.rarities[0]!.id, base.stackable ? (generous ? 3 : this.rng.int(1, 2)) : 1);
      },
      describe: (c: CharacterState) => {
        const look = this.world.origins.find((o) => o.id === c.classId);
        const kin = rx(this.r).kin.get(c.kinId)?.name;
        const done = Object.values(this.state.quests).filter((q) => q.status === 'completed').length;
        const fame = done > 6 ? 'well known in these parts' : done > 2 ? 'starting to be known around here' : 'new around here';
        return `${c.name} (${PRONOUNS[c.presentation]}), ${kin ? `${kin} ` : ''}${this.ctx.className(c.classId)}${look?.appearance ? `, ${look.appearance}` : ''}, ${fame}`;
      },
      communication: () => this.world.input.communication,
      questDef: (id: string) => this.questDef(id),
      knowsSkill: (u: string, skillId: string) => {
        const p = this.state.players[u];
        if (!p) return 'No party.';
        const lead = p.party.find((c) => c.id === p.leaderId) ?? p.party[0]!;
        // (Skills cost nothing outside a fight: the hero only has to know it.)
        return knownSkills(this.r, lead).includes(skillId) && rx(this.r).skill.has(skillId) ? null : 'You do not know that ability.';
      },
    };
  }

  questDef(id: string): QuestDef | undefined {
    return this.ctx.quests.get(id);
  }

  // =================================================================== test helpers

  /** Direct access for tests and tools. */
  _live(zoneId: string) {
    return this.places.live(zoneId);
  }
  _charActors(userId: string) {
    const p = this.state.players[userId];
    return p ? this.charActors(p) : [];
  }
  _combats() {
    return [...this.combats.values()];
  }
}

export type { CharacterSpec, DifficultyId };
