/**
 * Save the rules records of the pipeline's example worlds as the tests' fixtures (test/fixtures/rules/<example>.json,
 * read by `fixtureRules` in test/helpers.ts). Run it from packages/server after the rules steps or their examples
 * change, so the tests compile and balance the rules the steps write now:
 *
 *   node src/cli/dumprules.ts woodland office
 *
 * It reads the records from each example's saved pipeline runs and calls no model.
 */
import fs from 'node:fs';
import path from 'node:path';
import { Pipeline } from '../pipeline/index.ts';
import '../paths.ts';

const NAMES = ['rulesSystems', 'rulesCore', 'rulesStatuses', 'rulesSkills', 'rulesPassives', 'rulesGear', 'rulesItems', 'fightLooks', 'art'];
const pipe = new Pipeline();
const out = path.resolve('test/fixtures/rules');
fs.mkdirSync(out, { recursive: true });
for (const id of process.argv.slice(2)) {
  const ex = pipe.example(id);
  const records = Object.fromEntries(NAMES.map((n) => [n, pipe.record(ex, n).value]));
  for (const [n, v] of Object.entries(records)) if (!v) throw new Error(`${id}: no ${n}`);
  const rulesSystems = records.rulesSystems as Record<string, unknown>;
  delete rulesSystems.surfaces;
  fs.writeFileSync(path.join(out, `${id}.json`), JSON.stringify({ length: ex.input.length, records }, null, 1) + '\n');
  console.log(`${id}: ${(JSON.stringify(records).length / 1024).toFixed(0)} KB`);
}
