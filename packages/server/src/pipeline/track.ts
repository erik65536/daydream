/**
 * Views over a step's data that note what is read. A template or schema of a step reads its inputs through these
 * views, so rendering it is also how the pipeline learns which steps it depends on, which fields of their outputs it
 * reads, and which names it uses that exist nowhere. Nothing is declared twice.
 *
 * A field of a step's output is named by its canonical path: the step's id, then its fields, with `[*]` for every
 * item of a list or every entry of an object keyed by the engine (`placePlan.places[*].name`).
 *
 * Joins: a step whose output has one entry per item of an engine list (the place plan, one per place) is joined to
 * those items, so `{{#map.places}}{{placePlan.name}}{{/map.places}}` reads each place's entry without a lookup.
 */
import { CANON, MISSING } from './path.ts';
import type { Resolved } from './types.ts';

export interface Access {
  /** The steps read. */
  deps: Set<string>;
  /** The fields of their outputs read, by canonical path. */
  reads: Set<string>;
  /** Fields that paths name and the outputs do not have, by canonical path as the path writes it (path.ts). */
  missed: Set<string>;
}

export const newAccess = (): Access => ({ deps: new Set(), reads: new Set(), missed: new Set() });

/** Where a step's entries joined to an engine list's items are: a path in its answer, after the id of the item they are in. */
export interface Join {
  path: string[];
  viaParent: boolean;
}

/** Where a view finds what it shows. */
export interface Sources {
  isStep(id: string): boolean;
  /** A step's output and its schema (null for a step that did not run because of its `when`). */
  output(id: string): { value: unknown; schema: Resolved } | null;
  /** Where in a step's output the entries joined to an engine list's items are, if anywhere. */
  joinPath(step: string, collection: string): Join | undefined;
  /** The engine lists an item belongs to (a town is in `map.places` and `map.towns`). */
  collectionsOf(item: object): string[];
  /** For an item of a list inside another item, that item. */
  parentOf(item: object, collection: string): object | undefined;
  constants: Record<string, unknown>;
  facts: { input: unknown; map: unknown; game: unknown };
}

const isObj = (v: unknown): v is object => typeof v === 'object' && v !== null;

export class Views {
  private made = new WeakMap<object, unknown>();
  private mine = new WeakSet<object>();
  private src: Sources;
  private access: Access;
  constructor(src: Sources, access: Access) {
    this.src = src;
    this.access = access;
  }

  /** What a template or schema sees: the inputs, the engine's map and game, the constants, every step by id, and `$`. */
  root(item?: unknown): Record<string, unknown> {
    const f = this.src.facts;
    const base: Record<string, unknown> = { input: this.fact(f.input), map: this.fact(f.map), game: this.fact(f.game), constants: this.src.constants, $: isObj(item) ? this.fact(item) : item };
    return new Proxy(base, {
      has: (t, k) => k in t || (typeof k === 'string' && this.src.isStep(k)),
      get: (t, k) => (typeof k === 'string' && !(k in t) && this.src.isStep(k) ? this.step(k) : Reflect.get(t, k)),
    });
  }

  private step(id: string): unknown {
    this.access.deps.add(id);
    const out = this.src.output(id);
    return out ? this.out(out.value, id, out.schema) : null;
  }

  /** An engine fact: not tracked, but its items carry the steps joined to them. */
  private fact(v: unknown): unknown {
    if (!isObj(v) || this.mine.has(v)) return v;
    const hit = this.made.get(v);
    if (hit) return hit;
    const join = (k: string | symbol) => {
      if (typeof k !== 'string' || k in v || !this.src.isStep(k)) return undefined;
      for (const c of this.src.collectionsOf(v)) {
        const j = this.src.joinPath(k, c);
        if (j) return { ...j, parent: j.viaParent ? (this.src.parentOf(v, c) as { id: string } | undefined) : undefined };
      }
      return undefined;
    };
    const p = new Proxy(v, {
      has: (t, k) => k in t || !!join(k),
      get: (t, k) => {
        const j = join(k);
        if (j) return this.joined(k as string, j.path, (t as { id: string }).id, j.parent?.id);
        const x = Reflect.get(t, k);
        return typeof k === 'string' && k !== 'length' ? this.fact(x) : x;
      },
    });
    this.made.set(v, p);
    this.mine.add(p);
    return p;
  }

  private joined(step: string, path: string[], id: string, parent?: string): unknown {
    this.access.deps.add(step);
    const out = this.src.output(step);
    if (!out) return null;
    let value = out.value as Record<string, unknown> | undefined, schema: Resolved | undefined = out.schema, canon = step;
    // Entries inside the answer of a step run for each item: first the answer for the item they are in.
    if (parent !== undefined) {
      value = value?.[parent] as Record<string, unknown> | undefined;
      schema = schema?.properties?.[parent];
      canon += '[*]';
    }
    for (const k of path) {
      value = value?.[k] as Record<string, unknown> | undefined;
      schema = schema?.properties?.[k];
      canon += `.${k}`;
    }
    return this.out(value?.[id], `${canon}[*]`, schema?.properties?.[id]);
  }

  /**
   * A step's output: every field read is noted under its canonical path. A field that another kind of the same
   * union has is nothing (null) on a kind without it, so `{{#of}}` asks whether an effect is of something; so is a
   * property left out by its `when` (`{{#rulesCore.words.magic}}` in a world without magic).
   */
  private out(v: unknown, canon: string, schema: Resolved | undefined): unknown {
    if (!isObj(v)) return v;
    if (this.mine.has(v)) return v;
    const node = pick(schema, v);
    const kindsHave = new Set([...(schema?.anyOf ?? []).flatMap((m) => Object.keys(m.properties ?? {})), ...(node?.['x-off'] ?? [])]);
    const absent = (t: object, k: string | symbol): k is string => typeof k === 'string' && !(k in t) && kindsHave.has(k);
    const p = new Proxy(v, {
      has: (t, k) => k in t || absent(t, k),
      get: (t, k) => {
        if (k === CANON) return canon;
        if (k === MISSING) return (path: string) => this.access.missed.add(path);
        if (absent(t, k)) {
          this.access.reads.add(`${canon}.${k}`);
          return null;
        }
        if (typeof k !== 'string' || k === 'length' || !(k in t)) return Reflect.get(t, k);
        const child = childOf(node, k, canon);
        this.access.reads.add(child.canon);
        return this.out(Reflect.get(t, k), child.canon, child.schema);
      },
    });
    this.mine.add(p);
    return p;
  }
}

/** The member of a union (or the non-null side of a nullable) that a value is. */
export function pick(schema: Resolved | undefined, v: unknown): Resolved | undefined {
  if (!schema?.anyOf) return schema;
  const live = schema.anyOf.filter((m) => m.type !== 'null');
  const kind = isObj(v) ? (v as { kind?: unknown }).kind : undefined;
  return live.find((m) => kind !== undefined && (m.properties?.kind as { const?: unknown } | undefined)?.const === kind) ?? live[0];
}

/** A field's schema and canonical path, within its parent's. */
function childOf(node: Resolved | undefined, k: string, canon: string): { schema: Resolved | undefined; canon: string } {
  if (node?.type === 'array' || /^\d+$/.test(k)) return { schema: node?.items, canon: `${canon}[*]` };
  if (node?.['x-keyed']) return { schema: node.properties?.[k], canon: `${canon}[*]` };
  return { schema: node?.properties?.[k], canon: `${canon}.${k}` };
}
