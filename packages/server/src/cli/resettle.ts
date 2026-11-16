/**
 * Make a built world's places again with the place pipeline as it is now, and settle them: each place's map is made
 * from its saved steps (draft/places/<zone>/), so only what is missing is painted, read, or repaired; then everything
 * is placed anew (a saved placement for that map is reused), the map is brought to game scale and the navigation
 * grid, people, things, and monster packs are laid out again. Delete a step's files in the draft to redo it. As a
 * build does after its places, the quests are checked against the new layout and experience is solved again from the
 * creatures now placed.
 *
 * The world file and the place images are backed up first (data/worlds/<id>/backup/<time>/). Adventures keep their
 * players, conversations, and quests; positions that are off a place's new ground move to its way in when loaded.
 * A running adventure picks the change up when it next loads (30 s after everyone leaves, or the dev menu's reload).
 *
 * Usage: node src/cli/resettle.ts <worldId> [zoneId ...]
 */
import fs from 'node:fs';
import path from 'node:path';
import { bindWorld } from '../rules/bind.ts';
import { loadWorld, saveWorld, worldAssetDir, worldDir } from '../storage.ts';
import { GpuQueue } from '../worldgen/gpu.ts';
import { placeSeed } from '../worldgen/build.ts';
import { questVerdict } from '../worldgen/questcheck.ts';
import { paintAndRead, settlePlace, sketchOf, worldLook } from '../worldgen/zones.ts';

const [worldId, ...only] = process.argv.slice(2);
if (!worldId) throw new Error('usage: resettle <worldId> [zoneId ...]');
const w = loadWorld(worldId);
if (!w) throw new Error(`no world ${worldId}`);

const backup = path.join(worldDir(worldId), 'backup', new Date().toISOString().replace(/[:.]/g, '-'));
fs.mkdirSync(path.join(backup, 'assets'), { recursive: true });
fs.copyFileSync(path.join(worldDir(worldId), 'world.json'), path.join(backup, 'world.json'));
const assets = worldAssetDir(worldId);
for (const f of fs.existsSync(assets) ? fs.readdirSync(assets) : []) if (f.startsWith('place_')) fs.copyFileSync(path.join(assets, f), path.join(backup, 'assets', f));
console.log(`backed up to ${backup}`);

const gpu = new GpuQueue();
for (const z of w.zones) {
  if (only.length && !only.includes(z.id)) continue;
  console.log(`${z.name} (${z.id})`);
  const ctx = { gpu, priority: 0, seed: placeSeed(w.id, z.id), report: (m: string) => console.log(`  ${m}`) };
  const painted = await paintAndRead(worldLook(w), sketchOf(w, z), ctx);
  // What the last settling added is laid out again.
  z.spawns = [];
  await settlePlace(w, z, painted, ctx);
  saveWorld(w);
  console.log(`  settled: ${Math.round(z.width)}×${Math.round(z.height)} m, ${z.features.length} features, ${z.spawns.length} monsters`);
}
// What a build does once its places are furnished (build.ts): every quest can still be finished, and experience is
// solved from the creatures now placed.
const verdict = questVerdict(w), problems = [...verdict.story, ...verdict.side];
for (const p of problems) console.log(`Quest check: ${w.quests.find((q) => q.id === p.questId)?.title ?? p.questId} cannot be finished: ${p.text}`);
if (!problems.length) console.log(`Quest check: all ${w.quests.length} quests can be finished.`);
bindWorld(w, w.ruleset);
saveWorld(w);
process.exit(0);
