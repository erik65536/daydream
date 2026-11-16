/**
 * Running steps: one call per item, side by side, through the gateway (which checks every answer against its
 * schema and asks again when it does not fit). Each run is saved with what it was made from, so a run whose step
 * or inputs have changed since shows as out of date. Spend is counted here, call by call, and stopped at a cap.
 */
import { callContext, withCallContext } from '../genai/context.ts';
import { GenAIError } from '../genai/types.ts';
import { genai } from '../genai/service.ts';
import type { Project } from './project.ts';
import { unique } from './names.ts';
import { request, Scope, type Prepared } from './scope.ts';
import { hash, noUsage, type RunRecord, type RunStore } from './store.ts';
import type { Example } from './types.ts';

/** Dollars spent, and the most that may be. A call is not started once the cap is reached. */
export class Budget {
  spent = 0;
  cap: number;
  constructor(cap: number) {
    this.cap = cap;
  }
  check() {
    if (this.spent >= this.cap) throw new Error(`The spending cap of $${this.cap.toFixed(2)} is reached ($${this.spent.toFixed(3)} spent)`);
  }
}

export type Status = { state: 'fresh' | 'stale' | 'missing' | 'failed'; why?: string };

/**
 * Whether a step's newest run still holds: the step would send exactly what it sent (the request, and the values its
 * checks look for, hold everything it read: the facts and constants it uses and the answers of the steps before it),
 * and none of those steps is out of date itself. A change to anything it does not read leaves it as it is, so a step
 * before it that ran again with the same answer to what it reads (or a new field it does not read) changes nothing.
 */
export function status(project: Project, store: RunStore, example: Example, id: string, memo = new Map<string, Status>(), scope = new Scope(project, example, store, 'saved')): Status {
  const hit = memo.get(id);
  if (hit) return hit;
  memo.set(id, { state: 'fresh' }); // (steps that read each other are a problem of their own)
  const run = store.latest(example.id, id);
  let s: Status;
  if (!run) {
    const failed = store.newest(example.id, id);
    s = failed ? { state: 'failed', why: failed.error } : { state: 'missing' };
  }
  // A change to the step that sends the same (an equivalent rewrite, a comment) leaves its runs as they are.
  else if (run.fingerprint.sent !== sentHash(scope, id)) s = { state: 'stale', why: 'What it would send has changed since' };
  else {
    s = { state: 'fresh' };
    for (const d of run.fingerprint.reads) {
      if (!project.steps.has(d)) continue;
      if (status(project, store, example, d, memo, scope).state === 'stale') {
        s = { state: 'stale', why: `${d} is out of date` };
        break;
      }
    }
  }
  memo.set(id, s);
  return s;
}

/** What a step would send now, as a fingerprint (none when it cannot be made). */
function sentHash(scope: Scope, id: string): string | undefined {
  try {
    return sent(scope, scope.prepare(id));
  } catch {
    return undefined;
  }
}

/** What a call sends and is held to: its request, its checks, and the names its own must differ from. */
const sentBy = (scope: Scope, p: Prepared, c: Prepared['calls'][number]) => [scope.body(p.step, c), c.checks, c.names ?? null];

/** What a prepared step sends, call by call. */
function sent(scope: Scope, p: Prepared): string {
  return hash(p.calls.map((c) => sentBy(scope, p, c)));
}

export type Tier = 'default' | 'flex';

interface RunOptions {
  budget: Budget;
  /** OpenAI's processing tier: standard while designing, for quick answers; a build asks for flex, at half price. */
  tier: Tier;
  /** Told how it goes, in a line. */
  report?: (line: string) => void;
}

/** A step ready to run on an example from the newest runs of what it reads, and what its run will be made from. */
function prepareRun(project: Project, store: RunStore, example: Example, id: string) {
  const scope = new Scope(project, example, store, 'saved');
  const p = scope.prepare(id);
  if (p.missing.length) throw new Error(`${id} reads ${p.missing.join(', ')}, which ${p.missing.length > 1 ? 'have' : 'has'} not run on ${example.id} yet`);
  if (p.problems.length) throw new Error(`${id} has problems: ${p.problems.join('; ')}`);
  const requests = p.calls.map((c) => ({ item: c.item, body: scope.body(p.step, c) }));
  const fingerprint = { sent: sent(scope, p), reads: [...p.access.deps].filter((d) => d !== id) };
  // Each call by what it sends, so an answer to it can be kept for another try of the step.
  const keys = p.calls.map((c) => hash(sentBy(scope, p, c)));
  return { p, step: p.step, keys, base: { step: id, example: example.id, at: Date.now(), fingerprint, requests, usage: noUsage() } };
}

/**
 * Runs a step on an example once, from the newest runs of the steps it reads. `answered` holds the answers of a try
 * before this one, by what each call sent: a step run once per item asks again only for the items that failed, and
 * adds the answers it gets.
 */
export async function runStep(project: Project, store: RunStore, example: Example, id: string, opts: RunOptions, answered = new Map<string, unknown>()): Promise<RunRecord> {
  const { p, step, keys, base } = prepareRun(project, store, example, id);
  const { usage, at } = base;
  if (!p.runs) return store.save({ ...base, ms: 0, output: null });
  opts.budget.check();
  try {
    // Within a build, the build's context stays (whose budget pays, which job), with this step's own counting added.
    const outer = callContext();
    const settled = await withCallContext(
      {
        ...outer,
        priority: outer?.priority ?? 'background',
        step: `pipeline ${id}`,
        onUsage: (u) => {
          outer?.onUsage?.(u);
          usage.calls++;
          usage.usd += u.usd;
          usage.input += u.input;
          usage.cached += u.cached;
          usage.output += u.output;
          usage.reasoning += u.reasoning;
          opts.budget.spent += u.usd;
        },
      },
      () =>
        // Every call is waited for, so one that fails leaves the others' answers, and their cost, in hand.
        Promise.allSettled(p.calls.map(async (c, i) => {
          if (answered.has(keys[i]!)) return answered.get(keys[i]!);
          const ask = request(step, c, opts.tier);
          const first = await genai().structured(step.purpose, ask);
          const answer = c.names ? await unique(step, c.names, c.schema, first, { system: ask.system, prompt: ask.prompt, extraBody: ask.extraBody }, (from, to) => opts.report?.(`${example.id} · ${id}: renamed ${from} (used already) to ${to}`)) : first;
          answered.set(keys[i]!, answer);
          return answer;
        })),
    );
    const failed = settled.find((s): s is PromiseRejectedResult => s.status === 'rejected');
    if (failed) throw failed.reason;
    const answers = settled.map((s) => (s as PromiseFulfilledResult<unknown>).value);
    const output = step.forEach ? Object.fromEntries(p.calls.map((c, i) => [c.item!, answers[i]])) : answers[0];
    const run = store.save({ ...base, ms: Date.now() - at, output });
    opts.report?.(`${example.id} · ${id}: done in ${((Date.now() - at) / 1000).toFixed(0)} s, $${usage.usd.toFixed(4)}`);
    return run;
  } catch (e) {
    const run = store.save({ ...base, ms: Date.now() - at, error: (e as Error).message, partial: e instanceof GenAIError ? e.partial : undefined });
    opts.report?.(`${example.id} · ${id}: failed: ${(e as Error).message.slice(0, 200)}`);
    return run;
  }
}

/**
 * Keeps an answer changed by hand (an owner's choice on the review before a world exists, worldgen/review.ts) as
 * the step's newest run, made from what the step would send now: it is fresh, and the steps after it read it. The
 * answer must be one the step could have given to that request.
 */
export function amendStep(project: Project, store: RunStore, example: Example, id: string, output: unknown): RunRecord {
  const { base } = prepareRun(project, store, example, id);
  return store.save({ ...base, ms: 0, output, edited: true });
}

/**
 * Runs steps on an example in order, each once the steps it reads are done (those that need nothing from each other
 * at the same time). `only` limits it to some steps, which still need the others' runs; `stale` runs only the steps
 * not fresh. A step that fails is tried again up to `tries` times, after `wait` (a build's model may fail now and
 * then); `onStep` hears each step start and end, or that a fresh one was kept.
 */
export async function runSteps(project: Project, store: RunStore, example: Example, order: string[], opts: RunOptions & { only?: string[]; stale?: boolean; tries?: number; wait?: (attempt: number, error: string) => Promise<void>; onStep?: (id: string, state: 'running' | 'done' | 'failed' | 'kept', run?: RunRecord) => void }): Promise<RunRecord[]> {
  const want = order.filter((id) => !opts.only || opts.only.includes(id));
  const done = new Map<string, Promise<RunRecord | undefined>>();
  // What each step reads does not depend on what has run: one made-up world tells it for all of them.
  const made = new Scope(project, example, store, 'sample');
  const reads = (id: string) => [...made.prepare(id).access.deps].filter((d) => d !== id);
  const tries = Math.max(1, opts.tries ?? 1);
  for (const id of want) {
    const before = reads(id).map((d) => done.get(d)).filter((x): x is Promise<RunRecord | undefined> => !!x);
    done.set(id, Promise.all(before).then(async (prior) => {
      if (prior.some((r) => !r || r.error)) return undefined;
      if (opts.stale && status(project, store, example, id).state === 'fresh') {
        const kept = store.latest(example.id, id);
        opts.onStep?.(id, 'kept', kept);
        return kept;
      }
      opts.onStep?.(id, 'running');
      // A try keeps the answers the try before it got (a step run once per item asks again only for what failed).
      const answered = new Map<string, unknown>();
      let run = await runStep(project, store, example, id, opts, answered);
      for (let n = 1; run.error && n < tries; n++) {
        await opts.wait?.(n, run.error);
        run = await runStep(project, store, example, id, opts, answered);
      }
      opts.onStep?.(id, run.error ? 'failed' : 'done', run);
      return run;
    }));
  }
  return (await Promise.all(done.values())).filter((r): r is RunRecord => !!r);
}
