/**
 * What a job's work costs, counted as it happens: every paid model call (model, tier, tokens, dollars, pictures),
 * every ComfyUI prompt (GPU seconds and time waiting for its turn), every span of a named step and every try of work
 * that is tried again. Each event carries the call context's job tag and step (`atStep`), so it is counted twice over:
 *
 * - **Tallies**, always: a job's totals by step, by model purpose, and by model, kept in memory while a job holds one
 *   open (`openTally`) and saved with its world by worldgen/metrics.ts. Small, and enough to price builds later.
 * - **The meter log**, when DAYDREAM_METER=1 (in .env, say): every event as a line of data/logs/meter.jsonl, with this
 *   process's CPU time every few seconds and the steps running then, for studies of one build in detail.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';
import { callContext, withCallContext } from './context.ts';
import { appendLine } from '../logfile.ts';

const file = path.join(DATA_DIR, 'logs', 'meter.jsonl');
let dirMade = false;

/** Whether this process writes the meter log (read once, at its first use). */
let on: boolean | undefined;
const metering = () => (on ??= process.env.DAYDREAM_METER === '1');

// ------------------------------------------------------------------------------------ tallies

/** Counts of one kind of work; a count that stayed at zero is left out. */
export interface Tally {
  /** Dollars of paid model calls, and the calls. */
  usd?: number;
  calls?: number;
  /** Tokens: text input (of it, cached), output (of it, reasoning) and image input. */
  input?: number;
  cached?: number;
  output?: number;
  reasoning?: number;
  imageInput?: number;
  /** Pictures a paid image model made. */
  images?: number;
  /** GPU work (ComfyUI prompts and voice sessions), the GPU's time on it, and its wait for a turn. */
  prompts?: number;
  gpuMs?: number;
  queueMs?: number;
  /** Spans of a named step, and their time added up (spans that run side by side each count). */
  spans?: number;
  ms?: number;
  /** Tries of work that is tried again until it works, those that failed, and the chains that ran out of tries. */
  tries?: number;
  failed?: number;
  gaveUp?: number;
}

/** A job's tallies: the whole, by step, by model purpose, and by model and tier ("gpt-6-luna flex"). */
export interface JobTally {
  total: Tally;
  steps: Record<string, Tally>;
  purposes: Record<string, Tally>;
  models: Record<string, Tally>;
}

export const emptyTally = (): JobTally => ({ total: {}, steps: {}, purposes: {}, models: {} });

/** The tallies open now, by world and job. */
const tallies = new Map<string, JobTally>();
const key = (worldId: string | undefined, jobId: string | undefined) => `${worldId ?? ''}/${jobId ?? ''}`;

/** Count a job's work from now on, adding to what it counted before (a resumed job's saved tallies). */
export function openTally(worldId: string, jobId: string, from: JobTally = emptyTally()): JobTally {
  tallies.set(key(worldId, jobId), from);
  return from;
}

export const closeTally = (worldId: string, jobId: string) => void tallies.delete(key(worldId, jobId));

/** A job's open tally (none when nothing records it, as in a run from the console). */
export const tallyOf = (worldId: string, jobId: string | undefined): JobTally | undefined => tallies.get(key(worldId, jobId));

function add(t: Tally, counts: Tally) {
  for (const [k, v] of Object.entries(counts) as [keyof Tally, number | undefined][]) if (v) t[k] = (t[k] ?? 0) + v;
}

/** Add counts to the open tally of the job the current call is for, under its step, purpose, and model. */
function count(counts: Tally, model?: string) {
  const ctx = callContext();
  const t = tallies.get(key(ctx?.tag?.worldId, ctx?.tag?.jobId));
  if (!t) return;
  add(t.total, counts);
  add((t.steps[ctx?.step ?? 'other'] ??= {}), counts);
  if (ctx?.purpose) add((t.purposes[ctx.purpose] ??= {}), counts);
  if (model) add((t.models[model] ??= {}), counts);
}

// ------------------------------------------------------------------------------------ events

function write(kind: string, entry: Record<string, unknown>) {
  if (!metering()) return;
  const ctx = callContext();
  if (!dirMade) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    dirMade = true;
  }
  const line = { t: Date.now(), kind, pid: process.pid, jobId: ctx?.tag?.jobId, worldId: ctx?.tag?.worldId, job: ctx?.tag?.kind, step: ctx?.step, purpose: ctx?.purpose, ...entry };
  appendLine(file, JSON.stringify(line));
}

/** A paid model call: its model, tier (standard, flex, or batch), API, tokens, dollars, and the pictures it made. */
export function meterCall(entry: { provider: string; api: string; model: string; tier: string; usd: number; input?: number; cached?: number; output?: number; reasoning?: number; imageInput?: number; images?: number }) {
  count({ usd: entry.usd, calls: 1, input: entry.input, cached: entry.cached, output: entry.output, reasoning: entry.reasoning, imageInput: entry.imageInput, images: entry.images }, `${entry.model} ${entry.tier}`);
  write('call', entry);
}

/**
 * A piece of GPU work: the GPU's time on it (a ComfyUI prompt from ComfyUI's own start and finish, a voice session
 * from when the broker gave it the GPU until it gave it back), the wait for its turn, and the whole.
 */
export function meterGpu(entry: { workflow?: string; gpuMs: number; queueMs: number; wallMs: number; ok: boolean; error?: string; cold?: boolean }) {
  count({ prompts: 1, gpuMs: entry.gpuMs, queueMs: entry.queueMs });
  write('gpu', entry);
}

/**
 * Work that is tried again until it works or its tries run out: one chain per piece of work (`retries`), one line per
 * try, the last marked `final`, so a report can tell how often retries happen, how often they rescue the work, and
 * how often they run out. `layer` says which mechanism retries (the gateway, a build step, a quality check).
 */
export function retries(layer: string, label: string) {
  const chain = crypto.randomBytes(4).toString('hex');
  let n = 0;
  return {
    /** One try's outcome; `final` when no further try follows (it worked, or the tries ran out). */
    try(ok: boolean, final: boolean, error?: string, extra?: Record<string, unknown>) {
      count({ tries: 1, failed: ok ? 0 : 1, gaveUp: final && !ok ? 1 : 0 });
      write('try', { layer, label: label.slice(0, 80), chain, attempt: ++n, ok, final, ...(error ? { error: error.slice(0, 200) } : {}), ...extra });
    },
  };
}

/** A Batch API batch sent or come back (its time out is the gap between the two). */
export function meterBatch(entry: { id: string; event: 'sent' | 'back'; requests: number; state?: string }) {
  write('batch', entry);
}

/** Steps running in this process now (a step may run several times at once, as places do). */
const running = new Map<string, number>();

/** Run `fn` as a named step: its model calls and GPU prompts are counted to it, and its span is counted and written. */
export async function atStep<T>(step: string, fn: () => Promise<T>): Promise<T> {
  const ctx = callContext();
  const inner = { ...(ctx ?? { priority: 'background' as const }), step };
  const t0 = Date.now();
  const runKey = `${ctx?.tag?.jobId ?? ''}|${step}`;
  if (metering()) {
    sampleCpu();
    running.set(runKey, (running.get(runKey) ?? 0) + 1);
  }
  let ok = false;
  try {
    const out = await withCallContext(inner, fn);
    ok = true;
    return out;
  } finally {
    withCallContext(inner, () => count({ spans: 1, ms: Date.now() - t0 }));
    if (metering()) {
      write('span', { step, start: t0, ms: Date.now() - t0, ok });
      sampleCpu();
      const n = (running.get(runKey) ?? 1) - 1;
      if (n > 0) running.set(runKey, n);
      else running.delete(runKey);
    }
  }
}

let lastCpu = process.cpuUsage();
let lastAt = Date.now();
let timer: ReturnType<typeof setInterval> | null = null;

/**
 * This process's CPU time since the last sample (every thread: the balance simulation's included), with the steps
 * running during it, so a report can share it between them.
 */
function sampleCpu() {
  timer ??= setInterval(sampleCpu, 5000).unref();
  const now = Date.now();
  const cpu = process.cpuUsage(lastCpu);
  if (now - lastAt >= 1000) {
    const steps = [...running.entries()].map(([k, n]) => ({ jobId: k.split('|')[0] || undefined, step: k.split('|').slice(1).join('|'), n }));
    write('cpu', { ms: now - lastAt, userMs: cpu.user / 1000, systemMs: cpu.system / 1000, steps });
    lastCpu = process.cpuUsage();
    lastAt = now;
  }
}
