import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import crypto from 'node:crypto';
import { globalDb, loadWorld } from '../src/storage.ts';
import { activeJob, claimNext, enqueue, enqueueAnimation, getJobRecord, JobConflict, latestJob, logTail, renewLease, requestCancel } from '../src/jobs/queue.ts';
import { Job, JobYield, workerState } from '../src/jobs/job.ts';
import { startWorker } from '../src/jobs/worker.ts';
import { runGeneration, worldPipeline } from '../src/worldgen/build.ts';
import { createWorld, writeReview } from '../src/worldgen/review.ts';
import { worldMetrics } from '../src/worldgen/metrics.ts';
import { mockModels, plainPlaces, until, validateWorld, type MockModels } from './helpers.ts';

const owner = { id: 'u_jobs', name: 'Jobs' };
const input = { theme: 'A drowned city of bell towers and lantern boats.', size: 'small' as const, length: 'short' as const, communication: 2 as const };
const wid = () => `w_jt_${crypto.randomBytes(4).toString('hex')}`;
const expireLease = (id: string) => globalDb().prepare('UPDATE jobs SET lease_until = 1 WHERE id = ?').run(id);

describe('durable jobs', () => {
  let models: MockModels, restore: () => void;
  beforeAll(async () => {
    models = await mockModels();
    restore = plainPlaces();
  });
  afterAll(() => {
    restore();
    models.stop();
  });

  it('queues one job per world, leases it, and hands it to another worker when the lease runs out', () => {
    const w = wid();
    const rec = enqueue('art', w, owner, { level: 'full' }, { priority: 0 });
    expect(rec.status).toBe('queued');
    expect(() => enqueue('art', w, owner, {})).toThrow(JobConflict);
    const claimed = claimNext('worker-a');
    expect(claimed?.id).toBe(rec.id);
    expect(claimed?.status).toBe('running');
    expect(claimNext('worker-b')?.id).not.toBe(rec.id);
    expireLease(rec.id); // worker-a died
    const again = claimNext('worker-b');
    expect(again?.id).toBe(rec.id);
    expect(again?.attempts).toBe(2);
    requestCancel(rec.id);
    expect(getJobRecord(rec.id)?.cancelRequested).toBe(true);
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(rec.id);
  });

  it('a build paused at a safe point resumes from its checkpoints and makes the same world', async () => {
    const w = wid();
    const rec = enqueue('world', w, owner, { input }, { priority: -10 });
    globalDb().prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(rec.id);
    // First run: the worker is asked to restart when the story's steps begin.
    class Restarting extends Job {
      override begin(id: string, counts?: { done?: number; total?: number }) {
        if (id === 'text:Map and story') workerState.yieldRequested = true;
        super.begin(id, counts);
      }
    }
    const first = new Restarting(w, input, owner, getJobRecord(rec.id));
    await expect(runGeneration(first)).rejects.toBeInstanceOf(JobYield);
    workerState.yieldRequested = false;
    // Second run (a fresh worker): the steps that finished are kept.
    const second = new Job(w, input, owner, getJobRecord(rec.id));
    await runGeneration(second);
    second.finish('done');
    expect(second.log.some((l) => /^Kept \d+ of the \d+ steps from before\./.test(l.msg))).toBe(true);
    const world = loadWorld(w)!;
    expect(world.status).toBe('ready');
    expect(validateWorld(world)).toEqual([]);
    expect(getJobRecord(rec.id)?.status).toBe('done');
    expect(logTail(rec.id).length).toBeGreaterThan(5);
  });

  it('a worker builds a reviewed world end to end, keeping the steps reviewed and recording what each part took', async () => {
    // This build runs the balance as a build does (the smallest one); other tests' builds leave it out (vitest.config.ts).
    process.env.DAYDREAM_BALANCE = 'smoke';
    const review = await writeReview(owner.id, input);
    const worldId = createWorld(owner, input, review.id);
    expect(loadWorld(worldId)?.status).toBe('generating');
    const worker = startWorker({ quiet: true });
    try {
      // Until the job ends, however it ends (the checks below say whether it went well).
      await until(() => expect(globalDb().prepare('SELECT status FROM jobs WHERE world_id = ?').get(worldId)).toMatchObject({ status: expect.stringMatching(/^(done|failed|cancelled)$/) }), 280_000);
    } finally {
      await worker.drain();
      workerState.yieldRequested = false;
    }
    expect(loadWorld(worldId)?.status).toBe('ready');
    const job = globalDb().prepare('SELECT id, status FROM jobs WHERE world_id = ?').get(worldId) as { id: string; status: string };
    expect(job.status).toBe('done');
    // The build kept the steps the owner reviewed.
    expect(logTail(job.id).some((l) => /^Kept [1-9]\d* of the \d+ steps from before\./.test(l.msg))).toBe(true);
    // Its records: the review's and the build's, by step and by purpose, with what the world holds.
    const records = worldMetrics(worldId);
    expect(records.map((m) => [m.kind, m.status])).toEqual([['review', 'done'], ['world', 'done']]);
    const build = records[1]!;
    expect(build.counts).toMatchObject({ towns: 1, areas: 4 });
    expect(build.activeMs).toBeGreaterThan(0);
    expect(Object.keys(build.steps)).toEqual(expect.arrayContaining(['pipeline story', 'balance']));
    expect(build.steps.balance!.spans).toBe(1);
    expect(Object.keys(build.purposes)).toContain('world.design');
    // What the page shows of the build: counts of everything made, and nothing of the world itself.
    const shown = getJobRecord(job.id)!.preview.activity!;
    const world = loadWorld(worldId)!;
    expect(shown.writing.done).toBe(shown.writing.total);
    expect(shown.places).toMatchObject({ done: world.zones.length, total: world.zones.length });
    expect((shown.characters.total ?? 0) * (shown.creatures.total ?? 0) * (shown.items.total ?? 0)).toBeGreaterThan(0);
    expect(shown.balance.fights).toBeGreaterThan(0);
    expect(shown.calls).toBeGreaterThan(0);
    const said = JSON.stringify(getJobRecord(job.id)!.preview);
    for (const name of [...world.zones.map((z) => z.name), ...world.npcs.map((p) => p.name), ...world.quests.map((q) => q.title)]) expect(said).not.toContain(name);
    // The review's calls, as its step's own run counted them.
    expect(records[0]!.steps['pipeline concept']?.calls).toBe(worldPipeline(worldId).store.latest(worldId, 'concept')!.usage.calls);
  }, 300_000);

  it('when one of two stages running together ends, the other is what the job shows it is doing', () => {
    const job = new Job(wid(), input, owner);
    job.plan([{ id: 'places', label: 'Painting places', detail: '' }, { id: 'balance', label: 'Balancing', detail: '' }]);
    job.begin('places');
    job.push('Painting places', 'step');
    job.begin('balance');
    job.push('Balancing', 'step');
    expect(job.step).toBe('Balancing');
    job.end('balance');
    expect(job.step).toBe('Painting places');
    // A resumed build passes stages it finished before; they announce themselves and end again.
    job.push('Balancing', 'step');
    job.end('balance');
    expect(job.step).toBe('Painting places');
  });

  it('a job that has ended writes nothing more: work of it still winding down cannot undo its outcome', async () => {
    const rec = enqueue('art', wid(), owner, {}, { priority: 90 });
    globalDb().prepare(`UPDATE jobs SET status = 'running' WHERE id = ?`).run(rec.id);
    const job = new Job(rec.worldId, input, owner, getJobRecord(rec.id));
    job.push('Painting', 'step');
    job.finish('failed', 'the painter stopped');
    const ended = getJobRecord(rec.id)!;
    expect(ended).toMatchObject({ status: 'failed', error: 'the painter stopped' });
    expect(ended.finishedAt).toBeGreaterThan(0);
    // A stage that ran beside the one that failed still counts and logs.
    job.push('One more place painted');
    job.count('places', 3, 4);
    job.flush();
    await new Promise((r) => setTimeout(r, 500));
    expect(getJobRecord(rec.id)).toMatchObject({ status: 'failed', finishedAt: ended.finishedAt, step: ended.step });
    expect(logTail(rec.id).map((l) => l.msg)).not.toContain('One more place painted');
  });

  it('a worker that lost its lease stops the job and leaves its row to the worker that has it', () => {
    const rec = enqueue('art', wid(), owner, {}, { priority: -20 });
    const mine = claimNext('worker-slow')!;
    expect(mine.id).toBe(rec.id);
    expect(renewLease(rec.id, 'worker-slow')).toBe(true);
    const job = new Job(rec.worldId, input, owner, mine);
    // It stood still past its lease, and another worker took the job.
    expireLease(rec.id);
    expect(claimNext('worker-next')?.id).toBe(rec.id);
    expect(renewLease(rec.id, 'worker-slow')).toBe(false);
    expect(renewLease(rec.id, 'worker-next')).toBe(true);
    expect(job.cancelled).toBe(false);
    job.abandon();
    expect(job.cancelled).toBe(true);
    job.step = 'Still painting';
    job.finish('failed', 'cancelled');
    expect(getJobRecord(rec.id)).toMatchObject({ status: 'running', leaseOwner: 'worker-next' });
    expect(getJobRecord(rec.id)!.step).not.toBe('Still painting');
    // A job ended from outside is nobody's to renew.
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(rec.id);
    expect(renewLease(rec.id, 'worker-next')).toBe(false);
  });

  it('an owner’s limit counts the jobs they asked for, not the animation that follows a build', () => {
    const who = { id: `u_cap_${crypto.randomBytes(3).toString('hex')}`, name: 'Capped' };
    enqueueAnimation(wid(), who);
    enqueueAnimation(wid(), who);
    const a = enqueue('world', wid(), who, {}, { priority: 99, maxPerOwner: 2 });
    const b = enqueue('world', wid(), who, {}, { priority: 99, maxPerOwner: 2 });
    expect(() => enqueue('world', wid(), who, {}, { priority: 99, maxPerOwner: 2 })).toThrow(JobConflict);
    requestCancel(a.id);
    const c = enqueue('world', wid(), who, {}, { priority: 99, maxPerOwner: 2 });
    expect(c.id).not.toBe(b.id);
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE owner_id = ?`).run(who.id);
  });

  it('animation runs beside the world jobs, queued once, after them', () => {
    const w = wid();
    enqueueAnimation(w, owner);
    enqueueAnimation(w, owner);
    const anims = globalDb().prepare(`SELECT id, priority FROM jobs WHERE world_id = ? AND kind = 'animate' AND status = 'queued'`).all(w) as { id: string; priority: number }[];
    expect(anims).toHaveLength(1);
    // It neither blocks nor shows as the world's job.
    expect(activeJob(w)).toBeUndefined();
    expect(latestJob(w)).toBeUndefined();
    const art = enqueue('art', w, owner, { level: 'full' }, { priority: 5 });
    expect(activeJob(w)?.id).toBe(art.id);
    // Everything else is claimed first.
    expect(claimNext('t-anim')?.id).toBe(art.id);
    expect(claimNext('t-anim')?.id).toBe(anims[0]!.id);
    globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE world_id = ?`).run(w);
  });
});
