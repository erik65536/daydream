/**
 * Templates are Mustache (placeholders, and sections that repeat over a list or show only when something is
 * there), with nothing escaped and every name read as a path (path.ts), so `{{#map.places[kind=town]}}` works.
 * A name found nowhere, or one that prints a list or an object, is a problem the editor shows; `{{json path}}` prints
 * one on purpose, as JSON. A partial (`{{> system}}`) is a text of constants.yaml, filled in where it stands.
 */
import Mustache from 'mustache';
import { follow } from './path.ts';

class PathContext extends Mustache.Context {
  private problems: Set<string>;
  constructor(view: unknown, parent: PathContext | undefined, problems: Set<string>) {
    super(view, parent);
    this.problems = problems;
  }

  override push(view: unknown): PathContext {
    return new PathContext(view, this, this.problems);
  }

  override lookup(name: string): unknown {
    if (name === '.') return isBoxed(this.view) ? this.view[VALUE] : this.view;
    if (name.startsWith('json ')) return JSON.stringify(this.lookup(name.slice(5).trim()), (_, v: unknown) => (isBoxed(v) ? v[VALUE] : v));
    for (let c: Mustache.Context | undefined = this; c; c = c.parent) {
      const found = follow(c.view, name);
      if (found.kind === 'none') continue;
      const v = found.kind === 'one' ? found.value : found.items.map((i) => i.value);
      if (v === undefined) this.problems.add(`"${name}" is not there`);
      return Array.isArray(v) ? v.map(positioned) : v;
    }
    this.problems.add(`"${name}" is not there`);
    return undefined;
  }
}

const VALUE = Symbol('value');
type Boxed = { [VALUE]: unknown };
const isBoxed = (v: unknown): v is Boxed => typeof v === 'object' && v !== null && VALUE in v;

/**
 * An item of the list a section repeats over knows where it stands in it: `$first`, `$last`, `$n` (from 1). A text
 * or number is boxed to carry them, and `{{.}}` prints it.
 */
function positioned(item: unknown, i: number, list: unknown[]): unknown {
  const pos: Record<string, unknown> = { $first: i === 0, $last: i === list.length - 1, $n: i + 1 };
  if (item === null || item === undefined) return item;
  if (typeof item !== 'object') return { [VALUE]: item, ...pos };
  return new Proxy(item, {
    has: (t, k) => (typeof k === 'string' && k in pos) || Reflect.has(t, k),
    get: (t, k) => (typeof k === 'string' && k in pos ? pos[k] : Reflect.get(t, k)),
  });
}

/** A template filled in. Blank lines left by empty sections are closed up, and the text trimmed. */
export function render(template: string, view: unknown, problems: Set<string>, partials: Record<string, unknown> = {}): string {
  const escape = (v: unknown) => {
    if (typeof v === 'object' && v !== null) {
      problems.add('a placeholder prints a list or an object, not text');
      return '';
    }
    return String(v);
  };
  let out: string;
  try {
    const partial = (name: string) => {
      const t = partials[name];
      if (typeof t === 'string') return t;
      problems.add(`"> ${name}" is not a text of constants.yaml`);
      return '';
    };
    out = new Mustache.Writer().render(template, new PathContext(view, undefined, problems), partial, { escape });
  } catch (e) {
    problems.add((e as Error).message);
    return '';
  }
  return out.replace(/[ \t]+$/gm, '').replace(/\n{3,}/g, '\n\n').trim();
}
