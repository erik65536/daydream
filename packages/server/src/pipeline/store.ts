/**
 * Every run of a step is kept: exactly what was sent, what came back, what it cost, and what it was made from. The
 * newest good run of a step is what the steps after it read. Runs live in data/pipeline/<example>/<step>/ for the
 * editor, or wherever a build keeps them.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';

export interface Usage {
  usd: number;
  calls: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

export const noUsage = (): Usage => ({ usd: 0, calls: 0, input: 0, cached: 0, output: 0, reasoning: 0 });

export interface RunRecord {
  id: string;
  step: string;
  example: string;
  at: number;
  ms: number;
  /** What it was made from: a hash of exactly what it sends, and the steps it read. */
  fingerprint: { sent: string; reads: string[] };
  /** The request bodies as sent (one per item for a step run once per item). */
  requests: { item?: string; body: Record<string, unknown> }[];
  /** The answer (keyed by item for a step run once per item); null when its `when` found nothing. */
  output?: unknown;
  error?: string;
  /** The text an answer cut off at its limit had reached. */
  partial?: string;
  /** Changed by hand rather than answered by the model (pipeline/run.ts, amendStep). */
  edited?: boolean;
  usage: Usage;
}

export const hash = (v: unknown) => crypto.createHash('sha1').update(JSON.stringify(v) ?? 'undefined').digest('hex').slice(0, 16);

const SAFE = /^[a-zA-Z0-9_-]+$/;

export class RunStore {
  readonly dir: string;
  constructor(dir = path.join(DATA_DIR, 'pipeline')) {
    this.dir = dir;
  }

  private folder(example: string, step: string) {
    if (!SAFE.test(example) || !SAFE.test(step)) throw new Error('Not an example or step id');
    return path.join(this.dir, example, step);
  }

  save(r: Omit<RunRecord, 'id'>): RunRecord {
    const d = new Date(r.at);
    const id = `${d.toISOString().replace(/[-:]/g, '').replace('T', '-').replace(/\..*/, '')}-${String(d.getMilliseconds()).padStart(3, '0')}-${crypto.randomBytes(2).toString('hex')}`;
    const run = { id, ...r };
    this.write(run);
    return run;
  }

  /** Keep a run made elsewhere as it is (a review's runs, moved into the world they were for). */
  put(run: RunRecord): void {
    if (!SAFE.test(run.id)) throw new Error('Not a run id');
    this.write(run);
  }

  /** A run's file, written whole or not at all: a stop halfway leaves no file that cannot be read. */
  private write(run: RunRecord) {
    const dir = this.folder(run.example, run.step);
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${run.id}.json`);
    fs.writeFileSync(`${file}.tmp`, JSON.stringify(run, null, 1));
    fs.renameSync(`${file}.tmp`, file);
  }

  /** The ids of a step's runs on an example, newest first (an id starts with the time of its run). */
  private ids(example: string, step: string): string[] {
    const dir = this.folder(example, step);
    if (!fs.existsSync(dir)) return [];
    return fs.readdirSync(dir).filter((f) => f.endsWith('.json')).map((f) => f.slice(0, -5)).sort().reverse();
  }

  private read(example: string, step: string, id: string): RunRecord {
    return JSON.parse(fs.readFileSync(path.join(this.folder(example, step), `${id}.json`), 'utf8')) as RunRecord;
  }

  /** A step's runs on an example, newest first. */
  list(example: string, step: string): RunRecord[] {
    return this.ids(example, step).map((id) => this.read(example, step, id));
  }

  /** A step's newest run, whether it gave an answer or failed. */
  newest(example: string, step: string): RunRecord | undefined {
    const id = this.ids(example, step)[0];
    return id === undefined ? undefined : this.read(example, step, id);
  }

  /**
   * The newest run that gave an answer (or found it had nothing to do): what the steps after it read. Runs are read
   * from the newest back, and no further than the first with an answer.
   */
  latest(example: string, step: string): RunRecord | undefined {
    for (const id of this.ids(example, step)) {
      const run = this.read(example, step, id);
      if (run.output !== undefined) return run;
    }
    return undefined;
  }

  get(example: string, step: string, id: string): RunRecord | undefined {
    if (!SAFE.test(id)) return undefined;
    const file = path.join(this.folder(example, step), `${id}.json`);
    return fs.existsSync(file) ? (JSON.parse(fs.readFileSync(file, 'utf8')) as RunRecord) : undefined;
  }
}
