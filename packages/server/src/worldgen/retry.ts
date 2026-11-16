/**
 * Work that must succeed: tried again after a wait when it fails, and after the last try the job stops with a
 * StepFailed (to be resumed once the service works). There is no made-up stand-in. A build's steps, its places, voices,
 * and sounds, and the art's image prompts all run under it.
 */
import { retries } from '../genai/meter.ts';
import { BudgetExceeded } from '../genai/spend.ts';
import { JobYield } from '../jobs/job.ts';

/** Tests shorten the waits between tries (DAYDREAM_RETRY_WAIT_SCALE=0). */
const RETRY_WAIT_SCALE = Number(process.env.DAYDREAM_RETRY_WAIT_SCALE ?? 1);

/** Tries per step before the job stops (it can be resumed later), and the waits between. */
export const STEP_TRIES = 4;
export const STEP_BACKOFF_MS = [5_000, 30_000, 120_000].map((ms) => ms * RETRY_WAIT_SCALE);
export const waitBeforeTry = (n: number) => new Promise<void>((r) => setTimeout(r, STEP_BACKOFF_MS[n - 1] ?? 120_000));

/** A step that failed after every try. The job stops here and can be resumed. */
export class StepFailed extends Error {}

/** The job this work belongs to has stopped (another piece failed, or it was told to): nothing more is tried. */
export class Halted extends Error {
  constructor() {
    super('stopped');
  }
}

interface Trying {
  report: (msg: string, level?: 'warn') => void;
  /** Why nothing more should be tried, when the job has stopped: thrown in place of the work's own error. */
  halt?: () => Error | undefined;
  /** The work succeeded, after this many seconds of its last try. */
  done?: (seconds: number) => void;
}

/**
 * Do a piece of work that must succeed. A job that has stopped ends the tries at once, before the first and after any
 * failure or wait, without a verdict on the work; running out of AI budget stops it at once too.
 */
export async function attempt<T>(label: string, fn: () => Promise<T>, o: Trying): Promise<T> {
  const before = o.halt?.();
  if (before) throw before;
  const tries = retries('step', label);
  for (let n = 1; ; n++) {
    const t0 = Date.now();
    try {
      const out = await fn();
      tries.try(true, true);
      o.done?.((Date.now() - t0) / 1000);
      return out;
    } catch (e) {
      const msg = (e as Error).message;
      const halted = o.halt?.();
      const interrupted = !!halted || e instanceof JobYield || e instanceof Halted;
      tries.try(false, interrupted || e instanceof StepFailed || e instanceof BudgetExceeded || n >= STEP_TRIES, interrupted ? `interrupted: ${msg}` : msg);
      if (halted) throw halted;
      if (e instanceof JobYield || e instanceof Halted || e instanceof StepFailed) throw e;
      if (e instanceof BudgetExceeded) throw new StepFailed(`${label}: ${msg} Resume the build then.`);
      if (n >= STEP_TRIES) throw new StepFailed(`${label} failed ${STEP_TRIES} times (last: ${msg.slice(0, 200)}). Resume the build once the service is working.`);
      o.report(`${label}: try ${n} failed (${msg.slice(0, 200)}); trying again in ${Math.round((STEP_BACKOFF_MS[n - 1] ?? 120_000) / 1000)}s`, 'warn');
      await waitBeforeTry(n);
      const after = o.halt?.();
      if (after) throw after;
    }
  }
}
