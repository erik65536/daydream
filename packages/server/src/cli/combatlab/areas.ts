/**
 * Combat lab: what area skills do in the balance loop's kind of fights. For every damaging skill use it counts the
 * fighters struck and the share of their side's Health it took, so an area's real catch can be compared with the catch
 * it was priced for (1.7 for a small area, 2.4 for a large one), and a blow that takes most of a party at once shows up.
 *   node src/cli/combatlab/areas.ts <worlds dir> [world id or -] [fights per scenario] [levels, e.g. 1,3,5]
 */
import { MonsterActor, type Actor } from '../../game/actors.ts';
import type { Combat } from '../../game/combat.ts';
import { runFight } from '../../rules/sim.ts';
import type { EncounterKind } from '../../rules/encounters.ts';
import { fightSpec, loadWorlds } from './bench.ts';

const [dir, only, nArg, levelsArg] = process.argv.slice(2);
const N = Number(nArg ?? 24);
const pct = (x: number) => `${Math.round(x * 100)}%`.padStart(4);

/** One side's damaging skill uses. */
interface Side { uses: number; areaUses: number; caught: number; hist: number[]; areaShare: number; singleUses: number; singleShare: number; worst: number; multiDown: number; perHit: number; hits: number; hitMax: number; singleHit: number; singleHits: number }
const side = (): Side => ({ uses: 0, areaUses: 0, caught: 0, hist: [0, 0, 0, 0, 0, 0], areaShare: 0, singleUses: 0, singleShare: 0, worst: 0, multiDown: 0, perHit: 0, hits: 0, hitMax: 0, singleHit: 0, singleHits: 0 });
const foe = (a: Actor) => a instanceof MonsterActor;

for (const w of loadWorlds(dir!)) {
  if (only && only !== '-' && w.id !== only) continue;
  console.log(`\n== ${w.name} (${w.id})`);
  const max = w.r.progression.maxLevel;
  const levels = levelsArg ? levelsArg.split(',').map(Number) : [...new Set([1, 2, Math.ceil(max / 2), max])];
  for (const level of levels)
    for (const kind of ['normal', 'boss'] as EncounterKind[]) {
      const s = { hero: side(), foe: side() };
      let wins = 0, hp = 0, firstRound = 0, wiped = 0;
      for (let i = 0; i < N; i++) {
        const spec = fightSpec(w, level, kind, i);
        let combat: Combat | null = null;
        const pool = { hero: 1, foe: 1 };
        // One action: a skill use and the blows its user lands until it acts again.
        let cur: { by: Actor; area: boolean; hit: Map<Actor, number>; dealt: number; downs: number } | null = null;
        let round1 = 0;
        const close = () => {
          if (!cur || cur.dealt <= 0) return void (cur = null);
          const t = s[foe(cur.by) ? 'foe' : 'hero'];
          const share = cur.dealt / pool[foe(cur.by) ? 'hero' : 'foe'];
          // Each struck fighter's loss as a share of its own Health.
          for (const [who, n] of cur.hit) {
            const own = n / Math.max(1, who.stats().maxHp);
            if (cur.area) {
              t.perHit += own;
              t.hits++;
              t.hitMax = Math.max(t.hitMax, own);
            } else {
              t.singleHit += own;
              t.singleHits++;
            }
          }
          if (cur.area) {
            t.areaUses++;
            t.caught += cur.hit.size;
            t.hist[Math.min(5, cur.hit.size)]!++;
            t.areaShare += share;
          } else {
            t.singleUses++;
            t.singleShare += share;
          }
          t.worst = Math.max(t.worst, share);
          if (cur.downs >= 2) t.multiDown++;
          cur = null;
        };
        const res = runFight(w.r, {
          ...spec,
          watch: {
            start(actors, c) {
              combat = c;
              for (const a of actors) pool[foe(a) ? 'foe' : 'hero'] += a.stats().maxHp;
            },
            skill(a, skill) {
              close();
              if (!skill.effects.some((e) => e.kind === 'damage')) return;
              s[foe(a) ? 'foe' : 'hero'].uses++;
              cur = { by: a, area: !!skill.radius, hit: new Map(), dealt: 0, downs: 0 };
            },
            damaged(target, source, amount) {
              if (amount <= 0) return;
              if (cur && source === cur.by) {
                cur.hit.set(target, (cur.hit.get(target) ?? 0) + amount);
                cur.dealt += amount;
                if (target.hp <= 0) cur.downs++;
              }
              if (!foe(target) && (combat?.round ?? 0) <= 1) round1 += amount;
            },
          },
        });
        close();
        if (res.win) wins++;
        if (res.downed >= spec.party.length) wiped++;
        hp += res.hpLost;
        firstRound += round1 / pool.hero;
      }
      const line = (name: string, t: Side) => `${name} area ${t.areaUses}/${t.uses} uses, catch ${(t.caught / Math.max(1, t.areaUses)).toFixed(2)} [${t.hist.slice(1).join(' ')}], area ${pct(t.areaShare / Math.max(1, t.areaUses))} vs single ${pct(t.singleShare / Math.max(1, t.singleUses))} of the side a use, worst ${pct(t.worst)}, downed 2+ at once ${t.multiDown}; a blow takes ${pct(t.perHit / Math.max(1, t.hits))} of its target's Health from an area (most ${pct(t.hitMax)}), ${pct(t.singleHit / Math.max(1, t.singleHits))} from one target`;
      console.log(`L${level} ${kind.padEnd(6)} win ${pct(wins / N)} Health lost ${pct(hp / N)} wiped ${wiped}/${N}, lost in round 1 ${pct(firstRound / N)}`);
      console.log(`    ${line('creatures', s.foe)}`);
      console.log(`    ${line('heroes   ', s.hero)}`);
    }
}
