/**
 * Combat lab: one of bench.ts's fights with a log of every AI step (who, what, at whom, Health left), for three
 * rounds from `from round` (0: from the start).
 *   node src/cli/combatlab/trace.ts <worlds dir> <world index> <level> <normal|boss> <fight> [from round]
 * WEIGH=1 also prints each step's options and their values; BOARD=1 with it prints the projection the AI judged by.
 */
import { decide, weigh, type AiAction, type Policy } from '../../game/ai.ts';
import type { Actor } from '../../game/actors.ts';
import { indexOf, project, type Board } from '../../game/tactics.ts';
import { runFight } from '../../rules/sim.ts';
import type { EncounterKind } from '../../rules/encounters.ts';
import { fightSpec, loadWorlds } from './bench.ts';

const [dir, worldIx, level, kind, fight, fromArg] = process.argv.slice(2);
const w = loadWorlds(dir!)[Number(worldIx)]!;
const from = Number(fromArg ?? 0);

const actText = (a: AiAction) => (a.kind === 'skill' ? `${a.skillId}>${a.targetId ?? ''}` : a.kind === 'move' ? `move ${a.to.x.toFixed(1)},${a.to.y.toFixed(1)}` : a.kind);

/** The projection the AI judged by, as `weigh` built it (turn order and all). */
function board(b: Board, a: Actor) {
  const n = b.units.length;
  const out = { walk: 0, log: [] as string[] };
  console.log(`     value ${project(b, indexOf(b, a), out).toFixed(4)}`);
  for (const l of out.log) console.log(`       ${l}`);
  b.units.forEach((u, i) => {
    const rates = Array.from(b.s.rate.slice(i * n, i * n + n)).map((x) => x.toFixed(0)).join(',');
    console.log(`     ${u.actor.name} side ${u.side} hp ${Math.round(u.hp)} reach ${u.reach.toFixed(1)} range ${u.range} rates ${rates} heal ${b.s.heal[i]!.toFixed(0)} statuses ${u.actor.statuses.map((x) => x.id).join(',')}`);
  });
}

const policy: Policy = (c, a) => {
  const act = decide(c, a);
  if (c.round < from || c.round >= from + 3) return act;
  if (process.env.WEIGH) {
    const { stay, options, board: b } = weigh(c, a);
    if (process.env.BOARD && b) board(b, a);
    console.log(`   stay ${stay.toFixed(4)}  ${options.slice(0, 6).map((o) => `${actText(o.act)} ${o.value.toFixed(4)}`).join(' | ')}`);
  }
  const t = act.kind === 'skill' && act.targetId ? c.participants().find((x) => x.id === act.targetId) : undefined;
  console.log(`r${c.round} ${a.name}(${a.id}) hp ${Math.round(a.hp)} ap ${a.ap} @${a.x.toFixed(1)},${a.y.toFixed(1)} -> ${actText(act)}${t ? ` ${t.name} hp ${Math.round(t.hp)}` : ''}`);
  return act;
};

console.log(runFight(w.r, { ...fightSpec(w, Number(level), kind as EncounterKind, Number(fight)), policy }));
