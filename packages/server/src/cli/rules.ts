/**
 * Write a world's rules anew, or rebalance them, as a job for the job worker (worldgen/build.ts, `runRulesJob`):
 *   - rebalance: the same rules, the balance simulation run again with the current engine. Numbers and how skills
 *     work may change; adventures stay playable and nothing is painted. About ten minutes on the spare cores.
 *   - regenerate: the world's rules steps run again in its own pipeline store, so new classes, skills, and items. The
 *     story, places and people stay; adventures begun under the old rules can no longer be played, and the heroes and
 *     item icons are painted again once it is done.
 * The world's owner pays for it, as for its build. Progress shows on the world page and the GPU page.
 *
 * Usage: node src/cli/rules.ts <worldId> rebalance|regenerate
 */
import { enqueue } from '../jobs/queue.ts';
import { loadWorld } from '../storage.ts';

const [id, mode] = process.argv.slice(2);
if (!id || (mode !== 'rebalance' && mode !== 'regenerate')) throw new Error('usage: node src/cli/rules.ts <worldId> rebalance|regenerate');
const w = loadWorld(id);
if (!w || w.status !== 'ready') throw new Error(`${id}: no such world, or it is still being built.`);
if (mode === 'rebalance' && !w.ruleset) throw new Error(`${id} has no rules to rebalance: regenerate them.`);
const job = enqueue('rules', w.id, { id: w.ownerId, name: w.ownerName }, { mode }, { priority: 5, step: 'Waiting for a free worker' });
console.log(`Queued ${mode === 'rebalance' ? 'a rebalance' : 'new rules'} for "${w.concept.title}" (job ${job.id}); the job worker runs it.`);
