/**
 * Combat lab: plays the balance loop's kind of fights on built worlds' rules with the combat AI on both sides and
 * shows how they end (wins, Health lost, rounds), how the fighters move, and what a fight costs. The same parties, packs, and dice every run,
 * so a change to the AI can be compared with the AI before it (docs/combat.md).
 *   node src/cli/combatlab/bench.ts [worlds dir] [fights per scenario]
 */
import { readFileSync, readdirSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { Rng, type Fighter, type Ruleset, type WorldDefinition } from '@daydream/shared';
import { makeParty, runFight } from '../../rules/sim.ts';
import { decide, type Policy } from '../../game/ai.ts';
import { MonsterActor } from '../../game/actors.ts';
import { DESIGN_PARTY, buildPack, withDifficulty, type EncounterKind } from '../../rules/encounters.ts';

export interface World { id: string; name: string; r: Ruleset; families: { members: Fighter[] }[] }

export function loadWorlds(dir: string): World[] {
  const out: World[] = [];
  for (const id of readdirSync(dir)) {
    const f = join(dir, id, 'world.json');
    if (!existsSync(f)) continue;
    const w = JSON.parse(readFileSync(f, 'utf8'));
    if (!w.ruleset?.classes) continue;
    const families = (w as WorldDefinition).families.map((fm) => ({ members: fm.members.map((m) => ({ fighter: m.fighter, classId: m.classId })) }));
    out.push({ id, name: w.ruleset.name ?? id, r: w.ruleset, families });
  }
  return out;
}

export const SCENARIOS: { level: number; kind: EncounterKind }[] = [
  { level: 3, kind: 'normal' }, { level: 8, kind: 'normal' }, { level: 8, kind: 'boss' },
];

/** The i-th fight of a scenario: the same party, pack, and seed whatever plays it. */
export function fightSpec(w: World, level: number, kind: EncounterKind, i: number) {
  const r = w.r;
  const ids = r.classes.map((c) => c.id);
  const rng = new Rng(`bench:${w.id}:${level}:${kind}:${i}`);
  const fam = w.families[i % w.families.length]!;
  const classes = Array.from({ length: DESIGN_PARTY }, (_, j) => ids[(i + j) % ids.length]!);
  const party = makeParty(r, { classes, level, rng });
  const pack = withDifficulty(r, buildPack(r, rng, { heroes: classes.length, level, kind, members: fam.members, depth: 0.5 }), 'normal', rng);
  return { party, pack, potions: kind === 'boss' ? 8 : 0, difficulty: 'normal' as const, seed: rng.next().toString(36) };
}

/**
 * How the fighters move: of all moves, the share that take a hero (or a creature) more than a meter further from its
 * nearest foe (and how many of those it made above half its Health); turns in which it walked away and struck nothing; and step-backs in two rounds running.
 */
class Moves {
  n = { hero: [0, 0, 0, 0, 0, 0], foe: [0, 0, 0, 0, 0, 0] }; // moves, away, turns, away without striking, away twice running, away above half Health
  private turn = new Map<string, { round: number; away: boolean; struck: boolean; prevAway: number }>();
  policy: Policy = (c, a) => {
    const act = decide(c, a);
    const n = this.n[a instanceof MonsterActor ? 'foe' : 'hero'];
    let t = this.turn.get(a.id);
    if (!t || t.round !== c.round) {
      if (t) this.close(t, n);
      t = { round: c.round, away: false, struck: false, prevAway: t?.away ? t.round : (t?.prevAway ?? -9) };
      this.turn.set(a.id, t);
      n[2]++;
    }
    if (act.kind === 'move') {
      n[0]++;
      const foes = c.participants().filter((x) => x.alive() && x.team() !== a.team());
      const near = (p: { x: number; y: number }) => Math.min(...foes.map((f) => Math.hypot(f.x - p.x, f.y - p.y)));
      if (foes.length && near(act.to) > near(a) + 1) {
        n[1]++;
        if (a.hp > a.stats().maxHp / 2) n[5]++;
        if (!t.away && t.prevAway === c.round - 1) n[4]++;
        t.away = true;
      }
    } else if (act.kind === 'skill') t.struck = true;
    return act;
  };
  private close(t: { away: boolean; struck: boolean }, n: number[]) {
    if (t.away && !t.struck) n[3]++;
  }
  /** One line: hero and creature moves. */
  line() {
    const one = ([m, away, turns, idle, twice, well]: number[]) => `away ${Math.round((100 * away!) / Math.max(1, m!))}% of ${m} moves (${well} above half Health), walked off ${idle}/${turns} turns, twice running ${twice}`;
    return `heroes ${one(this.n.hero)} | creatures ${one(this.n.foe)}`;
  }
}

if (process.argv[1]?.endsWith('bench.ts')) {
  const dir = process.argv[2] ?? '../../../../data/worlds';
  const N = Number(process.argv[3] ?? 30);
  const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);
  for (const w of loadWorlds(dir)) {
    console.log(`
== ${w.name}`);
    for (const sc of SCENARIOS) {
      const level = Math.min(sc.level, w.r.progression.maxLevel);
      let wins = 0, hp = 0, rounds = 0;
      const moves = new Moves();
      const t0 = performance.now();
      for (let i = 0; i < N; i++) {
        const res = runFight(w.r, { ...fightSpec(w, level, sc.kind, i), policy: moves.policy });
        if (res.win) wins++;
        hp += res.hpLost;
        rounds += res.rounds;
      }
      const ms = (performance.now() - t0) / N;
      console.log(`L${level} ${sc.kind.padEnd(6)} win ${pct(wins / N)} hp ${pct(hp / N)} r ${(rounds / N).toFixed(1)} ${ms.toFixed(0).padStart(3)}ms  ${moves.line()}`);
    }
  }
}
