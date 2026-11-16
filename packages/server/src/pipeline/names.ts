/**
 * Names that must all differ (a step's `names`): its own, at the paths that start with its id, and those the steps
 * before it made. Two things a player meets under one name read as one, so a repeat is renamed: on its own, in a
 * small request that keeps the rest of the answer, told every name already used. The first of a name keeps it, and an
 * earlier step's names never change, so what later steps read stays true.
 */
import { pathLabel, setAtPath } from '../genai/json.ts';
import { genai } from '../genai/service.ts';
import { parsePath } from './path.ts';
import { plain, toZod } from './schema.ts';
import type { Resolved, StepDef } from './types.ts';

/** A step's names for one call: its own paths into its answer, and the names earlier steps hold. */
export interface Names {
  own: string[];
  taken: string[];
}

/** A name kept apart from its case, spacing, and punctuation ("Giant's Twitch" is "giants twitch"). */
const same = (name: string) => name.normalize('NFKD').toLowerCase().replace(/[^\p{L}\p{N}]+/gu, '');

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

/** Every text a path of the step's own (its id, then into the answer) finds, with where it is. */
export function located(answer: unknown, path: string): { at: (string | number)[]; name: string }[] {
  let found: { at: (string | number)[]; value: unknown }[] = [{ at: [], value: answer }];
  for (const seg of parsePath(path).slice(1)) {
    const next: typeof found = [];
    for (const { at, value } of found) {
      if ('name' in seg) {
        if (isObj(value) && seg.name in value) next.push({ at: [...at, seg.name], value: value[seg.name] });
      } else if ('all' in seg || 'values' in seg) {
        const entries: [string | number, unknown][] = Array.isArray(value) ? value.map((v, i) => [i, v]) : isObj(value) ? Object.entries(value) : [];
        for (const [k, v] of entries) if (v != null && ('all' in seg || (isObj(v) && seg.values.includes(String(v[seg.field]))))) next.push({ at: [...at, k], value: v });
      }
    }
    found = next;
  }
  return found.filter((f): f is { at: (string | number)[]; value: string } => typeof f.value === 'string').map((f) => ({ at: f.at, name: f.value }));
}

/** The names of the answer that repeat one used before them (earlier steps' first, then the answer's in order). */
export function repeats(names: Names, answer: unknown): { at: (string | number)[]; name: string }[] {
  const seen = new Set(names.taken.map(same));
  const out: { at: (string | number)[]; name: string }[] = [];
  for (const p of names.own)
    for (const n of located(answer, p)) {
      if (seen.has(same(n.name))) out.push(n);
      else seen.add(same(n.name));
    }
  return out;
}

/**
 * The schema of the value at a place in the answer, through the unions on the way (a nullable field, or a list of
 * several kinds: the kind the value there is), so a name asked for again keeps its limits.
 */
export function schemaAt(schema: Resolved, answer: unknown, at: (string | number)[]): Resolved {
  // The member of a union a value is: by its `kind`, or else the first that holds what is read from it next.
  const member = (s: Resolved | undefined, v: unknown, next?: string | number): Resolved | undefined => {
    if (!s?.anyOf) return s;
    const live = s.anyOf.filter((m) => m.type !== 'null');
    const kind = isObj(v) ? v.kind : undefined;
    const holds = (m: Resolved) => (typeof next === 'number' ? !!m.items : next !== undefined && !!m.properties?.[next]);
    return live.find((m) => kind !== undefined && (m.properties?.kind as { const?: unknown } | undefined)?.const === kind) ?? live.find(holds) ?? live[0];
  };
  let s: Resolved | undefined = schema;
  let v = answer;
  for (const k of at) {
    s = member(s, v, k);
    s = typeof k === 'number' ? s?.items : s?.properties?.[k];
    v = isObj(v) ? v[k] : undefined;
  }
  return member(s, v) ?? { type: 'string' };
}

/**
 * Renames the repeats of an answer until it has none, three times at most, and throws if some remain.
 * `ask` is the step's own call as the gateway takes it (its system, prompt, model, and settings); `renamed` hears each rename.
 */
export async function unique<T>(step: StepDef, names: Names, schema: Resolved, answer: T, ask: { system?: string; prompt: string; extraBody?: Record<string, unknown> }, renamed?: (from: string, to: string) => void): Promise<T> {
  let out: unknown = answer;
  for (let round = 0; round < 3; round++) {
    const dup = repeats(names, out);
    if (!dup.length) return out as T;
    const r: Resolved = { type: 'object', additionalProperties: false, properties: Object.fromEntries(dup.map((d, i) => [`n${i}`, schemaAt(schema, out, d.at)])), required: dup.map((_, i) => `n${i}`) };
    const used = names.taken.length ? `\n\nNAMES THE WORLD ALREADY USES:\n${names.taken.join(', ')}` : '';
    const list = dup.map((d, i) => `n${i} (${pathLabel(d.at)}): ${d.name}`).join('\n');
    const fixed = await genai().structured(step.purpose, {
      system: ask.system,
      prompt: `${ask.prompt}\n\nYOUR ANSWER:\n${JSON.stringify(out)}${used}\n\nThese names are used already, by the world or earlier in your answer. Give each a new name that fits it and differs from every other name:\n${list}`,
      schema: toZod(r),
      jsonSchema: plain(r),
      name: `${step.id}_names`,
      maxTokens: 300 + dup.length * 40,
      model: step.model,
      extraBody: ask.extraBody,
    });
    dup.forEach((d, i) => {
      const to = (fixed as Record<string, unknown>)[`n${i}`];
      out = setAtPath(out, d.at, to);
      renamed?.(d.name, String(to));
    });
  }
  const left = repeats(names, out);
  if (left.length) throw new Error(`Names still used twice after renaming three times: ${left.map((d) => d.name).join(', ')}`);
  return out as T;
}
