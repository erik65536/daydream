/**
 * The pipeline's files, in pipeline/ at the repository root:
 *   steps/<id>.yaml      one per step (types.ts StepDef)
 *   constants.yaml       values every step may read (`{{constants.voice}}`), each text a partial too (`{{> system}}`)
 *   records.yaml         which output fills each of the game's records (records.ts)
 *   order.yaml           how the steps read: groups by subject, each listing its steps in order
 *   examples/<id>.yaml   saved owner inputs to run on
 * Editing keeps a file's comments and layout: only the fields changed are rewritten.
 */
import fs from 'node:fs';
import path from 'node:path';
import YAML from 'yaml';
import { ROOT_DIR } from '../paths.ts';
import { WorldInputSchema } from '../worldInput.ts';
import type { Example, StepDef } from './types.ts';

export const PIPELINE_DIR = path.join(ROOT_DIR, 'pipeline');

const ID = /^[a-zA-Z][a-zA-Z0-9_]*$/;
/** Names a template already uses for something else. */
const TAKEN = new Set(['input', 'map', 'game', 'constants']);

export class Project {
  readonly steps = new Map<string, StepDef>();
  readonly examples = new Map<string, Example>();
  constants: Record<string, unknown> = {};
  records: Record<string, string> = {};
  /** The steps' groups as order.yaml lists them (analysis.ts checks the list against what each step reads). */
  groups: { name: string; steps: string[] }[] = [];
  /** Files that could not be read. */
  readonly problems: string[] = [];
  readonly dir: string;

  constructor(dir = PIPELINE_DIR) {
    this.dir = dir;
    this.reload();
  }

  reload() {
    this.steps.clear();
    this.examples.clear();
    this.problems.length = 0;
    this.constants = this.readYaml('constants.yaml') ?? {};
    this.records = this.readYaml('records.yaml') ?? {};
    const order = this.readYaml('order.yaml') ?? {};
    this.groups = Object.entries(order).map(([name, steps]) => ({ name, steps: Array.isArray(steps) ? steps.map(String) : [] }));
    for (const f of this.list('steps')) {
      const id = f.replace(/\.yaml$/, '');
      const def = this.readYaml(`steps/${f}`) as StepDef | undefined;
      if (!def) continue;
      if (!ID.test(id) || TAKEN.has(id)) this.problems.push(`steps/${f}: a step's id is a name of letters, digits and _, and not ${[...TAKEN].join(', ')}`);
      else this.steps.set(id, { ...def, id });
    }
    for (const f of this.list('examples')) {
      const id = f.replace(/\.yaml$/, '');
      const input = this.readYaml(`examples/${f}`);
      if (!input) continue;
      const wrong = inputProblem(input);
      if (wrong) this.problems.push(`examples/${f}: ${wrong}`);
      this.examples.set(id, { id, input });
    }
  }

  private list(sub: string): string[] {
    const d = path.join(this.dir, sub);
    return fs.existsSync(d) ? fs.readdirSync(d).filter((f) => f.endsWith('.yaml')).sort() : [];
  }

  private readYaml(rel: string): any {
    const file = path.join(this.dir, rel);
    if (!fs.existsSync(file)) return undefined;
    try {
      return YAML.parse(fs.readFileSync(file, 'utf8'));
    } catch (e) {
      this.problems.push(`${rel}: ${(e as Error).message.split('\n')[0]}`);
      return undefined;
    }
  }

  /** A known step's file (ids come from the editor, so only the steps that exist are opened). */
  stepFile(id: string) {
    if (!this.steps.has(id)) throw new Error(`There is no step "${id}"`);
    return path.join(this.dir, 'steps', `${id}.yaml`);
  }

  /** A step's file as written. */
  stepText(id: string): string {
    return fs.readFileSync(this.stepFile(id), 'utf8');
  }

  /** A step's schema as written in its file (comments kept), for editing. */
  stepSchemaText(id: string): string {
    const node = YAML.parseDocument(this.stepText(id)).get('schema', true);
    return node ? new YAML.Document(node).toString({ lineWidth: 0 }) : '';
  }

  /** This project with one step as given instead of as saved (to show an edit before it is saved). */
  withStep(def: StepDef): Project {
    const p = Object.create(this) as Project;
    Object.defineProperty(p, 'steps', { value: new Map(this.steps).set(def.id, def) });
    return p;
  }

  /** Changes some fields of a step, keeping the rest of its file as it was. `schema` is given as YAML text. */
  saveStep(id: string, changes: Partial<Omit<StepDef, 'id' | 'schema'>> & { schema?: string }) {
    const doc = YAML.parseDocument(this.stepText(id));
    for (const [k, v] of Object.entries(changes)) {
      if (k === 'schema') doc.set('schema', YAML.parseDocument(v as string).contents);
      else if (v === undefined || v === '') doc.delete(k);
      else doc.set(k, typeof v === 'string' && v.includes('\n') ? Object.assign(doc.createNode(v), { type: 'BLOCK_LITERAL' }) : v);
    }
    if (doc.errors.length) throw new Error(doc.errors[0]!.message);
    this.write(this.stepFile(id), doc.toString({ lineWidth: 0 }));
  }

  /** A copy of a step under a new id: a variant that nothing reads until something is pointed at it. */
  duplicateStep(id: string): string {
    let n = 2;
    const base = id.replace(/_\d+$/, '');
    while (this.steps.has(`${base}_${n}`)) n++;
    const copy = `${base}_${n}`;
    this.write(path.join(this.dir, 'steps', `${copy}.yaml`), this.stepText(id));
    this.editOrder((groups) => {
      const g = groups.find((s) => names(s).includes(id)) ?? groups.at(-1);
      g?.items.splice(names(g).indexOf(id) + 1 || g.items.length, 0, new YAML.Scalar(copy));
    });
    return copy;
  }

  createStep(id: string) {
    if (!ID.test(id) || TAKEN.has(id)) throw new Error(`"${id}" is not a step's id: use letters, digits and _, starting with a letter`);
    if (this.steps.has(id)) throw new Error(`There is already a step "${id}"`);
    this.write(path.join(this.dir, 'steps', `${id}.yaml`), `purpose: world.design\nmaxTokens: 4000\nsystem: '{{> system}}'\nuser: |\n  THE OWNER'S THEME:\n  {{input.theme}}\nschema:\n  type: object\n  properties:\n    answer:\n      type: string\n      maxLength: 400\n`);
    this.editOrder((groups) => groups.at(-1)?.items.push(new YAML.Scalar(id)));
  }

  deleteStep(id: string) {
    fs.rmSync(this.stepFile(id));
    this.editOrder((groups) => groups.forEach((g) => (g.items = g.items.filter((_, i) => names(g)[i] !== id))));
  }

  /** Changes the lists of order.yaml (one per group), keeping the file's comments and layout. */
  private editOrder(change: (groups: YAML.YAMLSeq[]) => void) {
    const file = path.join(this.dir, 'order.yaml');
    if (!fs.existsSync(file)) return this.reload();
    const doc = YAML.parseDocument(fs.readFileSync(file, 'utf8'));
    change((YAML.isMap(doc.contents) ? doc.contents.items : []).flatMap((p) => (YAML.isSeq(p.value) ? [p.value as YAML.YAMLSeq] : [])));
    this.write(file, doc.toString({ lineWidth: 0 }));
  }

  constantsText(): string {
    const file = path.join(this.dir, 'constants.yaml');
    return fs.existsSync(file) ? fs.readFileSync(file, 'utf8') : '';
  }

  /** Replaces the constants, if they are YAML naming values (`system: …`). */
  saveConstants(text: string) {
    let v: unknown;
    try {
      v = YAML.parse(text) ?? {};
    } catch (e) {
      throw new Error(`It is not YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    if (typeof v !== 'object' || Array.isArray(v)) throw new Error('The constants are names with values, such as "system: …"');
    this.write(path.join(this.dir, 'constants.yaml'), text);
  }

  /** A known example's file. */
  exampleFile(id: string) {
    if (!this.examples.has(id)) throw new Error(`There is no example "${id}"`);
    return path.join(this.dir, 'examples', `${id}.yaml`);
  }

  exampleText(id: string): string {
    return fs.readFileSync(this.exampleFile(id), 'utf8');
  }

  /** Replaces an example's file, if it is an owner's input as a new world would accept it. */
  saveExample(id: string, text: string) {
    let input: unknown;
    try {
      input = YAML.parse(text);
    } catch (e) {
      throw new Error(`It is not YAML: ${(e as Error).message.split('\n')[0]}`);
    }
    const wrong = inputProblem(input);
    if (wrong) throw new Error(wrong);
    this.write(this.exampleFile(id), text);
  }

  /** A new example, starting as a copy of another (or a blank owner's input). */
  createExample(id: string, from?: string) {
    if (!ID.test(id)) throw new Error(`"${id}" is not an example's id: use letters, digits and _, starting with a letter`);
    if (this.examples.has(id)) throw new Error(`There is already an example "${id}"`);
    // A copy lays out its own map, from its id.
    const text = from ? this.exampleText(from) :'theme: Describe the world in a sentence or two, as an owner would.\nsize: small\nlength: short\ncommunication: 2\n';
    this.write(path.join(this.dir, 'examples', `${id}.yaml`), text);
  }

  deleteExample(id: string) {
    fs.rmSync(this.exampleFile(id));
    this.reload();
  }

  private write(file: string, text: string) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    fs.writeFileSync(tmp, text);
    fs.renameSync(tmp, file);
    this.reload();
  }
}

/** The step ids a group of order.yaml lists. */
const names = (group: YAML.YAMLSeq) => group.items.map((s) => String(YAML.isScalar(s) ? s.value : s));

/** What is wrong with an owner's input, if anything: the first thing a new world would refuse. */
function inputProblem(input: unknown): string | undefined {
  const r = WorldInputSchema.safeParse(input);
  const i = r.success ? undefined : r.error.issues[0];
  return i && (i.path.length ? `${i.path.join('.')}: ${i.message}` : i.message);
}
