/**
 * Generate one world end to end with the configured models:
 *   node src/cli/genlive.ts "<theme>" [--prompt <topic> "..."]... [--size tiny|small|medium|large] [--length brief|short|medium|long|epic]
 *     [--fast-travel] [--still] [--owner <userId> <name>] [--resume <worldId>]
 * (topics: story, places, people, monsters, rules, art; --still builds it without animation). Once the world is built
 * its animation is queued, as after a build on the server: the server's worker paints it in the background.
 */
import { PROMPT_TOPICS, type GameLength, type PromptTopic, type WorldSize } from '@daydream/shared';
import { queueAnimation } from '../anim/job.ts';
import { WorldGenJob, runGeneration } from '../worldgen/build.ts';
import { loadWorld } from '../storage.ts';
import { openaiCost, openaiUsage } from '../genai/providers.ts';

const args = process.argv.slice(2);
const opt = (name: string, n = 1) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 ? args.slice(i + 1, i + 1 + n) : undefined;
};
const theme = args[0] && !args[0].startsWith('--') ? args[0] : 'A fog-bound coastal barony where drowned bells ring under the tide and smugglers bargain with things from the deep.';
const prompts = args.flatMap((a, i) => (a === '--prompt' && PROMPT_TOPICS.includes(args[i + 1] as PromptTopic) && args[i + 2] ? [{ topic: args[i + 1] as PromptTopic, text: args[i + 2]! }] : []));
const [ownerId, ownerName] = opt('owner', 2) ?? ['cli', 'CLI'];
// --resume <worldId> continues a build that stopped (every finished step is kept; the world is laid out from its id).
const resumeId = opt('resume')?.[0];
const id = resumeId ?? `w_live${Date.now().toString(36)}`;
const input = loadWorld(id)?.input ?? {
  theme, prompts, size: (opt('size')?.[0] ?? 'small') as WorldSize, length: (opt('length')?.[0] ?? 'short') as GameLength, communication: 2 as const,
  rules: args.includes('--fast-travel') ? { fastTravel: true } : undefined,
  animate: !args.includes('--still'),
};
const job = new WorldGenJob(id, input, { id: ownerId!, name: ownerName ?? 'CLI' });
const t0 = Date.now();
let lastPhase = '';
const timer = setInterval(() => {
  // Stages run side by side: show every active one, and the overall progress.
  const active = job.phases.filter((p) => p.status === 'active').map((p) => `${p.label}${p.total ? ` ${p.done ?? 0}/${p.total}` : ''}`);
  const label = `${Math.round(job.progress * 100)}% ${active.join(' · ') || job.step}`;
  if (label !== lastPhase) console.log(`[${((Date.now() - t0) / 60000).toFixed(1)}m] >> ${label}`);
  lastPhase = label;
}, 5000);
try {
  await runGeneration(job);
  console.log(`DONE ${id} in ${((Date.now() - t0) / 60000).toFixed(1)} min`);
  console.log(`OpenAI usage: ${JSON.stringify(openaiUsage)} ≈ $${openaiCost().toFixed(3)}`);
  const w = loadWorld(id);
  if (w?.status === 'ready' && w.input.animate) {
    queueAnimation(w, { id: w.ownerId, name: w.ownerName });
    console.log('Animation queued: the server\'s worker paints it.');
  }
} catch (e) {
  console.error('FAILED', e);
  process.exitCode = 1;
} finally {
  clearInterval(timer);
}
