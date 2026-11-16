/**
 * The build pipeline (docs/build-pipeline.md): the build's text steps as data, each one Responses API call, run by
 * this one runner for the editor, the CLI, and the build alike.
 */
import { analyze, type Analysis } from './analysis.ts';
import { follow } from './path.ts';
import { Project } from './project.ts';
import { z } from 'zod';
import { exampleFacts, plain, type Facts } from './facts.ts';
import { RECORDS, type RecordName } from './records.ts';
import { assemble, compileRules, type Records } from './world.ts';
import { Chat } from './chat.ts';
import type { Ruleset, WorldDefinition } from '@daydream/shared';
import { amendStep, Budget, runStep, runSteps, status, type Status, type Tier } from './run.ts';
import { plain as plainSchema } from './schema.ts';
import { Scope, type Mode } from './scope.ts';
import { RunStore, type RunRecord } from './store.ts';
import { newAccess, Views } from './track.ts';
import type { Example, StepDef } from './types.ts';

export { Budget, Project, RunStore, type Analysis, type RunRecord, type Status };
export type { StepDef } from './types.ts';
export type { Mode } from './scope.ts';

/** What a step would send, call by call. */
export interface Preview {
  /** Each call's prompt, its answer's shape as the model is told it (limits as given), and its body as sent. */
  calls: { item?: string; system: string; user: string; schema: Record<string, unknown>; body?: Record<string, unknown> }[];
  /** Steps it reads that have not run (their made-up outputs stand in). */
  missing: string[];
  problems: string[];
  runs: boolean;
}

export class Pipeline {
  readonly project: Project;
  readonly store: RunStore;
  readonly budget: Budget;
  /** The editor and the CLI run at the standard tier, for quick answers; a build passes flex. */
  readonly tier: Tier;

  constructor(opts: { dir?: string; runs?: string; cap?: number; tier?: Tier } = {}) {
    this.project = new Project(opts.dir);
    this.store = new RunStore(opts.runs);
    this.budget = new Budget(opts.cap ?? 1);
    this.tier = opts.tier ?? 'default';
  }

  /** An example by id, or one given whole (a build's world: worldgen/build.ts). */
  example(id: string | Example): Example {
    if (typeof id !== 'string') return id;
    const ex = this.project.examples.get(id);
    if (!ex) throw new Error(`There is no example "${id}" (${[...this.project.examples.keys()].join(', ')})`);
    return ex;
  }

  step(id: string) {
    const s = this.project.steps.get(id);
    if (!s) throw new Error(`There is no step "${id}"`);
    return s;
  }

  analyze(example: string | Example): Analysis {
    return analyze(this.project, this.example(example), this.store);
  }

  /**
   * What a step sends: from the newest runs of what it reads (`saved`), or from made-up outputs (`sample`).
   * `draft` shows the step as edited but not saved.
   */
  preview(example: string | Example, id: string, mode: Mode = 'saved', draft?: StepDef): Preview {
    const step = draft ?? this.step(id);
    const project = draft ? this.project.withStep(draft) : this.project;
    const scope = new Scope(project, this.example(example), this.store, mode);
    const p = scope.prepare(id);
    const problems = [...p.problems];
    const calls = p.calls.map((c) => {
      let body: Record<string, unknown> | undefined;
      try {
        body = scope.body(step, c, this.tier);
      } catch (e) {
        problems.push(`The request cannot be made: ${(e as Error).message}`);
      }
      return { item: c.item, system: c.system, user: c.user, schema: plainSchema(c.schema), body };
    });
    return { calls, missing: p.missing, problems: [...new Set(problems)], runs: p.runs };
  }

  /**
   * The game's world from an example's newest runs (world.ts), as a build will make it before painting. Refuses,
   * naming them, when steps it needs have not run.
   */
  world(example: string | Example): WorldDefinition {
    const ex = this.example(example);
    const { records, missing } = this.records(example);
    if (missing.size) throw new Error(`Run ${[...missing].join(', ')} on ${ex.id} first: the world needs ${missing.size > 1 ? 'them' : 'it'}`);
    return assemble(ex, exampleFacts(ex), records);
  }

  /**
   * The rules alone from an example's newest runs, as `world` makes them, without reading its story, places, or
   * people: a built world is rebalanced from its rules records whatever became of its other steps' answers.
   */
  ruleset(example: string | Example): Ruleset {
    const ex = this.example(example);
    return compileRules(ex, exampleFacts(ex), this.records(example).records);
  }

  /** Every game record from an example's newest runs, and the steps that have not run for them. */
  private records(example: string | Example): { records: Records; missing: Set<string> } {
    const records = {} as Records;
    const missing = new Set<string>();
    for (const name of Object.keys(RECORDS) as RecordName[]) {
      const r = this.record(example, name);
      for (const m of r.missing) missing.add(m);
      if (!r.from) throw new Error(`Nothing fills the record "${name}" (pipeline/records.yaml)`);
      (records as Record<string, unknown>)[name] = r.value;
    }
    return { records, missing };
  }

  /**
   * A conversation with one of an example's people, by id or by part of their name, in the world its runs make.
   */
  chat(example: string | Example, person: string): Chat {
    const w = this.world(example);
    const want = person.toLowerCase();
    const npc = w.npcs.find((n) => n.id === person) ?? w.npcs.find((n) => n.name.toLowerCase().includes(want));
    if (!npc) throw new Error(`Nobody in ${this.example(example).id} is called "${person}": ${w.npcs.map((n) => `${n.id} ${n.name}`).join(', ')}`);
    return new Chat(`${this.example(example).id}_${npc.id}_${Date.now().toString(36)}`, w, npc.id, this.budget);
  }

  /** What the engine lays out from an example before any call (`input`, `map` and `game`), as plain data. */
  facts(example: string | Example): Facts {
    return plain(exampleFacts(this.example(example))) as Facts;
  }

  /**
   * A game record: its shape (as JSON Schema), and what the newest runs of an example fill it with (`missing` steps
   * have not run).
   */
  record(example: string | Example, name: string): { shape: Record<string, unknown>; from?: string; value: unknown; missing: string[] } {
    if (!(name in RECORDS)) throw new Error(`There is no record "${name}"`);
    const shape = z.toJSONSchema(RECORDS[name as RecordName]) as Record<string, unknown>;
    const from = this.project.records[name];
    if (!from) return { shape, value: null, missing: [] };
    const ex = this.example(example);
    const access = newAccess();
    const f = follow(new Views(new Scope(this.project, ex, this.store, 'saved'), access).root(), from);
    const missing = [...access.deps].filter((d) => !this.store.latest(ex.id, d));
    const value = !missing.length && f.kind === 'one' ? JSON.parse(JSON.stringify(f.value ?? null)) : null;
    return { shape, from, value, missing };
  }

  /**
   * The names the example's newest answers give to ids (a place's, a story person's, an arc's), to show beside an
   * id wherever it appears. Entries keyed by id are named by their `name`, `title` or `label`.
   */
  names(example: string | Example): Record<string, string> {
    const names: Record<string, string> = {};
    const walk = (v: unknown) => {
      if (!v || typeof v !== 'object') return;
      const entries = Object.entries(v);
      if (!Array.isArray(v) && entries.length && entries.every(([, e]) => e && typeof e === 'object' && !Array.isArray(e)))
        for (const [k, e] of entries) {
          const t = ['name', 'title', 'label'].map((f) => (e as Record<string, unknown>)[f]).find((x) => typeof x === 'string');
          if (typeof t === 'string') names[k] ??= t;
        }
      for (const [, e] of entries) walk(e);
    };
    const exId = this.example(example).id;
    for (const id of this.project.steps.keys()) walk(this.store.latest(exId, id)?.output);
    return names;
  }

  /** Whether each step's newest run holds (every step, or those given). */
  status(example: string | Example, ids: string[] = [...this.project.steps.keys()]): Record<string, Status> {
    const ex = this.example(example);
    const memo = new Map<string, Status>();
    const scope = new Scope(this.project, ex, this.store, 'saved');
    return Object.fromEntries(ids.map((id) => [id, status(this.project, this.store, ex, id, memo, scope)]));
  }

  /** Runs one step `times` times side by side (each run is kept; the newest is what later steps read). */
  async run(example: string | Example, id: string, times = 1, report?: (line: string) => void): Promise<RunRecord[]> {
    this.step(id);
    const ex = this.example(example);
    return Promise.all(Array.from({ length: times }, () => runStep(this.project, this.store, ex, id, { budget: this.budget, tier: this.tier, report })));
  }

  /** Keeps an answer changed by hand as a step's newest run, fresh for what the step would send now (run.ts, amendStep). */
  amend(example: string | Example, id: string, output: unknown): RunRecord {
    this.step(id);
    return amendStep(this.project, this.store, this.example(example), id, output);
  }

  /**
   * The steps a world is made from: those whose answers fill the game's records, and every step they read. A step
   * nothing reads (a variant left beside the one it was copied from) is not among them, so a build does not run it.
   */
  needed(example: string | Example): string[] {
    return this.upstream(example, Object.values(this.project.records).map((from) => from.split(/[.[]/)[0]!));
  }

  /** The steps given and every step they read, however far back, in the order they run. */
  upstream(example: string | Example, ids: string[]): string[] {
    const { order, steps } = this.analyze(example);
    const want = new Set<string>();
    const add = (id: string) => {
      if (want.has(id)) return;
      want.add(id);
      for (const d of steps[id]?.reads ?? []) add(d);
    };
    ids.forEach(add);
    return order.filter((id) => want.has(id));
  }

  /** Runs every step (or those given) in order, the ones that need nothing from each other side by side. */
  async runAll(example: string | Example, opts: Omit<Parameters<typeof runSteps>[4], 'budget' | 'tier'> = {}): Promise<RunRecord[]> {
    const ex = this.example(example);
    const { order } = this.analyze(example);
    return runSteps(this.project, this.store, ex, order, { budget: this.budget, tier: this.tier, ...opts });
  }
}
