/**
 * How a fight is going and where it ends, for the combat AI (and through it the balance simulation).
 *
 * A board is a snapshot of the fight from one fighter's side: each fighter's effective Health, how much damage per
 * round it deals to each foe, how much it heals, where it stands, and how far it reaches in a round. `project` plays
 * the rest of the fight out in continuous time: every fighter attacks the foe it gains most from killing first (its
 * damage per round over the time it takes to kill, walking included), healers heal whoever is under the most fire,
 * statuses change rates for as long as they last. The value of a board is the share of Health its side keeps at the
 * end minus the share the foes keep, so an action is worth exactly what it changes about the ending: a kill removes
 * a foe's damage for the rest of the fight, a blow past what a foe has left is worth nothing, a buff is worth what it
 * adds over the fight, a heal what it saves.
 */
import {
  blockedBy, chanceAt, cleanseCount, expectedDamage, flatDamage, statusPower, healOf, lifestealAt, reviveAt, isHarmful, potency, rx, skillAp, statusDot, worstFirst,
  type ActiveStatus, type Effect, type Ruleset, type SkillDef, type StatBlock, type Vec2,
} from '@daydream/shared';
import type { Actor } from './actors.ts';
import { canReviveWith, isHostileTo, relation } from './effects.ts';

/** Rounds the projection looks ahead; a fight not over by then is judged on the Health each side has left. */
const HORIZON = 12;
/** Rounds a fight is first taken to have left, to make the rates for the projection that tells how many it has. */
const FIRST_GUESS = 5;
/** A melee fighter's reach (m): within it a foe can be hit without walking. */
const MELEE = 2.5;

const dist = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);

/** A change for a while: `mult` on what a fighter deals or takes, until `until` rounds from now. */
interface Mod { mult: number; until: number }

interface Unit {
  actor: Actor;
  /** 0: the deciding fighter's side; 1: its foes. */
  side: 0 | 1;
  hp: number;
  maxHp: number;
  /** A downed hero: out of the fight unless revived. */
  down: boolean;
  x: number;
  y: number;
  /** Meters it covers in a round when it does nothing but walk. */
  reach: number;
  range: number;
  apPerTurn: number;
  /** Action points it still has this turn (only the deciding fighter spends them on the board). */
  ap: number;
  apMax: number;
  /** Rounds from now until its next turn: those after the decider this round act sooner than those who have acted. */
  next: number;
  off: Mod[];
  taken: Mod[];
  /** Rounds from now until it can move again (a root holds through that many of its own turns). */
  rootFor: number;
  /** Turns of its own it loses to a stun before it acts again. */
  stunFor: number;
  /** Damage (negative: healing) per round until a time, from statuses already on it or applied now. */
  dots: { per: number; until: number }[];
}

/** What the boards of one decision share: the ruleset, stats, and the expensive per-pair rates. */
interface Shared {
  r: Ruleset;
  stats: StatBlock[];
  skills: SkillDef[][];
  /** rate[i * n + j]: damage per round i deals to j over a fight. */
  rate: Float64Array;
  heal: Float64Array;
  /** Rounds the fight is expected to last from now (a first projection), over which the rates are averaged. */
  rounds: number;
  /** Effect of a status on a fighter: what it does to its damage dealt and taken, keyed `unit|status|strength`. */
  statusCache: Map<string, { off: number; taken: number; root: boolean }>;
  maxHp: [number, number];
  /** Whether one spot sees another (line of sight on the place's ground). */
  sees: (a: Vec2, b: Vec2) => boolean;
  /** sight[i * n + j]: i sees j from where they stood when the board was made. */
  sight: Uint8Array;
  /** Where each stood when the board was made, and far[i * n + j], the distance between two of those spots (NaN until asked). */
  x0: Float64Array;
  y0: Float64Array;
  far: Float64Array;
}

export interface Board {
  s: Shared;
  units: Unit[];
  /** The foes are taken to hold their ground: whoever wants the fight has to go to it (when sides wait). */
  press?: boolean;
}

// ------------------------------------------------------------------------------------ rates

/**
 * How many times a fighter can use a skill in the next `rounds` rounds: a skill without a cooldown every turn, one
 * with a cooldown when it is next ready (now, or once the cooldown running out) and then every cooldown + 1 turns,
 * since it waits out its cooldown's turns between uses.
 */
function usesIn(a: Actor, skill: SkillDef, rounds: number): number {
  if (skill.cooldown <= 0) return rounds;
  const ready = a.cooldowns[skill.id] ?? 0;
  return ready >= rounds ? 0 : 1 + Math.floor((rounds - 1 - ready) / (skill.cooldown + 1));
}

/** Expected damage of one use on a target: its blows and the damage over time it leaves. */
function damagePerUse(r: Ruleset, a: Actor, s: StatBlock, t: StatBlock, skill: SkillDef): number {
  const rank = a.skillRank(skill.id);
  let v = 0;
  for (const e of skill.effects) {
    if (e.kind === 'damage') v += expectedDamage(r, s, t, skill, rank, e);
    else if (e.kind === 'status' && !e.self) {
      const def = rx(r).status.get(e.statusId);
      const pot = potency(skill, rank);
      if (def?.dot) v += flatDamage(t, statusDot(r, e.statusId, statusPower(r, s, e.statusId, pot)), def.dot.typeId) * e.turns * chanceAt(e, skill, rank) * (1 - t.dodge);
    }
  }
  return v;
}

/**
 * Damage per round over the `rounds` the fight has left: the best repeatable attack, plus what each use of a skill on
 * a cooldown adds over the attack its action points would otherwise have made, for as many uses as fit.
 */
function offense(r: Ruleset, a: Actor, s: StatBlock, skills: SkillDef[], t: StatBlock, rounds: number): number {
  let base = 0;
  const bursts: { skill: SkillDef; per: number; ap: number }[] = [];
  for (const skill of skills) {
    if (blockedBy(s, skill) || !skill.effects.some((e) => e.kind === 'damage')) continue;
    const per = damagePerUse(r, a, s, t, skill);
    const ap = Math.max(1, skillAp(skill, s));
    if (skill.cooldown <= 0) base = Math.max(base, per / ap);
    else bursts.push({ skill, per, ap });
  }
  let rate = s.apPerTurn * base;
  for (const b of bursts) rate += (Math.max(0, b.per - b.ap * base) * usesIn(a, b.skill, rounds)) / rounds;
  return rate;
}

/** Health per round a fighter gives its side over the `rounds` the fight has left. */
function healing(r: Ruleset, a: Actor, s: StatBlock, skills: SkillDef[], rounds: number): number {
  let best = 0;
  for (const skill of skills) {
    if (blockedBy(s, skill) || isHarmful(r, skill.effects)) continue;
    const rank = a.skillRank(skill.id);
    const pot = potency(skill, rank);
    let amt = 0;
    for (const e of skill.effects) {
      if (e.kind === 'heal') amt += healOf(s, e, s.maxHp, pot);
      else if (e.kind === 'status') {
        const def = rx(r).status.get(e.statusId);
        if (def?.hot) amt += def.hot.coef * statusPower(r, s, e.statusId, pot) * e.turns * chanceAt(e, skill, rank);
      }
    }
    if (amt <= 0) continue;
    const per = amt * (skill.radius ? 1.5 : 1);
    const perTurn = skill.cooldown <= 0 ? s.apPerTurn / Math.max(1, skillAp(skill, s)) : Math.min(s.apPerTurn / Math.max(1, skillAp(skill, s)), usesIn(a, skill, rounds) / rounds);
    best = Math.max(best, per * perTurn);
  }
  return best;
}

function combatSkills(r: Ruleset, a: Actor): SkillDef[] {
  const ix = rx(r);
  return a.skillIds().map((id) => ix.skill.get(id)!).filter(Boolean);
}

// ------------------------------------------------------------------------------------ the board

/** The fight as `me` sees it: its allies (side 0) and its foes (side 1); bystanders are left out. */
export function buildBoard(r: Ruleset, fighters: Actor[], me: Actor, sees: (a: Vec2, b: Vec2) => boolean = () => true, turnIn: (a: Actor) => number = (a) => (a === me ? 1 : 0.5)): Board {
  const units: Unit[] = [];
  for (const a of fighters) {
    const ally = relation(me, a) === 'ally';
    if (!ally && !isHostileTo(me, a)) continue;
    if (!a.alive() && !(ally && a.downed())) continue;
    const s = a.stats();
    const dotsOn = a.statuses.flatMap((st) => {
      const def = rx(r).status.get(st.id);
      if (def?.dot) return [{ per: flatDamage(s, statusDot(r, st.id, st.power), def.dot.typeId), until: st.turns }];
      if (def?.hot) return [{ per: -def.hot.coef * st.power, until: st.turns }];
      return [];
    });
    units.push({
      actor: a, side: ally ? 0 : 1, hp: a.alive() ? a.hp : 0, maxHp: s.maxHp, down: !a.alive(),
      x: a.x, y: a.y, reach: s.rooted ? 0 : s.move * s.apPerTurn, range: s.weapon.range, apPerTurn: s.apPerTurn, ap: a.ap, apMax: s.apMax, next: turnIn(a),
      off: [], taken: [], rootFor: 0, dots: dotsOn,
      stunFor: Math.max(0, ...a.statuses.map((st) => (rx(r).status.get(st.id)?.control === 'stun' ? st.turns : 0))),
    });
  }
  const n = units.length;
  const stats = units.map((u) => u.actor.stats());
  const skills = units.map((u) => combatSkills(r, u.actor));
  const rate = new Float64Array(n * n);
  const heal = new Float64Array(n);
  const fill = (rounds: number) => {
    for (let i = 0; i < n; i++) {
      heal[i] = healing(r, units[i]!.actor, stats[i]!, skills[i]!, rounds);
      for (let j = 0; j < n; j++) if (units[i]!.side !== units[j]!.side) rate[i * n + j] = offense(r, units[i]!.actor, stats[i]!, skills[i]!, stats[j]!, rounds);
    }
  };
  const maxHp: [number, number] = [0, 0];
  for (const u of units) maxHp[u.side] += u.maxHp;
  const sight = new Uint8Array(n * n);
  for (let i = 0; i < n; i++) for (let j = i + 1; j < n; j++) if (units[i]!.side !== units[j]!.side) sight[i * n + j] = sight[j * n + i] = sees(units[i]!, units[j]!) ? 1 : 0;
  const x0 = Float64Array.from(units, (u) => u.x), y0 = Float64Array.from(units, (u) => u.y), far = new Float64Array(n * n).fill(NaN);
  const b: Board = { s: { r, stats, skills, rate, heal, rounds: FIRST_GUESS, statusCache: new Map(), maxHp, sees, sight, x0, y0, far }, units };
  // How long the fight has left decides how many times a skill on a cooldown comes round: a first projection with a
  // usual fight's length tells, and the rates are made again for that.
  fill(FIRST_GUESS);
  const out = { walk: 0, end: 0 };
  project(b, -1, out);
  b.s.rounds = Math.max(1, Math.min(HORIZON, Math.round(out.end)));
  if (b.s.rounds !== FIRST_GUESS) fill(b.s.rounds);
  return b;
}

function cloneBoard(b: Board): Board {
  return { s: b.s, press: b.press, units: b.units.map((u) => ({ ...u, off: u.off.slice(), taken: u.taken.slice(), dots: u.dots.slice() })) };
}

export const indexOf = (b: Board, a: Actor) => b.units.findIndex((u) => u.actor === a);

const up = (u: Unit) => !u.down && u.hp > 0;

// ------------------------------------------------------------------------------------ actions on the board

/**
 * What a status does to a fighter's damage dealt and taken (ratios), measured with the real stat rules: the fighter
 * with the status against the fighter without it. One of the two is the fighter as it stands (with it, when the status
 * is already on, as for a cleanse that would take it off), and the other is worked out.
 */
function statusEffect(b: Board, i: number, statusId: string, power: number, strength: number): { off: number; taken: number; root: boolean } {
  const key = `${i}|${statusId}|${strength.toFixed(3)}`;
  const hit = b.s.statusCache.get(key);
  if (hit) return hit;
  const { r, stats, skills, rate } = b.s;
  const u = b.units[i]!;
  const n = b.units.length;
  const rest = u.actor.statuses.filter((x) => x.id !== statusId);
  const on = rest.length < u.actor.statuses.length;
  const s2 = u.actor.statsWith(on ? rest : [...rest, { id: statusId, turns: 1, power, strength } as ActiveStatus]);
  // (0: as it stands; 1: the other.)
  let off0 = 0, off1 = 0, in0 = 0, in1 = 0;
  for (let j = 0; j < n; j++) {
    if (b.units[j]!.side === u.side) continue;
    off0 += rate[i * n + j]!;
    off1 += offense(r, u.actor, s2, skills[i]!, stats[j]!, b.s.rounds);
    in0 += rate[j * n + i]!;
    in1 += offense(r, b.units[j]!.actor, stats[j]!, skills[j]!, s2, b.s.rounds);
  }
  // Healers are measured by their healing when they deal little damage.
  if (off0 <= 0 && b.s.heal[i]! > 0) {
    off0 = b.s.heal[i]!;
    off1 = healing(r, u.actor, s2, skills[i]!, b.s.rounds);
  }
  const [offWith, offWithout, inWith, inWithout] = on ? [off0, off1, in0, in1] : [off1, off0, in1, in0];
  const [sWith, sWithout] = on ? [stats[i]!, s2] : [s2, stats[i]!];
  const res = { off: offWithout > 0 ? offWith / offWithout : 1, taken: inWithout > 0 ? inWith / inWithout : 1, root: sWith.rooted && !sWithout.rooted };
  b.s.statusCache.set(key, res);
  return res;
}

function damage(u: Unit, amount: number) {
  u.hp = Math.max(0, u.hp - amount);
}

function healUnit(u: Unit, amount: number, revive: boolean) {
  if (u.down) {
    if (!revive) return;
    u.down = false;
    u.hp = 0;
  }
  u.hp = Math.min(u.maxHp, Math.max(1, u.hp + amount));
}

/** Multiplier on what the deciding fighter deals right now (its own buffs from earlier in the turn). */
const nowMult = (mods: Mod[]) => mods.reduce((m, x) => (x.until > 0 ? m * x.mult : m), 1);

export interface Use {
  /** The fighter acting (index on the board). */
  by: number;
  skill: SkillDef;
  target?: number;
  point?: Vec2;
  /** Where it stands when it acts. */
  from: Vec2;
}

/** The expected result of a skill on the board: the board after it, the user's action points spent. */
export function applyUse(b0: Board, use: Use): Board {
  const b = cloneBoard(b0);
  const { r } = b.s;
  const me = b.units[use.by]!;
  const s = b.s.stats[use.by]!;
  const skill = use.skill;
  const rank = me.actor.skillRank(skill.id);
  const pot = potency(skill, rank);
  me.x = use.from.x;
  me.y = use.from.y;
  me.ap -= skillAp(skill, s);
  const harmful = isHarmful(r, skill.effects);
  const revive = canReviveWith(r, skill.effects);
  const center = skill.targeting === 'self' ? use.from : use.point ?? (use.target !== undefined ? b.units[use.target]! : use.from);
  let targets: number[];
  if (skill.radius) targets = b.units.map((_, k) => k).filter((k) => {
    const t = b.units[k]!;
    return dist(t, center) <= skill.radius! + 0.01 && (harmful ? t.side !== me.side : t.side === me.side) && (up(t) || (revive && t.down));
  });
  else targets = use.target !== undefined ? [use.target] : skill.targeting === 'self' ? [use.by] : [];
  // A dash lands beside its target.
  if (skill.effects.some((e) => e.kind === 'dash') && use.target !== undefined) {
    const t = b.units[use.target]!;
    const d = dist(me, t) || 1;
    me.x = t.x + ((me.x - t.x) / d) * 1.1;
    me.y = t.y + ((me.y - t.y) / d) * 1.1;
  }
  const mult = nowMult(me.off);
  let dealt = 0;
  for (const k of targets) {
    const t = b.units[k]!;
    const ts = b.s.stats[k]!;
    for (const e of skill.effects) if (!(e.kind === 'status' && e.self)) applyEffect(b, me, use.by, s, skill, rank, pot, e, k, t, ts, mult, revive, (x) => (dealt += x));
  }
  // What the user gains is theirs once, whoever the skill caught.
  for (const e of skill.effects) {
    if (e.kind === 'status' && e.self) applyEffect(b, me, use.by, s, skill, rank, pot, e, use.by, me, s, mult, revive, () => {});
    if (e.kind === 'lifesteal' && dealt > 0) healUnit(me, dealt * lifestealAt(e, pot), false);
  }
  if (s.lifesteal > 0 && dealt > 0) healUnit(me, dealt * s.lifesteal, false);
  return b;
}

function applyEffect(b: Board, me: Unit, by: number, s: StatBlock, skill: SkillDef, rank: number, pot: number, e: Effect, k: number, t: Unit, ts: StatBlock, mult: number, revive: boolean, dealt: (x: number) => void) {
  const { r } = b.s;
  switch (e.kind) {
    case 'damage': {
      if (!up(t)) return;
      const v = expectedDamage(r, s, ts, skill, rank, e) * mult;
      const before = t.hp;
      damage(t, v);
      dealt(Math.min(before, v));
      return;
    }
    case 'heal':
      healUnit(t, healOf(s, e, t.maxHp, pot), revive);
      return;
    case 'revive':
      if (t.down && r.revive !== 'after_combat') {
        t.down = false;
        t.hp = Math.max(1, t.maxHp * reviveAt(e, pot));
      }
      return;
    case 'cleanse': {
      const harmfulOn = worstFirst(r, t.actor.statuses).slice(0, cleanseCount(skill, rank));
      for (const st of harmfulOn) {
        const fx = statusEffect(b, k, st.id, st.power, st.strength ?? 1);
        if (fx.off > 0) t.off.push({ mult: 1 / fx.off, until: t.next + st.turns });
        if (fx.taken > 0) t.taken.push({ mult: 1 / fx.taken, until: t.next + st.turns });
        if (fx.root) t.rootFor = 0;
        if (rx(r).status.get(st.id)?.control === 'stun') t.stunFor = 0;
        // Its damage over time goes with it.
        if (rx(r).status.get(st.id)?.dot) {
          const at = t.dots.findIndex((d) => d.per > 0 && d.until === st.turns);
          if (at >= 0) t.dots = t.dots.filter((_, i) => i !== at);
        }
      }
      return;
    }
    case 'status': {
      const who = e.self ? me : t;
      const wi = e.self ? by : k;
      const id = e.statusId;
      const def = rx(r).status.get(id);
      if (!def || !up(who)) return;
      if (def.control && (who.actor.controlImmune > 0 || !r.control.enabled)) return;
      // A status already on refreshes its length only.
      const existing = who.actor.statuses.find((x) => x.id === id);
      const turns = Math.max(0, e.turns - (existing?.turns ?? 0));
      if (turns <= 0) return;
      const power = statusPower(r, s, id, pot);
      // A blow that is dodged puts nothing on its target.
      const chance = chanceAt(e, skill, rank) * (e.self || !skill.effects.some((x) => x.kind === 'damage') ? 1 : 1 - b.s.stats[wi]!.dodge);
      if (def.dot) who.dots.push({ per: flatDamage(b.s.stats[wi]!, statusDot(r, id, power), def.dot.typeId) * chance, until: turns });
      if (def.hot) who.dots.push({ per: -def.hot.coef * power * chance, until: turns });
      // (One already on only lasts longer: its stat changes are in the rates as they stand.)
      if (!existing && (def.modifiers?.length || def.control)) {
        const fx = statusEffect(b, wi, id, power, pot);
        // It lasts through that many of its bearer's own turns: until the end of the last of them.
        const until = who.next + turns;
        if (fx.off !== 1) who.off.push({ mult: 1 + (fx.off - 1) * chance, until });
        if (fx.taken !== 1) who.taken.push({ mult: 1 + (fx.taken - 1) * chance, until });
        if (fx.root) who.rootFor = Math.max(who.rootFor, until * chance);
        if (def.control === 'stun') who.stunFor = Math.max(who.stunFor, turns * chance);
      }
      return;
    }
    default:
      return;
  }
}

/** A potion or other healing drunk by the deciding fighter. */
export function applyHeal(b0: Board, by: number, amount: number, ap: number): Board {
  const b = cloneBoard(b0);
  const me = b.units[by]!;
  healUnit(me, amount, false);
  me.ap -= ap;
  return b;
}

/** The deciding fighter walks to a spot, paying `ap` for it. */
export function applyMove(b0: Board, by: number, to: Vec2, ap: number): Board {
  const b = cloneBoard(b0);
  const me = b.units[by]!;
  me.x = to.x;
  me.y = to.y;
  me.ap -= ap;
  return b;
}

// ------------------------------------------------------------------------------------ the projection

/** The projection's working arrays, kept between projections (each is reset for the fighters on the board). */
const makeScratch = (size: number) => ({
  size,
  ehp: new Float64Array(size), alive: new Uint8Array(size), px: new Float64Array(size), py: new Float64Array(size), at: new Int16Array(size),
  tgt: new Int16Array(size), engage: new Float64Array(size), threat: new Float64Array(size), mine: new Int8Array(size),
  incoming: new Float64Array(size), side: new Uint8Array(size), top: new Float64Array(size), turn0: new Float64Array(size),
});
let scratch = makeScratch(16);

const product = (mods: Mod[], t: number) => {
  let m = 1;
  for (const x of mods) if (x.until > t) m *= x.mult;
  return m;
};

/**
 * Play the rest of the fight out and return how it ends for side 0: the share of its Health it keeps minus the
 * share the foes keep (from -1 to 1). `by`, the deciding fighter, keeps the action points it has not spent for its
 * next turn, as far as they carry over.
 */
export function project(b: Board, by = -1, out?: { walk: number; end?: number; log?: string[] }): number {
  const { rate, heal } = b.s;
  const units = b.units;
  const n = units.length;
  if (n > scratch.size) scratch = makeScratch(n);
  const { ehp, alive, px, py, at, tgt, engage, threat, mine, incoming, side, top, turn0 } = scratch;
  const { x0, y0, far } = b.s;
  let left0 = 0, left1 = 0;
  for (let i = 0; i < n; i++) {
    const u = units[i]!;
    alive[i] = 0;
    ehp[i] = 0;
    tgt[i] = -1;
    engage[i] = 0;
    mine[i] = -1;
    side[i] = u.side;
    top[i] = u.maxHp;
    // (A stunned fighter's first turn is the one after those it loses.)
    turn0[i] = u.next + u.stunFor;
    if (up(u)) {
      alive[i] = 1;
      ehp[i] = u.hp;
      if (u.side === 0) left0++;
      else left1++;
    }
    px[i] = u.x;
    py[i] = u.y;
    // Standing where the board was made, its distances to others standing so are worked out once for all boards.
    at[i] = u.x === x0[i] && u.y === y0[i] ? i : -1;
  }
  const gap0 = (i: number, j: number) => {
    const p = at[i]!, q = at[j]!;
    if (p < 0 || q < 0) return Math.hypot(px[i]! - px[j]!, py[i]! - py[j]!);
    const k = p * n + q;
    if (Number.isNaN(far[k]!)) far[k] = far[q * n + p] = Math.hypot(x0[p]! - x0[q]!, y0[p]! - y0[q]!);
    return far[k]!;
  };
  // Threat of a fighter to the other side: its damage per round on an average foe, and its healing.
  for (let i = 0; i < n; i++) {
    let sum = 0, cnt = 0;
    for (let j = 0; j < n; j++) if (side[j] !== side[i] && alive[j]) {
      sum += rate[i * n + j]!;
      cnt++;
    }
    threat[i] = (cnt ? sum / cnt : 0) + heal[i]!;
  }
  // The deciding fighter may stand somewhere new: what it sees from there.
  const moved = by >= 0 && (units[by]!.x !== units[by]!.actor.x || units[by]!.y !== units[by]!.actor.y);
  const seen = (i: number, j: number) => {
    if (!moved || (i !== by && j !== by)) return b.s.sight[i * n + j] === 1;
    const k = i === by ? j : i;
    if (mine[k]! < 0) mine[k] = b.s.sees(units[by]!, units[k]!) ? 1 : 0;
    return mine[k] === 1;
  };
  const choose = (i: number, t: number) => {
    const u = units[i]!;
    // A melee fighter that reached its last foe fights on from where that foe stood.
    const prev = tgt[i]!;
    if (prev >= 0 && u.range <= MELEE && engage[i]! <= t) {
      px[i] = px[prev]!;
      py[i] = py[prev]!;
      at[i] = at[prev]!;
    }
    let best = -1, bp = 0, bd = 0;
    const x = px[i]!, y = py[i]!, range = Math.max(u.range, 1.6);
    // Out of sight, a fighter at range has to step around what is in the way first.
    const around = u.range > MELEE && x === u.x && y === u.y;
    const reach = b.press && u.side === 1 ? 0 : u.reach;
    for (let j = 0; j < n; j++) {
      if (!alive[j] || side[j] === side[i]) continue;
      const r = rate[i * n + j]!;
      if (r <= 0) continue;
      let gap = Math.max(0, gap0(i, j) - range);
      if (around && !seen(i, j)) gap = Math.max(gap, 2);
      const walk = gap <= 0 ? 0 : reach > 0 ? gap / reach + Math.max(0, u.rootFor - t) : Infinity;
      if (walk === Infinity) continue;
      // Smith's rule: the most damage removed per round spent killing (walking included) first.
      const p = (threat[j]! * r) / (ehp[j]! + r * walk);
      if (p > bp) {
        bp = p;
        best = j;
        bd = walk;
      }
    }
    tgt[i] = best;
    engage[i] = Math.max(t, turn0[i]!) + bd;
  };
  for (let i = 0; i < n; i++) if (alive[i]) choose(i, 0);
  // Everyone fights from their next turn on. The deciding fighter's blows this round are what it does now (already on
  // the board); the action points it saves are more blows in its next turn.
  let bankMult = 1;
  if (by >= 0) {
    const me = units[by]!;
    bankMult = 1 + Math.max(0, Math.min(me.ap, me.apMax - me.apPerTurn)) / Math.max(1, me.apPerTurn);
  }
  // Rounds fighters spend, from their next turn on, walking to a foe (or unable to reach one) instead of striking.
  let walk = 0, walkers = 0;
  let t = 0;
  for (let guard = 0; guard < 6 * n + 20 && t < HORIZON && left0 > 0 && left1 > 0; guard++) {
    for (let i = 0; i < n; i++) incoming[i] = 0;
    walkers = 0;
    let next = HORIZON;
    for (let i = 0; i < n; i++) {
      if (!alive[i]) continue;
      const u = units[i]!;
      for (const d of u.dots) if (d.until > t) {
        incoming[i] += d.per;
        next = Math.min(next, d.until);
      }
      for (const m of u.off) if (m.until > t) next = Math.min(next, m.until);
      for (const m of u.taken) if (m.until > t) next = Math.min(next, m.until);
      if (i === by && t < 2) next = Math.min(next, units[i]!.next + 1);
      const j = tgt[i]!;
      if (j < 0 || engage[i]! > t) {
        if (t >= turn0[i]!) walkers++;
        if (j >= 0) next = Math.min(next, engage[i]!);
        continue;
      }
      const turn = i === by && t < units[i]!.next + 1 ? bankMult : 1;
      incoming[j] += rate[i * n + j]! * product(u.off, t) * product(units[j]!.taken, t) * turn;
    }
    // Each side's healers heal whoever is under the most fire.
    for (let s = 0; s < 2; s++) {
      let h = 0, worst = -1;
      for (let i = 0; i < n; i++) {
        if (!alive[i] || side[i] !== s) continue;
        // Before its next turn a healer adds nothing (its share would be zero).
        if (heal[i]! !== 0 && t >= turn0[i]!) h += heal[i]! * product(units[i]!.off, t);
        if (worst < 0 || incoming[i]! > incoming[worst]!) worst = i;
      }
      if (h > 0 && worst >= 0) incoming[worst] = incoming[worst]! - Math.min(h, Math.max(0, incoming[worst]!));
    }
    for (let j = 0; j < n; j++) if (alive[j] && incoming[j]! > 1e-9) next = Math.min(next, t + ehp[j]! / incoming[j]!);
    const dt = Math.max(1e-6, next - t);
    walk += walkers * dt;
    for (let j = 0; j < n; j++) {
      if (!alive[j]) continue;
      ehp[j] = Math.min(top[j]!, ehp[j]! - incoming[j]! * dt);
    }
    if (out?.log) out.log.push(`t=${t.toFixed(2)}..${next.toFixed(2)} ` + units.map((u, i) => `${u.actor.name}${alive[i] ? `:${Math.round(ehp[i]!)}-${Math.round(incoming[i]!)}/r>${tgt[i]}@${engage[i]!.toFixed(1)}` : 'x'}`).join(' '));
    t = next;
    let died = false;
    for (let j = 0; j < n; j++) if (alive[j] && ehp[j]! <= 1e-6) {
      alive[j] = 0;
      ehp[j] = 0;
      died = true;
      if (side[j] === 0) left0--;
      else left1--;
    }
    if (died) for (let i = 0; i < n; i++) if (alive[i] && (tgt[i]! < 0 || !alive[tgt[i]!])) choose(i, t);
  }
  if (out) {
    out.walk = walk;
    out.end = left0 > 0 && left1 > 0 ? HORIZON : t;
  }
  let keep0 = 0, keep1 = 0;
  for (let i = 0; i < n; i++) if (alive[i]) {
    const kept = Math.min(units[i]!.maxHp, ehp[i]!);
    if (units[i]!.side === 0) keep0 += kept;
    else keep1 += kept;
  }
  return keep0 / Math.max(1, b.s.maxHp[0]) - keep1 / Math.max(1, b.s.maxHp[1]);
}
