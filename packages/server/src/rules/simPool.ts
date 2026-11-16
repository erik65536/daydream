/**
 * Plays the balance loop's fights on worker threads, off the main thread so the rest of the process (the game, a build's
 * model calls, the GPU queue) keeps running meanwhile. Each fight is a pure function of the ruleset, the settings it is
 * played with, and its seed, so the answers do not depend on how many threads play them or which plays which. Fights
 * are handed out one at a time from one queue, so every thread stays busy while any fit of a stage still has fights.
 */
import os from 'node:os';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';
import type { Ruleset } from '@daydream/shared';
import { playFight, type FightJob, type FightOutcome, type TaskContext } from './balanceTasks.ts';

type ToWorker = { ruleset: Ruleset; ctx: TaskContext } | { id: number; job: FightJob };
type FromWorker = { id: number; outcome: FightOutcome } | { id: number; error: string };

/** Fights given to a thread at once, so it has the next at hand when one ends. */
const AHEAD = 2;

/**
 * Threads for simulation: half the machine's (two on the four-thread server, beside the game server and the worker's
 * own work; the worker runs at a lower priority than the game). DAYDREAM_BALANCE_THREADS asks for another number, up
 * to the cores but one.
 */
export function simThreads(): number {
  const cores = os.availableParallelism();
  const env = Math.floor(Number(process.env.DAYDREAM_BALANCE_THREADS) || Math.floor(cores / 2));
  return Math.max(1, Math.min(env, cores - 1));
}

interface Thread { worker: Worker; busy: number }

export class SimPool {
  /** Fights played so far. */
  played = 0;
  /** Told after every fight. */
  onPlayed?: () => void;
  private threads: Thread[] = [];
  private queue: { id: number; job: FightJob }[] = [];
  private waiting = new Map<number, { resolve: (o: FightOutcome) => void; reject: (e: Error) => void }>();
  private next = 0;
  private failed: Error | null = null;
  /** Without threads: the ruleset the fights play by, on this thread. */
  private here: { r: Ruleset; ctx: TaskContext } | null = null;

  constructor(threads = simThreads()) {
    // Each thread runs this file itself (Node strips its types), also when this process is vitest's.
    for (let i = 0; i < threads; i++) {
      const t: Thread = { worker: new Worker(new URL(import.meta.url)), busy: 0 };
      t.worker.on('message', (m: FromWorker) => {
        t.busy--;
        const w = this.waiting.get(m.id);
        this.waiting.delete(m.id);
        if ('error' in m) {
          // The fight that failed is answered too: its evaluation would otherwise wait for it forever.
          const e = new Error(m.error);
          w?.reject(e);
          return this.fail(e);
        }
        this.played++;
        this.onPlayed?.();
        w?.resolve(m.outcome);
        this.feed();
      });
      t.worker.on('error', (e: Error) => this.fail(e));
      this.threads.push(t);
    }
  }

  /** Play the fights that follow by the ruleset as it is now (each thread gets a copy; a stage changes it in between). */
  use(r: Ruleset, ctx: TaskContext) {
    if (!this.threads.length) this.here = { r, ctx };
    for (const t of this.threads) t.worker.postMessage({ ruleset: r, ctx } satisfies ToWorker);
  }

  /** Play fights; their outcomes come back in their order. */
  play(jobs: FightJob[]): Promise<FightOutcome[]> {
    if (this.failed) return Promise.reject(this.failed);
    if (!this.threads.length) {
      const out = jobs.map((job) => {
        const o = playFight(this.here!.r, this.here!.ctx, job);
        this.played++;
        this.onPlayed?.();
        return o;
      });
      return Promise.resolve(out);
    }
    const out = Promise.all(jobs.map((job) => new Promise<FightOutcome>((resolve, reject) => {
      const id = this.next++;
      this.waiting.set(id, { resolve, reject });
      this.queue.push({ id, job });
    })));
    this.feed();
    return out;
  }

  private feed() {
    for (const t of this.threads) {
      while (t.busy < AHEAD && this.queue.length) {
        t.busy++;
        t.worker.postMessage(this.queue.shift()! satisfies ToWorker);
      }
    }
  }

  private fail(e: Error) {
    this.failed ??= e;
    this.queue = [];
    for (const w of this.waiting.values()) w.reject(this.failed);
    this.waiting.clear();
  }

  /** Stop the threads (a pool that is not closed keeps the process alive). */
  close() {
    for (const t of this.threads) void t.worker.terminate();
    this.threads = [];
  }
}

if (!isMainThread && parentPort) {
  const port = parentPort;
  let r: Ruleset | null = null;
  let ctx: TaskContext | null = null;
  port.on('message', (m: ToWorker) => {
    if ('ruleset' in m) {
      r = m.ruleset;
      ctx = m.ctx;
      return;
    }
    try {
      port.postMessage({ id: m.id, outcome: playFight(r!, ctx!, m.job) } satisfies FromWorker);
    } catch (e) {
      port.postMessage({ id: m.id, error: (e as Error).stack ?? (e as Error).message } satisfies FromWorker);
    }
  });
}
