/**
 * A step's world for one example: the engine facts, and the outputs of the other steps, either as saved by their
 * newest runs (to run a step, or show what it would send) or made up from their schemas (to check every template
 * and schema, and learn what reads what, before anything has run).
 */
import { genai } from '../genai/service.ts';
import { exampleFacts, type Facts } from './facts.ts';
import type { Names } from './names.ts';
import { follow, parsePath } from './path.ts';
import type { Project } from './project.ts';
import { declares, found, off, plain, resolve, sample, toZod } from './schema.ts';
import type { RunStore } from './store.ts';
import { render } from './template.ts';
import { newAccess, Views, type Access, type Join, type Sources } from './track.ts';
import type { Example, Resolved, SchemaNode, StepDef } from './types.ts';

export type Mode = 'sample' | 'saved';

/** One call a step makes (a step run once per item makes one for each). */
export interface Call {
  item?: string;
  system: string;
  user: string;
  schema: Resolved;
  /** The step's checks that hold here, with their values read. */
  checks: Check[];
  /** The step's names that must differ: its own paths, and the names before it (names.ts). */
  names?: Names;
}

export interface Check {
  says: string;
  in: string[];
  /** The values to find; without them, anything found will do. */
  has?: unknown[];
}

/** A step made concrete: its calls, what it read, and what is wrong with it. */
export interface Prepared {
  step: StepDef;
  calls: Call[];
  access: Access;
  /** Steps it reads that have not run yet (saved mode). */
  missing: string[];
  problems: string[];
  /** False when its `when` found nothing: it is not called. */
  runs: boolean;
}

export class CycleError extends Error {}

export class Scope implements Sources {
  readonly facts: Facts;
  readonly constants: Record<string, unknown>;
  private colls = new WeakMap<object, string[]>();
  /** For an item of a list inside another item (a town's residents), that item, by collection. */
  private parents = new Map<string, WeakMap<object, object>>();
  private joins = new Map<string, Map<string, Join>>();
  private outputs = new Map<string, { value: unknown; schema: Resolved } | null>();
  private schemas = new Map<string, Resolved>();
  private making: string[] = [];
  private absent = new Set<string>();
  readonly project: Project;
  readonly example: Example;
  readonly store: RunStore;
  readonly mode: Mode;

  constructor(project: Project, example: Example, store: RunStore, mode: Mode) {
    this.project = project;
    this.example = example;
    this.store = store;
    this.mode = mode;
    this.facts = exampleFacts(example);
    this.constants = project.constants;
    const add = (it: object, c: string) => this.colls.set(it, [...(this.colls.get(it) ?? []), c]);
    for (const [k, list] of Object.entries(this.facts.map))
      for (const it of list as unknown as Record<string, unknown>[]) {
        add(it, `map.${k}`);
        // The lists in an item are collections too (`map.towns[*].residents`), each item knowing the one it is in.
        for (const [f, v] of Object.entries(it)) {
          if (!Array.isArray(v)) continue;
          const c = `map.${k}[*].${f}`;
          const parents = this.parents.get(c) ?? new WeakMap();
          this.parents.set(c, parents);
          for (const x of v) if (x && typeof x === 'object') (add(x, c), parents.set(x, it));
        }
      }
    for (const s of project.steps.values()) this.findJoins(s);
  }

  isStep(id: string) {
    return this.project.steps.has(id);
  }

  collectionsOf(item: object) {
    return this.colls.get(item) ?? [];
  }

  joinPath(step: string, collection: string) {
    return this.joins.get(step)?.get(collection);
  }

  parentOf(item: object, collection: string) {
    return this.parents.get(collection)?.get(item);
  }

  /**
   * Entries keyed by an engine list (`keys.from: map.places[*].id`), outside any list, join that list's items. A
   * step run once for each item of an engine list joins those items, and entries keyed inside its answer by a list
   * of the item (`keys.from: $.residents[*].id`) join that list's items, through the item they are in.
   */
  private findJoins(s: StepDef) {
    const add = (coll: string, join: Join) => {
      const m = this.joins.get(s.id) ?? new Map<string, Join>();
      if (!m.has(coll)) m.set(coll, join);
      this.joins.set(s.id, m);
    };
    const each = /^(map\.[a-zA-Z]+)$/.exec(s.forEach ?? '');
    if (each) add(each[1]!, { path: [], viaParent: false });
    const walk = (n: SchemaNode | undefined, at: string[]) => {
      const from = n?.keys?.from ?? '';
      const keyed = /^(map\.[a-zA-Z]+)\[\*\]\.id$/.exec(from);
      if (keyed && !each) add(keyed[1]!, { path: at, viaParent: false });
      const inItem = /^\$\.([a-zA-Z]+)\[\*\]\.id$/.exec(from);
      if (inItem && each) add(`${each[1]}[*].${inItem[1]}`, { path: at, viaParent: true });
      for (const [k, v] of Object.entries(n?.properties ?? {})) walk(v, [...at, k]);
    };
    walk(s.schema, []);
  }

  output(id: string): { value: unknown; schema: Resolved } | null {
    if (this.outputs.has(id)) return this.outputs.get(id)!;
    let out: { value: unknown; schema: Resolved } | null;
    if (this.mode === 'sample') {
      const schema = this.schemaOf(id);
      out = { value: sample(schema, id), schema };
    } else {
      const run = this.store.latest(this.example.id, id);
      if (!run) {
        this.absent.add(id);
        const schema = this.schemaOf(id);
        out = { value: sample(schema, id), schema };
      } else out = run.output === null ? null : { value: run.output, schema: this.schemaOf(id) };
    }
    this.outputs.set(id, out);
    return out;
  }

  /** A step's schema for its whole output (keyed by item for a step run once per item). */
  schemaOf(id: string): Resolved {
    const hit = this.schemas.get(id);
    if (hit) return hit;
    if (this.making.includes(id)) throw new CycleError(`These steps read each other: ${[...this.making.slice(this.making.indexOf(id)), id].join(' → ')}`);
    this.making.push(id);
    try {
      const p = this.prepare(id, newAccess());
      const schema: Resolved = this.project.steps.get(id)!.forEach
        ? { type: 'object', properties: Object.fromEntries(p.calls.map((c) => [c.item!, c.schema])), required: p.calls.map((c) => c.item!), additionalProperties: false, 'x-keyed': true }
        : (p.calls[0]?.schema ?? { type: 'null' });
      this.schemas.set(id, schema);
      return schema;
    } finally {
      this.making.pop();
    }
  }

  /**
   * The fields that paths name and that the steps they read have in no world (a field renamed or removed). In an
   * answer such a path finds nothing, as one to a field that a `when` leaves out here does, so only the schema tells.
   */
  undeclared(access: Access): string[] {
    return [...access.missed].filter((at) => {
      const [first, ...rest] = parsePath(at);
      const step = this.project.steps.get((first as { name: string }).name);
      return !!step && !declares(step.forEach ? { each: step.schema } : step.schema, rest);
    });
  }

  /** A step's calls for this example, with what they read. */
  prepare(id: string, access: Access = newAccess()): Prepared {
    const step = this.project.steps.get(id)!;
    const problems = new Set<string>();
    const why: string[] = [];
    const views = new Views(this, access);
    const root = (item?: unknown) => views.root(item);
    let items: { id?: string; item?: unknown }[] = [{}];
    if (step.forEach) {
      // A list as written (`map.towns`), or the items a path finds (`map.places[kind=town]`).
      const f = follow(root(), step.forEach);
      const list = f.kind === 'many' ? f.items.map((i) => i.value) : f.kind === 'one' && Array.isArray(f.value) ? [...f.value] : undefined;
      if (!list) problems.add(`forEach: "${step.forEach}" is not a list`);
      // Each call is named by its item's id, or by its name for an item of an answer, which has no id (a class).
      items = (list ?? []).map((value) => ({ id: String((value as { id?: unknown; name?: unknown }).id ?? (value as { name?: unknown }).name), item: value }));
    }
    let runs = true;
    if (step.when) {
      const f = follow(root(), step.when);
      const v = f.kind === 'one' ? f.value : f.kind === 'many' ? f.items : undefined;
      runs = Array.isArray(v) ? v.length > 0 : !!v;
      if (f.kind === 'none') problems.add(`when: "${step.when}" is not there`);
    }
    const calls: Call[] = [];
    for (const { id: item, item: $ } of items) {
      const schema = resolve(step.schema, { root, problems }, $, 'schema', why);
      if (!schema) {
        // The last reason is the one that stopped it (earlier ones may only have dropped a member of a union).
        problems.add(why.at(-1) ?? 'The schema cannot be made');
        continue;
      }
      const checks = (step.checks ?? []).flatMap((c): Check[] => {
        if (c.when && off(c as SchemaNode, { root, problems }, $)) return [];
        if (!c.has) return [{ says: c.says, in: c.in }];
        const has = Array.isArray(c.has) ? c.has : found(c.has.from, { root, problems }, $, 'checks').map((f) => f.value);
        return has.length ? [{ says: c.says, in: c.in, has }] : [];
      });
      const own = (step.names ?? []).filter((p) => (parsePath(p)[0] as { name: string }).name === step.id);
      const taken = (step.names ?? []).filter((p) => !own.includes(p)).flatMap((p) => found(p, { root, problems }, $, 'names').map((f) => f.value)).filter((v): v is string => typeof v === 'string');
      const names = step.names?.length ? { own, taken } : undefined;
      calls.push({ item, checks, ...(names && { names }), system: render(step.system ?? '', root($), problems, this.constants), user: render(step.user ?? '', root($), problems, this.constants), schema });
    }
    for (const at of this.undeclared(access)) problems.add(`"${at}" is not a field of ${(parsePath(at)[0] as { name: string }).name}`);
    const missing = [...access.deps].filter((d) => this.absent.has(d));
    return { step, calls, access, missing, problems: [...problems], runs };
  }

  /** The request body a call sends, exactly. */
  body(step: StepDef, call: Call, tier?: 'default' | 'flex'): Record<string, unknown> {
    return genai().structuredBody(step.purpose, request(step, call, tier));
  }
}

/** A call as the gateway takes it. */
export function request(step: StepDef, call: Call, tier?: 'default' | 'flex') {
  return {
    system: call.system || undefined,
    prompt: call.user,
    schema: toZod(call.schema),
    jsonSchema: plain(call.schema),
    name: step.id,
    maxTokens: step.maxTokens,
    model: step.model,
    extraBody: { ...(step.reasoning && { reasoning: { effort: step.reasoning } }), ...(tier && { service_tier: tier }) },
    validate: (answer: unknown) => unmet(call.checks, answer),
  };
}

/** What an answer lacks of its checks, as the model is told it; null when it holds them all. */
export function unmet(checks: Check[], answer: unknown): string | null {
  const wrong = checks.flatMap((c) => {
    const there = new Set(c.in.flatMap((p) => {
      const f = follow(answer, p);
      return (f.kind === 'many' ? f.items.map((i) => i.value) : f.kind === 'one' ? [f.value] : []).filter((v) => v != null).map(String);
    }));
    if (!c.has) return there.size ? [] : [c.says];
    const missing = c.has.filter((v) => !there.has(String(v)));
    return missing.length ? [`${c.says}: ${missing.join(', ')}`] : [];
  });
  return wrong.length ? wrong.join('. ') : null;
}
