/**
 * Turn-based combat encounter on a place's ground (meters; movement budgets are meters too). The core is synchronous: every action applies immediately
 * and returns how long its animation takes; pacing goes through `host.after`, so the live game paces with
 * timers while the balance simulator runs the very same code instantly.
 *
 * Heroes whose turns come one after another in the order act together (a shared turn): each player moves their own,
 * and the turn passes on when all of them have finished (docs/multiplayer.md). With several players in the fight a
 * shared turn has a time limit, after which the AI finishes it for whoever has not.
 */
import {
  Nav, SPACING, SQUEEZE, WALK_SPEED, cutPath, rx, skillAp, skillRange, walkCost,
  type ActiveStatus, type CombatView, type CombatantView, type ItemInstance, type NavPathOptions, type Vec2,
} from '@daydream/shared';
import { Actor, CharActor } from './actors.ts';
import { checkItemUse, checkSkill, executeSkill, startTurn, useConsumable, wearStatuses, type EffectHost } from './effects.ts';
import { aiStep, type AiMemory, type Policy } from './ai.ts';
import { bodyAt, isFree, walkAmong, walkAndTaken } from './space.ts';
import { reportError } from '../log.ts';

export interface CombatHost extends EffectHost {
  broadcastCombat(c: Combat): void;
  /** The fight is over: one side won, or the players' side withdrew (fled). */
  combatEnded(c: Combat, outcome: CombatOutcome): void;
  isMultiplayer(c: Combat): boolean;
  /** The healing potions a hero played by the AI may drink, each with what takes it from the bag. */
  aiPotions?(a: Actor): { item: ItemInstance; consume: () => void }[];
  /** Run `fn` after `ms` of game time (timers live, immediate in simulation). */
  after(ms: number, fn: () => void): void;
}

export type CombatOutcome = 'victory' | 'defeat' | 'fled';

// ------------------------------------------------------------------------------------ action points

/** Action points at the start of a turn: the first turn's (less an opening attack already made), then what each turn adds. */
function gainAp(a: Actor, first: boolean) {
  const s = a.stats();
  a.ap = first ? Math.max(0, Math.min(s.apMax, s.apStart) - a.openerAp) : Math.min(s.apMax, a.ap + s.apPerTurn);
  a.openerAp = 0;
  a.movementLeft = 0;
}

/** Meters the actor can still move this turn, keeping `reserve` action points for something else (-1 when it has not that many). */
function moveBudget(a: Actor, reserve = 0): number {
  return a.ap < reserve ? -1 : a.movementLeft + (a.ap - reserve) * a.stats().move;
}

/** Pay for moving `len` meters (already checked against the budget): whole action points, the rest kept as movement. */
function payMove(a: Actor, len: number) {
  const per = a.stats().move;
  if (len <= a.movementLeft + 1e-6) {
    a.movementLeft -= len;
    return;
  }
  const cost = Math.ceil((len - a.movementLeft - 1e-6) / per);
  a.ap -= cost;
  a.movementLeft = a.movementLeft + cost * per - len;
}

/** An actor out of a fight: no turn resources, and nothing a fight left on it. */
function release(a: Actor) {
  a.combatId = null;
  a.ap = 0;
  a.movementLeft = 0;
  a.controlImmune = 0;
  a.dirty = true;
}

// ------------------------------------------------------------------------------------ combat

/** Seconds players have for a shared turn when several are in the fight, before the AI finishes it. */
const TURN_LIMIT = 120;

export class Combat {
  round = 1;
  order: Actor[] = [];
  /** The first of the actors whose turn it is, in `order`; `span` order places from there are this turn's. */
  idx = 0;
  private span = 1;
  /** Who acts now: one actor, or the heroes sharing a turn (those who have finished leave it). */
  acting: Actor[] = [];
  /** Heroes waiting for the AI to finish their part of a shared turn, one after another. */
  private aiQueue: Actor[] = [];
  turnStartedAt = Date.now();
  ended = false;
  /** The AI is playing someone's turn (heroes handed to it in a shared turn take theirs one after another). */
  busy = false;
  private turnToken = 0;
  private started = false;
  private acted = new Set<string>();
  /** Those whose turn this is (a stunned one too), each with the statuses it began the turn with: they wear at its end. */
  private turn = new Map<Actor, ActiveStatus[]>();
  private initiative = new Map<string, number>();
  readonly ai = new Map<string, AiMemory>();
  /** How AI-played fighters choose (the game's own AI unless an experiment plugs in another). */
  policy?: Policy;
  /** Whole rounds in a row in which nobody's Health changed (the AI presses on when sides wait for each other). */
  quietRounds = 0;
  private lastHealth = -1;
  /** Fast mode for tests (no animation delays). */
  static instant = false;
  readonly id: string;
  readonly zoneId: string;
  readonly host: CombatHost;

  constructor(id: string, zoneId: string, host: CombatHost) {
    this.id = id;
    this.zoneId = zoneId;
    this.host = host;
  }

  /** The first of those acting now (the actor, when one acts alone). */
  get active(): Actor | undefined {
    return this.acting[0];
  }

  isActing(a: Actor): boolean {
    return this.acting.includes(a);
  }

  /** The hero a player acts with now: `charId` if that one is theirs and acting, else the first of theirs acting. */
  actingFor(userId: string, charId?: string): CharActor | undefined {
    const mine = this.acting.filter((a): a is CharActor => a instanceof CharActor && a.userId === userId && this.isHumanControlled(a));
    return mine.find((a) => a.id === charId) ?? mine[0];
  }

  participants(): Actor[] {
    return this.order;
  }

  add(a: Actor) {
    if (this.participants().includes(a)) return;
    a.combatId = this.id;
    a.motion = null;
    a.ap = Math.min(a.stats().apMax, a.stats().apStart);
    a.movementLeft = 0;
    a.dirty = true;
    this.initiative.set(a.id, a.stats().initiative + this.host.rng.int(0, 6));
    if (!this.started) return void this.order.push(a);
    // Someone joining a fight under way takes their place among the turns still to come this round, by initiative, so
    // they act this round like everyone else (never after the turn at hand, which is already under way).
    const from = this.idx + this.span;
    let at = from;
    while (at < this.order.length && (this.initiative.get(this.order[at]!.id) ?? 0) >= (this.initiative.get(a.id) ?? 0)) at++;
    this.order.splice(at, 0, a);
  }

  start() {
    this.started = true;
    this.order.sort((a, b) => (this.initiative.get(b.id) ?? 0) - (this.initiative.get(a.id) ?? 0));
    this.idx = 0;
    this.host.broadcastCombat(this);
    this.beginTurn();
  }

  view(): CombatView {
    return {
      id: this.id,
      round: this.round,
      order: this.order.map<CombatantView>((a) => ({
        id: a.id,
        name: a.name,
        team: a.team() === 'players' ? 'players' : 'enemies',
        ap: a.ap,
        maxAp: a.stats().apMax,
        movementLeft: Math.round(a.movementLeft * 10) / 10,
        ownerUserId: a instanceof CharActor ? a.userId : undefined,
        controllerUserId: a instanceof CharActor && !a.aiDriven() ? a.userId : undefined,
      })),
      activeId: this.active?.id ?? '',
      actingIds: this.acting.map((a) => a.id),
      turnStartedAt: this.turnStartedAt,
      turnLimit: this.host.isMultiplayer(this) ? TURN_LIMIT : undefined,
    };
  }

  isHumanControlled(a: Actor): boolean {
    return a instanceof CharActor && !a.aiDriven();
  }

  private delay(ms: number) {
    return Combat.instant ? 0 : ms;
  }

  /** Ready an actor for its turn: what its statuses do to it, then its action points. False when a stun takes the turn. */
  private readyTurn(a: Actor): boolean {
    if (a.alive()) startTurn(this.host, a);
    this.turn.set(a, a.statuses);
    const stunned = a.stats().stunned;
    if (!stunned) gainAp(a, !this.acted.has(a.id));
    this.acted.add(a.id);
    if (stunned && a.alive()) this.host.log(this.zoneId, `${a.name} is stunned and loses the turn.`);
    return !stunned;
  }

  private beginTurn() {
    if (this.ended) return;
    const a = this.order[this.idx];
    if (!a) return this.finish('defeat');
    this.span = 1;
    if (!a.alive()) {
      this.acting = [];
      return this.advance();
    }
    // Heroes whose turns come next one after another share this turn (the downed among them are passed over).
    const phase = [a];
    if (this.isHumanControlled(a))
      for (let j = this.idx + 1; j < this.order.length; j++) {
        const b = this.order[j]!;
        if (!this.isHumanControlled(b) && !(b instanceof CharActor && b.downed())) break;
        this.span++;
        if (b.alive()) phase.push(b);
      }
    const token = ++this.turnToken;
    this.turnStartedAt = Date.now();
    this.aiQueue = [];
    this.acting = phase.filter((x) => this.readyTurn(x) && x.alive());
    this.host.broadcastCombat(this);
    if (this.checkEnd()) return;
    if (!this.acting.length) {
      this.host.after(this.delay(500), () => token === this.turnToken && this.advance());
      return;
    }
    if (!this.isHumanControlled(a)) {
      this.busy = true;
      this.host.after(this.delay(this.aiPace(450)), () => this.driveAi(a, token, 0));
    } else if (this.host.isMultiplayer(this)) {
      // Whoever has not finished when the time is up: the AI plays the rest of their turn.
      this.host.after(TURN_LIMIT * 1000, () => {
        if (token === this.turnToken && !this.ended) for (const x of [...this.acting]) this.aiTakeOver(x);
      });
    }
  }

  /** A hero is handed to the AI during its turn (its player chose so, dropped out, or ran out of time): the AI plays the rest of it. */
  aiTakeOver(a: Actor) {
    if (this.ended || !this.isActing(a) || this.aiQueue.includes(a)) return;
    this.aiQueue.push(a);
    if (!this.busy) this.nextAi();
  }

  private nextAi(): void {
    const a = this.aiQueue.shift();
    if (!a) return;
    if (!this.isActing(a)) return this.nextAi();
    this.busy = true;
    const token = this.turnToken;
    this.host.after(this.delay(300), () => this.driveAi(a, token, 0));
  }

  /** Creatures act with shorter pauses the more of them are alive, so a big fight keeps moving. */
  private aiPace(ms: number): number {
    const many = this.participants().filter((x) => x.alive() && x.team() !== 'players').length;
    return ms * Math.max(0.45, Math.min(1, 1 - (many - 3) * 0.08));
  }

  private driveAi(a: Actor, token: number, step: number) {
    if (token !== this.turnToken || this.ended || !this.isActing(a)) {
      // Its turn ended under the AI's hands (its player ended it): on to whoever waits for the AI next.
      if (!this.ended && token === this.turnToken) {
        this.busy = false;
        this.nextAi();
      }
      return;
    }
    let ms = -1;
    try {
      ms = step < 10 && a.alive() ? aiStep(this, a) : -1;
    } catch (e) {
      reportError(e, { in: 'combat AI', zone: this.zoneId, actor: `${a.name} (${a.id})`, hp: a.hp, round: this.round, step });
    }
    if (ms < 0 || this.ended) {
      this.busy = false;
      if (token === this.turnToken && !this.ended) this.done(a);
      return;
    }
    this.host.after(this.delay(a.team() === 'players' ? ms : this.aiPace(ms)), () => this.driveAi(a, token, step + 1));
  }

  /** One actor has finished its turn: the turn passes on once everyone sharing it has. */
  private done(a: Actor) {
    this.acting = this.acting.filter((x) => x !== a);
    if (this.acting.length) {
      this.host.broadcastCombat(this);
      if (!this.busy) this.nextAi();
      return;
    }
    this.advance();
  }

  advance() {
    if (this.ended) return;
    if (this.checkEnd()) return;
    // The turn at hand is over for everyone who had it.
    for (const [a, had] of this.turn) if (a.alive()) wearStatuses(this.host, a, had);
    this.turn.clear();
    this.busy = false;
    this.acting = [];
    this.idx += this.span;
    this.span = 1;
    if (this.idx >= this.order.length) {
      this.idx = 0;
      this.round++;
      const health = this.participants().reduce((sum, x) => sum + (x.alive() ? x.hp : 0), 0);
      this.quietRounds = Math.abs(health - this.lastHealth) < 1e-6 ? this.quietRounds + 1 : 0;
      this.lastHealth = health;
      this.order = this.order.filter((a) => a.alive() || a.downed());
    }
    this.beginTurn();
  }

  checkEnd(): boolean {
    if (this.ended) return true;
    const alive = this.participants().filter((a) => a.alive());
    const players = alive.filter((a) => a.team() === 'players');
    const enemies = alive.filter((a) => a.team() === 'enemies');
    if (!enemies.length) {
      this.finish('victory');
      return true;
    }
    if (!players.length) {
      this.finish('defeat');
      return true;
    }
    return false;
  }

  private finish(outcome: CombatOutcome) {
    if (this.ended) return;
    this.ended = true;
    this.busy = false;
    for (const a of this.participants()) release(a);
    this.host.combatEnded(this, outcome);
  }

  remove(a: Actor) {
    release(a);
    const i = this.order.indexOf(a);
    const wasActing = this.isActing(a);
    this.acting = this.acting.filter((x) => x !== a);
    this.aiQueue = this.aiQueue.filter((x) => x !== a);
    this.turn.delete(a);
    if (i >= 0) {
      this.order.splice(i, 1);
      if (i < this.idx) this.idx--;
      else if (i < this.idx + this.span) this.span--;
      if (wasActing && !this.acting.length) this.advance();
    }
    this.checkEnd();
  }

  /**
   * The players' side withdraws (someone called the retreat): every hero leaves the fight together, the fallen with
   * the rest, and the fight ends without a winner. The creatures are left to the host to calm down.
   */
  withdraw() {
    if (this.ended) return;
    for (const a of this.order) if (a.team() === 'players') release(a);
    this.order = this.order.filter((a) => a.team() !== 'players');
    this.finish('fled');
  }

  // ------------------------------------------------------------------ space

  private people(): Actor[] {
    return this.host.actorsInZone(this.zoneId);
  }

  private nav(): Nav {
    return this.host.zoneMap(this.zoneId).nav;
  }

  /** Someone standing at p (alive, or downed but not dead), if any. */
  occupant(p: Vec2, ignore?: Actor): Actor | undefined {
    return bodyAt(this.people(), p, ignore);
  }

  /** Somewhere `a` can stop. */
  standable(a: Actor, p: Vec2): boolean {
    return isFree(this.nav(), this.people(), p, a);
  }

  /** What walking costs `a` per meter at p beyond the meter itself: allies squeezed past. */
  private extraFor(a: Actor): (p: Vec2) => number {
    const allies = this.people().filter((o) => o !== a && o.team() === a.team() && (o.alive() || o.downed()));
    return (p) => (allies.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < SPACING - 0.01) ? SQUEEZE : 0);
  }

  walkOptions(a: Actor): NavPathOptions {
    return walkAmong(this.nav(), a, this.people(), (o) => o.team() === a.team());
  }

  pathFor(a: Actor, to: Vec2): Vec2[] | null {
    if (this.occupant(to, a)) return null;
    return this.nav().path(a, to, { ...this.walkOptions(a), maxNodes: 12000 });
  }

  /** Movement a walk uses: its length plus squeezing past allies. */
  pathCost(a: Actor, path: Vec2[]): number {
    return walkCost(a, path, this.extraFor(a));
  }

  /** Every free spot `a` can reach within `budget` meters (half-meter steps), with about what it costs. */
  reach(a: Actor, budget: number): { p: Vec2; cost: number }[] {
    const nav = this.nav(), { walk, taken } = walkAndTaken(nav, a, this.people(), (o) => o.team() === a.team());
    const out: { p: Vec2; cost: number }[] = [];
    const { cells, costs } = nav.reachCells(a, budget, walk);
    for (let k = 0; k < cells.length; k++) {
      const i = cells[k]!;
      if (!taken(i)) out.push({ p: nav.center(i % nav.cols, Math.floor(i / nav.cols)), cost: costs[k]! });
    }
    return out;
  }

  /** Why `a` cannot walk to `to`, in a few words a player can act on. */
  private unreachable(a: Actor, to: Vec2): string {
    if (this.occupant(to, a)) return 'Someone is standing there.';
    // Through everyone, as if the place were empty: is there a way at all?
    const open = this.nav().path(a, to, { maxNodes: 12000 });
    return open?.length ? 'The way there is blocked by others.' : 'There is no way there.';
  }

  /**
   * Why `a` cannot get within reach of a target this turn: how far the nearest place in reach is beyond the movement
   * left (keeping what the skill costs), or that every way to it is blocked.
   */
  private outOfReach(a: Actor, budget: number, inRange: (p: Vec2) => boolean, cost: number): string {
    const ap = this.host.r.terminology.actionPoints;
    const near = this.reach(a, Math.max(budget, 0) + 40).filter((s) => inRange(s.p)).sort((p, q) => p.cost - q.cost)[0];
    if (!near) return 'Out of reach: every way to it is blocked.';
    if (near.cost <= budget) return 'Out of reach: the way there is blocked by others.';
    const m = (v: number) => `${Math.round(v * 10) / 10} tile${Math.round(v * 10) === 10 ? '' : 's'}`;
    return `Out of reach this turn: the nearest place in reach is ${m(near.cost)} away, ${m(Math.max(0, budget))} of movement is left${cost ? ` keeping ${cost} ${ap} for it` : ''}.`;
  }

  // ------------------------------------------------------------------ actions

  /** Move the active actor; returns an error, or the animation duration in ms. */
  move(a: Actor, to: Vec2): { error?: string; ms: number } {
    if (!this.isActing(a)) return { error: 'Not your turn.', ms: 0 };
    if (a.stats().rooted) return { error: 'You are rooted in place.', ms: 0 };
    const full = this.pathFor(a, to);
    if (!full || !full.length) return { error: this.unreachable(a, to), ms: 0 };
    // As far as the budget goes, stopping exactly there (or just short, where nobody stands).
    const extra = this.extraFor(a);
    const path = cutPath(a, full, moveBudget(a), extra, (p) => this.standable(a, p));
    if (!path.length) return { error: `Not enough ${this.host.r.terminology.actionPoints} to move.`, ms: 0 };
    payMove(a, Math.min(walkCost(a, path, extra), moveBudget(a)));
    const from = { x: a.x, y: a.y };
    const last = path[path.length - 1]!;
    a.motion = { path, from, speed: WALK_SPEED, t0: this.host.now() };
    a.facing = Math.atan2(last.y - from.y, last.x - from.x);
    a.x = last.x;
    a.y = last.y;
    a.dirty = true;
    this.host.actorMoved(a);
    this.host.broadcastCombat(this);
    const ms = (Nav.length(from, path) / WALK_SPEED) * 1000 + 80;
    this.host.after(this.delay(ms), () => {
      if (a.motion?.t0 !== undefined && a.motion.path === path) a.motion = null;
    });
    this.checkEnd();
    return { ms };
  }

  useSkill(a: Actor, skillId: string, target?: Actor, point?: Vec2): string | null {
    if (!this.isActing(a)) return 'Not your turn.';
    const skill = rx(this.host.r).skill.get(skillId);
    if (!skill) return 'Unknown skill.';
    if (!a.skillIds().includes(skillId)) return 'You do not know that.';
    const use = { user: a, skill, target, point };
    const err = checkSkill(this.host, use, { inCombat: true });
    if (err) return err;
    executeSkill(this.host, use, true);
    this.host.broadcastCombat(this);
    this.checkEnd();
    return null;
  }

  /**
   * Use a skill aimed beyond reach (at someone, or at a point on the ground): walk to the cheapest reachable spot from
   * which it reaches, with line of sight for a ranged skill, that leaves enough to act; then act.
   */
  approachAndUse(a: Actor, skillId: string, target?: Actor, point?: Vec2): string | null {
    if (!this.isActing(a)) return 'Not your turn.';
    const skill = rx(this.host.r).skill.get(skillId);
    if (!skill || !a.skillIds().includes(skillId)) return 'Unknown skill.';
    const at = point ?? target;
    if (!at) return 'Choose a target.';
    const stats = a.stats();
    if (stats.rooted) return 'Out of range.';
    const cost = skillAp(skill, stats);
    const budget = moveBudget(a, cost);
    if (budget < 0) return `Not enough ${this.host.r.terminology.actionPoints}.`;
    const range = skillRange(skill, stats);
    const nav = this.nav();
    const inRange = (p: Vec2) => Math.hypot(p.x - at.x, p.y - at.y) <= range - 0.05 && (range <= 2 || nav.sees(p, at));
    const spots = this.reach(a, budget).filter((s) => inRange(s.p)).sort((p, q) => p.cost - q.cost);
    let best: { p: Vec2; cost: number } | null = null;
    for (const { p } of spots.slice(0, 8)) {
      const path = this.pathFor(a, p);
      if (!path?.length) continue;
      const c = this.pathCost(a, path);
      if (c <= budget + 1e-6 && (!best || c < best.cost)) best = { p, cost: c };
    }
    if (!best) return this.outOfReach(a, budget, inRange, cost);
    const moved = this.move(a, best.p);
    if (moved.error) return moved.error;
    this.host.after(this.delay(moved.ms + 80), () => {
      if (this.isActing(a) && a.alive() && (!target || target.alive() || target.downed())) this.useSkill(a, skillId, target, point);
    });
    return null;
  }

  useItem(a: Actor, item: ItemInstance, target?: Actor, point?: Vec2, consume?: () => void): string | null {
    if (!this.isActing(a)) return 'Not your turn.';
    const err = checkItemUse(this.host, a, item, true, target, point);
    if (err) return err;
    useConsumable(this.host, a, item, true, target, point);
    consume?.();
    this.host.broadcastCombat(this);
    this.checkEnd();
    return null;
  }

  endTurn(a: Actor): string | null {
    if (!this.isActing(a)) return 'Not your turn.';
    this.done(a);
    return null;
  }
}
