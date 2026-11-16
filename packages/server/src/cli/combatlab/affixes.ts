/**
 * Combat lab: what each bonus gear can carry is worth in a fight, in power % (a percent more damage on everything,
 * the unit the rules price bonuses in). Every hero's weapon is given one stat, as much as the rules' price says is
 * worth `dose` power %, and the same fights are played with it, with nothing, and with `dose` of Damage itself; the
 * Health the party loses tells the worth: a stat priced right saves as much Health as `dose` of Damage does.
 *
 * The creatures are set as strong as the balance loop's strength measure finds right for the party without bonuses
 * (ordinary fights cost it the middle of the target), and every variant plays the same seeds, so each stat's worth is
 * read from paired fights; `±` is one standard error of that pairing.
 *   node src/cli/combatlab/affixes.ts <worlds dir> [world id or -] [dose] [fights] [levels, e.g. 3,8]
 */
import { invalidateRuleset, itemMod, knot, statUnit, type Ruleset, type StatId } from '@daydream/shared';
import { getKnob, partyStrength, type FightJob, type KnobRef, type Settings, type TaskContext } from '../../rules/balanceTasks.ts';
import { SimPool } from '../../rules/simPool.ts';
import { statPrice } from '../../rules/worldRules.ts';

/** What one unit of a stat is worth by the rules' prices, in a ruleset's world. */
const affixPrice = (r: Ruleset, stat: StatId) => statPrice(stat, r.damageTypes.map((t) => t.id), r.resolution.critMult);
import { loadWorlds } from './bench.ts';

const [dir, only, doseArg, fightsArg, levelsArg] = process.argv.slice(2);
const DOSE = Number(doseArg ?? 20);
const FIGHTS = Number(fightsArg ?? 400);

/** The stats to measure: every one the engine has, whether the world rolls it or not, and crit damage beside more crit. */
function stats(r: Ruleset): { label: string; mods: [StatId, number][] }[] {
  const all: StatId[] = ['hpPct', 'move', 'hpRegen', 'thorns', 'lifesteal', 'healing', ...r.damageTypes.flatMap((t): StatId[] => [`dmg:${t.id}`, `mit:${t.id}`])];
  if (r.resolution.crit) all.push('crit', 'critDmg');
  if (r.resolution.dodge) all.push('dodge');
  const out = all.map((s) => ({ label: s, mods: [[s, DOSE]] as [StatId, number][] }));
  // Crit damage is worth what crit chance makes of it: measured beside a lot of crit, and that crit alone.
  if (r.resolution.crit) out.push({ label: 'crit x2', mods: [['crit', DOSE * 2]] }, { label: 'crit x2 + critDmg', mods: [['crit', DOSE * 2], ['critDmg', DOSE]] });
  return out;
}

/** The ruleset with every weapon carrying stats worth `mods` power % each, at a level. */
function dosed(r: Ruleset, level: number, mods: [StatId, number][]): Ruleset {
  const out: Ruleset = structuredClone(r);
  for (const b of out.items)
    if (b.weapon) b.implicit = [...(b.implicit ?? []), ...mods.map(([stat, worth]) => ({ stat, value: worth / affixPrice(out, stat) / itemMod(out, { stat, value: 1 }, level).value }))];
  invalidateRuleset(out);
  return out;
}

const pool = new SimPool();
const mean = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / Math.max(1, xs.length);
for (const w of loadWorlds(dir!)) {
  if (only && only !== '-' && w.id !== only) continue;
  const r = w.r;
  const max = r.progression.maxLevel;
  const levels = levelsArg ? levelsArg.split(',').map(Number) : [Math.ceil(max / 2), max];
  const ids = r.classes.map((c) => c.id);
  const lineups = ids.map((_, i) => Array.from({ length: 4 }, (_, j) => ids[(i + j) % ids.length]!));
  const ctx: TaskContext = { seed: `affixes:${w.id}`, families: w.families };
  // The strength measure and the settings move the creatures' curves at the levels measured, which need knots of their own.
  const withKnot = (k: { level: number; value: number }[], l: number) => (k.some((x) => x.level === l) ? k : [...k, { level: l, value: knot(k, l) }].sort((a, b) => a.level - b.level));
  console.log(`\n== ${w.name} (${w.id}): ${r.classes.map((c) => c.name).join(', ')}; dose ${DOSE} power %, ${FIGHTS} fights each`);
  for (const level of levels) {
    r.curves.monsterHp = withKnot(r.curves.monsterHp, level);
    r.curves.monsterDmg = withKnot(r.curves.monsterDmg, level);
    const hpK: KnobRef = { curve: 'monsterHp', level }, dmgK: KnobRef = { curve: 'monsterDmg', level };
    pool.use(r, ctx);
    const m = await partyStrength(pool, r, { level, classes: lineups, tag: 'affix-base', fights: 64, steps: 5 });
    const set: Settings = { knobs: [[hpK, getKnob(r, hpK) * m], [dmgK, getKnob(r, dmgK) * m]] };
    const lost = async (rr: Ruleset) => {
      pool.use(rr, ctx);
      const jobs = Array.from({ length: FIGHTS }, (_, index): FightJob => ({ scenario: { level, kind: 'normal', difficulty: 'normal' }, tag: 'affix', index, classes: lineups, set }));
      return (await pool.play(jobs)).map((o) => o.hpLost);
    };
    const base = await lost(r);
    const ref = await lost(dosed(r, level, [['power', DOSE]]));
    const refGain = mean(base) - mean(ref);
    console.log(`  level ${level}: creatures x${m.toFixed(2)}, the party loses ${(mean(base) * 100).toFixed(1)}% of its Health; ${DOSE}% Damage saves ${(refGain * 100).toFixed(1)} points`);
    const worth = new Map<string, number>();
    for (const s of stats(r)) {
      const got = await lost(dosed(r, level, s.mods));
      const diff = base.map((b, i) => b - got[i]!);
      const d = mean(diff);
      const se = Math.sqrt(mean(diff.map((x) => (x - d) ** 2)) / diff.length);
      const v = (DOSE * d) / refGain;
      worth.set(s.label, v);
      const [stat] = s.mods.at(-1)!;
      const unit = s.mods.map(([st, dz]) => `${(dz / affixPrice(r, st)).toFixed(statUnit(st) === 'pct' ? 1 : 3)} ${st}`).join(' + ');
      console.log(`    ${s.label.padEnd(18)} ${unit.padEnd(30)} worth ${v.toFixed(1).padStart(6)} ±${((DOSE * se) / refGain).toFixed(1).padEnd(4)} power %   price ${affixPrice(r, stat).toFixed(3).padStart(8)}, measured ${((affixPrice(r, stat) * v) / DOSE).toFixed(3).padStart(8)}`);
    }
    if (worth.has('crit x2 + critDmg')) console.log(`    critDmg beside ${DOSE * 2} power % of crit: worth ${(worth.get('crit x2 + critDmg')! - worth.get('crit x2')!).toFixed(1)} power %`);
  }
}
pool.close();
process.exit(0);
