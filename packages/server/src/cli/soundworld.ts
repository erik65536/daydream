/**
 * Make built worlds' sounds and music again (docs/sound.md), the way a build does: each sound in the world's sound
 * plan (its build's sounds step, kept with the world's pipeline runs) is made on the GPU through the broker and made
 * game-ready. What a world has already is kept, so it can be run again after a stop; `--again` makes every sound anew,
 * from the same plan with new takes (to change the plan, run the world's sounds step again first).
 *
 * The world file is backed up first (data/worlds/<id>/backup/<time>/). Needs the broker with Stable Audio 3 in its
 * ComfyUI (docs/hosting.md, "GPU PC setup").
 *
 * Usage: node src/cli/soundworld.ts <worldId ...> | --all [--again]
 */
import fs from 'node:fs';
import path from 'node:path';
import { listWorlds, loadWorld, saveWorld, worldDir } from '../storage.ts';
import { buildSounds } from '../worldgen/sounds.ts';
import { soundPlan } from '../worldgen/build.ts';

const args = process.argv.slice(2);
const again = args.includes('--again');
const ids = args.includes('--all') ? listWorlds().filter((w) => w.status === 'ready').map((w) => w.id) : args.filter((a) => !a.startsWith('--'));
if (!ids.length) throw new Error('usage: soundworld <worldId ...> | --all [--again]');

for (const id of ids) {
  const w = loadWorld(id);
  if (!w) {
    console.log(`${id}: no such world`);
    continue;
  }
  console.log(`\n${w.concept.title} (${id})`);
  const backup = path.join(worldDir(id), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
  fs.mkdirSync(backup, { recursive: true });
  fs.copyFileSync(path.join(worldDir(id), 'world.json'), path.join(backup, 'world.json'));
  const t0 = Date.now();
  let saved = Date.now();
  await buildSounds(w, soundPlan(w), {
    again,
    report: (m) => console.log(`  ${m}`),
    shouldStop: () => false,
    progress: (f) => process.stdout.write(`\r  ${Math.round(f * 100)}%  `),
    onSound: () => {
      if (Date.now() - saved < 10_000) return;
      saved = Date.now();
      saveWorld(w);
    },
  });
  saveWorld(w);
  console.log(`\n  done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
process.exit(0);
