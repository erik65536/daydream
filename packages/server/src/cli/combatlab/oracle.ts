/**
 * Combat lab: how far an AI plays from the best it could, measured with the real engine.
 *
 * At sampled moments of simulated fights, the fight is replayed up to a fighter's decision and every step worth
 * considering is tried there, each followed by many playouts with fresh dice (the same dice for every step, so they
 * are compared fairly). The steps are ranked on one set of playouts and the best and the AI's own choice are measured
 * again on another, so luck does not flatter the best. Regret is how much more of its side's Health share (heroes'
 * Health kept minus the creatures') the best step keeps than the AI's choice.
 *
 *   node src/cli/combatlab/oracle.ts [worlds dir] [fights per scenario] [playouts] [threads]
 */
import os from 'node:os';
import { writeFileSync } from 'node:fs';
import { Worker, isMainThread, parentPort, workerData } from 'node:worker_threads';
import { Rng } from '@daydream/shared';
import { decide, weigh, type AiAction, type Policy } from '../../game/ai.ts';
import type { Actor } from '../../game/actors.ts';
import { runFight } from '../../rules/sim.ts';
import { SCENARIOS, fightSpec, loadWorlds, type World } from './bench.ts';

interface Job { world: number; level: number; kind: (typeof SCENARIOS)[number]['kind']; fight: number; k: number }
interface Outcome {
  job: Job;
  side: 'heroes' | 'foes';
  actor: string;
  chosen: string;
  best: string;
  /** Health share the best step keeps over the AI's choice, measured on fresh playouts (>= 0 is expected). */
  regret: number;
  /** The AI's own estimate of the same two steps. */
  options: number;
}

const key = (a: AiAction) => (a.kind === 'skill' ? `${a.skillId}>${a.targetId ?? (a.point ? `${a.point.x.toFixed(1)},${a.point.y.toFixed(1)}` : 'self')}` : a.kind === 'move' ? `move ${a.to.x.toFixed(1)},${a.to.y.toFixed(1)}` : a.kind);

/** Value of a finished fight for the heroes: the share of their Health kept minus the share the creatures keep. */
const valueOf = (res: { hpLost: number; foesLeft: number }) => 1 - res.hpLost - res.foesLeft;

function run(w: World, job: Job, at?: { k: number; act: AiAction; seed: string }, probe?: (c: Parameters<Policy>[0], a: Actor) => void) {
  let calls = 0;
  const policy: Policy = (c, a) => {
    const k = calls++;
    if (at && k === at.k) {
      c.host.rng = new Rng(at.seed);
      return at.act;
    }
    if (probe && k === job.k) probe(c, a);
    return decide(c, a);
  };
  const res = runFight(w.r, { ...fightSpec(w, job.level, job.kind, job.fight), policy });
  return { res, calls };
}

function measure(w: World, job: Job, playouts: number): Outcome | null {
  let cands: AiAction[] = [];
  let chosen: AiAction | null = null;
  let side: 'heroes' | 'foes' = 'heroes';
  let actor = '';
  run(w, job, undefined, (c, a) => {
    chosen = decide(c, a);
    side = a.team() === 'players' ? 'heroes' : 'foes';
    actor = `${a.name} (${a.id})`;
    const { options } = weigh(c, a);
    const pick = [...options.slice(0, 7)];
    // A few of the steps the AI ranks low, so its blind spots can show.
    const rest = options.slice(7);
    const rng = new Rng(`pick:${job.world}:${job.fight}:${job.k}`);
    for (let i = 0; i < 3 && rest.length; i++) pick.push(rest.splice(rng.int(0, rest.length - 1), 1)[0]!);
    cands = [...pick.map((o) => o.act), { kind: 'end' }];
  });
  if (!chosen) return null;
  const all = new Map<string, AiAction>();
  for (const a of [chosen as AiAction, ...cands]) all.set(key(a), a);
  const sign = side === 'heroes' ? 1 : -1;
  const play = (act: AiAction, tag: string) => {
    let v = 0;
    for (let s = 0; s < playouts; s++) v += valueOf(run(w, job, { k: job.k, act, seed: `${tag}:${s}` }).res);
    return (sign * v) / playouts;
  };
  const ranked = [...all.entries()].map(([k, act]) => ({ k, act, v: play(act, 'rank') })).sort((p, q) => q.v - p.v);
  const best = ranked[0]!;
  const ck = key(chosen);
  const regret = best.k === ck ? 0 : play(best.act, 'check') - play(chosen, 'check');
  return { job, side, actor, chosen: ck, best: best.k, regret, options: ranked.length };
}

if (isMainThread) {
  const dir = process.argv[2] ?? '../../../../data/worlds';
  const fights = Number(process.argv[3] ?? 3);
  const playouts = Number(process.argv[4] ?? 12);
  const threads = Number(process.argv[5] ?? Math.max(1, os.availableParallelism() - 2));
  const worlds = loadWorlds(dir);
  // Sample two decisions in each fight, from its length when played as it is.
  const jobs: Job[] = [];
  worlds.forEach((w, wi) => {
    for (const sc of SCENARIOS)
      for (let f = 0; f < fights; f++) {
        const level = Math.min(sc.level, w.r.progression.maxLevel);
        const probe: Job = { world: wi, level, kind: sc.kind, fight: f, k: -1 };
        const { calls } = run(w, probe);
        const rng = new Rng(`jobs:${wi}:${sc.level}:${sc.kind}:${f}`);
        for (let j = 0; j < 2; j++) jobs.push({ ...probe, k: rng.int(0, Math.max(0, Math.min(calls - 1, 200))) });
      }
  });
  console.log(`${jobs.length} decisions, ${playouts} playouts per step, ${threads} threads`);
  const t0 = Date.now();
  const results: Outcome[] = [];
  let next = 0;
  await new Promise<void>((resolve) => {
    let live = 0;
    for (let t = 0; t < Math.min(threads, jobs.length); t++) {
      const w = new Worker(new URL(import.meta.url), { workerData: { dir, playouts } });
      live++;
      const feed = () => {
        if (next < jobs.length) w.postMessage(jobs[next++]);
        else {
          void w.terminate();
          if (--live === 0) resolve();
        }
      };
      w.on('message', (o: Outcome | null) => {
        if (o) results.push(o);
        if (results.length % 10 === 0) console.log(`  ${results.length}/${jobs.length} (${Math.round((Date.now() - t0) / 1000)} s)`);
        feed();
      });
      w.on('error', (e) => {
        console.error(e);
        feed();
      });
      feed();
    }
  });
  const mean = (xs: number[]) => (xs.length ? xs.reduce((s, x) => s + x, 0) / xs.length : 0);
  const pct = (x: number) => `${(x * 100).toFixed(1)}%`;
  for (const side of ['heroes', 'foes'] as const) {
    const rs = results.filter((r) => r.side === side);
    console.log(`\n${side}: ${rs.length} decisions, mean regret ${pct(mean(rs.map((r) => r.regret)))}, best was the AI's choice in ${pct(rs.filter((r) => r.best === r.chosen).length / Math.max(1, rs.length))}`);
    worlds.forEach((w, wi) => {
      const x = rs.filter((r) => r.job.world === wi);
      console.log(`  ${w.name.padEnd(28)} ${pct(mean(x.map((r) => r.regret))).padStart(6)}  (${x.length})`);
    });
    const kinds = new Map<string, number[]>();
    for (const r of rs) {
      const k = `${r.chosen.split(/[ >]/)[0] === 'move' ? 'move' : r.chosen === 'end' ? 'end' : r.chosen === 'potion' ? 'potion' : 'skill'} -> ${r.best.startsWith('move') ? 'move' : r.best === 'end' ? 'end' : r.best === 'potion' ? 'potion' : 'skill'}`;
      kinds.set(k, [...(kinds.get(k) ?? []), r.regret]);
    }
    for (const [k, v] of [...kinds].sort((p, q) => q[1].reduce((s, x) => s + x, 0) - p[1].reduce((s, x) => s + x, 0))) console.log(`  chose ${k.padEnd(18)} ${String(v.length).padStart(4)} decisions, regret total ${pct(v.reduce((s, x) => s + x, 0))}`);
  }
  console.log('\nWorst decisions:');
  for (const r of [...results].sort((p, q) => q.regret - p.regret).slice(0, 12)) console.log(`  ${pct(r.regret).padStart(6)} ${worlds[r.job.world]!.name} L${r.job.level} ${r.job.kind} fight ${r.job.fight} step ${r.job.k}: ${r.actor} chose ${r.chosen}, best ${r.best}`);
  const out = process.env.ORACLE_OUT;
  if (out) writeFileSync(out, JSON.stringify(results, null, 1));
  console.log(`\n${Math.round((Date.now() - t0) / 1000)} s`);
} else {
  const { dir, playouts } = workerData as { dir: string; playouts: number };
  const worlds = loadWorlds(dir);
  parentPort!.on('message', (job: Job) => {
    try {
      parentPort!.postMessage(measure(worlds[job.world]!, job, playouts));
    } catch (e) {
      console.error(e);
      parentPort!.postMessage(null);
    }
  });
}
