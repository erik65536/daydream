/** WebSocket connection + client-side game state store shared by the renderer and React UI. */
import { useSyncExternalStore } from 'react';
import {
  BitSet, EARSHOT_M, Nav, currentWays, fogSize, sampleMotion, characterStats, itemDisplayName, rx,
  type ClientMessage, type ClientWorld, type ClockView, type CombatView, type DialogState, type EntityView, type FeatureDef, type FeatureState, type FxEvent,
  type Aim, type LootPile, type LootView, type PlayerView, type RosterEntry, type SceneView, type ServerMessage, type TradeState, type ZoneView, type CharacterState, type StatBlock,
  type ChatLine, type ItemInstance, type Ruleset, type DevCommand, type DevInfo, type Moment, type ToastKind,
} from '@daydream/shared';
import { setRules } from '../rules';
import { sound } from '../sound';
import { sounds } from '../sounds';
import { breadcrumb } from '../report';

/**
 * Smaller copies of a world's art for where it is drawn small (made once by the server, `?w=` on the asset route): a
 * figure or an object stands at most about 300 device pixels tall at the closest zoom, an icon fills a slot. The
 * paintings of places are drawn near their own size and are always sent whole.
 */
const ASSET_SIZE = { figure: 512, icon: 256 } as const;

/** The server's answer to a developer command. */
interface DevResult {
  ok: boolean;
  text: string;
  info?: DevInfo;
}

/**
 * The place the party is in: its view, and where people can walk and see in it. Its `features` are those there for the
 * player now; `allFeatures` also holds those not yet (a stash nobody told them of, a quest's find before the quest).
 */
export interface ZoneData extends ZoneView {
  walk: Nav;
  allFeatures: FeatureDef[];
}

/** The features of a place the player sees, by the feature states the server sent. */
const seen = (all: FeatureDef[], states: Map<string, FeatureState>) => all.filter((f) => !states.get(f.id)?.unseen);

export interface WheelItem { id: string; label: string; sub?: string; icon?: string; disabled?: boolean }
interface Wheel { kind: 'skills' | 'panels'; items: WheelItem[]; sel: number }
export type Panel = 'inventory' | 'character' | 'skills' | 'quests' | 'map' | 'craft' | 'storage' | 'menu' | 'help' | 'codex' | 'settings' | null;

export interface Targeting {
  charId: string;
  skillId?: string;
  itemId?: string;
}

export interface Toast {
  id: number;
  text: string;
  kind: ToastKind;
  at: number;
}

/** A story card (protocol `narration`): its text grows while `pending`, read by the narrator's `lines`. */
export type Narration = Omit<Extract<ServerMessage, { t: 'narration' }>, 't'>;

interface GameState {
  status: 'connecting' | 'connected' | 'closed' | 'error';
  error?: string;
  /** Why the game cannot go on, when the adventure's page is where to go next (protocol `error.code`). */
  errorCode?: 'heroes' | 'full' | 'removed' | 'gone';
  world?: ClientWorld;
  userId?: string;
  adventureName?: string;
  isOwner: boolean;
  zone?: ZoneData;
  entities: Map<string, EntityView>;
  features: Map<string, FeatureState>;
  lootPiles: LootPile[];
  explored?: BitSet;
  player?: PlayerView;
  /** The fight the player's heroes are in. */
  combat: CombatView | null;
  /** The fights in this place the player's heroes are not in: drawn in the world, while the player walks, talks and loots as usual. */
  watched: CombatView[];
  dialog: DialogState | null;
  trade: TradeState | null;
  loot: LootView | null;
  clock?: ClockView & { localAt: number };
  toasts: Toast[];
  /** What happened nearby (fights, pickups), kept for the chat history; `at` is this device's time, as in `chat`. */
  log: { text: string; color?: string; at: number }[];
  narrations: Narration[];
  /** Spoken lines that could not be voiced (they expired or failed). */
  unvoiced: Set<string>;
  chat: ChatLine[];
  /** Who plays the adventure, where, and in what color. */
  roster: RosterEntry[];
  /** The conversations going on in this place. */
  scenes: SceneView[];
  /** Friends' aims during a fight (user id -> where, and when it last changed). */
  aims: Map<string, Aim & { at: number }>;
  /** The copy of the adventure the server just saved for this player (Save a copy), for the menu to say so. */
  savedCopy?: { adventureId: string; name: string };
  panel: Panel;
  targeting: Targeting | null;
  /** Last input device used: the HUD shows controller prompts in 'pad' mode and touch hints in 'touch' mode. */
  inputMode: 'mouse' | 'pad' | 'touch';
  /** A controller's radial menu, while its trigger is held. */
  wheel: Wheel | null;
  /** What the controller's A button would do now ("Talk", "Open"), and to what. */
  padPrompt: { verb: string; name: string; x: number; y: number } | null;
  /** The controller's focus ring is on the party display (View), to read everyone's Health and statuses. */
  partyFocus: boolean;
  /** The chat history is open for reading (tapped open, or chosen from the controller's menu wheel). */
  historyOpen: boolean;
  selectedCharId?: string;
  /** Monotonic version so React can re-render on mutation. */
  version: number;
  zoneVersion: number;
}

type FxListener = (events: FxEvent[]) => void;
/** A notice shown, and the moment it is heard as (protocol `toast`). */
type ToastListener = (kind: Toast['kind'], sound: Moment | null | undefined, text: string) => void;

/**
 * What a connection's session holds: everything the server sends while it lasts and sends again (or has ended) after
 * a reconnection.
 */
const freshSession = () => ({
  combat: null, watched: [] as CombatView[], dialog: null, trade: null, loot: null, targeting: null,
  scenes: [] as SceneView[], aims: new Map<string, Aim & { at: number }>(), unvoiced: new Set<string>(),
});

let toastId = 1;
/** Lines of the log, and of chat, kept to read back. */
const HISTORY = 100;
/** The longest a blow on its way holds back what it did (a slow shot, a long rush). */
const HOLD_MS = 1500;

export class GameClient {
  state: GameState = {
    status: 'connecting', isOwner: false, entities: new Map(), features: new Map(), lootPiles: [], ...freshSession(),
    toasts: [], log: [], narrations: [], chat: [], roster: [], panel: null, inputMode: 'mouse', wheel: null, padPrompt: null, partyFocus: false, historyOpen: false, version: 0, zoneVersion: 0,
  };
  private ws: WebSocket | null = null;
  private listeners = new Set<() => void>();
  private fxListeners = new Set<FxListener>();
  private toastListeners = new Set<ToastListener>();
  private serverListeners = new Set<(m: ServerMessage) => void>();
  private sendListeners = new Set<(m: ClientMessage) => void>();
  /** Bring the view back to the party after it was moved in a fight (the renderer sets this). */
  lookHome: () => void = () => {};
  /**
   * The middle of the view and how far it reaches (ground meters, half its width), set by the renderer: the world is
   * heard from there. Without a view, from the leader.
   */
  view: () => { x: number; y: number; halfWidth: number } | null = () => null;
  /** serverTime - localTime */
  offset = 0;
  private pingTimer: ReturnType<typeof setInterval> | null = null;
  private notifyScheduled = false;
  private closedByUser = false;
  private retries = 0;
  private retryTimer: ReturnType<typeof setTimeout> | null = null;
  private devReq = 0;
  private devWaiting = new Map<number, (r: DevResult) => void>();

  /** The game's sound (here too for playtests: `window.__gd.sound`, and its effects and music `window.__gd.sounds`). */
  readonly sound = sound;
  readonly sounds = sounds;
  private unsubscribe: (() => void)[] = [];
  private codecSent: string | null = null;
  readonly adventureId: string;

  constructor(adventureId: string) {
    this.adventureId = adventureId;
    // The player hears what they see: in a fight the camera shows whoever acts, wherever their own hero is. Anything
    // in the view is in earshot, however far the view is zoomed out.
    sound.listener = () => {
      const v = this.view();
      if (v) return { x: v.x, y: v.y, earshot: Math.max(EARSHOT_M, v.halfWidth) };
      const e = this.leaderEntity();
      return e ? { ...this.entityPos(e), earshot: EARSHOT_M } : null;
    };
    const tell = () => this.sendAudio();
    this.unsubscribe.push(sound.onChange(tell), sound.onUnlock(tell));
    this.unsubscribe.push(
      sound.onEnd((id, status) => {
        if (status !== 'expired' && status !== 'failed') return;
        this.state.unvoiced = new Set(this.state.unvoiced).add(id);
        this.notify();
      }),
    );
  }

  /** How this player hears speech now: nothing with voices off, or before the browser allows sound. */
  private audioCodec() {
    return sound.audible('voices') && sound.unlocked ? sound.codec() : null;
  }

  /** Tell the server how this player hears speech now, if that changed; while connecting, once the socket opens. */
  private sendAudio() {
    const codec = this.audioCodec();
    if (codec === this.codecSent) return;
    if (!codec) sound.reset();
    if (this.ws?.readyState !== WebSocket.OPEN) return;
    this.codecSent = codec;
    this.send({ t: 'audio', codec });
  }

  connect() {
    if (this.closedByUser) return;
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    sound.unlock();
    this.codecSent = this.audioCodec();
    const audio = this.codecSent ? `&audio=${this.codecSent}` : '';
    const ws = new WebSocket(`${proto}://${location.host}/ws?adventure=${encodeURIComponent(this.adventureId)}${audio}`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onmessage = (ev) => (typeof ev.data === 'string' ? this.onMessage(JSON.parse(ev.data) as ServerMessage) : sound.packet(ev.data as ArrayBuffer));
    ws.onclose = () => {
      if (this.pingTimer) clearInterval(this.pingTimer);
      if (this.closedByUser || this.state.status === 'error') {
        if (this.state.status !== 'error') this.state.status = 'closed';
        return this.notify();
      }
      // Transient disconnect (server restart, network blip): retry quietly.
      this.state.status = this.retries > 3 ? 'closed' : 'connecting';
      this.notify();
      if (this.retries < 40) this.retryTimer = setTimeout(() => this.connect(), Math.min(5000, 500 + this.retries++ * 400));
    };
    ws.onopen = () => {
      this.retries = 0;
      // The game started playing, or the browser allowed sound, while the socket was connecting.
      this.sendAudio();
      this.ping();
      this.pingTimer = setInterval(() => this.ping(), 5000);
    };
  }

  /** Leave the game on purpose: the heroes go at once (a dropped connection keeps them a minute). */
  close() {
    this.closedByUser = true;
    if (this.retryTimer) clearTimeout(this.retryTimer);
    for (const u of this.unsubscribe) u();
    // The sound no longer asks this client where the listener is (which would keep it alive).
    sound.listener = () => null;
    sound.reset();
    this.send({ t: 'leave' });
    this.ws?.close();
    if (this.pingTimer) clearInterval(this.pingTimer);
  }

  private ping() {
    this.send({ t: 'ping', clientTime: Date.now() });
  }

  send(msg: ClientMessage) {
    // Not the panel's own refreshes or keep-alives: what the player (or an administrator) did.
    if (msg.t !== 'ping' && !(msg.t === 'dev' && msg.action === 'info')) breadcrumb(msg.t === 'dev' ? `dev ${msg.action}` : `sent ${msg.t}`);
    for (const l of this.sendListeners) l(msg);
    if (this.ws?.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  /**
   * A developer command (administrators only), answered when the server has run it: for the dev panel, and for scripts
   * and automated browser tests (`await window.__gd.dev({ action: 'level', level: 5 })`).
   */
  dev(cmd: DevCommand): Promise<DevResult> {
    const reqId = ++this.devReq;
    return new Promise((resolve) => {
      const done = (r: DevResult) => {
        this.devWaiting.delete(reqId);
        resolve(r);
      };
      this.devWaiting.set(reqId, done);
      setTimeout(() => done({ ok: false, text: 'No answer from the server.' }), 10_000);
      this.send({ t: 'dev', reqId, ...cmd });
    });
  }

  serverNow() {
    return Date.now() + this.offset;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => this.listeners.delete(fn);
  };

  onFx(fn: FxListener) {
    this.fxListeners.add(fn);
    return () => this.fxListeners.delete(fn);
  }

  /** Every notice shown, local ones too. */
  onToast(fn: ToastListener) {
    this.toastListeners.add(fn);
    return () => this.toastListeners.delete(fn);
  }

  /** Every message from the server, before the state takes it in. */
  onServer(fn: (m: ServerMessage) => void) {
    this.serverListeners.add(fn);
    return () => this.serverListeners.delete(fn);
  }

  /** Every message sent to the server. */
  onSent(fn: (m: ClientMessage) => void) {
    this.sendListeners.add(fn);
    return () => this.sendListeners.delete(fn);
  }

  /** Show effects made here as if the server had sent them (the effects reel, render/fxreel.ts). */
  playFx(events: FxEvent[]) {
    for (const l of this.fxListeners) l(events);
  }

  /** Play the effects reel (admins; again to stop it). */
  fxReel() {
    return import('../render/fxreel').then((m) => m.playFxReel(this));
  }

  notify() {
    if (this.notifyScheduled) return;
    this.notifyScheduled = true;
    queueMicrotask(() => {
      this.notifyScheduled = false;
      this.state = { ...this.state, version: this.state.version + 1 };
      for (const l of this.listeners) l();
    });
  }

  /**
   * Blows on their way to someone (a shot in flight, a rush): until the renderer shows one land, that one's Health and
   * fall stay as they were, so what the server already counted is seen when it happens (at most HOLD_MS late).
   */
  private holds = new Map<string, { blows: number; latest?: EntityView; timer: ReturnType<typeof setTimeout> }>();

  /** An entity as it is shown now: its new state, but its Health and fall as before while a blow is on its way. */
  private shown(e: EntityView): EntityView {
    const h = this.holds.get(e.id);
    const was = this.state.entities.get(e.id);
    if (!h || !was) return e;
    h.latest = e;
    return { ...e, hp: was.hp, dead: was.dead, downed: was.downed };
  }

  /** A blow is on its way to `id`. */
  holdHealth(id: string) {
    const h = this.holds.get(id);
    if (h) return void h.blows++;
    this.holds.set(id, { blows: 1, timer: setTimeout(() => this.landed(id, true), HOLD_MS) });
  }

  /** A blow reached `id` (or, `all`, the wait is over): what it did shows. */
  landed(id: string, all = false) {
    const h = this.holds.get(id);
    if (!h || (--h.blows > 0 && !all)) return;
    clearTimeout(h.timer);
    this.holds.delete(id);
    if (h.latest && this.state.entities.has(id)) {
      this.state.entities.set(id, h.latest);
      this.notify();
    }
  }

  update(patch: Partial<GameState>) {
    Object.assign(this.state, patch);
    this.notify();
  }

  toast(text: string, kind: Toast['kind'] = 'info', sound?: Moment | null) {
    for (const l of this.toastListeners) l(kind, sound, text);
    // What a hero picks up rises quietly over them (the renderer draws it) and is kept in the log, not announced.
    if (kind === 'pickup') {
      this.state.log = [...this.state.log.slice(1 - HISTORY), { text: `Picked up ${text}`, color: '#d8c79a', at: Date.now() }];
      return this.notify();
    }
    const t = { id: toastId++, text, kind, at: Date.now() };
    this.state.toasts = [...this.state.toasts.slice(-5), t];
    this.notify();
    setTimeout(() => {
      this.state.toasts = this.state.toasts.filter((x) => x !== t);
      this.notify();
    }, kind === 'quest' || kind === 'good' ? 5200 : 4000);
  }

  /** Close the narration shown: its voice stops too. */
  dismissNarration() {
    const n = this.state.narrations[0];
    if (!n) return;
    this.skipLines((n.lines ?? []).map((l) => l.id));
    this.update({ narrations: this.state.narrations.slice(1) });
  }

  /** Stop hearing these lines, here and on the server. */
  skipLines(ids: string[]) {
    for (const id of sound.stop((_q, lineId) => ids.includes(lineId))) this.send({ t: 'skip_line', id });
  }

  private onMessage(m: ServerMessage) {
    const s = this.state;
    for (const l of this.serverListeners) l(m);
    switch (m.t) {
      case 'welcome':
        s.world = m.world;
        setRules(m.world.ruleset);
        s.userId = m.userId;
        s.adventureName = m.adventureName;
        s.isOwner = m.isOwner;
        s.status = 'connected';
        // A (re)connection starts from a clean slate; the server re-sends what is active. A story card still being
        // written when the connection dropped stays to be read, as far as it got.
        Object.assign(s, freshSession());
        s.narrations = s.narrations.map((n) => (n.pending ? { ...n, pending: false } : n));
        sound.reset();
        this.offset = m.serverTime - Date.now();
        s.chat = m.chat.map((l) => ({ ...l, at: l.at - this.offset }));
        break;
      case 'pong': {
        const rtt = Date.now() - m.clientTime;
        this.offset = m.serverTime + rtt / 2 - Date.now();
        return;
      }
      case 'zone': {
        const z = m.zone;
        if (!z.nav) break;
        s.entities = new Map(m.entities.map((e) => [e.id, e]));
        s.features = new Map(m.features.map((f) => [f.id, f]));
        s.zone = { ...z, walk: new Nav(z.nav), allFeatures: z.features, features: seen(z.features, s.features) };
        s.lootPiles = m.loot;
        const fog = fogSize(z);
        s.explored = new BitSet(fog.w * fog.h, m.explored);
        s.zoneVersion++;
        s.targeting = null;
        // A chest or pile left open stayed in the place the party came from.
        s.loot = null;
        break;
      }
      case 'entities':
        for (const e of m.upsert) s.entities.set(e.id, this.shown(e));
        for (const id of m.remove) s.entities.delete(id);
        break;
      case 'features':
        for (const f of m.features) s.features.set(f.id, f);
        if (s.zone) s.zone = { ...s.zone, features: seen(s.zone.allFeatures, s.features) };
        s.zoneVersion++;
        break;
      case 'loot_piles':
        s.lootPiles = m.loot;
        break;
      case 'player':
        s.player = m.player;
        if (!s.selectedCharId || !m.player.party.some((c) => c.id === s.selectedCharId)) s.selectedCharId = m.player.leaderId;
        break;
      case 'fights':
        s.watched = m.fights;
        break;
      case 'combat': {
        s.combat = m.combat;
        if (!s.combat) {
          s.targeting = null;
          s.aims.clear();
        } else {
          // On one's turn the hero acting is the one selected (of one's own sharing the turn, the selected one if it acts).
          const mine = this.myActors();
          if (mine.length && !mine.includes(s.selectedCharId ?? '')) s.selectedCharId = mine[0];
          if (s.targeting && !mine.includes(s.targeting.charId)) s.targeting = null;
        }
        break;
      }
      case 'fx': {
        for (const l of this.fxListeners) l(m.events);
        const lines = this.combatLines(m.events);
        if (!lines.length) return;
        s.log = [...s.log, ...lines].slice(-HISTORY);
        break;
      }
      case 'dialog':
        // Leaving a conversation silences it (the server stops sending its lines).
        if (!m.dialog && s.dialog) sound.stop((q) => q.endsWith(`/dialog:${s.dialog!.npcId}`));
        // A conversation beginning closes the window that was open; one opened during it stays.
        if (m.dialog && !s.dialog) s.panel = null;
        s.dialog = m.dialog;
        break;
      case 'trade':
        s.trade = m.trade;
        break;
      case 'loot':
        s.loot = m.loot;
        break;
      case 'clock':
        s.clock = { ...m.clock, localAt: Date.now() };
        break;
      case 'narration':
        // A card already shown (its text growing) is replaced where it is.
        s.narrations = s.narrations.some((n) => n.id === m.id) ? s.narrations.map((n) => (n.id === m.id ? m : n)) : [...s.narrations, m];
        break;
      case 'open':
        s.panel = m.panel;
        break;
      case 'line':
        sound.line(m.id, m.queue, m.at);
        return;
      case 'line_start':
        sound.start(m.id, m.rate, m.codec);
        return;
      case 'line_end':
        sound.end(m.id, m.status);
        return;
      case 'toast':
        this.toast(m.text, m.kind, m.sound);
        return;
      case 'journal':
        // The journal comes whole with the player's state; an entry made since then is added as it happens.
        if (s.player && !s.player.journal.some((j) => j.minute === m.entry.minute && j.text === m.entry.text)) s.player = { ...s.player, journal: [...s.player.journal, m.entry] };
        break;
      case 'log':
        s.log = [...s.log.slice(1 - HISTORY), { text: m.text, color: m.color, at: Date.now() }];
        break;
      case 'chat':
        s.chat = [...s.chat.slice(1 - HISTORY), { from: m.from, text: m.text, userId: m.userId, at: m.at - this.offset }];
        break;
      case 'roster':
        s.roster = m.players;
        break;
      case 'scenes':
        s.scenes = m.scenes;
        break;
      case 'aim':
        if (m.aim) s.aims.set(m.userId, { ...m.aim, at: Date.now() });
        else s.aims.delete(m.userId);
        return;
      case 'saved':
        s.savedCopy = { adventureId: m.adventureId, name: m.name };
        break;
      case 'dev_result':
        if (m.reqId !== undefined) this.devWaiting.get(m.reqId)?.({ ok: m.ok, text: m.text, info: m.info });
        break;
      case 'error':
        breadcrumb(`server error: ${m.message}`);
        s.status = 'error';
        s.error = m.message;
        s.errorCode = m.code;
        break;
    }
    this.notify();
  }

  // ------------------------------------------------------------------ helpers

  /** Where an entity is now (ground meters), along its walk if it is walking. */
  entityPos(e: EntityView): { x: number; y: number; moving: boolean; facing: number } {
    if (e.motion) {
      const smp = sampleMotion(e.motion, this.serverNow());
      return { x: smp.x, y: smp.y, moving: !smp.done, facing: smp.done ? e.facing : smp.facing };
    }
    return { x: e.x, y: e.y, moving: false, facing: e.facing };
  }

  /** The hero the windows and the skill bar show: the selected one, else the first of the party. */
  selectedHero(): CharacterState | undefined {
    const party = this.state.player?.party ?? [];
    return party.find((c) => c.id === this.state.selectedCharId) ?? party[0];
  }

  /** Whether a thing in the place is what a quest step needs: a find not yet taken. */
  questThing(f: FeatureDef): boolean {
    const fs = this.state.features.get(f.id);
    return !!f.questId && !(fs?.opened && fs.empty);
  }

  /** Whether a creature counts for a quest's step being done now (one of a family to fight there, or the foe to beat). */
  questFoe(e: EntityView): boolean {
    const pl = this.state.player;
    const zoneId = this.state.zone?.id;
    if (!pl || e.dead) return false;
    return Object.values(pl.quests).some((q) => {
      const def = q.status === 'active' ? pl.questDefs[q.questId] : undefined;
      if (!def) return false;
      const ways = currentWays(def, q);
      return ways.some((o) => !q.objectives[o.id]?.done && (o.type === 'kill' ? o.familyId === e.familyId && (!o.zoneId || o.zoneId === zoneId) : o.type === 'kill_unique' && !!e.bossId && o.targetId === e.bossId));
    });
  }

  /** Readable combat log lines for skill uses, hits, misses, and deaths. */
  private combatLines(events: FxEvent[]): { text: string; color?: string; at: number }[] {
    const s = this.state;
    if (!s.world) return [];
    const ix = rx(s.world.ruleset);
    const name = (id?: string) => (id ? s.entities.get(id)?.name : undefined);
    const mine = (id?: string) => !!id && s.entities.get(id)?.ownerUserId === s.userId;
    const at = Date.now();
    const out: { text: string; color?: string; at: number }[] = [];
    for (const ev of events) {
      if (ev.kind === 'skill' && ev.skillId && ev.skillId !== s.world.ruleset.basicAttackId) {
        const who = name(ev.sourceId);
        const sk = ix.skill.get(ev.skillId);
        if (who && sk) out.push({ text: `${who} uses ${sk.name}.`, color: mine(ev.sourceId) ? '#cfe4ff' : '#e8c8b8', at });
      } else if (ev.kind === 'damage' && ev.damage) {
        const d = ev.damage;
        const target = name(d.targetId);
        if (!target) continue;
        const src = name(ev.sourceId);
        if (d.miss) out.push({ text: `${src ? `${src} misses ${target}` : `${target} dodges`}.`, color: '#a69c8c', at });
        else if (d.type === 'heal') out.push({ text: `${target} recovers ${Math.round(d.amount)}.`, color: '#9fe0a0', at });
        else {
          const kind = ix.type.get(d.type)?.name ?? '';
          const verb = d.crit ? 'critically hits' : 'hits';
          out.push({ text: src && src !== target ? `${src} ${verb} ${target} for ${Math.round(d.amount)}${kind ? ` ${kind.toLowerCase()}` : ''}.` : `${target} takes ${Math.round(d.amount)}${kind ? ` ${kind.toLowerCase()}` : ''} damage.`, color: mine(d.targetId) ? '#ffb0a0' : d.crit ? '#ffe08a' : '#d8d0c0', at });
        }
      } else if (ev.kind === 'text' && ev.text === 'Dodged') {
        const who = name(ev.targetId);
        if (who) out.push({ text: `${who} dodges${name(ev.sourceId) ? ` ${name(ev.sourceId)}’s attack` : ''}.`, color: '#a69c8c', at });
      } else if (ev.kind === 'death') {
        const who = name(ev.targetId ?? ev.sourceId);
        if (who) out.push({ text: `${who} falls.`, color: mine(ev.targetId ?? ev.sourceId) ? '#ff8a70' : '#f0c070', at });
      }
    }
    return out;
  }

  get r(): Ruleset {
    return this.state.world!.ruleset;
  }

  charStats(ch: CharacterState): StatBlock {
    return characterStats(this.r, ch);
  }

  uniqueItems() {
    return { ...(this.state.world?.uniqueItems ?? {}), ...(this.state.player?.dynamicItems ?? {}) } as Record<string, { name: string; description: string }>;
  }

  itemName(item: ItemInstance): string {
    return itemDisplayName(this.r, item, { uniqueItems: this.uniqueItems() });
  }

  /** What a pile on the ground holds, in a few words: its best thing (in that thing's color), how much else, and the gold. */
  lootSummary(pile: LootPile): { text: string; color: string } {
    const ix = rx(this.r);
    const rank = (i: ItemInstance) => (i.uniqueId ? 99 : ix.rarityOrder.get(i.rarityId) ?? 0);
    const best = [...pile.items].sort((a, b) => rank(b) - rank(a))[0];
    const gold = pile.gold ? `${pile.gold} ${this.r.terminology.currency}` : '';
    if (!best) return { text: gold || pile.label, color: '#ffe08a' };
    const name = `${this.itemName(best)}${best.qty > 1 ? ` ×${best.qty}` : ''}`;
    const more = pile.items.length - 1;
    const text = [name, more > 0 ? `+${more} more` : '', gold].filter(Boolean).join('  ·  ');
    return { text, color: best.uniqueId ? '#ffd24a' : ix.rarity.get(best.rarityId)?.color ?? '#e8e0d0' };
  }

  itemDescription(item: ItemInstance): string {
    if (item.uniqueId) return this.uniqueItems()[item.uniqueId]?.description ?? '';
    return rx(this.r).item.get(item.baseId)?.description ?? '';
  }

  skillName(id: string): string {
    return rx(this.r).skill.get(id)?.name ?? id;
  }

  /** A player's color (their heroes' rings and names, their chat). */
  colorOf(userId?: string): string {
    return this.state.roster.find((p) => p.userId === userId)?.color ?? '#bfe4ff';
  }

  leaderEntity(): EntityView | undefined {
    const p = this.state.player;
    if (!p) return undefined;
    return this.state.entities.get(p.leaderId) ?? [...this.state.entities.values()].find((e) => e.ownerUserId === this.state.userId);
  }

  /** The player's own heroes acting now (heroes share a turn when theirs come one after another). */
  myActors(): string[] {
    const c = this.state.combat;
    if (!c) return [];
    return c.actingIds.filter((id) => c.order.find((o) => o.id === id)?.controllerUserId === this.state.userId);
  }

  isMyTurn(): boolean {
    return this.myActors().length > 0;
  }

  /** The hero the player acts with now: the selected one if it is acting, else the first of theirs acting. */
  myActor(): string | undefined {
    const mine = this.myActors();
    return mine.find((id) => id === this.state.selectedCharId) ?? mine[0];
  }

  private lastAim = '';
  private lastAimAt = 0;
  /** Tell friends where the player aims now (null: not aiming); at most a few times a second, and only when it changes. */
  aim(aim: Aim | null) {
    const key = aim ? `${aim.charId}|${aim.skillId ?? aim.itemId ?? 'move'}|${aim.x.toFixed(1)},${aim.y.toFixed(1)}` : '';
    if (key === this.lastAim || (aim && Date.now() - this.lastAimAt < 120)) return;
    if (!aim && !this.lastAim) return;
    this.lastAim = key;
    this.lastAimAt = Date.now();
    if (this.state.roster.filter((r) => r.online && r.zoneId === this.state.zone?.id).length > 1) this.send({ t: 'aim', aim });
  }

  assetUrl(key?: string, size?: keyof typeof ASSET_SIZE): string | undefined {
    if (!key || !this.state.world) return undefined;
    const rec = this.state.world.assets[key];
    if (!rec || rec.status !== 'ok' || !rec.file) return undefined;
    return `/api/worlds/${this.state.world.id}/assets/${rec.file}${size ? `?w=${ASSET_SIZE[size]}` : ''}`;
  }

  /** Whether the party has seen the ground at (x, y) meters (the fog of war remembers it per square meter). */
  seen(x: number, y: number): boolean {
    const { zone: z, explored } = this.state;
    if (!z || !explored) return true;
    const { w, h } = fogSize(z);
    const cx = Math.round(x), cy = Math.round(y);
    return cx >= 0 && cy >= 0 && cx < w && cy < h && explored.get(cy * w + cx);
  }

  /** Estimated game clock now. */
  clockMinute(): number {
    const c = this.state.clock;
    if (!c) return 8 * 60;
    if (c.paused) return c.minute;
    return c.minute + (Date.now() - c.localAt) / 1000;
  }
}

// Kept on globalThis so hot-reloaded copies of this module share the active client.
const holder = globalThis as unknown as { __gdClient?: GameClient | null };
export function setClient(c: GameClient | null) {
  holder.__gdClient = c;
}
export function clearClient(c: GameClient) {
  if (holder.__gdClient === c) holder.__gdClient = null;
}
export function tryClient(): GameClient | null {
  return holder.__gdClient ?? null;
}
export function client(): GameClient {
  const c = holder.__gdClient;
  if (!c) throw new Error('No game client');
  return c;
}

/** React hook: re-render when the store changes. */
export function useGame<T>(sel: (s: GameState, c: GameClient) => T): T {
  const c = client();
  const s = useSyncExternalStore(c.subscribe, () => c.state);
  return sel(s, c);
}
