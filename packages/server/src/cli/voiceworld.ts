/**
 * Make built worlds' voices again (docs/voices.md), the way a build does: every person, boss, and the narrator is
 * designed a voice from how the build described them, and the lines known before play are spoken, on the GPU through
 * the broker. What a world has already is kept, so it can be run again after a stop.
 *
 * The world file is backed up first (data/worlds/<id>/backup/<time>/). Needs GPU speech (`speech.gpu`) and the broker
 * with its speech adapter; Pocket TTS (`speech.cpu`) measures the voices' level on the CPU.
 *
 * Usage: node src/cli/voiceworld.ts <worldId ...> | --all
 */
import fs from 'node:fs';
import path from 'node:path';
import { listWorlds, loadWorld, saveWorld, worldDir } from '../storage.ts';
import { buildVoices } from '../worldgen/voices.ts';

const args = process.argv.slice(2);
const ids = args.includes('--all') ? listWorlds().filter((w) => w.status === 'ready').map((w) => w.id) : args.filter((a) => !a.startsWith('--'));
if (!ids.length) throw new Error('usage: voiceworld <worldId ...> | --all');

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
  await buildVoices(w, { report: (m) => console.log(`  ${m}`), shouldStop: () => false, tag: { worldId: id, kind: 'cli', label: 'voiceworld' } });
  saveWorld(w);
  console.log(`  done in ${Math.round((Date.now() - t0) / 1000)} s`);
}
process.exit(0);
