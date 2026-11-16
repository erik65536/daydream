/**
 * Making sounds from their orders (sound/prompts.ts): each take is generated on the GPU (Stable Audio 3 through the
 * broker), made game-ready on a thread of its own (sound/worker.ts), and kept or refused. A sound keeps as many takes
 * as it has variants; refused ones are made again with new seeds, twice at most, and a sound with no good take is
 * left out (the game then plays its stand-in, or nothing). What was kept before is kept, so a stopped build resumes.
 *
 * A take's seed is its number among all the takes ever made of its sound, counted in a file beside the sounds' folder.
 * So making a sound again, after it was refused or to have it anew, makes new takes and never the same ones twice.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { Worker } from 'node:worker_threads';
import { soundFile, type SoundDef, type SoundKey } from '@daydream/shared';
import { stableAudio } from '../worldgen/comfy.ts';
import type { SoundModel, SoundOrder } from './prompts.ts';
import type { TakeJob, TakeResult } from './worker.ts';

/** Opus bit rates (both channels), by where a sound is heard. */
export const KBPS = { interface: 64, effects: 64, ambience: 96, music: 112 } as const;
/** Rounds of takes for a sound: the first, then retakes of what was refused. */
const ROUNDS = 3;

let worker: Worker | null = null;
const waiting = new Map<number, (r: TakeResult) => void>();
let nextId = 1;

/** Make one generated take game-ready on the sound thread. */
function readyTake(flac: Uint8Array, order: SoundOrder): Promise<TakeResult> {
  if (!worker) {
    worker = new Worker(new URL('./worker.ts', import.meta.url));
    worker.on('message', (r: TakeResult) => {
      waiting.get(r.id)?.(r);
      waiting.delete(r.id);
      // An idle thread does not keep the process alive (a console tool ends when its work does).
      if (!waiting.size) worker?.unref();
    });
    worker.on('error', (e: Error) => {
      for (const [id, done] of waiting) done({ id, ok: false, problem: `the sound thread failed: ${e.message}` });
      waiting.clear();
      worker = null;
    });
  }
  const id = nextId++;
  const job: TakeJob = { id, flac, spec: order.spec, bpm: order.bpm, kbps: KBPS[order.spec.bus] };
  return new Promise((resolve) => {
    waiting.set(id, resolve);
    worker!.ref();
    worker!.postMessage(job);
  });
}

interface SoundMaking {
  /** The folder the files go in. */
  dir: string;
  /** What exists already (its files are kept). */
  have: Record<SoundKey, SoundDef>;
  /** What the seeds are made from, with each sound's key and its take's number: a world's id. */
  seedBase: string;
  /**
   * The file that counts the takes made of each sound, so the next are new ones: beside the sounds' folder unless
   * another is given, and none (null) when every run has a seed base of its own.
   */
  takesFile?: string | null;
  /** Run GPU work in its turn (a build's GPU queue; by default at once). */
  gpu?: <T>(model: SoundModel, fn: () => Promise<T>) => Promise<T>;
  report(msg: string, level?: 'warn'): void;
  shouldStop(): boolean;
  progress?(frac: number): void;
  /** A sound is finished (made, or given up on: null). */
  onSound?(key: SoundKey, def: SoundDef | null): void;
}

const seedOf = (base: string, key: string, n: number) => crypto.createHash('sha1').update(`${base}:${key}:${n}`).digest().readUInt32LE(0) % 2_000_000_000;

/** How many takes were ever made of each sound (the file that counts them), and a way to keep the count. */
function takesMade(file: string | null): { count: Record<SoundKey, number>; keep(): void } {
  let count: Record<SoundKey, number> = {};
  try {
    if (file) count = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<SoundKey, number>;
  } catch {
    // None counted yet.
  }
  return { count, keep: () => file && fs.writeFileSync(file, JSON.stringify(count)) };
}

/** Make every sound ordered that is not already there; returns the whole set. */
export async function makeSounds(orders: SoundOrder[], m: SoundMaking): Promise<Record<SoundKey, SoundDef>> {
  fs.mkdirSync(m.dir, { recursive: true });
  const exists = (d: SoundDef | undefined) => !!d?.files.length && d.files.every((f) => fs.existsSync(path.join(m.dir, f))) && (!d.intro || fs.existsSync(path.join(m.dir, d.intro)));
  const out: Record<SoundKey, SoundDef> = {};
  for (const o of orders) if (exists(m.have[o.key])) out[o.key] = m.have[o.key]!;
  // Small SFX first, then Medium: the GPU changes models once.
  const todo = orders.filter((o) => !out[o.key]).sort((a, b) => Number(a.model === 'medium') - Number(b.model === 'medium'));
  const gpu = m.gpu ?? ((_model, fn) => fn());
  const counted = takesMade(m.takesFile === undefined ? `${m.dir}.takes.json` : m.takesFile);
  let done = orders.length - todo.length;
  const failed: string[] = [];
  m.progress?.(done / Math.max(1, orders.length));
  if (todo.length) m.report(`Sounds: making ${todo.length} of ${orders.length}`);

  const make = async (o: SoundOrder) => {
    const files: string[] = [];
    let intro: string | undefined;
    // Its takes carry on from the last one ever made of it.
    let tries = counted.count[o.key] ?? 0;
    const problems: string[] = [];
    for (let round = 0; round < ROUNDS && files.length < o.spec.variants; round++) {
      const takes = Array.from({ length: o.spec.variants - files.length }, () => tries++);
      for (const n of takes) {
        if (m.shouldStop()) throw new Error('stopped');
        const flac = await gpu(o.model, () => stableAudio(o.model, o.prompt, o.seconds, seedOf(m.seedBase, o.key, n)));
        counted.count[o.key] = n + 1;
        counted.keep();
        const r = await readyTake(flac, o);
        if (!r.ok) {
          problems.push(r.problem);
          continue;
        }
        const file = soundFile(o.key, files.length);
        fs.writeFileSync(path.join(m.dir, file), r.main);
        if (r.intro) fs.writeFileSync(path.join(m.dir, (intro = soundFile(o.key, files.length, 'intro'))), r.intro);
        files.push(file);
      }
    }
    const def = files.length ? { files, ...(intro ? { intro } : {}) } : null;
    if (def) out[o.key] = def;
    else failed.push(`${o.key} (${[...new Set(problems)].join('; ')})`);
    m.onSound?.(o.key, def);
    m.progress?.(++done / orders.length);
  };

  // Two sounds at a time: one generating while the other's takes are made game-ready.
  let next = 0;
  await Promise.all(Array.from({ length: 2 }, async () => {
    while (next < todo.length) await make(todo[next++]!);
  }));
  if (failed.length) m.report(`Sounds: ${failed.length} could not be made, so the game stands in for them or stays quiet: ${failed.slice(0, 6).join(', ')}${failed.length > 6 ? '…' : ''}`, 'warn');
  return out;
}
