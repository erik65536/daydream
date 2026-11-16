/**
 * The combat AI for creatures, heroes played by the AI, and the balance simulation's parties.
 *
 * A fighter weighs the sequences of things it could do this turn (walk somewhere, use skills, drink a potion) by how
 * each would change the way the fight ends (tactics.ts), and does the first step of the best one. After every step it
 * looks again, so a dodge, a crit, or a kill changes the rest of its turn. Creatures play below their best on gentler
 * difficulties, in the way of their kind (see `temperament`), so how they fight stays readable.
 *
 * Synchronous: each `aiStep` performs one action and returns its animation time, or -1 when the turn is over.
 */
import {
  NAV_CELL, blockedBy, consumableStats, isHarmful, healOf, rx, skillAp, skillRange,
  type DifficultyId, type FighterKind, type Ruleset, type SkillDef, type Vec2,
} from '@daydream/shared';
import { Actor, MonsterActor, holdStats } from './actors.ts';
import { canReviveWith, checkItemUse } from './effects.ts';
import { applyHeal, applyMove, applyUse, buildBoard, indexOf, project, type Board } from './tactics.ts';
import type { Combat } from './combat.ts';

export interface AiMemory {
  turnKey: string;
  banned: Set<string>;
  moves: number;
}

/** One step of a turn. A move is made toward something the fighter means to do from there. */
export type AiAction =
  | { kind: 'skill'; skillId: string; targetId?: string; point?: Vec2 }
  | { kind: 'move'; to: Vec2 }
  | { kind: 'potion' }
  | { kind: 'end' };

/** Chooses a fighter's next step. The game and the balance simulation use `decide`; experiments plug in others. */
export type Policy = (c: Combat, a: Actor) => AiAction;

const d = (a: Vec2, b: Vec2) => Math.hypot(a.x - b.x, a.y - b.y);
const keyOf = (act: AiAction) => (act.kind === 'skill' ? `${act.skillId}:${act.targetId ?? `${act.point?.x},${act.point?.y}`}` : act.kind === 'move' ? `move:${act.to.x.toFixed(2)},${act.to.y.toFixed(2)}` : act.kind);

/** Steps searched beyond the first, and how many lines are followed at each. */
const DEPTH = 2;
const BEAM = 3;
/** Moves a fighter may make in one turn. */
const MAX_MOVES = 3;

/**
 * What a round of walking costs, as a share of a fight's Health, whoever does the walking. Stepping back is often the
 * best play: it pulls a creature onto a sturdier ally, or makes a crowd spend its turn closing in again. Valued by
 * the ending alone it was taken for the smallest gain, and fights became chases. Counting every fighter's walking
 * keeps the step back for when it is worth a good share of a fight, and two careful sides do not wait for each other.
 */
const WALK_COST = 0.06;

/** How good a board is for the deciding fighter: how the fight ends, less the walking it takes to get there. */
function judge(b: Board, me: number): number {
  const out = { walk: 0 };
  return project(b, me, out) - WALK_COST * out.walk;
}

interface Line {
  first: AiAction;
  board: Board;
  /** Skills with a cooldown already used in this line. */
  used: Set<string>;
  value: number;
}

function memory(c: Combat, a: Actor): AiMemory {
  const key = `${c.round}:${c.idx}`;
  let mem = c.ai.get(a.id);
  if (!mem || mem.turnKey !== key) c.ai.set(a.id, (mem = { turnKey: key, banned: new Set(), moves: 0 }));
  return mem;
}

/** Rounds until each fighter's next turn, seen from `me` acting now: later in this round, or in the next. */
function turnsUntil(c: Combat, me: Actor): (a: Actor) => number {
  const n = Math.max(1, c.order.length);
  const at = c.order.indexOf(me);
  return (a) => {
    if (a === me) return 1;
    const k = c.order.indexOf(a);
    if (k < 0 || at < 0) return 1;
    // Those sharing this turn and still to act are as quick as the decider's next blow.
    if (c.isActing(a)) return 0.05;
    return k > at ? (k - at) / n : 1 + (k - at) / n;
  };
}

const potionsOf = (c: Combat, a: Actor) => c.host.aiPotions?.(a) ?? [];

function canUse(a: Actor, skill: SkillDef, ap: number, used: Set<string>): boolean {
  const stats = a.stats();
  if (used.has(skill.id) || (a.cooldowns[skill.id] ?? 0) > 0) return false;
  return skillAp(skill, stats) <= ap && !blockedBy(stats, skill);
}

/** Skills `me` can use from where it stands on the board: each with its target, and the board after it. */
function usesFrom(c: Combat, b: Board, me: number, used: Set<string>, banned?: Set<string>): { act: AiAction; board: Board; skill: SkillDef }[] {
  const r = c.host.r;
  const ix = rx(r);
  const nav = c.host.zoneMap(c.zoneId).nav;
  const u = b.units[me]!;
  const a = u.actor;
  const stats = a.stats();
  const out: { act: AiAction; board: Board; skill: SkillDef }[] = [];
  const from = { x: u.x, y: u.y };
  for (const id of a.skillIds()) {
    const skill = ix.skill.get(id);
    if (!skill || !canUse(a, skill, u.ap, used)) continue;
    const range = skillRange(skill, stats);
    const harmful = isHarmful(r, skill.effects);
    const revive = canReviveWith(r, skill.effects);
    const reaches = (p: Vec2) => d(from, p) <= range + 0.01 && (range <= 2 || nav.sees(from, p));
    const push = (act: AiAction, target?: number, point?: Vec2) => {
      if (banned?.has(keyOf(act))) return;
      out.push({ act, skill, board: applyUse(b, { by: me, skill, target, point, from }) });
    };
    if (skill.targeting === 'self') {
      push({ kind: 'skill', skillId: id });
      continue;
    }
    const takes = (t: Board['units'][number]) => {
      const live = !t.down && t.hp > 0;
      const helps = t.side === u.side && (live || (revive && t.down));
      return skill.targeting === 'enemy' ? t.side !== u.side && live : skill.targeting === 'ally' ? helps : harmful ? t.side !== u.side && live : helps;
    };
    // An area on the ground is weighed once for each set of those it would catch (two points catching the same are one choice).
    const caught = new Set<string>();
    const aimAt = (p: Vec2) => {
      if (!reaches(p)) return;
      if (skill.radius) {
        const set = b.units.flatMap((t, k) => (takes(t) && d(t, p) <= skill.radius! + 0.01 ? [k] : [])).join();
        if (!set || caught.has(set)) return;
        caught.add(set);
      }
      push({ kind: 'skill', skillId: id, point: { x: p.x, y: p.y } }, undefined, { x: p.x, y: p.y });
    };
    const marks = b.units.map((t, k) => ({ t, k })).filter(({ t }) => takes(t));
    for (const { t, k } of marks) {
      if (skill.targeting === 'ground') aimAt(t);
      else if (reaches(t)) push({ kind: 'skill', skillId: id, targetId: t.actor.id }, k);
    }
    // An area on the ground may also fall between two it should catch, to catch both.
    if (skill.targeting === 'ground' && skill.radius)
      for (const [i, { t }] of marks.entries())
        for (const { t: o } of marks.slice(i + 1)) if (d(t, o) <= skill.radius * 2) aimAt({ x: (t.x + o.x) / 2, y: (t.y + o.y) / 2 });
  }
  return out;
}

/** Places worth walking to this turn: in reach of each foe, out of reach of them, and where an area catches most. */
function spots(c: Combat, a: Actor, b: Board, me: number): { p: Vec2; ap: number }[] {
  const stats = a.stats();
  if (stats.rooted) return [];
  const budget = a.movementLeft + a.ap * stats.move;
  if (budget <= 0.3) return [];
  let reach = c.reach(a, budget);
  if (reach.length > 300) reach = reach.filter(({ p }) => Math.floor(p.x / NAV_CELL) % 2 === 0 && Math.floor(p.y / NAV_CELL) % 2 === 0);
  const apFor = (cost: number) => (cost <= a.movementLeft ? 0 : Math.ceil((cost - a.movementLeft) / Math.max(0.5, stats.move)));
  const nav = c.host.zoneMap(c.zoneId).nav;
  const u = b.units[me]!;
  const foes = b.units.filter((x) => x.side !== u.side && !x.down && x.hp > 0);
  const out: { p: Vec2; ap: number; cost: number }[] = [];
  const add = (s: { p: Vec2; cost: number } | undefined) => {
    if (s && d(s.p, a) > 0.3 && !out.some((o) => d(o.p, s.p) < 0.6)) out.push({ p: s.p, cost: s.cost, ap: apFor(s.cost) });
  };
  // Rounds before the nearest foe could hit a spot: the higher the safer. Each spot's is worked out once, when first asked.
  const safe = new Float64Array(reach.length).fill(NaN);
  const safety = (i: number) => {
    if (Number.isNaN(safe[i]!)) {
      const p = reach[i]!.p;
      let m = Infinity;
      for (const f of foes) m = Math.min(m, (d(p, f) - Math.max(f.range, 1.6)) / Math.max(0.5, f.reach));
      safe[i] = m;
    }
    return safe[i]!;
  };
  /** The first spot that `better` prefers to every one before it. */
  const first = (better: (i: number, than: number) => boolean) => {
    let best = -1;
    for (let i = 0; i < reach.length; i++) if (best < 0 || better(i, best)) best = i;
    return best < 0 ? undefined : reach[best];
  };
  const ranges = [...new Set(a.skillIds().map((id) => rx(c.host.r).skill.get(id)).filter((s): s is SkillDef => !!s).map((s) => skillRange(s, stats)))];
  const longest = Math.max(...ranges);
  // Stepping back (to the safest spot to strike from, or the safest spot of all) is weighed like any other step, with
  // its walking counted (WALK_COST). A creature's kind of fighter is its habit here: brutes and swarms never give
  // ground, and a guardian holds its ground unless badly hurt.
  const kind = a instanceof MonsterActor ? a.fighter : undefined;
  const backOff = kind === 'brute' || kind === 'swarm' ? false : kind === 'guardian' ? a.hp < stats.maxHp * 0.35 : true;
  const safer = (i: number, than: number) => safety(i) > safety(than);
  for (const f of foes) {
    // Each spot's distance to this foe, and whether it sees the foe (worked out once, when first asked).
    const far = new Float64Array(reach.length);
    let nearest = Infinity;
    for (let i = 0; i < reach.length; i++) nearest = Math.min(nearest, (far[i] = d(reach[i]!.p, f)));
    const view = new Uint8Array(reach.length);
    const sees = (i: number) => (view[i] ||= nav.sees(reach[i]!.p, f) ? 1 : 2) === 1;
    for (const range of ranges) {
      // The nearest spot to strike from, and the safest one when backing off makes sense (the first of each, in order).
      const wary = range > 2 && backOff;
      let near = -1, safest = -1;
      for (let i = 0; i < reach.length; i++) {
        if (!(far[i]! <= range - 0.05 && (range <= 2 || sees(i)))) continue;
        if (near < 0 || reach[i]!.cost < reach[near]!.cost) near = i;
        if (wary && (safest < 0 || safer(i, safest))) safest = i;
      }
      if (near < 0) continue;
      add(reach[near]);
      if (wary) add(reach[safest]);
    }
    // Out of reach of everything this turn: the closest it can get.
    if (reach.length && !(nearest <= longest)) add(first((i, than) => far[i]! < far[than]!));
  }
  if (reach.length && backOff) add(first(safer));
  // Where an area around the fighter catches the most.
  for (const id of a.skillIds()) {
    const skill = rx(c.host.r).skill.get(id);
    if (!skill?.radius || skill.targeting !== 'self') continue;
    const harmful = isHarmful(c.host.r, skill.effects);
    const group = b.units.filter((x) => (harmful ? x.side !== u.side : x.side === u.side) && !x.down && x.hp > 0);
    let best: { p: Vec2; cost: number } | undefined, bn = 0;
    for (const s of reach) {
      const k = group.filter((x) => d(x, s.p) <= skill.radius!).length;
      if (k > bn || (k === bn && best && s.cost < best.cost)) {
        bn = k;
        best = s;
      }
    }
    if (bn >= 2) add(best);
  }
  return out.filter((s) => s.ap < a.ap || (s.ap <= a.ap && s.cost <= a.movementLeft + a.ap * stats.move));
}

/** The best value reachable from a line by more skills from where the fighter stands (it can always stop). */
function deepen(c: Combat, line: Line, me: number, depth: number): number {
  let best = line.value;
  if (depth <= 0 || line.board.units[me]!.ap <= 0) return best;
  const next = usesFrom(c, line.board, me, line.used).map((x) => ({ ...x, value: judge(x.board, me) }));
  next.sort((p, q) => q.value - p.value);
  for (const x of next.slice(0, BEAM)) {
    const used = x.skill.cooldown > 0 ? new Set([...line.used, x.skill.id]) : line.used;
    best = Math.max(best, deepen(c, { first: line.first, board: x.board, used, value: x.value }, me, depth - 1));
  }
  return best;
}

// ------------------------------------------------------------------------------------ temperament

/**
 * How creatures fall short of their best, by difficulty: the weight of their kind's habit against the best move.
 * Habits are in the same units as the projection (a share of Health), so 0.15 lets a habit win over a move that is
 * up to 15% of the heroes' Health better. Heroes always play their best.
 */
const HABIT: Record<DifficultyId, number> = { story: 0.3, easy: 0.18, normal: 0.08, hard: 0.03, brutal: 0 };

/**
 * What a creature likes to do, scored 0..1 for a step: its kind of fighter decides whom it goes for (brutes and swarms
 * the nearest, stalkers the weakest, guardians whoever is near their own; a soldier has no habit), and its class how
 * it acts (a healer class helps its own, a ranged class fights from where it stands).
 */
function habit(t: Temper, c: Combat, a: Actor, b: Board, act: AiAction): number {
  const target = act.kind === 'skill' && act.targetId ? b.units.find((u) => u.actor.id === act.targetId) : undefined;
  const foes = b.units.filter((u) => u.side === 1 && !u.down && u.hp > 0);
  if (!foes.length) return 0;
  const near = Math.min(...foes.map((f) => d(f, a)));
  const weakest = Math.min(...foes.map((f) => f.hp / f.maxHp));
  const harmful = act.kind === 'skill' && isHarmful(c.host.r, rx(c.host.r).skill.get(act.skillId)?.effects ?? []);
  if (t.healer && act.kind === 'skill' && !harmful) return 1;
  if (t.ranged && act.kind === 'move') return 0;
  switch (t.fighter) {
    case 'brute':
    case 'swarm':
      // Straight at whoever is closest.
      return target && target.side === 1 ? (d(target, a) <= near + 1 ? 1 : 0) : act.kind === 'move' ? 0.5 : 0;
    case 'stalker':
      // The most wounded, or the one least able to take a blow.
      return target && target.side === 1 ? (target.hp / target.maxHp <= weakest + 0.05 ? 1 : 0.3) : 0;
    case 'guardian':
      // Whoever is closest to its own.
      return target && target.side === 1 ? (b.units.some((u) => u.side === 0 && u.actor !== a && d(u, target) < 3) ? 1 : 0.4) : 0;
    default:
      return t.ranged && act.kind === 'skill' ? 0.6 : 0;
  }
}

interface Temper { fighter: FighterKind; healer: boolean; ranged: boolean; weight: number }

function temperament(r: Ruleset, a: Actor): Temper | null {
  if (!(a instanceof MonsterActor)) return null;
  const cls = rx(r).cls.get(a.classIds[0] ?? '');
  return { fighter: a.fighter, healer: a.classIds.some((id) => rx(r).cls.get(id)?.role === 'healer'), ranged: cls?.reach === 'ranged', weight: HABIT[a.difficulty()] };
}

// ------------------------------------------------------------------------------------ deciding and acting

/** Every first step worth weighing for `a`, best first, with what it leads to; and what ending the turn now is worth. */
export function weigh(c: Combat, a: Actor): { stay: number; options: { act: AiAction; value: number }[]; board?: Board } {
  // Weighing only looks: nobody's stats change until a step is taken.
  return holdStats(() => weighNow(c, a));
}

function weighNow(c: Combat, a: Actor): { stay: number; options: { act: AiAction; value: number }[]; board?: Board } {
  const mem = memory(c, a);
  const r = c.host.r;
  const nav = c.host.zoneMap(c.zoneId).nav;
  const b = buildBoard(r, c.participants(), a, (p, q) => nav.sees(p, q), turnsUntil(c, a));
  b.press = c.quietRounds >= 2;
  const me = indexOf(b, a);
  if (me < 0 || !b.units.some((u) => u.side === 1 && !u.down && u.hp > 0)) return { stay: 0, options: [] };
  const lines: Line[] = [];
  for (const x of usesFrom(c, b, me, new Set(), mem.banned)) lines.push({ first: x.act, board: x.board, used: x.skill.cooldown > 0 ? new Set([x.skill.id]) : new Set(), value: judge(x.board, me) });
  if (mem.moves < MAX_MOVES)
    for (const s of spots(c, a, b, me)) {
      const act: AiAction = { kind: 'move', to: s.p };
      if (mem.banned.has(keyOf(act))) continue;
      const board = applyMove(b, me, s.p, s.ap);
      lines.push({ first: act, board, used: new Set(), value: judge(board, me) });
    }
  // A potion when hurt: worth what it changes, less what it costs to carry one.
  const stats = a.stats();
  const potion = potionsOf(c, a)[0];
  if (potion && a.hp < stats.maxHp * 0.6 && !checkItemUse(c.host, a, potion.item, true)) {
    const base = rx(r).item.get(potion.item.baseId);
    const heal = base?.use?.effects.find((e) => e.kind === 'heal');
    if (heal && heal.kind === 'heal') {
      const amount = Math.min(stats.maxHp - a.hp, healOf(consumableStats(r, a.level), heal, stats.maxHp));
      const board = applyHeal(b, me, amount, base!.use!.ap);
      lines.push({ first: { kind: 'potion' }, board, used: new Set(), value: judge(board, me) - (0.5 * amount) / Math.max(1, b.s.maxHp[0]) });
    }
  }
  lines.sort((p, q) => q.value - p.value);
  // Follow the most promising lines a few steps further; a move is only worth what can be done from where it leads.
  const options = lines.map((l, i) => ({ act: l.first, value: i < BEAM + 2 ? deepen(c, l, me, DEPTH) : l.value }));
  options.sort((p, q) => q.value - p.value);
  return { stay: judge(b, me), options, board: b };
}

/** The best next step for `a`. */
export const decide: Policy = (c, a) => {
  const { stay, options, board } = weigh(c, a);
  const temper = temperament(c.host.r, a);
  let best: { act: AiAction; score: number } = { act: { kind: 'end' }, score: stay };
  for (const o of options) {
    const score = o.value + (temper && board ? temper.weight * habit(temper, c, a, board, o.act) : 0);
    if (score > best.score + 1e-9) best = { act: o.act, score };
  }
  return best.act;
};

/** Carry out a step. Returns its animation time in ms, 0 to decide again at once, -1 when the turn is over. */
function perform(c: Combat, a: Actor, act: AiAction): number {
  const mem = memory(c, a);
  switch (act.kind) {
    case 'end':
      return -1;
    case 'move': {
      mem.moves++;
      const res = c.move(a, act.to);
      if (res.error) {
        mem.banned.add(keyOf(act));
        return mem.moves > MAX_MOVES ? -1 : 0;
      }
      return res.ms;
    }
    case 'skill': {
      const target = act.targetId ? c.participants().find((x) => x.id === act.targetId) : undefined;
      const err = c.useSkill(a, act.skillId, target, act.point);
      if (err) {
        mem.banned.add(keyOf(act));
        return 0;
      }
      return 800;
    }
    case 'potion': {
      const p = potionsOf(c, a)[0];
      if (!p) return -1;
      const err = c.useItem(a, p.item, a, undefined, p.consume);
      return err ? -1 : 700;
    }
  }
}

/** Perform one AI action for the active actor. Returns the animation time in ms, 0 to retry at once, -1 when done. */
export function aiStep(c: Combat, a: Actor): number {
  return perform(c, a, (c.policy ?? decide)(c, a));
}
