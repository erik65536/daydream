/**
 * Building a world. Luna writes the world in the build pipeline's text steps (pipeline/, docs/build-pipeline.md),
 * each starting as soon as the steps it reads are done; the world is assembled from their answers (pipeline/world.ts),
 * and then the GPU paints places, then makes voices and sounds (one task at a time, worldgen/gpu.ts), while the rules
 * are balanced on the spare cores and GPT Image draws characters:
 *
 *   the text steps ─ assemble ─┬─ balance
 *                              ├─ places painted, read, and settled
 *                              ├─ heroes, people, creatures, objects, and icons drawn
 *                              ├─ voices designed, fixed lines spoken
 *                              └─ sounds and music made
 *
 * Everything finished is kept, so a build that stops resumes where it was: each step's answer is a run in the world's
 * own pipeline store (`draft/pipeline`), and art, places, voices, and sounds keep what they made.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { type Ruleset, type WorldDefinition, type WorldInput, type ZoneDef } from '@daydream/shared';
import { atStep } from '../genai/meter.ts';
import { loadWorld, saveWorld, worldDir } from '../storage.ts';
import { enqueue } from '../jobs/queue.ts';
import { Job as WorldGenJob, JobYield, workerState, type JobPhase } from '../jobs/job.ts';
import { balanceRuleset, type BalanceSize } from '../rules/balance.ts';
import { bindWorld } from '../rules/bind.ts';
import { Pipeline } from '../pipeline/index.ts';
import type { Example } from '../pipeline/types.ts';
import { questVerdict, type QuestProblem } from './questcheck.ts';
import { attempt, Halted, STEP_BACKOFF_MS, STEP_TRIES, StepFailed, waitBeforeTry as wait } from './retry.ts';
import { Activity } from './activity.ts';
import { buildVoices } from './voices.ts';
import { buildSounds } from './sounds.ts';
import { generateArt, linkAssets } from './art.ts';
import { GpuQueue } from './gpu.ts';
import { paintAndRead, settlePlace, sketchOf, worldLook, type Painted, type PlaceContext } from './zones.ts';
import type { SoundPlan } from '../sound/prompts.ts';
export { WorldGenJob, StepFailed };
export type { JobPhase, GenLogEntry } from '../jobs/job.ts';

/**
 * Build a world its owner has reviewed (worldgen/review.ts), or start a stopped build again from where it stopped:
 * the steps that finished are kept, those of the review among them. Everything is laid out and painted from the world's id,
 * so a build that resumes makes the same world.
 */
export function buildWorld(w: WorldDefinition, opts: { maxPerOwner?: number } = {}): void {
  enqueue('world', w.id, { id: w.ownerId, name: w.ownerName }, {}, { priority: 5, maxPerOwner: opts.maxPerOwner });
  w.status = 'generating';
  w.updatedAt = Date.now();
  saveWorld(w);
}

/** A world before it is built: its owner's input, and a title until its concept names it. */
export function placeholderWorld(id: string, input: WorldInput, owner: { id: string; name: string }, status: WorldDefinition['status'] = 'generating'): WorldDefinition {
  return {
    id, ownerId: owner.id, ownerName: owner.name, public: true, createdAt: Date.now(), updatedAt: Date.now(), status, input,
    concept: { title: 'A world is being dreamed…', pitch: input.theme.slice(0, 200), genre: '', tone: '', artStyle: '', intro: '', narratorVoice: '', palette: { primary: '#c8a24a', secondary: '#3a4a6a', accent: '#e0603a', ui: '#1a1a22' } },
    ruleset: undefined as unknown as Ruleset, maxLevel: 1, origins: [], uniqueItems: {}, families: [], bosses: [], zones: [], npcs: [], quests: [], arcs: [], finalQuestId: '', ending: '', lore: [], assets: {}, startZoneId: '',
  };
}

// ------------------------------------------------------------------------------------ the world's pipeline

/** The most a build may spend on its text steps (the spending ledger checks the owner's budget call by call). */
export const TEXT_CAP_USD = 5;

/** A world's own pipeline: its input is the example, and its runs are kept with the world. */
export function worldPipeline(worldId: string): Pipeline {
  return new Pipeline({ runs: path.join(worldDir(worldId), 'draft', 'pipeline'), cap: TEXT_CAP_USD, tier: 'flex' });
}

export const worldExample = (w: Pick<WorldDefinition, 'id' | 'input'>): Example => ({ id: w.id, input: w.input });

/** The sounds step's answer for a built world (its plan), from the world's own pipeline. */
export function soundPlan(w: WorldDefinition): SoundPlan {
  const r = worldPipeline(w.id).record(worldExample(w), 'sounds');
  if (!r.value) throw new Error(`${w.concept.title} has no sound plan: run its sounds step first`);
  return r.value as SoundPlan;
}

// ------------------------------------------------------------------------------------ steps

/**
 * How far the build is: every piece of work has a weight (about the seconds it takes on the busiest resource, the
 * GPU) and adds it as it finishes, paintings part by part. Never moves backwards when new work is found.
 */
class Progress {
  private units = new Map<string, { weight: number; done: number }>();
  private job: WorldGenJob;
  constructor(job: WorldGenJob) {
    this.job = job;
  }
  add(key: string, weight: number) {
    if (!this.units.has(key)) this.units.set(key, { weight, done: 0 });
  }
  set(key: string, frac: number) {
    const u = this.units.get(key);
    if (!u) return;
    u.done = Math.max(u.done, Math.min(1, frac));
    let total = 0, done = 0;
    for (const x of this.units.values()) {
      total += x.weight;
      done += x.weight * x.done;
    }
    this.job.progress = Math.max(this.job.progress, Math.min(0.99, done / Math.max(1, total)));
  }
}

/** The GPU order after places (worldgen/gpu.ts: places come first, at 0 and up to the number of regions). */
const GPU_AFTER_PLACES = { art: 10, voices: 20, sounds: 30 };

/** About how long each kind of work takes, in seconds. */
const COST = { text: 300, balance: 60, image: 12, map: 600, settle: 40, voices: 120, sounds: 300 };

/** How places are painted and furnished (tests swap in plain ground, to build worlds without an image model). */
export const places = { paint: paintAndRead, settle: settlePlace };

const hash = (s: string) => crypto.createHash('sha1').update(s).digest().readUInt32LE(0) % 1_000_000;
/** The seed a place is painted with (its saved steps belong to it, so a resumed build or a resettle finds them). */
export const placeSeed = (worldSeed: string, zoneId: string) => hash(`${worldSeed}:${zoneId}`);

/** The pipeline's groups of text steps (pipeline/order.yaml) as far as a build runs them: the groups with a needed step. */
const textGroups = (pipe: Pipeline, needed: string[]) => pipe.project.groups.map((g) => ({ name: g.name, steps: g.steps.filter((s) => needed.includes(s)) })).filter((g) => g.steps.length);

/** The job's stages: the groups of text steps the build runs, then painting, balancing, and sound. */
function phases(pipe: Pipeline, needed: string[]): Omit<JobPhase, 'status'>[] {
  return [
    ...textGroups(pipe, needed).map((g) => ({ id: `text:${g.name}`, label: g.name, detail: g.steps.join(', '), total: g.steps.length, done: 0 })),
    { id: 'places', label: 'Painting places', detail: 'Every place painted, read for where people can walk, and furnished' },
    { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number' },
    { id: 'art', label: 'Characters and items', detail: 'Heroes, people, creatures, bosses, and item icons' },
    { id: 'voices', label: 'Voices', detail: 'A voice for everyone who speaks, and the lines known before play spoken once' },
    { id: 'sounds', label: 'Sound and music', detail: 'Every sound made from what the world is made of, and its music' },
  ];
}

// ------------------------------------------------------------------------------------ the build

export async function runGeneration(job: WorldGenJob) {
  const input = job.input;
  const pipe = worldPipeline(job.worldId);
  const ex = worldExample({ id: job.worldId, input });
  const progress = new Progress(job);
  /** What the build has done, in counts, for the page that shows it (activity.ts). */
  const activity = new Activity(job);
  let failed = false;
  const stopped = () => failed || job.cancelled || workerState.yieldRequested;
  const gpu = new GpuQueue(stopped, { jobId: job.id, worldId: job.worldId, kind: 'world' });
  /** Every piece of work runs under this: a failure stops the GPU queue and the build, which waits for the rest to stop. */
  const work: Promise<unknown>[] = [];
  const track = <T>(p: Promise<T>): Promise<T> => {
    p.catch(() => (failed = true));
    work.push(p);
    return p;
  };
  /** Work that must succeed (worldgen/retry.ts); once the build has stopped, nothing more of it is tried. */
  const halt = () => (job.cancelled ? new Error('cancelled') : workerState.yieldRequested ? new JobYield() : failed ? new Halted() : undefined);
  const step = <T>(label: string, fn: () => Promise<T>) => attempt(label, fn, { report: (m, level) => job.push(m, level), halt, done: (s) => job.push(`${label}: done in ${s.toFixed(1)}s`) });
  /** The world once it is assembled, as the build's pieces fill it in. */
  let built: WorldDefinition | undefined;
  const stage = async <T>(id: string, step: string, fn: () => Promise<T>): Promise<T> => {
    job.begin(id);
    job.yieldPoint();
    job.push(step, 'step');
    const out = await atStep(id, fn);
    job.end(id);
    return out;
  };

  // Only the text steps the world is made from are run (the steps behind the game's records and all they read).
  const needed = pipe.needed(ex);
  job.plan(phases(pipe, needed));
  for (const [k, w] of Object.entries({ text: COST.text, balance: COST.balance, voices: COST.voices, sounds: COST.sounds })) progress.add(k, w);

  try {
    // ---------------------------------------------------------------- the world in words: the pipeline's steps
    const groups = textGroups(pipe, needed);
    const groupOf = new Map(groups.flatMap((g) => g.steps.map((s) => [s, g.name] as const)));
    const stepsDone = new Map<string, number>();
    const total = needed.length;
    let finished = 0, kept = 0;
    await atStep('text', () => pipe.runAll(ex, {
      only: needed,
      stale: true,
      tries: STEP_TRIES,
      wait: async (n, error) => {
        job.push(`A step failed (${error.slice(0, 200)}); trying again in ${Math.round((STEP_BACKOFF_MS[n - 1] ?? 120_000) / 1000)}s`, 'warn');
        await wait(n);
        job.yieldPoint();
      },
      onStep: (id, state, run) => {
        const group = `text:${groupOf.get(id) ?? ''}`;
        if (state === 'running') {
          job.begin(group);
          // A stop or a worker restart waits for no new step (steps already asked finish and are kept).
          return job.yieldPoint();
        }
        if (state === 'failed') return job.push(`${id} failed: ${run?.error?.slice(0, 200)}`, 'warn');
        if (state === 'kept') kept++;
        const n = (stepsDone.get(group) ?? 0) + 1;
        stepsDone.set(group, n);
        job.count(group, n);
        if (n === groups.find((g) => `text:${g.name}` === group)?.steps.length) job.end(group);
        progress.set('text', ++finished / total);
        activity.written(finished, total);
      },
    }));
    if (kept) job.push(`Kept ${kept} of the ${total} steps from before.`);
    const status = pipe.status(ex, needed);
    const missing = needed.filter((id) => status[id]?.state !== 'fresh');
    if (missing.length) throw new StepFailed(`The world could not be written: ${missing.join(', ')} did not finish. Resume the build once the service is working.`);

    // ---------------------------------------------------------------- assembly
    job.yieldPoint();
    const assembled = pipe.world(ex);
    const world: WorldDefinition = { ...assembled, id: job.worldId, ownerId: job.owner.id, ownerName: job.owner.name, public: true, createdAt: loadWorld(job.worldId)?.createdAt ?? Date.now(), status: 'generating', input };
    // Art, voices, and sounds made before a restart are kept (their files are still there).
    const before = loadWorld(job.worldId);
    world.assets = before?.assets ?? {};
    if (before?.voices) world.voices = before.voices;
    if (before?.sounds) world.sounds = before.sounds;
    linkAssets(world);
    activity.assembled(world);
    let lastSave = 0;
    built = world;
    // A build that has failed or been stopped saves nothing more: its world is marked as stopped then, and a late save
    // would call it building again.
    const save = (force = false) => {
      if (failed || (!force && Date.now() - lastSave < 5000)) return;
      lastSave = Date.now();
      world.updatedAt = Date.now();
      saveWorld(world);
    };
    save(true);
    job.push(`Assembled ${world.zones.length} places, ${world.npcs.length} people, ${world.quests.length} quests (${world.quests.filter((q) => q.main).length} main), ${world.bosses.length} bosses.`);

    const balance = track(stage('balance', 'Balancing the rules by simulation', () => balanceWorld(job, world, (frac, fights) => {
      progress.set('balance', frac);
      activity.balance(frac, fights);
    })).then(() => {
      progress.set('balance', 1);
      save(true);
    }));

    // ---------------------------------------------------------------- places, painted and settled
    job.begin('places');
    let placesDone = 0;
    job.count('places', 0, world.zones.length);
    const placeCost = COST.map + COST.settle;
    for (const z of world.zones) progress.add(`place:${z.id}`, placeCost);
    const placeCtx = (z: ZoneDef, priority: number): PlaceContext => ({
      gpu,
      priority,
      seed: placeSeed(world.id, z.id),
      stopped,
      report: (m) => job.push(m),
      onPart: (done, all) => progress.set(`place:${z.id}`, (done / all) * (COST.map / placeCost)),
      noted: (what) => activity.painting(what),
    });
    /** GPU order: the starting place first, then region by region. */
    const priority = (z: ZoneDef) => (z.id === world.startZoneId ? 0 : 1 + z.regionIndex + world.zones.indexOf(z) / 100);
    const settled = world.zones.map((z) => track((async () => {
      const ctx = placeCtx(z, priority(z));
      const painted: Painted = await step(`Painting ${z.name}`, () => places.paint(worldLook(world), sketchOf(world, z), ctx));
      // Painting lays out where everything stands, the creatures too (they stood on open ground until now).
      z.spawns = [];
      await step(`Settling ${z.name}`, () => atStep('places.furnish', () => places.settle(world, z, painted, ctx)));
      progress.set(`place:${z.id}`, 1);
      job.count('places', ++placesDone);
      activity.place();
      job.push(`${z.name} is ready`);
      save();
    })()));
    gpu.holdFrom(GPU_AFTER_PLACES.art, Promise.allSettled(settled));

    // ---------------------------------------------------------------- characters, voices, and sounds
    // Everything is drawn while places are painted: the rules are whole once compiled (balancing changes only numbers).
    job.begin('art');
    const art = track(generateArt(world, {
      report: (m) => job.push(m),
      onAsset: () => save(),
      onCount: (done, all) => {
        progress.add('art', all * COST.image);
        progress.set('art', done / all);
      },
      onPrompts: (done) => activity.promptsWritten(done),
      onRepair: (n) => activity.repaired(n),
      shouldStop: stopped,
      gpu: (work) => gpu.run('klein', GPU_AFTER_PLACES.art, work),
    }));
    const voices = track(stage('voices', 'Voices', () => step('Voices', () => buildVoices(world, {
      report: (m, level) => job.push(m, level),
      shouldStop: stopped,
      progress: (frac) => {
        progress.set('voices', frac);
        activity.voices(frac);
      },
      tag: { jobId: job.id, worldId: job.worldId, kind: 'world', label: 'voices' },
      gpu: (fn) => gpu.run('speech', GPU_AFTER_PLACES.voices, fn),
    }))).then(() => save(true)));
    const plan = pipe.record(ex, 'sounds').value as SoundPlan;
    const sounds = track(stage('sounds', 'Sound and music', () => step('Sounds', () => buildSounds(world, plan, {
      report: (m, level) => job.push(m, level),
      shouldStop: stopped,
      progress: (frac) => {
        progress.set('sounds', frac);
        activity.sounds(frac);
      },
      gpu: (model, fn) => gpu.run(model === 'small' ? 'sound-small' : 'sound-medium', GPU_AFTER_PLACES.sounds, fn),
      onSound: () => save(),
    }))).then(() => save(true)));

    await Promise.all([...settled, balance, art, voices, sounds]);
    // The art stops quietly for a worker restart or a stop; the world is not ready then (a restart resumes it).
    job.yieldPoint();
    if (job.cancelled) throw new Error('cancelled');
    job.end('places');
    job.end('art');

    // Every quest can be finished, now that each place is furnished: a world whose story cannot be is not ready.
    checkWorldQuests(job, world);
    // Experience is solved from every creature now placed.
    bindWorld(world, world.ruleset);
    linkAssets(world);
    world.generationLog = job.log.map((l) => l.msg);
    world.status = 'ready';
    save(true);
    job.finishPhases();
    job.push('The world is ready.', 'step');
  } catch (e) {
    failed = true;
    if (workerState.yieldRequested && job.id) throw new JobYield();
    // The build's other pieces stop at their next safe point (work on the GPU or at a model finishes first). What they
    // had made is saved once they are quiet, so the world is not written again after the job has ended.
    await Promise.allSettled(work);
    if (built) {
      built.updatedAt = Date.now();
      saveWorld(built);
    }
    throw e;
  } finally {
    activity.stop();
  }
}

/**
 * The build's last guard (worldgen/questcheck.ts): every quest can be finished. Quests are made finishable where they
 * are written, so a problem here is a bug in the build. One in the main story stops the build as a failed step that
 * names it (the world is not ready; its owner can look at it and resume). One in a side quest is a warning, kept on the
 * world with the rest (`questProblems`) for the world viewer.
 */
export function checkWorldQuests(job: Pick<WorldGenJob, 'push'>, world: WorldDefinition) {
  const { story, side } = questVerdict(world);
  const said = (p: QuestProblem) => `${world.quests.find((q) => q.id === p.questId)?.title ?? p.questId} cannot be finished: ${p.text}`;
  for (const p of [...story, ...side]) job.push(`Quest check: ${said(p)}`, 'warn');
  if (story.length) throw new StepFailed(`The main story cannot be finished: ${story.slice(0, 3).map(said).join('; ')}${story.length > 3 ? `; and ${story.length - 3} more` : ''}. The world is kept as it is, not ready: its quests and these problems are in the world viewer.`);
  if (!side.length) job.push(`Quest check: all ${world.quests.length} quests can be finished.`);
}

/** Balance a world's rules by simulated fights of its own creatures (on the spare cores), and bind them to the world. */
async function balanceWorld(job: WorldGenJob, world: WorldDefinition, onProgress: (frac: number, fights: number) => void) {
  let said = '';
  const report = await atStep('balance.sim', () => balanceRuleset(world.ruleset, {
    seed: world.id,
    families: world.families.map((f) => ({ members: f.members.map((m) => ({ fighter: m.fighter, classId: m.classId })) })),
    size: (process.env.DAYDREAM_BALANCE as BalanceSize | undefined) ?? 'full',
    onProgress: (m, frac, fights) => {
      onProgress(frac, fights);
      if (m !== said && m !== 'Balanced') job.push((said = m));
    },
  }));
  job.push(`Balance: ${report.notes.join(' ')}`);
  bindWorld(world, world.ruleset);
}

/**
 * Rebalance a world's rules (its rules records compiled by the current engine and balanced again), or write them
 * anew (its rules steps run again in the world's pipeline first). Places, people, and art stay; adventures begun under
 * other classes may not fit them.
 */
export async function runRulesJob(job: WorldGenJob, world: WorldDefinition, mode: 'regenerate' | 'rebalance') {
  job.step = mode === 'regenerate' ? 'Writing new rules' : 'Rebalancing the rules';
  job.plan([...(mode === 'regenerate' ? [{ id: 'rules', label: 'Rules', detail: 'The rules steps written anew' }] : []), { id: 'balance', label: 'Balancing', detail: 'Simulated fights tune every number' }]);
  const pipe = worldPipeline(world.id);
  const ex = worldExample(world);
  if (mode === 'regenerate') {
    job.phase('rules');
    const rules = [...pipe.project.steps.keys()].filter((id) => id.startsWith('rules') || id === 'fightLooks');
    const runs = await pipe.runAll(ex, { only: rules, tries: STEP_TRIES, wait: (n) => wait(n) });
    if (runs.length < rules.length || runs.some((r) => r.error)) throw new StepFailed('The rules could not be written. Try again once the service is working.');
  }
  // The ruleset as the world's pipeline makes it, from the newest runs of its rules steps alone.
  world.ruleset = pipe.ruleset(ex);
  job.phase('balance');
  await balanceWorld(job, world, (frac) => (job.progress = (mode === 'regenerate' ? 0.4 : 0) + 0.58 * frac));
  saveWorld(world);
  job.finishPhases();
  job.push('The rules are ready.', 'step');
}

/** Paint a world's missing, failed, or changed art (or only the assets named), saving as images arrive. */
export async function paintArt(job: WorldGenJob, world: WorldDefinition, only?: Set<string>) {
  job.step = 'Painting the world';
  let lastSave = Date.now();
  try {
    await generateArt(world, {
      only,
      report: (m) => job.push(m),
      onAsset: () => {
        if (Date.now() - lastSave > 5000) {
          saveWorld(world);
          lastSave = Date.now();
        }
      },
      onCount: (done, total) => {
        job.progress = done / total;
        job.count('art', done, total);
      },
      shouldStop: () => job.cancelled || workerState.yieldRequested,
    });
    job.yieldPoint();
  } finally {
    linkAssets(world);
    saveWorld(world);
  }
}

/** The art job's one stage. */
const ART_PHASE: Omit<JobPhase, 'status'> = { id: 'art', label: 'Characters and items', detail: 'Heroes, people, creatures, bosses, and item icons' };

export async function runArtJob(job: WorldGenJob, world: WorldDefinition) {
  job.plan([ART_PHASE]);
  job.phase('art');
  await paintArt(job, world);
  job.finishPhases();
}
