/**
 * The balance loop. Simulates encounters with the real combat code and fits a small set of settings toward
 * difficulty targets, in the order they depend on each other:
 *   1. classes: each class's strength in a party is measured and evened out;
 *   2. skills: potency follows how often the AI uses each skill, and builds far stronger than typical are weakened;
 *   3. creatures' health and damage at each tuned level;
 *   4. bosses at each level;
 *   5. each difficulty's multipliers;
 *   6. how a pack's strength follows the number of heroes.
 * Every fit of a scenario replays the same fights (the same seeds), so two settings are compared on equal terms, and
 * each step solves for the setting from how the last one moved the result instead of nudging it. A fixed number of
 * fights bounds the work, never a clock, so a world balances the same on any machine, however many threads play the
 * fights (simPool.ts). The report judges the result on other fights than those fitted, and the findings say what numbers
 * could not fix (a skill the AI never uses, a class no correction evens out, a target out of reach with a setting at
 * its limit) for the world's owner. Mutates the ruleset in place and returns the report. Deterministic for a given seed.
 */
import {
  DIFFICULTIES, Rng, invalidateRuleset, knot, rx, treePointsAt,
  type BalanceFinding, type BalanceReport, type BalanceScenarioResult, type DifficultyId, type Fighter, type Ruleset,
} from '@daydream/shared';
import { DESIGN_PARTY, type EncounterKind } from './encounters.ts';
import { makeParty } from './sim.ts';
import { SLACK, TARGETS, evaluate, fit, onTarget, partyStrength, setKnob, typicalSkills, type Eval, type FitSpec, type KnobRef, type Scenario, type Settings, type TaskContext } from './balanceTasks.ts';
import type { FightTelemetry } from './sim.ts';
import { SimPool } from './simPool.ts';

/** A family the world's packs are built from: its members, each a kind of fighter fighting as a class. */
export interface FamilyInfo {
  members: Fighter[];
}

interface BalanceOptions {
  seed: string;
  families?: FamilyInfo[];
  /**
   * How much to simulate: 'quick' tests the loop, 'smoke' only runs it, 'off' keeps the rules as written (tests that
   * build a world for something else: a balance is most of a test build's time, and a dozen at once timed out).
   */
  size?: BalanceSize;
  /** Told how far it is, and how many fights it has simulated. */
  onProgress?: (msg: string, frac: number, fights: number) => void;
  /** Threads to simulate on (default: simThreads()). */
  threads?: number;
}

export type BalanceSize = 'full' | 'quick' | 'smoke' | 'off';

/** Fights per evaluation and steps per fit; a fit aims inside the targets on its own fights, the report plays others. */
const SIZES = {
  full: { fights: 16, steps: 6, report: 24, classFights: 10, classSteps: 3, classPasses: 2, builds: true },
  quick: { fights: 4, steps: 2, report: 8, classFights: 3, classSteps: 1, classPasses: 1, builds: false },
  // (Smoke plays level 1 only, where fights are short.)
  smoke: { fights: 1, steps: 0, report: 1, classFights: 1, classSteps: 1, classPasses: 0, builds: false },
};

const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const round = (v: number) => Math.round(v * 1000) / 1000;
const pct = (v: number) => `${Math.round(v * 100)}%`;
/**
 * How many times the usual fights a scenario is fitted and reported on. A boss fight, one creature, is decided by a few
 * blows and swings far more from fight to fight than a pack; Brutal fights somewhat more. With as many fights
 * as a pack's, their fit followed the dice of the fitted seeds (measured 3 November 2026, docs/combat.md).
 */
const swing = (s: { kind: string; difficulty: string }) => (s.kind === 'boss' ? 3 : s.difficulty === 'brutal' ? 2 : 1);
const geomean = (xs: number[]) => Math.exp(xs.reduce((s, x) => s + Math.log(x), 0) / Math.max(1, xs.length));

/** How far the party-size powers may go. */
const PARTY_POWER: [number, number] = [0.3, 3.5];

/** Class corrections stay within these; a class still far off at a limit is a finding. */
const CLASS_TUNE: [number, number] = [0.6, 1.6];

/** The levels at which a hero all-in on a class can first take a skill of each deeper tier (fighterSkills follows the same rule). */
function tierSteps(r: Ruleset): number[] {
  const out: number[] = [];
  for (const need of r.progression.tierRequirements.slice(1)) {
    let level = 1;
    while (level < r.progression.maxLevel && treePointsAt(r, level) <= need) level++;
    if (treePointsAt(r, level) > need) out.push(level);
  }
  return out;
}

export async function balanceRuleset(r: Ruleset, opts: BalanceOptions): Promise<BalanceReport> {
  const t0 = Date.now();
  const size = opts.size ?? 'full';
  if (size === 'off') {
    const report: BalanceReport = { at: t0, iterations: 0, durationMs: 0, fights: 0, scenarios: [], classes: [], skillUsage: [], outliers: [], findings: [], notes: ['Not simulated: the rules as written.'] };
    r.balance = report;
    return report;
  }
  const P = SIZES[size];
  const maxL = r.progression.maxLevel;
  // Heroes grow by steps where a tier's first skill can be taken; between fitted levels the settings are interpolated,
  // so a full balance also fits each such level and the one before it, or the step is smeared over the levels between.
  const steps = size === 'full' ? tierSteps(r).flatMap((l) => [l - 1, l]) : [];
  const levels = [...new Set([...(size === 'full' ? [1, Math.max(2, Math.round(maxL * 0.35)), Math.max(3, Math.round(maxL * 0.7)), maxL] : size === 'quick' ? [1, maxL] : [1]), ...steps].filter((l) => l >= 1 && l <= maxL))].sort((x, y) => x - y);
  const midL = levels[Math.floor(levels.length / 2)]!;
  // Bosses at every tuned level (a long world's first gap is wide); difficulties from the middle up.
  const diffLevels = size === 'full' ? [...new Set([midL, maxL])] : [levels[levels.length - 1]!];
  const ctx: TaskContext = { seed: opts.seed, families: opts.families?.length ? opts.families : [{ members: r.classes.map((c) => ({ fighter: 'soldier', classId: c.id })) }] };
  const notes: string[] = [];
  const outliers: string[] = [];
  const findings: BalanceFinding[] = [];
  const limits = new Map<string, string>();
  let fits = 0;
  const pool = new SimPool(opts.threads);
  let now = { msg: '', from: 0, to: 0, start: 0, most: 1 };
  const progress = (msg: string, frac: number) => opts.onProgress?.(msg, clamp(frac, 0, 1), pool.played);
  pool.onPlayed = () => progress(now.msg, now.from + ((now.to - now.from) * (pool.played - now.start)) / now.most);
  /**
   * A stage: its work plays by the ruleset as it is now (the stage's own trials are settings of its fights), and the
   * loop applies the stage's results once it is done. `most` is the most fights it may play, for its progress.
   */
  const stage = async <T>(msg: string, from: number, to: number, most: number, work: () => Promise<T>): Promise<T> => {
    invalidateRuleset(r);
    pool.use(r, ctx);
    now = { msg, from, to, start: pool.played, most: Math.max(1, most) };
    progress(msg, from);
    const out = await work();
    invalidateRuleset(r);
    return out;
  };

  try {
    // The tuned levels' settings start from the current curves.
    const at = (k: { level: number; value: number }[], ls: number[]) => ls.map((l) => ({ level: l, value: knot(k, l) }));
    r.curves.monsterHp = at(r.curves.monsterHp, levels);
    r.curves.monsterDmg = at(r.curves.monsterDmg, levels);
    r.boss.hp = at(r.boss.hp, levels);
    r.boss.dmg = at(r.boss.dmg, levels);
    for (const d of DIFFICULTIES) {
      if (d === 'normal') continue;
      r.difficulty[d].enemyHp = at(r.difficulty[d].enemyHp, diffLevels);
      r.difficulty[d].enemyDmg = at(r.difficulty[d].enemyDmg, diffLevels);
    }
    const classIds = r.classes.map((c) => c.id);

    // ---------------------------------------------------------------- 1. classes
    // A class's strength is measured in parties where it is half the heroes, beside the other classes in turn, and
    // corrected toward the classes' average; the second pass learns from the first how strongly a correction tells.
    const classResults: BalanceReport['classes'] = [];
    if (classIds.length > 1) {
      const lineups = (c: string): string[][] => {
        const others = classIds.filter((x) => x !== c);
        return others.map((_, i) => [c, c, others[i % others.length]!, others[(i + 1) % others.length]!]);
      };
      const measure = async (pass: number) => {
        const s = await stage('Evening out the classes', 0.02 + 0.08 * pass, 0.1 + 0.08 * pass, classIds.length * P.classFights * P.classSteps, () =>
          Promise.all(classIds.map((c) => partyStrength(pool, r, { level: midL, classes: lineups(c), tag: `class:${c}`, fights: P.classFights, steps: P.classSteps }))));
        const avg = geomean(s);
        return new Map(classIds.map((c, i) => [c, s[i]! / avg]));
      };
      let strength = await measure(0);
      let response = 0.67;
      for (let pass = 0; pass < P.classPasses; pass++) {
        const applied = new Map<string, number>();
        for (const c of r.classes) {
          const f = clamp(Math.pow(1 / strength.get(c.id)!, 1 / response), 0.8, 1.25);
          const before = c.tune.hp;
          c.tune.hp = clamp(c.tune.hp * f, ...CLASS_TUNE);
          c.tune.dmg = clamp(c.tune.dmg * f, ...CLASS_TUNE);
          applied.set(c.id, c.tune.hp / before);
        }
        const next = await measure(pass + 1);
        // How much a class's strength moved per unit of correction, over the classes that moved.
        const moved = classIds.filter((c) => Math.abs(Math.log(applied.get(c)!)) > 0.03);
        if (moved.length) response = clamp(moved.reduce((s, c) => s + Math.log(next.get(c)! / strength.get(c)!) / Math.log(applied.get(c)!), 0) / moved.length, 0.25, 2);
        strength = next;
      }
      for (const c of r.classes) {
        const s = strength.get(c.id)!;
        classResults.push({ classId: c.id, strength: round(s), tune: { hp: round(c.tune.hp), dmg: round(c.tune.dmg) } });
        if (Math.abs(Math.log(s)) > Math.log(1.15)) {
          const pinned = (s < 1 && c.tune.hp >= CLASS_TUNE[1] * 0.999) || (s > 1 && c.tune.hp <= CLASS_TUNE[0] * 1.001);
          findings.push({ kind: 'class_strength', classId: c.id, text: `${c.name} is ${pct(Math.abs(s - 1))} ${s < 1 ? 'weaker' : 'stronger'} than the average class in a party${pinned ? ' even with the largest correction the engine allows' : ' after correction'}.` });
        }
      }
    }

    // ---------------------------------------------------------------- 2. skills
    // Usage from fights at the middle and highest level: a skill that takes most of a class's turns is toned down, one
    // the AI almost never picks gets stronger.
    const seen: FightTelemetry = { uses: new Map() };
    const uses = seen.uses;
    const usageLevels = [...new Set([midL, maxL])];
    await stage('Reading skill usage', 0.27, 0.32, usageLevels.length * 2 * P.classFights, () =>
      Promise.all(usageLevels.flatMap((l) => (['normal', 'boss'] as const).map((kind) => evaluate(pool, { level: l, kind, difficulty: 'normal' }, P.classFights, 'usage', { telemetry: seen })))));
    const usage: BalanceReport['skillUsage'] = [];
    for (const cls of r.classes) {
      const own = [...(uses.get(cls.id) ?? [])].filter(([id]) => rx(r).skill.get(id)?.owner === cls.id);
      const total = own.reduce((s, [, n]) => s + n, 0);
      if (!total) continue;
      for (const sk of r.skills.filter((s) => s.owner === cls.id)) {
        const share = (uses.get(cls.id)?.get(sk.id) ?? 0) / total;
        if (share > 0.5 && own.length > 2) sk.tune = clamp(sk.tune * 0.92, 0.6, 1.6);
        else if (share < 0.03 && sk.effects.some((e) => e.kind === 'damage' || e.kind === 'heal')) sk.tune = clamp(sk.tune * 1.08, 0.6, 1.6);
        usage.push({ skillId: sk.id, share: round(share), tune: round(sk.tune) });
      }
    }

    // Builds far stronger than typical: random builds at the highest level, four heroes of the class with the build in
    // ordinary fights (where the health they lose tells builds apart), and the passive or skill rank that carries the
    // best one is weakened.
    if (P.builds) {
      progress('Searching for overpowered builds', 0.33);
      const builds = r.classes.map((cls) => {
        const rng = new Rng(`${opts.seed}:builds:${cls.id}`);
        return { cls, typical: makeParty(r, { classes: [cls.id], level: maxL, rng })[0]!.tree, random: Array.from({ length: 5 }, () => makeParty(r, { classes: [cls.id], level: maxL, rng, style: 'random' })[0]!.tree) };
      });
      const fight: Scenario = { level: maxL, kind: 'normal', difficulty: 'normal' };
      const score = (e: Eval) => e.hpLost + (1 - e.winRate);
      const party = (c: string) => [[c, c, c, c]];
      const res = await stage('Searching for overpowered builds', 0.33, 0.4, builds.length * 6 * 8, () =>
        Promise.all(builds.flatMap((b) => [b.typical, ...b.random].map((tree) => evaluate(pool, fight, 8, `build:${b.cls.id}`, { classes: party(b.cls.id), tree })))));
      const ablate: { cls: (typeof builds)[number]['cls']; tree: Record<string, number>; best: Eval; gap: number; nodes: string[] }[] = [];
      builds.forEach((b, i) => {
        const evals = res.slice(i * 6, i * 6 + 6);
        const base = evals[0]!;
        let bi = 1;
        for (let k = 2; k < 6; k++) if (score(evals[k]!) < score(evals[bi]!)) bi = k;
        // Better by a third of what a typical build loses, and by a clear margin.
        const gap = score(base) - score(evals[bi]!);
        if (gap < Math.max(0.08, score(base) / 3)) return;
        const tree = b.random[bi - 1]!;
        const nodes = rx(r).node;
        const candidates = Object.entries(tree).filter(([id, n]) => n > 0 && nodes.get(id) && nodes.get(id)!.kind !== 'skill').sort((a, c) => c[1] - a[1]).slice(0, 5).map(([id]) => id);
        ablate.push({ cls: b.cls, tree, best: evals[bi]!, gap, nodes: candidates });
      });
      if (ablate.length) {
        const res2 = await stage('Searching for overpowered builds', 0.4, 0.44, ablate.reduce((n, a) => n + a.nodes.length * 8, 0), () =>
          Promise.all(ablate.flatMap((a) => a.nodes.map((id) => {
            const t2 = { ...a.tree };
            delete t2[id];
            return evaluate(pool, fight, 8, `build:${a.cls.id}`, { classes: party(a.cls.id), tree: t2 });
          }))));
        let k = 0;
        for (const a of ablate) {
          let worst: { id: string; delta: number } | null = null;
          for (const id of a.nodes) {
            const delta = score(res2[k++]!) - score(a.best);
            if (!worst || delta > worst.delta) worst = { id, delta };
          }
          if (!worst || worst.delta <= a.gap * 0.4) continue;
          const node = rx(r).node.get(worst.id)!;
          if (node.skillId) {
            const sk = rx(r).skill.get(node.skillId)!;
            sk.tune = clamp(sk.tune * 0.85, 0.5, 1.6);
          } else node.tune = clamp((node.tune ?? 1) * 0.8, 0.4, 1.5);
          const text = `${a.cls.name}: "${node.name}" carried a build that lost ${pct(a.best.hpLost)} of its ${r.health.name} where a typical one lost ${pct(a.best.hpLost + a.gap)}; it was weakened.`;
          outliers.push(text);
          findings.push({ kind: 'outlier', classId: a.cls.id, text });
        }
      }
    }

    // ---------------------------------------------------------------- 3–5. creatures, tiers, difficulties
    // A stage's fits run side by side, each on its own copy of the settings it moves.
    const fitAll = async (specs: { s: Scenario; hp: KnobRef; dmg: KnobRef }[], msg: string, from: number, to: number) => {
      const fitSpecs = specs.map((x): FitSpec => ({ scenario: x.s, hp: x.hp, dmg: x.dmg, fights: Math.round(P.fights * swing(x.s)), steps: P.steps }));
      const res = await stage(msg, from, to, fitSpecs.reduce((n, f) => n + f.fights * (f.steps + 1), 0), () => Promise.all(fitSpecs.map((f) => fit(pool, r, f))));
      fits += specs.length;
      specs.forEach((x, i) => {
        const f = res[i]!;
        setKnob(r, x.hp, f.hp);
        setKnob(r, x.dmg, f.dmg);
        const id = `${x.s.difficulty}:${x.s.kind}:${x.s.level}`;
        if (f.limit) limits.set(id, f.limit);
        else limits.delete(id);
      });
    };
    await fitAll(levels.map((l) => ({ s: { level: l, kind: 'normal', difficulty: 'normal' }, hp: { curve: 'monsterHp', level: l }, dmg: { curve: 'monsterDmg', level: l } })), 'Fitting creature strength per level', 0.45, 0.6);
    await fitAll(levels.map((l) => ({ s: { level: l, kind: 'boss' as EncounterKind, difficulty: 'normal' as DifficultyId }, hp: { curve: 'bossHp' as const, level: l }, dmg: { curve: 'bossDmg' as const, level: l } })), 'Fitting boss encounters', 0.6, 0.75);
    await fitAll(DIFFICULTIES.filter((d) => d !== 'normal').flatMap((d) => diffLevels.map((l) => ({ s: { level: l, kind: 'normal' as EncounterKind, difficulty: d }, hp: { curve: 'enemyHp' as const, difficulty: d, level: l }, dmg: { curve: 'enemyDmg' as const, difficulty: d, level: l } }))), 'Calibrating the difficulties', 0.75, 0.82);

    // ---------------------------------------------------------------- 6. party sizes
    // The game fits packs to the heroes there are (fitPack), by the heroes' ratio to four to a power: one power for
    // fewer heroes and one for more (one number cannot serve both), for packs and for bosses. Each is solved by the
    // same secant steps so that its parties lose, on average in log terms, the health four do; a higher power eases
    // fights for fewer heroes and hardens them for more. (The gap between party sizes is small beside one fight's
    // swing, so these play twice the fights of a fit.)
    const sides = [
      { key: 'packFewer', kind: 'normal', sizes: size === 'full' ? [1, 2] : [1] },
      { key: 'packMore', kind: 'normal', sizes: [6] },
      { key: 'bossFewer', kind: 'boss', sizes: size === 'full' ? [1, 2] : [1] },
      { key: 'bossMore', kind: 'boss', sizes: [6] },
    ] as const;
    const partyFights = (kind: EncounterKind) => Math.round(P.fights * (kind === 'boss' ? 3 : 2));
    const partySteps = Math.min(3, P.steps) + 1;
    await stage('Fitting fights to the number of heroes', 0.82, 0.86, partyFights('normal') + partyFights('boss') + sides.reduce((n, x) => n + partySteps * x.sizes.length * partyFights(x.kind), 0), async () => {
      // Each evaluation plays with the powers as they are now (the threads hold the ruleset as the stage began).
      const lost = async (kind: EncounterKind, heroes: number[]) => {
        const set: Settings = { party: { ...r.party } };
        const res = await Promise.all(heroes.map((h) => evaluate(pool, { level: midL, kind, difficulty: 'normal', heroes: h === DESIGN_PARTY ? undefined : h }, partyFights(kind), 'party', { set })));
        return res.map((e) => Math.max(0.02, e.hpLost));
      };
      const four = { normal: (await lost('normal', [DESIGN_PARTY]))[0]!, boss: (await lost('boss', [DESIGN_PARTY]))[0]! } as Record<EncounterKind, number>;
      for (const side of sides) {
        const gap = async () => (await lost(side.kind, [...side.sizes])).reduce((s, h, j) => s + Math.sign(DESIGN_PARTY - side.sizes[j]!) * Math.log(h / four[side.kind]), 0) / side.sizes.length;
        let slope = -0.5;
        let prev: { p: number; g: number } | null = null;
        let best = { p: r.party[side.key], g: Infinity };
        for (let step = 0; step <= Math.min(3, P.steps); step++) {
          const p = r.party[side.key];
          const g = await gap();
          if (Math.abs(g) < Math.abs(best.g)) best = { p, g };
          if (Math.abs(g) < 0.05) break;
          if (prev && Math.abs(p - prev.p) > 0.02) slope = clamp(0.5 * slope + 0.5 * ((g - prev.g) / (p - prev.p)), -3, -0.1);
          prev = { p, g };
          r.party[side.key] = clamp(p + clamp(-g / slope, -0.5, 0.5), ...PARTY_POWER);
        }
        r.party[side.key] = round(best.p);
      }
    });

    // ---------------------------------------------------------------- report
    const scenarios: Scenario[] = [
      ...levels.map((l): Scenario => ({ level: l, kind: 'normal', difficulty: 'normal' })),
      ...levels.map((l): Scenario => ({ level: l, kind: 'boss', difficulty: 'normal' })),
      ...DIFFICULTIES.filter((d) => d !== 'normal').flatMap((d) => diffLevels.map((l): Scenario => ({ level: l, kind: 'normal', difficulty: d }))),
      ...(['normal', 'boss'] as const).flatMap((kind) => [1, 6].map((heroes): Scenario => ({ level: midL, kind, difficulty: 'normal', heroes }))),
    ];
    const reportFights = (s: Scenario) => Math.round(P.report * swing(s));
    const res = await stage('Writing the balance report', 0.86, 1, scenarios.reduce((n, s) => n + reportFights(s), 0), () =>
      Promise.all(scenarios.map((s) => evaluate(pool, s, reportFights(s), 'report', { telemetry: seen }))));
    const results: BalanceScenarioResult[] = scenarios.map((s, i) => {
      const e = res[i]!;
      const t = TARGETS[s.difficulty][s.kind];
      const id = `${s.difficulty}:${s.kind}:${s.level}${s.heroes ? `:${s.heroes}` : ''}`;
      const ok = onTarget(e, t, SLACK);
      const who = s.heroes ? ` · ${s.heroes} hero${s.heroes > 1 ? 'es' : ''}` : '';
      return { id, label: `${r.difficulty[s.difficulty].name} · ${s.kind} · level ${s.level}${who}`, level: s.level, difficulty: s.difficulty, heroes: s.heroes, runs: e.runs, winRate: round(e.winRate), hpLost: round(e.hpLost), rounds: round(e.rounds), target: t, ok, limit: ok ? undefined : limits.get(id) };
    });
    for (const s of results) if (s.limit) findings.push({ kind: 'out_of_reach', text: `${s.label}: ${s.limit} (wins ${pct(s.winRate)}, ${r.health.name} lost ${pct(s.hpLost)}, ${s.rounds.toFixed(1)} rounds).` });
    findings.push(...usageFindings(r, uses, opts.seed, maxL), ...ruleFindings(r));

    const okCount = results.filter((s) => s.ok).length;
    const pinned = results.filter((s) => !s.ok && s.limit).length;
    notes.push(`${okCount}/${results.length} scenarios on target after ${fits} fits and ${pool.played} simulated fights${pinned ? `; ${pinned} missed with a setting at its limit (the rules, not the fitting)` : ''}.`);
    invalidateRuleset(r);
    const report: BalanceReport = { at: Date.now(), iterations: fits, durationMs: Date.now() - t0, fights: pool.played, scenarios: results, classes: classResults, skillUsage: usage, outliers, findings, notes };
    r.balance = report;
    progress('Balanced', 1);
    return report;
  } finally {
    pool.close();
  }
}

/** What the AI's choices in the report's fights say about the skills. */
function usageFindings(r: Ruleset, uses: Map<string, Map<string, number>>, seed: string, maxL: number): BalanceFinding[] {
  const out: BalanceFinding[] = [];
  for (const cls of r.classes) {
    const m = uses.get(cls.id);
    if (!m) continue;
    const all = [...m.values()].reduce((s, n) => s + n, 0);
    if (all < 40) continue;
    const basic = (m.get(r.basicAttackId) ?? 0) / all;
    if (basic > 0.6) out.push({ kind: 'basic_attack', classId: cls.id, text: `${cls.name} mostly uses the basic attack (${pct(basic)} of its actions): its skills do too little for their cost for the AI to pick them.` });
    const known = typicalSkills(r, cls.id, maxL, seed).filter((id) => rx(r).skill.get(id)?.owner === cls.id);
    const own = known.reduce((s, id) => s + (m.get(id) ?? 0), 0);
    if (!own) continue;
    for (const id of known) {
      const sk = rx(r).skill.get(id)!;
      const share = (m.get(id) ?? 0) / own;
      // (Reviving and cleansing answer trouble: rare by nature.)
      const situational = sk.effects.some((e) => e.kind === 'revive' || e.kind === 'cleanse');
      if (share < 0.02 && !situational) out.push({ kind: 'unused_skill', classId: cls.id, text: `${cls.name}'s "${sk.name}" [${sk.effects.map((e) => e.kind).join('+')}] was used in ${pct(share)} of the class's skill uses: the AI rarely finds it worth its turn.` });
      else if (share > 0.55 && known.length >= 3) out.push({ kind: 'dominant_skill', classId: cls.id, text: `${cls.name}'s "${sk.name}" [${sk.effects.map((e) => e.kind).join('+')}] takes ${pct(share)} of the class's skill uses: the class plays as one button.` });
    }
  }
  return out;
}

/** What the rules themselves leave unused: a passive that cannot help its class (healing, where the class has no healing skill). */
export function ruleFindings(r: Ruleset): BalanceFinding[] {
  const out: BalanceFinding[] = [];
  for (const cls of r.classes) {
    const heals = r.skills.some((s) => s.owner === cls.id && s.effects.some((e) => e.kind === 'heal' || e.kind === 'revive'));
    if (heals) continue;
    for (const n of cls.nodes) {
      if (n.kind === 'passive' && n.modifiers?.some((m) => m.stat === 'healing')) out.push({ kind: 'dead_passive', classId: cls.id, text: `${cls.name}'s passive "${n.name}" raises healing, and the class has no healing skill.` });
    }
  }
  return out;
}
