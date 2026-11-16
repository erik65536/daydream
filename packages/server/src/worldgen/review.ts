/**
 * The review before a world is built: the build's first steps write its concept and choose its rule systems from the
 * owner's description, and the owner looks them over on the creation page. They may describe it again, which writes
 * again only the steps the change reaches, or set any system by hand (the page keeps that; it becomes their choice in
 * the input). Nothing is saved as a world until they create it: then the reviewed runs move into the new world's
 * pipeline store and its build carries on from them.
 *
 * A review's runs wait in a scratch folder of their own (data/cache/reviews/<id>/), which a later review clears once a
 * day has passed. A system set by hand is the owner's choice (RulesChoices), which the rules systems step can only
 * answer with, so no model is asked again: its answer is amended to the choice (pipeline/run.ts, amendStep).
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { ReviewView, RulesChoices, RuleSystems, WorldInput } from '@daydream/shared';
import { DATA_DIR } from '../paths.ts';
import { withCallContext } from '../genai/context.ts';
import { deleteWorld, purgeTrashEntry, saveWorld, worldDir } from '../storage.ts';
import { Pipeline } from '../pipeline/index.ts';
import { buildWorld, placeholderWorld, worldExample, worldPipeline, TEXT_CAP_USD } from './build.ts';
import type { JobMetrics } from './metrics.ts';
import type { Tally } from '../genai/meter.ts';

/** The steps the owner reviews (with every step they read, which runs first). */
const REVIEWED = ['concept', 'rulesSystems'];

const REVIEWS = path.join(DATA_DIR, 'cache', 'reviews');
/** A review left this long is cleared. */
const KEEP_MS = 24 * 3600_000;
const ID = /^r_[0-9a-f]{16}$/;

/** A review being written now cannot be written again at the same time. */
export class ReviewBusy extends Error {}
/** A review that is gone (cleared, or someone else's). */
export class NoReview extends Error {}

const dirOf = (id: string) => path.join(REVIEWS, id);
/**
 * A review's runs, at the standard tier: the owner is waiting for them (about 20 seconds, where flex took up to a minute). The build keeps
 * them all the same, since a run's freshness does not depend on the tier it was served at.
 */
const pipelineOf = (id: string) => new Pipeline({ runs: dirOf(id), cap: TEXT_CAP_USD, tier: 'default' });

const writing = new Set<string>();

/** The review an owner may use: theirs, and still there. */
function ownReview(id: string, ownerId: string) {
  if (!ID.test(id)) throw new NoReview('No such review.');
  try {
    if ((JSON.parse(fs.readFileSync(path.join(dirOf(id), 'owner.json'), 'utf8')) as { ownerId: string }).ownerId === ownerId) return;
  } catch {
    // gone
  }
  throw new NoReview('This review has expired. Write the world again.');
}

/** Clear reviews left more than a day ago. */
function clearOld() {
  if (!fs.existsSync(REVIEWS)) return;
  for (const d of fs.readdirSync(REVIEWS)) {
    const at = fs.statSync(dirOf(d)).mtimeMs;
    if (Date.now() - at > KEEP_MS) fs.rmSync(dirOf(d), { recursive: true, force: true });
  }
}

/**
 * Write the steps of a review for the owner's input: a new review, or one they had, whose steps the input no longer
 * matches are written again (none, when nothing they read changed). The owner's budget pays.
 */
export async function writeReview(ownerId: string, input: WorldInput, id?: string): Promise<ReviewView> {
  if (id) ownReview(id, ownerId);
  else {
    clearOld();
    id = `r_${crypto.randomBytes(8).toString('hex')}`;
    fs.mkdirSync(dirOf(id), { recursive: true });
    fs.writeFileSync(path.join(dirOf(id), 'owner.json'), JSON.stringify({ ownerId }));
  }
  if (writing.has(id)) throw new ReviewBusy('The world is still being written.');
  writing.add(id);
  try {
    const pipe = pipelineOf(id), ex = { id, input };
    applyChoices(pipe, ex, writtenWith(id)?.rules);
    await withCallContext({ priority: 'owner', userId: ownerId }, () => pipe.runAll(ex, { only: pipe.upstream(ex, REVIEWED), stale: true, tries: 2 }));
    fs.writeFileSync(path.join(dirOf(id), 'input.json'), JSON.stringify(input));
    return view(pipe, id, input);
  } finally {
    writing.delete(id);
  }
}

/**
 * The choices the owner set by hand since the rules systems step answered (with `before`), amended into its answer
 * when its request differs only by them (the same input but for the choices): no model is asked again.
 */
function applyChoices(pipe: Pipeline, ex: { id: string; input: WorldInput }, before: RulesChoices | undefined) {
  const answer = pipe.store.latest(ex.id, 'rulesSystems')?.output as RuleSystems | undefined;
  if (!answer || pipe.status(ex, ['rulesSystems']).rulesSystems?.state !== 'stale') return;
  const answered = { id: ex.id, input: { ...ex.input, rules: before } };
  if (pipe.status(answered, ['rulesSystems']).rulesSystems?.state === 'fresh') pipe.amend(ex, 'rulesSystems', withChoices(answer, ex.input.rules ?? {}));
}

/** The input a review was last written for. */
function writtenWith(id: string): WorldInput | undefined {
  try {
    return JSON.parse(fs.readFileSync(path.join(dirOf(id), 'input.json'), 'utf8')) as WorldInput;
  } catch {
    return undefined;
  }
}

/** What the owner sees of a review: the concept, the systems, and what it cost; the step that failed, if one did. */
function view(pipe: Pipeline, id: string, input: WorldInput): ReviewView {
  const ex = { id, input };
  const ids = pipe.upstream(ex, REVIEWED);
  const status = pipe.status(ex, ids);
  const failed = ids.find((s) => status[s]!.state !== 'fresh');
  const latest = (step: string) => pipe.store.latest(id, step)?.output;
  return {
    id,
    concept: latest('concept') as ReviewView['concept'],
    systems: latest('rulesSystems') as RuleSystems | undefined,
    usd: ids.flatMap((s) => pipe.store.list(id, s)).reduce((n, r) => n + r.usage.usd, 0),
    ...(failed && { failed: { step: failed, error: status[failed]!.why ?? 'it did not finish' } }),
  };
}

/** An answer with the owner's choices in it: each choice made replaces what the step chose. */
export function withChoices(answer: RuleSystems, rules: RulesChoices): RuleSystems {
  const { defeat, potions, ...flat } = rules;
  return { ...answer, ...flat, defeat: { ...answer.defeat, ...defeat }, potions: { ...answer.potions, ...potions } };
}

/**
 * Create the world the owner reviewed and start building it: the review's runs become the world's, the systems they
 * set by hand amend the rules systems step's answer, and the review's cost is kept with the world's build records.
 */
export function createWorld(owner: { id: string; name: string }, input: WorldInput, reviewId: string, opts: { maxPerOwner?: number } = {}): string {
  ownReview(reviewId, owner.id);
  if (writing.has(reviewId)) throw new ReviewBusy('The world is still being written.');
  const w = placeholderWorld(`w_${crypto.randomBytes(5).toString('hex')}`, input, owner);
  const review = pipelineOf(reviewId), pipe = worldPipeline(w.id), ex = worldExample(w);
  const steps = pipe.upstream(ex, REVIEWED);
  const runs = steps.flatMap((s) => review.store.list(reviewId, s));
  for (const r of runs) pipe.store.put({ ...r, example: w.id });
  // Systems set by hand since: the answer the step must now give.
  applyChoices(pipe, ex, writtenWith(reviewId)?.rules);
  w.concept.title = (pipe.store.latest(w.id, 'concept')?.output as { title?: string } | undefined)?.title ?? w.concept.title;
  saveWorld(w);
  keepReviewCost(w.id, runs);
  try {
    buildWorld(w, opts);
  } catch (e) {
    // Not built after all (too many builds of the owner's): nothing of it stays.
    deleteWorld(w.id);
    purgeTrashEntry(w.id);
    throw e;
  }
  fs.rmSync(dirOf(reviewId), { recursive: true, force: true });
  return w.id;
}

/** The review's model calls, by step, as the first of the world's build records (worldgen/metrics.ts). */
function keepReviewCost(worldId: string, runs: { step: string; at: number; ms: number; usage: { usd: number; calls: number; input: number; cached: number; output: number; reasoning: number } }[]) {
  const total: Tally = {}, steps: Record<string, Tally> = {};
  for (const r of runs) {
    const counts: Tally = { usd: r.usage.usd, calls: r.usage.calls, input: r.usage.input, cached: r.usage.cached, output: r.usage.output, reasoning: r.usage.reasoning, spans: 1, ms: r.ms };
    for (const t of [total, (steps[`pipeline ${r.step}`] ??= {})]) for (const [k, v] of Object.entries(counts) as [keyof Tally, number][]) if (v) t[k] = (t[k] ?? 0) + v;
  }
  const m: JobMetrics = { job: 'review', kind: 'review', started: Math.min(Date.now(), ...runs.map((r) => r.at)), updated: Date.now(), activeMs: total.ms ?? 0, status: 'done', total, steps, purposes: {}, models: {} };
  fs.mkdirSync(path.join(worldDir(worldId), 'metrics'), { recursive: true });
  fs.writeFileSync(path.join(worldDir(worldId), 'metrics', 'review.json'), JSON.stringify(m));
}
