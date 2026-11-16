/**
 * A JSON Schema in plain words: each field's type, limits, and description. The editor draws it (designer Shape.tsx)
 * and the CLI prints it, from these same rules. Both kinds of schema read the same: a record's (from zod: keyed
 * maps, `oneOf` unions, patterns) and a step's answer as sent (strict mode: every key spelled out, `anyOf` with null
 * for nullable).
 */

export interface S {
  type?: string | string[];
  properties?: Record<string, S>;
  additionalProperties?: S | boolean;
  items?: S;
  anyOf?: S[];
  oneOf?: S[];
  enum?: unknown[];
  const?: unknown;
  pattern?: string;
  description?: string;
  minLength?: number;
  maxLength?: number;
  minItems?: number;
  maxItems?: number;
  minimum?: number;
  maximum?: number;
}

const HEX = '^#[0-9a-fA-F]{6}$';
const same = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

/** The member of a nullable (`X, or nothing`), and whether it was one. */
export function unwrap(s: S): { s: S; nullable: boolean } {
  const members = s.anyOf ?? s.oneOf;
  if (members) {
    const live = members.filter((m) => m.type !== 'null');
    if (live.length === 1 && live.length < members.length) return { s: { ...live[0], description: s.description ?? live[0]!.description }, nullable: true };
  }
  if (Array.isArray(s.type) && s.type.includes('null')) {
    const rest = s.type.filter((t) => t !== 'null');
    return { s: { ...s, type: rest.length === 1 ? rest[0] : rest }, nullable: true };
  }
  return { s, nullable: false };
}

/** The members of a union of several shapes. */
const unionOf = (s: S) => (s.oneOf ?? s.anyOf)?.filter((m) => m.type !== 'null');

/** An object whose fields all share one shape: keyed by id (a record's map, or a step's `keys`, spelled out). */
export function keyed(s: S): { keys?: string[]; each: S } | undefined {
  if (s.type !== 'object') return undefined;
  if (!s.properties && typeof s.additionalProperties === 'object') return { each: s.additionalProperties };
  const vals = Object.values(s.properties ?? {});
  if (vals.length >= 2 && vals.every((v) => v.type === 'object' && same(v, vals[0]))) return { keys: Object.keys(s.properties!), each: vals[0]! };
  return undefined;
}

/** A union member's name: its constant field (`kind: talk`), and the member without that field. */
export function kindOf(m: S): { tag?: string; rest: S } {
  const found = Object.entries(m.properties ?? {}).find(([, p]) => p.const !== undefined || p.enum?.length === 1);
  if (!found) return { rest: m };
  const [k, p] = found;
  return { tag: `${k}: ${String(p.const ?? p.enum![0])}`, rest: { ...m, properties: Object.fromEntries(Object.entries(m.properties!).filter(([f]) => f !== k)) } };
}

const range = (lo: number | undefined, hi: number | undefined, unit: string) =>
  (lo !== undefined && hi !== undefined ? (lo === hi ? `${lo} ${unit}` : `${lo} to ${hi} ${unit}`) : hi !== undefined ? `up to ${hi} ${unit}` : lo !== undefined ? `at least ${lo} ${unit}` : '').trim();

/** A type in plain words, with its limits. */
export function typeWords(s0: S): string {
  const { s, nullable } = unwrap(s0);
  const or = nullable ? ', or nothing' : '';
  if (s.const !== undefined) return `exactly ${JSON.stringify(s.const)}${or}`;
  if (s.enum) return `one of the values below${or}`;
  if (unionOf(s)?.length) return `one of the kinds below${or}`;
  const k = keyed(s);
  if (k) return `${k.keys ? `one for each of these ${k.keys.length}` : 'one per id'}, each with these fields${or}`;
  switch (s.type) {
    case 'string':
      if (s.pattern === HEX) return `color, #rrggbb${or}`;
      return ['text', range(s.minLength, s.maxLength, 'characters'), s.pattern ? `matching /${s.pattern}/` : ''].filter(Boolean).join(', ') + or;
    case 'integer':
    case 'number':
      return [s.type === 'integer' ? 'whole number' : 'number', range(s.minimum, s.maximum, '')].filter(Boolean).join(', ') + or;
    case 'boolean':
      return `yes or no${or}`;
    case 'array': {
      const item = s.items ? unwrap(s.items).s : {};
      const of = unionOf(item)?.length ? 'list, each one of these kinds' : item.type === 'object' ? 'list, each with these fields' : item.enum ? 'list of the values below' : `list of ${typeWords(s.items ?? {})}`;
      return [of, range(s.minItems, s.maxItems, 'items')].filter(Boolean).join(', ') + or;
    }
    case 'object':
      return `group of fields${or}`;
    default:
      return (Array.isArray(s.type) ? s.type.join(' or ') : (s.type ?? 'anything')) + or;
  }
}

/** What a field holds inside: fields, kinds, values, or what each item or entry holds. */
export type Inside =
  | { kind: 'values'; values: unknown[] }
  | { kind: 'kinds'; kinds: { tag?: string; shape: S }[] }
  | { kind: 'fields'; keys?: string[]; fields: [string, S][] }
  | { kind: 'none' };

export function inside(s0: S): Inside {
  const { s } = unwrap(s0);
  if (s.enum) return { kind: 'values', values: s.enum };
  const union = unionOf(s);
  if (union?.length) return { kind: 'kinds', kinds: union.map((m) => ({ tag: kindOf(m).tag, shape: kindOf(m).rest })) };
  const k = keyed(s);
  if (k) return { kind: 'fields', keys: k.keys, fields: Object.entries(k.each.properties ?? {}) };
  if (s.type === 'array' && s.items) {
    const item = unwrap(s.items).s;
    return item.type === 'object' || unionOf(item)?.length || item.enum ? inside(s.items) : { kind: 'none' };
  }
  if (s.type === 'object') return { kind: 'fields', fields: Object.entries(s.properties ?? {}) };
  return { kind: 'none' };
}

/** The shape as indented text, for the CLI: `name: type`, the description below, what it holds indented under. */
export function shapeText(schema: unknown): string {
  const out: string[] = [];
  const holds = (s: S, ind: string) => {
    const i = inside(s);
    if (i.kind === 'values') out.push(`${ind}values: ${i.values.map(String).join(', ')}`);
    if (i.kind === 'kinds')
      for (const k of i.kinds) {
        out.push(`${ind}- ${k.tag ?? 'kind'}${k.shape.description ? `  # ${k.shape.description}` : ''}`);
        for (const [n, f] of Object.entries(k.shape.properties ?? {})) field(n, f, `${ind}    `);
      }
    if (i.kind === 'fields') {
      if (i.keys) out.push(`${ind}ids: ${i.keys.join(', ')}`);
      for (const [n, f] of i.fields) field(n, f, ind);
    }
  };
  const field = (name: string, s: S, ind: string) => {
    const about = s.description ?? unwrap(s).s.description;
    // A short description goes on the field's own line; a long one below it.
    const short = about && !about.includes('\n') && about.length <= 60;
    out.push(`${ind}${name}: ${typeWords(s)}${short ? `  # ${about}` : ''}`);
    if (about && !short) out.push(...about.split('\n').map((l) => `${ind}    ${l}`));
    holds(s, `${ind}  `);
  };
  const s = schema as S;
  if (s.description) out.push(s.description);
  if (keyed(s) || s.type !== 'object') {
    out.push(typeWords(s));
    holds(s, '  ');
  } else holds(s, '');
  return out.join('\n');
}
