/**
 * A step's schema made concrete for one example: `enum.from` and `keys.from` read what exists (through the views,
 * so what they read is noted), descriptions are filled in, every property is required, and nullable fields become
 * a union with null. The result is plain JSON Schema, which zod reads for the gateway's checks.
 */
import { z } from 'zod';
import { follow, type Segment } from './path.ts';
import { render } from './template.ts';
import type { Resolved, SchemaNode } from './types.ts';

interface ResolveCtx {
  /** The view a template or path sees, with `$` the item given. */
  root(item: unknown): unknown;
  problems: Set<string>;
}

const KNOWN = new Set(['description', 'nullable', 'type', 'minLength', 'maxLength', 'pattern', 'minimum', 'maximum', 'enum', 'const', 'properties', 'items', 'minItems', 'maxItems', 'anyOf', 'keys', 'each', 'when']);

/** Null when the node cannot exist here (an enum with nothing to choose from), with the reason in `why`. */
export function resolve(node: SchemaNode, ctx: ResolveCtx, item: unknown, at = 'schema', why: string[] = []): Resolved | null {
  for (const k of Object.keys(node)) if (!KNOWN.has(k)) ctx.problems.add(`${at}: "${k}" is not part of a schema (a description with a comma needs quotes in { … })`);
  const out: Resolved = {};
  if (node.description) out.description = render(node.description, ctx.root(item), ctx.problems);
  let core: Resolved | null;
  if (node.keys) core = keyed(node, ctx, item, at, why);
  else if (node.anyOf) {
    const members = node.anyOf.filter((m) => !off(m, ctx, item)).map((m, i) => resolve(m, ctx, item, `${at}.anyOf[${i}]`, why)).filter((m): m is Resolved => !!m);
    core = members.length ? { anyOf: members } : null;
  } else if (node.enum !== undefined || node.const !== undefined) core = choice(node, ctx, item, at, why);
  else if (node.type === 'object' || node.properties) core = object(node, ctx, item, at, why);
  else if (node.type === 'array') {
    const items = node.items ? resolve(node.items, ctx, item, `${at}[]`, why) : null;
    if (!node.items) ctx.problems.add(`${at}: a list needs "items"`);
    const min = count(node.minItems, ctx, item, `${at}.minItems`);
    const max = count(node.maxItems, ctx, item, `${at}.maxItems`);
    core = items && { type: 'array', items, ...(min !== undefined && { minItems: min }), ...(max !== undefined && { maxItems: max }) };
  } else if (node.type === 'string') {
    core = { type: 'string', minLength: node.minLength ?? 1, ...(node.maxLength !== undefined && { maxLength: node.maxLength }), ...(node.pattern && { pattern: node.pattern }) };
  } else if (node.type === 'integer' || node.type === 'number') {
    core = { type: node.type, ...(node.minimum !== undefined && { minimum: node.minimum }), ...(node.maximum !== undefined && { maximum: node.maximum }) };
  } else if (node.type === 'boolean') core = { type: 'boolean' };
  else {
    ctx.problems.add(`${at}: no type`);
    core = null;
  }
  if (!core) return null;
  if (node.nullable) return { ...out, anyOf: [core, { type: 'null' }] };
  return { ...core, ...out };
}

/** A list's length as written, or read from a path. */
function count(n: SchemaNode['minItems'], ctx: ResolveCtx, item: unknown, at: string): number | undefined {
  if (n === undefined || typeof n === 'number') return n;
  const f = follow(ctx.root(item), n.from);
  if (f.kind === 'one' && typeof f.value === 'number') return f.value;
  ctx.problems.add(`${at}: "${n.from}" is not a number`);
  return undefined;
}

function object(node: SchemaNode, ctx: ResolveCtx, item: unknown, at: string, why: string[]): Resolved | null {
  const properties: Record<string, Resolved> = {};
  const left: string[] = [];
  for (const [k, v] of Object.entries(node.properties ?? {})) {
    if (off(v, ctx, item)) {
      left.push(k);
      continue;
    }
    const r = resolve(v, ctx, item, `${at}.${k}`, why);
    if (!r) return null;
    properties[k] = r;
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false, ...(left.length ? { 'x-off': left } : {}) };
}

function keyed(node: SchemaNode, ctx: ResolveCtx, item: unknown, at: string, why: string[]): Resolved | null {
  if (!node.each) {
    ctx.problems.add(`${at}: "keys" needs "each"`);
    return null;
  }
  const properties: Record<string, Resolved> = {};
  for (const { value, owner } of found(node.keys!.from, ctx, item, at)) {
    const r = resolve(node.each, ctx, owner, `${at}.${String(value)}`, why);
    if (!r) return null;
    properties[String(value)] = r;
  }
  return { type: 'object', properties, required: Object.keys(properties), additionalProperties: false, 'x-keyed': true };
}

function choice(node: SchemaNode, ctx: ResolveCtx, item: unknown, at: string, why: string[]): Resolved | null {
  if (node.const !== undefined) return { type: typeof node.const as 'string', const: node.const };
  const values = Array.isArray(node.enum) ? node.enum : [...new Set(found(node.enum!.from, ctx, item, at).map((f) => f.value).filter((v) => ['string', 'number', 'boolean'].includes(typeof v)))];
  if (!values.length) {
    why.push(`${at}: nothing to choose from${Array.isArray(node.enum) ? '' : ` (${node.enum!.from})`}`);
    return null;
  }
  // Either answer of a yes or no is just a yes or no.
  if (values.length === 2 && values.every((v) => typeof v === 'boolean')) return { type: 'boolean' };
  return { type: typeof values[0] as 'string' | 'number' | 'boolean', enum: values };
}

/**
 * A property or union member whose `when` does not hold: `path` finds nothing (false, null, nothing at all, or an
 * empty list, such as a filter no item passes), or `path=a|b` finds none of the values given. `a & b` holds when both
 * do, and a list of conditions when any one does.
 */
export function off(node: SchemaNode, ctx: ResolveCtx, item: unknown): boolean {
  if (!node.when) return false;
  const unmet = (when: string) => when.split('&').some((cond) => fails(cond, ctx, item));
  return Array.isArray(node.when) ? node.when.every(unmet) : unmet(node.when);
}

function fails(cond: string, ctx: ResolveCtx, item: unknown): boolean {
  // The values asked for come after the path (a filter's `=` is inside its brackets).
  const eq = cond.indexOf('=', cond.lastIndexOf(']') + 1);
  const path = eq < 0 ? cond : cond.slice(0, eq);
  const values = eq < 0 ? undefined : cond.slice(eq + 1);
  const f = follow(ctx.root(item), path.trim());
  if (f.kind === 'none') {
    ctx.problems.add(`when: "${path.trim()}" is not there`);
    return true;
  }
  const v = f.kind === 'one' ? f.value : f.items;
  if (values !== undefined) return !values.split('|').map((x) => x.trim()).includes(String(v));
  return Array.isArray(v) ? v.length === 0 : !v;
}

export function found(path: string, ctx: ResolveCtx, item: unknown, at: string) {
  const f = follow(ctx.root(item), path);
  if (f.kind === 'none') ctx.problems.add(`${at}: "${path}" is not there`);
  return f.kind === 'many' ? f.items : f.kind === 'one' && f.value !== undefined ? [{ value: f.value, owner: item }] : [];
}

/** The schema without the pipeline's own marks, as the gateway takes it. */
export function plain(r: Resolved): Record<string, unknown> {
  return JSON.parse(JSON.stringify(r, (k, v) => (k === 'x-keyed' || k === 'x-off' ? undefined : v)));
}

export const toZod = (r: Resolved) => z.fromJSONSchema(plain(r) as never);

/**
 * An answer made up for a step that has not run, so a template that reads it can be shown and checked. Each text
 * says where it comes from (`⟨placePlan.places.t0_0.name⟩`); a list has one item of each kind it can hold, even
 * when that is more than the list may hold (what reads a field of any kind is seen, and a kind left out would show its
 * fields as unread), and a single value of several kinds is the kind with the most fields.
 */
export function sample(r: Resolved, at: string): unknown {
  if (r.anyOf) {
    const live = r.anyOf.filter((m) => m.type !== 'null');
    const fields = (m: Resolved) => Object.keys(m.properties ?? {}).length;
    return sample(live.reduce((a, b) => (fields(b) > fields(a) ? b : a), live[0] ?? r.anyOf[0]!), at);
  }
  if (r.const !== undefined) return r.const;
  if (Array.isArray(r.enum)) return r.enum[0];
  switch (r.type) {
    case 'object':
      // Fields that choose from a list take its values in turn, so fields choosing among the same few spread out.
      return Object.fromEntries(Object.entries(r.properties ?? {}).map(([k, v], i) => [k, Array.isArray(v.enum) ? v.enum[i % v.enum.length] : sample(v, `${at}.${k}`)]));
    case 'array': {
      const items = r.items!;
      const fields = (m: Resolved) => Object.keys(m.properties ?? {}).length;
      // The kinds with the most fields first.
      const kinds = [...(items.anyOf?.filter((m) => m.type !== 'null') ?? byValue(items))].sort((a, b) => fields(b) - fields(a));
      // One item of each kind, and at least as many as the list needs. A list of one kind keeps to its limits.
      const least = (r.minItems as number | undefined) ?? 1;
      const n = kinds.length > 1 ? Math.max(kinds.length, least) : Math.min(Math.max(1, least), (r.maxItems as number | undefined) ?? Infinity);
      return Array.from({ length: n }, (_, i) => sample(kinds[i % kinds.length]!, `${at}[${i}]`));
    }
    case 'string':
      // A color is a color; any other text says where it comes from, within its length.
      if (r.pattern === '^#[0-9a-fA-F]{6}$') return '#808080';
      return `⟨${at}⟩`.slice(0, (r.maxLength as number | undefined) ?? Infinity);
    case 'boolean':
      return true;
    case 'null':
      return null;
    default:
      return (r.minimum as number | undefined) ?? 1;
  }
}

/**
 * The kinds of item a list of objects can hold, for made-up answers: one for each value of the first field with a
 * choice of values (a slot's kind), so a later step choosing among the armor slots finds one.
 */
function byValue(items: Resolved): Resolved[] {
  if (items.type !== 'object') return [items];
  for (const [k, v] of Object.entries(items.properties ?? {})) {
    const values = (v.anyOf?.find((m) => Array.isArray(m.enum)) ?? v).enum;
    if (Array.isArray(values) && values.length > 1) return values.map((value) => ({ ...items, properties: { ...items.properties, [k]: { const: value } } }));
  }
  return [items];
}

/**
 * Whether a step's schema has the field a canonical path names in any world: every `when` taken as holding and every
 * member of a union tried, a name taken as any key of an object keyed by what exists, and `[*]` as any field or entry.
 */
export function declares(n: SchemaNode, segs: Segment[]): boolean {
  const [seg, ...rest] = segs;
  if (!seg) return true;
  if (n.anyOf) return n.anyOf.some((m) => declares(m, segs));
  const kids = 'name' in seg ? [n.properties?.[seg.name] ?? n.each ?? (/^\d+$/.test(seg.name) ? n.items : undefined)] : [...Object.values(n.properties ?? {}), n.each, n.items];
  return kids.some((k) => !!k && declares(k, rest));
}

/** Every field a schema gives, by canonical path (lists and engine-keyed objects as `[*]`). */
export function leaves(r: Resolved, at: string, out = new Set<string>()): Set<string> {
  if (r.anyOf) for (const m of r.anyOf) leaves(m, at, out);
  else if (r.type === 'array' && r.items) leaves(r.items, `${at}[*]`, out);
  else if (r.type === 'object') {
    for (const [k, v] of Object.entries(r.properties ?? {})) leaves(v, r['x-keyed'] ? `${at}[*]` : `${at}.${k}`, out);
  } else if (r.type !== 'null') out.add(at);
  return out;
}
