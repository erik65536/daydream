/**
 * The balance loop's work. Its unit is one fight: a pure function of the ruleset, the settings being tried, and the
 * fight's description (seeded by name), so the fights can be played on several threads (simPool.ts) and give the same
 * answer as on one. Evaluations, fits, and strength measures run on the loop's own thread and hand their fights to the
 * pool; they never change the ruleset, so a stage's fits run side by side, and the loop applies their results.
 */
import {
  Rng, knot, knownSkills,
  type DifficultyId, type Knots, type Ruleset,
} from '@daydream/shared';
import { DESIGN_PARTY, buildPack, fittedPack, withDifficulty, type EncounterKind } from './encounters.ts';
import { makeParty, runFight, type FightTelemetry } from './sim.ts';
import type { FamilyInfo } from './balance.ts';
import type { SimPool } from './simPool.ts';

type Range = [number, number];
export interface Target { winRate: Range; hpLost: Range; rounds: Range }

/**
 * Intended feel per encounter kind and difficulty, for a competent player: the simulation's heroes play about as well
 * as an attentive player (docs/combat.md), so a newcomer does somewhat worse; Story and Easy are for them.
 */
export const TARGETS: Record<DifficultyId, Record<EncounterKind, Target>> = {
  story: { normal: { winRate: [0.98, 1], hpLost: [0.05, 0.25], rounds: [2, 4.5] }, boss: { winRate: [0.9, 1], hpLost: [0.3, 0.7], rounds: [3.5, 8] } },
  easy: { normal: { winRate: [0.97, 1], hpLost: [0.12, 0.35], rounds: [2.5, 4.5] }, boss: { winRate: [0.75, 0.97], hpLost: [0.45, 0.8], rounds: [4, 9] } },
  normal: { normal: { winRate: [0.94, 1], hpLost: [0.2, 0.45], rounds: [2.5, 5] }, boss: { winRate: [0.55, 0.9], hpLost: [0.55, 0.9], rounds: [4.5, 10] } },
  hard: { normal: { winRate: [0.88, 0.99], hpLost: [0.35, 0.6], rounds: [3, 5.5] }, boss: { winRate: [0.4, 0.75], hpLost: [0.65, 0.95], rounds: [5, 11] } },
  brutal: { normal: { winRate: [0.8, 0.97], hpLost: [0.5, 0.75], rounds: [3, 6] }, boss: { winRate: [0.25, 0.6], hpLost: [0.75, 1], rounds: [5, 12] } },
};

/** The report's tolerance around a target (a fit aims inside it, so fresh fights still land). */
export const SLACK = { winRate: 0.05, hpLost: 0.08, rounds: 0.8 };

export interface Scenario {
  level: number;
  kind: EncounterKind;
  difficulty: DifficultyId;
  /** Another number of heroes than the four packs are built for: the pack is fitted to them as the game does. */
  heroes?: number;
}

export interface Eval {
  winRate: number;
  hpLost: number;
  rounds: number;
  runs: number;
}

/** A setting the loop fits: a value at one level of one of the ruleset's multiplier curves. */
export interface KnobRef {
  curve: 'monsterHp' | 'monsterDmg' | 'bossHp' | 'bossDmg' | 'enemyHp' | 'enemyDmg';
  difficulty?: DifficultyId;
  level: number;
}

/** How far each setting may go; one at its limit while its target is missed means the rules are at fault. */
const LIMITS: Record<KnobRef['curve'], Range> = {
  monsterHp: [0.15, 8], monsterDmg: [0.1, 8], bossHp: [1.5, 24], bossDmg: [0.5, 6], enemyHp: [0.3, 4], enemyDmg: [0.3, 4],
};

function knots(r: Ruleset, k: KnobRef): Knots {
  switch (k.curve) {
    case 'monsterHp': return r.curves.monsterHp;
    case 'monsterDmg': return r.curves.monsterDmg;
    case 'bossHp': return r.boss.hp;
    case 'bossDmg': return r.boss.dmg;
    case 'enemyHp': return r.difficulty[k.difficulty!].enemyHp;
    case 'enemyDmg': return r.difficulty[k.difficulty!].enemyDmg;
  }
}

export const getKnob = (r: Ruleset, k: KnobRef) => knot(knots(r, k), k.level);

/** A value for a setting, within its limits. */
const clampKnob = (k: KnobRef, value: number) => Math.max(LIMITS[k.curve][0], Math.min(LIMITS[k.curve][1], value));

export function setKnob(r: Ruleset, k: KnobRef, value: number) {
  const list = knots(r, k);
  const v = clampKnob(k, value);
  const e = list.find((x) => x.level === k.level);
  if (e) e.value = v;
  else {
    list.push({ level: k.level, value: v });
    list.sort((a, b) => a.level - b.level);
  }
}

const atLimit = (k: KnobRef, v: number, side: 'lo' | 'hi') => {
  const [lo, hi] = LIMITS[k.curve];
  return side === 'lo' ? v <= lo * 1.001 : v >= hi * 0.999;
};

/** A setting's name in a sentence. */
function knobName(r: Ruleset, k: KnobRef): string {
  const what = /Hp$/.test(k.curve) ? r.health.name : 'damage';
  const who = k.curve.startsWith('boss') ? 'bosses\'' : k.curve.startsWith('enemy') ? `${r.difficulty[k.difficulty!].name} creatures'` : 'creatures\'';
  return `${who} ${what.toLowerCase()}`;
}

export const mid = (x: Range) => (x[0] + x[1]) / 2;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const inRange = (v: number, x: Range, slack = 0) => v >= x[0] - slack && v <= x[1] + slack;

export function onTarget(e: Eval, t: Target, slack?: typeof SLACK): boolean {
  return inRange(e.winRate, t.winRate, slack?.winRate) && inRange(e.hpLost, t.hpLost, slack?.hpLost) && inRange(e.rounds, t.rounds, slack?.rounds);
}

// ------------------------------------------------------------------------------------ fights

export interface TaskContext {
  seed: string;
  families: FamilyInfo[];
}

/**
 * Settings a fight plays with in place of the ruleset's: those a fit or a measure is trying. Each knob names a level
 * the curve already has (the loop gives every level it fits a knot of its own before fitting).
 */
export interface Settings {
  knobs?: [KnobRef, number][];
  party?: Partial<Ruleset['party']>;
}

/** Run `fn` with the settings in place of the ruleset's, then put the ruleset's back. */
function withSettings<T>(r: Ruleset, set: Settings | undefined, fn: () => T): T {
  const undo: (() => void)[] = [];
  for (const [k, v] of set?.knobs ?? []) {
    const e = knots(r, k).find((x) => x.level === k.level);
    if (!e) throw new Error(`${k.curve} has no knot at level ${k.level}`);
    const was = e.value;
    e.value = v;
    undo.push(() => (e.value = was));
  }
  for (const [key, v] of Object.entries(set?.party ?? {}) as [keyof Ruleset['party'], number][]) {
    const was = r.party[key];
    r.party[key] = v;
    undo.push(() => (r.party[key] = was));
  }
  try {
    return fn();
  } finally {
    for (const u of undo.reverse()) u();
  }
}

/** One fight of an evaluation: its scenario, which of the scenario's seeded fights it is, and how it is played. */
export interface FightJob {
  scenario: Scenario;
  tag: string;
  index: number;
  classes?: string[][];
  tree?: Record<string, number>;
  telemetry?: boolean;
  set?: Settings;
}

export interface FightOutcome {
  win: boolean;
  hpLost: number;
  rounds: number;
  /** With telemetry: the skills each side used. */
  uses?: [string, [string, number][]][];
}

/** Play one fight of an evaluation: the same seeds every time for the same tag, so settings are compared on equal terms. */
export function playFight(r: Ruleset, ctx: TaskContext, f: FightJob): FightOutcome {
  return withSettings(r, f.set, () => {
    const s = f.scenario, i = f.index;
    const ids = r.classes.map((c) => c.id);
    const rng = new Rng(`${ctx.seed}:${f.tag}:${s.level}:${s.kind}:${s.difficulty}:${s.heroes ?? DESIGN_PARTY}:${i}`);
    const fam = ctx.families[i % ctx.families.length]!;
    const classes = f.classes ? f.classes[i % f.classes.length]! : Array.from({ length: s.heroes ?? DESIGN_PARTY }, (_, j) => ids[(i + j) % ids.length]!);
    const party = makeParty(r, { classes, level: s.level, rng, tree: f.tree });
    const pack = s.heroes
      ? fittedPack(r, buildPack(r, rng, { heroes: DESIGN_PARTY, level: s.level, kind: s.kind, members: fam.members, depth: 0.5 }), { heroes: s.heroes, difficulty: s.difficulty, rng })
      : withDifficulty(r, buildPack(r, rng, { heroes: classes.length, level: s.level, kind: s.kind, members: fam.members, depth: 0.5 }), s.difficulty, rng);
    const telemetry: FightTelemetry | undefined = f.telemetry ? { uses: new Map() } : undefined;
    const res = runFight(r, { party, pack, potions: s.kind === 'boss' ? 2 * classes.length : 0, difficulty: s.difficulty, seed: rng.next().toString(36), telemetry });
    return { win: res.win, hpLost: res.hpLost, rounds: res.rounds, uses: telemetry && [...telemetry.uses].map(([k, m]) => [k, [...m]]) };
  });
}

/** Play a scenario's fights on the pool and sum them up in order; with `telemetry`, the skills used are counted into it. */
export async function evaluate(pool: SimPool, s: Scenario, n: number, tag: string, o: { classes?: string[][]; tree?: Record<string, number>; telemetry?: FightTelemetry; set?: Settings } = {}): Promise<Eval> {
  const out = await pool.play(Array.from({ length: n }, (_, index): FightJob => ({ scenario: s, tag, index, classes: o.classes, tree: o.tree, telemetry: !!o.telemetry, set: o.set })));
  let wins = 0, hp = 0, rounds = 0;
  for (const x of out) {
    if (x.win) wins++;
    hp += x.hpLost;
    rounds += x.rounds;
    for (const [k, list] of x.uses ?? []) {
      let m = o.telemetry!.uses.get(k);
      if (!m) o.telemetry!.uses.set(k, (m = new Map()));
      for (const [id, c] of list) m.set(id, (m.get(id) ?? 0) + c);
    }
  }
  return { winRate: wins / n, hpLost: hp / n, rounds: rounds / n, runs: n };
}

/** A fit's or a measure's own copy of the curves it moves: it tries values there, and its fights play with them. */
class Trial {
  private curves = new Map<KnobRef, Knots>();
  constructor(r: Ruleset, ...refs: KnobRef[]) {
    for (const k of refs) this.curves.set(k, knots(r, k).map((x) => ({ ...x })));
  }
  get(k: KnobRef) {
    return knot(this.curves.get(k)!, k.level);
  }
  set(k: KnobRef, value: number) {
    this.curves.get(k)!.find((x) => x.level === k.level)!.value = value;
  }
  settings(): Settings {
    return { knobs: [...this.curves].map(([k, list]) => [k, list.find((x) => x.level === k.level)!.value]) };
  }
}

/** Where to aim the health lost inside its band so the win rate lands in its own. */
function aimHpLost(e: Eval, t: Target): number {
  const w = t.hpLost[1] - t.hpLost[0];
  if (e.winRate < t.winRate[0]) return t.hpLost[0] + w * 0.2;
  if (e.winRate > t.winRate[1]) return t.hpLost[1] - w * 0.2;
  return mid(t.hpLost);
}

/**
 * How far an evaluation is from where a fit aims: the win rate inside its band, the health lost, and the rounds inside
 * the middle half of theirs (so other fights than the fitted ones still land in the band). Zero is there.
 */
function miss(e: Eval, t: Target): number {
  const out = (v: number, [lo, hi]: Range, inner: number) => {
    const w = hi - lo, a = lo + w * inner, b = hi - w * inner;
    return Math.max(0, a - v, v - b) / w;
  };
  return out(e.winRate, t.winRate, 0) + out(e.hpLost, t.hpLost, 0.25) + out(e.rounds, t.rounds, 0.25);
}

/** A scenario to fit: two settings (health against rounds, damage against health lost), on so many fights a step. */
export interface FitSpec { scenario: Scenario; hp: KnobRef; dmg: KnobRef; fights: number; steps: number }
interface Fitted { e: Eval; hp: number; dmg: number; limit?: string }

/**
 * Fit a scenario. Creature health sets how many rounds a fight lasts, and creature damage how much health the heroes
 * lose each round; fitted that way (damage against the health lost per round, not in all) the two settings barely
 * disturb each other. Each step moves both by the gap in log terms over how strongly each answered the last step (a
 * secant estimate, starting from typical values), at most doubling or halving at once. The best step is kept.
 */
export async function fit(pool: SimPool, r: Ruleset, t: FitSpec): Promise<Fitted> {
  const target = TARGETS[t.scenario.difficulty][t.scenario.kind];
  const trial = new Trial(r, t.hp, t.dmg);
  const slope = { hp: 0.8, dmg: 0.9 };
  const perRound = (e: Eval) => Math.max(0.005, e.hpLost) / Math.max(1, e.rounds);
  let prev: { h: number; d: number; e: Eval } | null = null;
  let best: { hp: number; dmg: number; e: Eval; miss: number } | null = null;
  for (let step = 0; ; step++) {
    const e = await evaluate(pool, t.scenario, t.fights, 'fit', { set: trial.settings() });
    const m = miss(e, target);
    if (!best || m < best.miss) best = { hp: trial.get(t.hp), dmg: trial.get(t.dmg), e, miss: m };
    if (m === 0 || step >= t.steps) break;
    const h = Math.log(trial.get(t.hp)), d = Math.log(trial.get(t.dmg));
    if (prev) {
      if (Math.abs(h - prev.h) > 0.03) slope.hp = clamp(0.5 * slope.hp + 0.5 * (Math.log(e.rounds / prev.e.rounds) / (h - prev.h)), 0.25, 2);
      if (Math.abs(d - prev.d) > 0.03) slope.dmg = clamp(0.5 * slope.dmg + 0.5 * (Math.log(perRound(e) / perRound(prev.e)) / (d - prev.d)), 0.25, 2);
    }
    prev = { h, d, e };
    const stepH = clamp(Math.log(mid(target.rounds) / Math.max(1, e.rounds)) / slope.hp, -Math.LN2, Math.LN2);
    const stepD = clamp(Math.log(aimHpLost(e, target) / mid(target.rounds) / perRound(e)) / slope.dmg, -Math.LN2, Math.LN2);
    trial.set(t.hp, clampKnob(t.hp, Math.exp(h + stepH)));
    trial.set(t.dmg, clampKnob(t.dmg, Math.exp(d + stepD)));
  }
  const e = best!.e;
  trial.set(t.hp, clampKnob(t.hp, best!.hp));
  trial.set(t.dmg, clampKnob(t.dmg, best!.dmg));
  const hp = trial.get(t.hp), dmg = trial.get(t.dmg);
  let limit: string | undefined;
  if (!onTarget(e, target)) {
    const pinned: string[] = [];
    if (e.rounds < target.rounds[0] && atLimit(t.hp, hp, 'hi')) pinned.push(`${knobName(r, t.hp)} is at its highest and fights are still too short`);
    if (e.rounds > target.rounds[1] && atLimit(t.hp, hp, 'lo')) pinned.push(`${knobName(r, t.hp)} is at its lowest and fights are still too long`);
    const tooHard = e.winRate < target.winRate[0] || e.hpLost > target.hpLost[1];
    const tooEasy = e.winRate > target.winRate[1] || e.hpLost < target.hpLost[0];
    if (tooHard && atLimit(t.dmg, dmg, 'lo')) pinned.push(`${knobName(r, t.dmg)} is at its lowest and the heroes still lose too much`);
    if (tooEasy && atLimit(t.dmg, dmg, 'hi')) pinned.push(`${knobName(r, t.dmg)} is at its highest and the fights are still too easy`);
    if (pinned.length) limit = pinned.join('; ');
  }
  return { e, hp, dmg, limit };
}

/**
 * A party's strength, as the factor on creatures' health and damage (both) at which ordinary fights cost the heroes
 * the middle of the target health: a factor of 1.2 means the party handles creatures a fifth stronger than the
 * world's. Found by the same secant steps as a fit, then extrapolated from the last step.
 */
export async function partyStrength(pool: SimPool, r: Ruleset, t: { level: number; classes: string[][]; tag: string; fights: number; steps: number }): Promise<number> {
  const s: Scenario = { level: t.level, kind: 'normal', difficulty: 'normal' };
  const aim = mid(TARGETS.normal.normal.hpLost);
  const hpK: KnobRef = { curve: 'monsterHp', level: t.level }, dmgK: KnobRef = { curve: 'monsterDmg', level: t.level };
  const base = { hp: getKnob(r, hpK), dmg: getKnob(r, dmgK) };
  const trial = new Trial(r, hpK, dmgK);
  let m = 1, slope = 1.2;
  let prev: { m: number; lost: number } | null = null;
  for (let step = 0; step < t.steps; step++) {
    // (Unclamped: the factor may take the settings past the limits a fit keeps to.)
    trial.set(hpK, base.hp * m);
    trial.set(dmgK, base.dmg * m);
    const lost = Math.max(0.02, (await evaluate(pool, s, t.fights, t.tag, { classes: t.classes, set: trial.settings() })).hpLost);
    if (prev && Math.abs(Math.log(m / prev.m)) > 0.03) slope = clamp(0.5 * slope + 0.5 * (Math.log(lost / prev.lost) / Math.log(m / prev.m)), 0.3, 3);
    prev = { m, lost };
    if (Math.abs(lost - aim) < 0.02) break;
    m *= Math.exp(clamp(Math.log(aim / lost) / slope, -Math.LN2, Math.LN2));
  }
  return prev!.m * Math.exp(Math.log(aim / prev!.lost) / slope);
}

/** Skills a typical hero of the class has at a level (what the AI could use). */
export function typicalSkills(r: Ruleset, classId: string, level: number, seed: string): string[] {
  const hero = makeParty(r, { classes: [classId], level, rng: new Rng(`${seed}:known:${classId}:${level}`) })[0]!;
  return knownSkills(r, hero);
}
