/**
 * Combat lab: what healing does in a fight. Plays parties with one healer (and the other classes in turn) against the
 * balance loop's packs and bosses on built worlds' rules, and reports the share of the Health the party loses that its
 * healer gives back, the share potions give back, what one heal mends against its target's most Health, and how the
 * fights end. Each `scale` multiplies every healing skill's healing (as another price of healing in the rules would),
 * without rebalancing. `--rebalance <scale>` also gives potions the rules' share of Health and runs the full balance
 * loop first, as a new build would.
 *   node src/cli/combatlab/healing.ts <worlds dir> [fights per scenario] [scale…] [--rebalance <scale>]
 */
import { Rng, rx, type Ruleset } from '@daydream/shared';
import { MonsterActor, type Actor } from '../../game/actors.ts';
import { makeParty, runFight } from '../../rules/sim.ts';
import { DESIGN_PARTY, buildPack, withDifficulty, type EncounterKind } from '../../rules/encounters.ts';
import { balanceRuleset } from '../../rules/balance.ts';
import { simThreads } from '../../rules/simPool.ts';
import { loadWorlds, type World } from './bench.ts';

const args = process.argv.slice(2);
const flag = args.indexOf('--rebalance');
const rebalance = flag >= 0 ? Number(args.splice(flag, 2)[1]) : 0;
const [dir, n, ...rest] = args;
if (!dir) throw new Error('Usage: healing.ts <worlds dir> [fights per scenario] [scale…] [--rebalance <scale>]');
const fights = Number(n ?? 24);
const scales = rest.map(Number);
/** The share of the drinker's Health a healing potion mends in the rules (worldRules.ts). */
const POTION_HEAL = 0.15;
const SCENARIOS: { level: number; kind: EncounterKind }[] = [{ level: 3, kind: 'normal' }, { level: 6, kind: 'normal' }, { level: 6, kind: 'boss' }];

/** The ruleset with every healing skill's healing scaled. */
function scaled(r: Ruleset, by: number): Ruleset {
  const out: Ruleset = JSON.parse(JSON.stringify(r));
  for (const s of out.skills) s.effects = s.effects.map((e) => (e.kind === 'heal' && e.share === undefined ? { kind: 'heal', coef: e.coef * by } : e));
  return out;
}

function measure(w: World, r: Ruleset, level: number, kind: EncounterKind) {
  const healer = r.classes.find((c) => c.role === 'healer');
  if (!healer) return null;
  const others = r.classes.filter((c) => c !== healer).map((c) => c.id);
  let taken = 0, bySkill = 0, byPotion = 0, wins = 0, hpLost = 0, casts = 0, castShare = 0;
  for (let i = 0; i < fights; i++) {
    const rng = new Rng(`healing:${w.id}:${level}:${kind}:${i}`);
    const classes = [healer.id, ...Array.from({ length: DESIGN_PARTY - 1 }, (_, j) => others[(i + j) % others.length]!)];
    const party = makeParty(r, { classes, level, rng });
    const fam = w.families[i % w.families.length]!;
    const pack = withDifficulty(r, buildPack(r, rng, { heroes: DESIGN_PARTY, level, kind, members: fam.members, depth: 0.5 }), 'normal', rng);
    let actors: Actor[] = [];
    let using: { a: Actor; potion: boolean } | null = null;
    const res = runFight(r, {
      party, pack, potions: kind === 'boss' ? 2 * DESIGN_PARTY : 0, difficulty: 'normal', seed: rng.next().toString(36),
      watch: {
        start: (all) => void (actors = all),
        damaged: (t, _s, amount) => void (!(t instanceof MonsterActor) && (taken += amount)),
        fx: (events) => {
          for (const e of events) {
            // Who heals: the one whose skill or potion this is (a potion's use names no skill).
            const by = (e.kind === 'skill' || e.kind === 'projectile') && actors.find((x) => x.id === e.sourceId);
            if (by) using = { a: by, potion: !e.skillId };
            if (e.kind !== 'damage' || e.damage?.type !== 'heal' || !using) continue;
            const t = actors.find((x) => x.id === e.targetId);
            if (!t || t instanceof MonsterActor) continue;
            if (using.potion) byPotion += e.damage.amount;
            else if (rx(r).cls.get((using.a as { ch?: { classId?: string } }).ch?.classId ?? '')?.role === 'healer') {
              bySkill += e.damage.amount;
              casts++;
              castShare += e.damage.amount / t.stats().maxHp;
            }
          }
        },
      },
    });
    if (res.win) wins++;
    hpLost += res.hpLost;
  }
  const pct = (v: number) => `${Math.round(v * 100)}%`;
  return `${kind} ${level}: healer gives back ${pct(bySkill / Math.max(1, taken))} of the Health lost, potions ${pct(byPotion / Math.max(1, taken))}; a heal mends ${pct(castShare / Math.max(1, casts))} of its target (${casts} heals); won ${pct(wins / fights)}, lost ${pct(hpLost / fights)}`;
}

for (const w of loadWorlds(dir)) {
  for (const by of [1, ...scales]) {
    const r = by === 1 ? w.r : scaled(w.r, by);
    console.log(`${w.name}${by === 1 ? '' : `, healing ×${by}`}`);
    for (const s of SCENARIOS) console.log(`  ${measure(w, r, s.level, s.kind) ?? 'no healer class'}`);
  }
  if (rebalance) {
    const r = scaled(w.r, rebalance);
    for (const it of r.items) if (it.use?.effects.some((e) => e.kind === 'heal')) it.use.effects = it.use.effects.map((e) => (e.kind === 'heal' ? { kind: 'heal', share: POTION_HEAL } : e));
    const report = await balanceRuleset(r, { seed: `healing:${w.id}`, families: w.families, size: 'full', threads: simThreads() });
    const on = report.scenarios.filter((s) => s.ok).length;
    console.log(`${w.name}, healing ×${rebalance} and potions at ${POTION_HEAL * 100}%, rebalanced (${on} of ${report.scenarios.length} scenarios on target):`);
    console.log(`  classes: ${report.classes.map((c) => `${r.classes.find((x) => x.id === c.classId)?.role} ${c.strength} (damage ${c.tune.dmg})`).join(', ')}`);
    for (const s of SCENARIOS) console.log(`  ${measure(w, r, s.level, s.kind) ?? 'no healer class'}`);
  }
}
