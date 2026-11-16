/**
 * Animate a world's characters and creatures by name, or clear a world's animation (see anim/job.ts). Animation is
 * painted through OpenAI's Batch API: this tool asks for the actors named and, with `--wait`, runs the animation
 * job's steps here until every batch is back and the actors are assembled (minutes); without it, the server's
 * worker picks the job up.
 *
 * `--clear` removes every actor's animation from the world (sheets, records, and painting steps): they show their
 * still images again. `--list` lists the actors and their animation state. `--sheets` paints the named actors' clip
 * sheets (attack, hit, death) again, keeping their turnarounds and walks: for actors animated before blows were
 * painted in the views that face the picture's left (about $0.03 an actor that fights at the Batch price).
 *
 * The world file is backed up first (data/worlds/<id>/backup/<time>/).
 *
 * Usage: node src/cli/animate.ts <worldId> [keyPart ...] [--wait] [--sheets] | --clear | --list
 */
import fs from 'node:fs';
import path from 'node:path';
import { loadWorld, saveWorld, worldDir } from '../storage.ts';
import { withCallContext } from '../genai/context.ts';
import { openaiCost, openaiImageUsage } from '../genai/providers.ts';
import { actorSprites } from '../anim/actors.ts';
import { animationState, clearAnimations, markRequested, queueAnimation, repaintSheets, runAnimateJob, workOut } from '../anim/job.ts';
import type { Job } from '../jobs/job.ts';

const args = process.argv.slice(2);
const flags = args.filter((a) => a.startsWith('--'));
const [worldId, ...only] = args.filter((a) => !a.startsWith('--'));
if (!worldId) throw new Error('usage: animate <worldId> [keyPart ...] [--wait] [--sheets] | --clear | --list');
const w = loadWorld(worldId);
if (!w) throw new Error(`no world ${worldId}`);

if (flags.includes('--list')) {
  for (const a of actorSprites(w)) {
    const s = animationState(w, a);
    console.log(`  ${a.key}: ${s.state}${s.error ? ` (${s.error.slice(0, 120)})` : ''}`);
  }
  process.exit(0);
}

const backup = path.join(worldDir(worldId), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(backup, { recursive: true });
fs.copyFileSync(path.join(worldDir(worldId), 'world.json'), path.join(backup, 'world.json'));
console.log(`backed up to ${backup}`);

if (flags.includes('--clear')) {
  const n = clearAnimations(w);
  saveWorld(w);
  console.log(`cleared the animation of ${n} actors`);
  process.exit(0);
}

const keys = actorSprites(w).map((a) => a.key).filter((k) => only.some((o) => k.includes(o)));
if (!keys.length) throw new Error('no actor matches; name some (a part of their key is enough)');
if (flags.includes('--sheets')) repaintSheets(w, keys);
else markRequested(w, keys);
console.log(`asked for: ${keys.join(', ')}`);
if (!flags.includes('--wait')) {
  queueAnimation(w, { id: w.ownerId, name: w.ownerName });
  console.log('queued: the worker paints them');
  process.exit(0);
}

// The job's steps here, until nothing is out: a stand-in for the worker's job (log to the console).
const owner = { id: w.ownerId, name: w.ownerName };
const job = { owner, cancelled: false, push: (m: string) => console.log(`  ${new Date().toISOString().slice(11, 19)} ${m}`) } as unknown as Job;
const out = () => workOut(worldId);
// A run with nothing out and nothing new asked for three times over is stuck: stop.
for (let idle = 0; idle < 3; ) {
  await withCallContext({ priority: 'background', userId: owner.id }, () => runAnimateJob(job, worldId, { queue: false }));
  const now = loadWorld(worldId)!;
  const left = keys.filter((k) => animationState(now, now.assets[k]!).state === 'waiting');
  if (!left.length) break;
  if (out()) (idle = 0), await new Promise((r) => setTimeout(r, 60_000));
  else idle++;
}
const end = loadWorld(worldId)!;
for (const k of keys) {
  const s = animationState(end, end.assets[k]!);
  console.log(`${s.state === 'animated' ? 'ok  ' : 'FAIL'} ${k}: ${s.state}${s.error ? ` (${s.error})` : ''}`);
}
// A console run is not charged to anyone's budget: say what it spent.
console.log(`spent about $${(openaiImageUsage.usd + openaiCost()).toFixed(3)} (${openaiImageUsage.calls} pictures at the Batch price, and the briefs)`);
process.exit(0);
