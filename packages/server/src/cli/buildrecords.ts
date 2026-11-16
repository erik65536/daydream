/**
 * What building a world took, from the records kept with it (worldgen/metrics.ts): each job's time, dollars, pictures,
 * GPU time and tries, step by step and by model purpose, beside what the creation page estimated for its size. Reads
 * the world's files only, so it is safe beside a running server.
 * Usage: node src/cli/buildrecords.ts <worldId> [--steps] [--json]
 *   --steps: every step, not only the twelve that cost most.
 *   --json: the records as they are kept.
 * For a study of one build in detail (CPU time, GPU samples, each call), see scripts/buildcost.mjs and DAYDREAM_METER.
 */
import { buildEstimate, type GameLength, type WorldSize } from '@daydream/shared';
import type { Tally } from '../genai/meter.ts';
import { loadWorld } from '../storage.ts';
import { measuredRates, worldMetrics } from '../worldgen/metrics.ts';

const args = process.argv.slice(2);
const id = args.find((a) => !a.startsWith('--'));
if (!id) throw new Error('usage: node src/cli/buildrecords.ts <worldId> [--steps] [--json]');
const w = loadWorld(id);
const records = worldMetrics(id);
if (args.includes('--json')) {
  console.log(JSON.stringify(records, null, 1));
  process.exit(0);
}
if (!records.length) throw new Error(`${id} has no build records (a world built before they were kept has none).`);

const min = (ms = 0) => `${(ms / 60_000).toFixed(1)} min`;
const usd = (d = 0) => `$${d.toFixed(d < 0.1 ? 4 : 2)}`;
const line = (name: string, t: Tally) =>
  `  ${name.padEnd(28).slice(0, 28)} ${usd(t.usd).padStart(9)} ${String(t.calls ?? 0).padStart(5)} calls ${String(t.images ?? 0).padStart(4)} pictures ${min(t.gpuMs).padStart(10)} GPU ${min(t.ms).padStart(10)} in steps${t.failed ? `  ${t.failed} of ${t.tries} tries failed` : ''}`;

console.log(`${w?.concept.title ?? id} (${id}), ${w?.input.size} ${w?.input.length}`);
for (const m of records) {
  console.log(`\n${m.kind} ${m.job}: ${m.status}, ${min(m.activeMs)} running, ${usd(m.total.usd)}, ${m.total.images ?? 0} pictures, ${min(m.total.gpuMs)} of GPU`);
  if (m.counts) console.log(`  holds ${Object.entries(m.counts).map(([k, v]) => `${v} ${k}`).join(', ')}`);
  const steps = Object.entries(m.steps).sort((a, b) => (b[1].usd ?? 0) + (b[1].gpuMs ?? 0) / 6e6 - ((a[1].usd ?? 0) + (a[1].gpuMs ?? 0) / 6e6));
  console.log(' by step:');
  for (const [s, t] of args.includes('--steps') ? steps : steps.slice(0, 12)) console.log(line(s, t));
  console.log(' by purpose:');
  for (const [p, t] of Object.entries(m.purposes)) console.log(line(p, t));
}
if (w) {
  const e = buildEstimate(w.input.size as WorldSize, w.input.length as GameLength, measuredRates()?.rates);
  console.log(`\nEstimated for its size: ${min(e.hours * 3_600_000)} until playable, ${usd(e.usd)}; animation ${min(e.animationHours * 3_600_000)}, ${usd(e.animationUsd)}.`);
}
