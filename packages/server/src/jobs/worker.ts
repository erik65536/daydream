/**
 * Runs queued jobs. Each claimed job holds a lease it renews while working; if this process stops, the lease
 * runs out and another worker (or this one, restarted) resumes the job from its checkpoints.
 *
 * Asked to restart (new code in development), the worker finishes in-flight steps, stops its jobs at their next
 * safe point, re-queues them and exits; the restarted worker continues them.
 */
import type { WorldDefinition } from '@daydream/shared';
import { genai } from '../genai/service.ts';
import { withCallContext } from '../genai/context.ts';
import { loadWorld, saveWorld } from '../storage.ts';
import { runArtJob, runGeneration, runRulesJob } from '../worldgen/build.ts';
import { recordJob, type JobMetrics } from '../worldgen/metrics.ts';
import { queueAnimation, runAnimateJob } from '../anim/job.ts';
import { Job, JobYield, workerState } from './job.ts';
import { claimNext, enqueue, HOLDER, purgeOldLogs, renewLease, requeue, type JobRecord } from './queue.ts';
import { control } from '../gpu/presence.ts';
import { activity, reportError } from '../log.ts';

/** A job that keeps dying (crashes the worker, say) is given up after this many starts. */
const MAX_ATTEMPTS = 6;

async function execute(rec: JobRecord, job: Job): Promise<void> {
  const world = (): WorldDefinition => {
    const w = loadWorld(rec.worldId);
    if (!w) throw new Error('The world no longer exists.');
    return w;
  };
  const p = rec.params as Record<string, unknown>;
  switch (rec.kind) {
    case 'world':
      return runGeneration(job);
    case 'rules':
      return runRulesJob(job, world(), p.mode === 'rebalance' ? 'rebalance' : 'regenerate');
    case 'art':
      return runArtJob(job, world());
    case 'animate':
      return runAnimateJob(job, rec.worldId);
  }
}

async function run(rec: JobRecord): Promise<void> {
  // A world's input is its owner's, kept with it from its creation on (worldgen/review.ts).
  const input = loadWorld(rec.worldId)?.input;
  const job = new Job(rec.worldId, input ?? ({} as WorldDefinition['input']), { id: rec.ownerId, name: rec.ownerName }, rec);
  job.status = 'running';
  if (rec.attempts > 1) job.push(`Resuming (start ${rec.attempts})`, 'step');
  // A lease that could not be kept (the process stood still past it, and another worker took the job) ends the work here.
  const renew = setInterval(() => {
    if (!renewLease(rec.id)) job.abandon();
  }, 15_000);
  // What the job takes is recorded with its world (worldgen/metrics.ts).
  const metrics = recordJob(rec.worldId, rec.id, rec.kind);
  let ended: JobMetrics['status'] = 'failed';
  try {
    if (rec.attempts > MAX_ATTEMPTS) throw new Error(`stopped unexpectedly ${MAX_ATTEMPTS} times`);
    // The world's owner pays for its building, rules, and painting.
    await withCallContext({ priority: 'background', onWait: (why) => job.waiting(why), userId: rec.ownerId, tag: job.tag, cancelled: () => job.cancelled }, () => execute(rec, job));
    if (job.lost) throw new Error('cancelled');
    job.finish(job.cancelled ? 'cancelled' : 'done');
    ended = job.cancelled ? 'cancelled' : 'done';
    if (rec.kind === 'world' && !job.cancelled) activity('world built', rec.ownerId, { world: rec.worldId }, { title: loadWorld(rec.worldId)?.concept.title, minutes: Math.round((Date.now() - (rec.startedAt ?? rec.createdAt)) / 60_000) });
    const owner = { id: rec.ownerId, name: rec.ownerName };
    // New rules have new classes and kins: their heroes are painted next (then animated). A rebalance changes numbers
    // and how skills work, nothing anyone sees.
    if (rec.kind === 'rules') {
      if (!job.cancelled && (rec.params as { mode?: string }).mode !== 'rebalance') enqueue('art', rec.worldId, owner, {}, { priority: 5, step: 'Waiting for a free worker' });
    }
    // New or repainted characters and creatures: their animation follows in the background.
    else if (rec.kind !== 'animate' && !job.cancelled) {
      const w = loadWorld(rec.worldId);
      if (w?.status === 'ready') queueAnimation(w, owner);
    }
  } catch (e) {
    // The job is another worker's now: its row, its world and what follows it are that worker's to write.
    if (job.lost) {
      ended = 'paused';
      console.log(`[worker ${HOLDER}] ${rec.kind} job ${rec.id} was taken over by another worker (its lease ran out); stopped here`);
      return;
    }
    if (e instanceof JobYield) {
      ended = 'paused';
      job.push('Paused for a worker restart; it continues where it left off.', 'step');
      job.flush();
      requeue(rec.id);
      return;
    }
    const msg = (e as Error).message;
    if (job.cancelled || msg === 'cancelled') {
      ended = 'cancelled';
      job.push('Stopped.', 'step');
      job.finish('cancelled');
    } else {
      if (rec.kind === 'world') activity('world failed', rec.ownerId, { world: rec.worldId }, { step: job.step, message: msg.slice(0, 200) });
      reportError(e, { job: rec.id, kind: rec.kind, world: rec.worldId, step: job.step, attempt: rec.attempts, minutes: Math.round((Date.now() - rec.createdAt) / 60_000) });
      job.push(`Failed: ${msg}`, 'error');
      job.finish('failed', msg);
    }
    // A world whose first build ended is marked so the lobby says so (resuming it keeps every step that finished).
    if (rec.kind === 'world') {
      const w = loadWorld(rec.worldId);
      if (w && w.status === 'generating') saveWorld({ ...w, status: 'failed' });
    }
  } finally {
    clearInterval(renew);
    job.close();
    const w = rec.kind === 'world' && ended === 'done' ? loadWorld(rec.worldId) ?? undefined : undefined;
    metrics.close(ended, w);
  }
}

export interface Worker {
  /** Jobs running now. */
  busy(): number;
  /** Stop taking jobs, stop running ones at their next safe point, and wait for them (re-queued). */
  drain(): Promise<void>;
}

export function startWorker(opts: { concurrency?: number; quiet?: boolean } = {}): Worker {
  const max = Math.max(1, opts.concurrency ?? genai().config.jobConcurrency ?? 1);
  const running = new Set<Promise<void>>();
  let draining = false;
  const tick = () => {
    // An administrator's pause: no new jobs (background animation can be paused on its own).
    while (!draining && !workerState.yieldRequested && running.size < max && !control('paused')) {
      const rec = claimNext(HOLDER, { noAnimation: !!control('animationPaused') });
      if (!rec) break;
      if (!opts.quiet) console.log(`[worker ${HOLDER}] ${rec.attempts > 1 ? 'resuming' : 'starting'} ${rec.kind} job ${rec.id} for ${rec.worldId}`);
      const p = run(rec).finally(() => running.delete(p));
      running.add(p);
    }
  };
  tick();
  const timer = setInterval(tick, 1000);
  purgeOldLogs();
  return {
    busy: () => running.size,
    async drain() {
      draining = true;
      workerState.yieldRequested = true;
      clearInterval(timer);
      await Promise.allSettled([...running]);
    },
  };
}
