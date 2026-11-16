/**
 * Paint (or repaint) a world's art outside the web server, so a long run survives server restarts.
 * Saves as it goes; the running server picks the changes up. Usage: node src/cli/paintworld.ts <worldId> [--only key1,key2,...]
 * (--only paints just those assets when they are missing, failed, or changed.)
 *
 * Only the art's own records are written back, onto the world as it is on disk then: a run takes long, and what
 * the server saved meanwhile (an actor's animation, say) stays.
 */
import { loadWorld, saveWorld } from '../storage.ts';
import { generateArt, linkAssets } from '../worldgen/art.ts';

const [worldId] = process.argv.slice(2).filter((a, i, all) => !a.startsWith('--') && all[i - 1] !== '--only');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1]!.split(',')) : undefined;
if (!worldId) throw new Error('usage: paintworld <worldId> [--only key1,key2,...]');
const w = loadWorld(worldId);
if (!w) throw new Error(`world ${worldId} not found`);
const t0 = Date.now();
let lastSave = Date.now();
/** The records this run changed, by key (as JSON when it started, to tell). */
const before = new Map(Object.entries(w.assets).map(([k, a]) => [k, JSON.stringify(a)]));
function save() {
  const now = loadWorld(worldId!) ?? w!;
  for (const [k, a] of Object.entries(w!.assets)) if (before.get(k) !== JSON.stringify(a)) now.assets[k] = a;
  linkAssets(now);
  saveWorld(now);
}
await generateArt(w, {
  only,
  report: (msg) => console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] ${msg}`),
  onAsset: () => {
    if (Date.now() - lastSave > 10_000) {
      save();
      lastSave = Date.now();
    }
  },
});
linkAssets(w);
save();
const assets = Object.values(w.assets);
console.log(`Done in ${((Date.now() - t0) / 60000).toFixed(1)} min: ${assets.filter((a) => a.status === 'ok').length} ok, ${assets.filter((a) => a.status === 'failed').length} failed of ${assets.length}.`);
