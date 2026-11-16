/**
 * Check built worlds for quests that cannot be finished (worldgen/questcheck.ts), without changing anything.
 * Usage: node src/cli/questcheck.ts [worldId | path/to/world.json ...] [--data <data dir>]
 * With no world named, every world in the data folder (DAYDREAM_DATA_DIR, or --data) is checked. Reads the world
 * files only, never the database, so it is safe beside a running server.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { WorldDefinition } from '@daydream/shared';
import { DATA_DIR } from '../paths.ts';
import { checkQuests } from '../worldgen/questcheck.ts';

const args = process.argv.slice(2);
const dataAt = args.indexOf('--data');
const data = dataAt >= 0 ? path.resolve(args[dataAt + 1]!) : DATA_DIR;
const named = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--data');
const worldsDir = path.join(data, 'worlds');
const files = named.length
  ? named.map((a) => (a.endsWith('.json') ? a : path.join(worldsDir, a, 'world.json')))
  : fs.readdirSync(worldsDir).map((d) => path.join(worldsDir, d, 'world.json')).filter((f) => fs.existsSync(f));

let total = 0;
for (const file of files) {
  const w = JSON.parse(fs.readFileSync(file, 'utf8')) as WorldDefinition;
  const problems = checkQuests(w);
  total += problems.length;
  const main = w.quests.filter((q) => q.main).length;
  console.log(`\n${w.id} "${w.concept?.title ?? '?'}" (${w.status}): ${w.quests.length} quests (${main} main), ${problems.length} problem${problems.length === 1 ? '' : 's'}`);
  for (const p of problems) {
    const q = w.quests.find((x) => x.id === p.questId);
    const o = q?.objectives.find((x) => x.id === p.objectiveId);
    console.log(`  ${q?.main ? 'story' : 'side '} ${p.questId}${o ? `/${o.id} (${o.type}: "${o.description}")` : ''}${q ? ` "${q.title}"` : ''}\n        ${p.text}`);
  }
}
console.log(`\n${files.length} world${files.length === 1 ? '' : 's'}, ${total} problem${total === 1 ? '' : 's'}.`);
