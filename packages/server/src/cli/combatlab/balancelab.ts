/**
 * Combat lab: run the balance loop (rules/balance.ts) on built worlds' rules with today's AI, without any model call,
 * and compare it with the balance the world has (time, fights, scenarios on target), and two seeds with each other
 * (how much the fitted settings move with the dice alone).
 *   node src/cli/combatlab/balancelab.ts <worlds dir> <worldId,...> [seeds a,b] [out.json]
 * BALANCE_SIZE=quick plays a small balance (to check the loop); BALANCE_LOG=1 prints its progress.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Ruleset, WorldDefinition } from '@daydream/shared';
import { balanceRuleset, type BalanceSize } from '../../rules/balance.ts';

const dir = process.argv[2]!;
const ids = process.argv[3]!.split(',');
const seeds = (process.argv[4] ?? 'a,b').split(',');
const outFile = process.argv[5];

const CURVES = ['monsterHp', 'monsterDmg'] as const;
const summary: Record<string, unknown> = {};
for (const id of ids) {
  const w = JSON.parse(readFileSync(join(dir, id, 'world.json'), 'utf8')) as WorldDefinition;
  const families = w.families.map((f) => ({ members: f.members.map((m) => ({ fighter: m.fighter, classId: m.classId })) }));
  const old = w.ruleset.balance!;
  console.log(`\n== ${w.ruleset.name} (${id}): last balance ${Math.round(old.durationMs / 1000)} s, ${old.fights} fights, ${old.scenarios.filter((s: { ok: boolean }) => s.ok).length}/${old.scenarios.length} on target`);
  const runs: { seed: string; r: Ruleset; s: number }[] = [];
  for (const seed of seeds) {
    const r: Ruleset = JSON.parse(JSON.stringify(w.ruleset));
    const t0 = Date.now();
    let said = '';
    const rep = await balanceRuleset(r, {
      seed: `${w.id}:${seed}`, families, size: (process.env.BALANCE_SIZE as BalanceSize | undefined) ?? 'full',
      onProgress: (m, f) => {
        if (process.env.BALANCE_LOG && m !== said) console.log(`    ${Math.round((Date.now() - t0) / 1000)} s ${Math.round(f * 100)}% ${(said = m)}`);
      },
    });
    const s = (Date.now() - t0) / 1000;
    runs.push({ seed, r, s });
    console.log(`  seed ${seed}: ${Math.round(s)} s, ${rep.fights} fights, ${rep.scenarios.filter((x) => x.ok).length}/${rep.scenarios.length} on target`);
    for (const x of rep.scenarios) console.log(`    ${x.ok ? ' ' : '!'} ${x.label.padEnd(40)} win ${Math.round(x.winRate * 100)}% lost ${Math.round(x.hpLost * 100)}% rounds ${x.rounds.toFixed(1)}`);
    for (const f of rep.findings.slice(0, 6)) console.log(`    finding: ${f.text}`);
  }
  // How far the fitted curves of the two seeds are apart (ratio, averaged over their levels).
  if (runs.length > 1) {
    const [a, b] = runs;
    for (const c of CURVES) {
      const ka = a!.r.curves[c], kb = b!.r.curves[c];
      const ratios = ka.map((k) => { const o = kb.find((x) => x.level === k.level); return o ? Math.abs(Math.log(k.value / o.value)) : 0; });
      console.log(`  ${c}: seeds differ by ${(100 * (Math.exp(ratios.reduce((s, x) => s + x, 0) / Math.max(1, ratios.length)) - 1)).toFixed(1)}% on average; ${ka.map((k) => `${k.level}:${k.value.toFixed(2)}`).join(' ')} | ${kb.map((k) => `${k.level}:${k.value.toFixed(2)}`).join(' ')} | old ${w.ruleset.curves[c].map((k: { level: number; value: number }) => `${k.level}:${k.value.toFixed(2)}`).join(' ')}`);
    }
    for (const k of ['hp', 'dmg'] as const) console.log(`  boss ${k}: ${a!.r.boss[k].map((x) => x.value.toFixed(2)).join(' ')} | ${b!.r.boss[k].map((x) => x.value.toFixed(2)).join(' ')} | old ${w.ruleset.boss[k].map((x: { value: number }) => x.value.toFixed(2)).join(' ')}`);
  }
  summary[id] = runs.map((x) => ({ seed: x.seed, seconds: x.s, report: x.r.balance, curves: x.r.curves, boss: x.r.boss, ruleset: x.r }));
}
if (outFile) writeFileSync(outFile, JSON.stringify(summary));
process.exit(0);
