/**
 * Paths into a step's data, as templates and schemas write them:
 *
 *   concept.title                 a field
 *   map.places[*].id              every item of a list (or every value of an object; a null is no item), then a
 *                                 field of each
 *   map.places[kind=town]         the items whose field has one of the values given (`kind=wilds|dungeon`)
 *   $.reach[*].placePlan.name     `$` is the item being described (a schema's `each`, a step's `forEach`)
 *   input.prompts.length          a list's length (for a template's "only if there are any"); also after a
 *                                 [*] or a filter: `input.prompts[topic=art].length`
 *   $last, $first, $n             in a template, on an item of the list a section repeats over: whether it is
 *                                 the last or first, and its number from 1
 *
 * A path is read through the views of track.ts, so whatever it reads is noted, and so is a field it names that a
 * step's output does not have (scope.ts asks the step's schema whether it has that field in any world).
 */

export type Segment = { name: string } | { all: true } | { field: string; values: string[] };

const cache = new Map<string, Segment[]>();

export function parsePath(path: string): Segment[] {
  const hit = cache.get(path);
  if (hit) return hit;
  const segs: Segment[] = [];
  const re = /([^.[\]]+)|\[([^\]]*)\]|(\.)/g;
  let m: RegExpExecArray | null;
  let last = 0;
  while ((m = re.exec(path))) {
    if (m.index !== last) throw new PathError(`"${path}" is not a path`);
    last = re.lastIndex;
    if (m[1] !== undefined) segs.push({ name: m[1].trim() });
    else if (m[2] !== undefined) {
      const sel = m[2].trim();
      if (sel === '*') segs.push({ all: true });
      else {
        const eq = sel.indexOf('=');
        if (eq < 1) throw new PathError(`"[${sel}]" in "${path}" should be [*] or [field=value]`);
        segs.push({ field: sel.slice(0, eq).trim(), values: sel.slice(eq + 1).split('|').map((v) => v.trim()) });
      }
    }
  }
  if (last !== path.length || !segs.length || !('name' in segs[0]!)) throw new PathError(`"${path}" is not a path`);
  cache.set(path, segs);
  return segs;
}

class PathError extends Error {}

/**
 * A view of a step's output (track.ts) gives its canonical path under `CANON`, and takes under `MISSING` the
 * canonical path of a field a path names that it does not have, so the check can ask the step's schema about it.
 */
export const CANON = Symbol('canon');
export const MISSING = Symbol('missing');
type View = { [CANON]?: string; [MISSING]?: (path: string) => void };

/** What a path finds: nothing (its first name is not here), one value, or many (after a [*] or a filter). */
export type Found = { kind: 'none' } | { kind: 'one'; value: unknown } | { kind: 'many'; items: { value: unknown; owner: unknown }[] };

const isObj = (v: unknown): v is Record<string, unknown> => typeof v === 'object' && v !== null;

const canonOf = (v: unknown) => (isObj(v) ? (v as View)[CANON] : undefined);

/**
 * Follows a path from `root`. `kind: 'none'` only when the first name is not in `root`, so a template can look
 * it up in the enclosing context instead; a later name that is missing gives `undefined` (one) or is skipped (many).
 * Each item found by a "many" path keeps the object it was read from (`owner`), so `keys.from: map.places[*].id`
 * knows which place each key belongs to.
 *
 * A name missing from a step's output is noted with the canonical path as the path writes it (each `[*]` and filter
 * as `[*]`): `rulesCore.classes[*].damage` names a field some classes have, though the healer does not.
 */
export function follow(root: unknown, path: string): Found {
  const segs = parsePath(path);
  const first = segs[0] as { name: string };
  if (!(isObj(root) && first.name in root)) return { kind: 'none' };
  type Item = { value: unknown; owner: unknown; at?: string };
  // Where an item is, as the path writes it, from the first view of a step's output on the way.
  const into = (value: unknown, owner: unknown, at: string | undefined, step: string): Item => ({ value, owner, at: at === undefined ? canonOf(value) : at + step });
  let items: Item[] = [into(root[first.name], root, canonOf(root), `.${first.name}`)];
  let many = false;
  for (const seg of segs.slice(1)) {
    const next: Item[] = [];
    if (many && 'name' in seg && seg.name === 'length') {
      items = [{ value: items.length, owner: undefined }];
      many = false;
      continue;
    }
    const name = 'name' in seg ? seg.name : undefined;
    const step = 'name' in seg ? `.${seg.name}` : '[*]';
    for (const { value, at } of items) {
      if (name !== undefined) {
        if (isObj(value) && name in value) {
          next.push(into(value[name], value, at, step));
          continue;
        }
        if ('name' in seg && isObj(value) && at !== undefined) (value as View)[MISSING]?.(at + step);
        // Inside nothing (a step that did not run) is nothing too; a name that is not there is undefined.
        if (!many) next.push({ value: value === null ? null : undefined, owner: value });
      } else {
        const list = Array.isArray(value) ? [...value] : isObj(value) ? Object.values(value) : [];
        for (const v of list) {
          if (v == null) continue;
          if ('values' in seg && isObj(v) && !(seg.field in v) && at !== undefined) (v as View)[MISSING]?.(`${at}[*].${seg.field}`);
          if ('all' in seg || ('values' in seg && isObj(v) && seg.values.includes(String(v[seg.field])))) next.push(into(v, value, at, step));
        }
        many = true;
      }
    }
    items = next;
  }
  return many ? { kind: 'many', items: items.map(({ value, owner }) => ({ value, owner })) } : { kind: 'one', value: items[0]?.value };
}
