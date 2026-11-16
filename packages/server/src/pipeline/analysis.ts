/**
 * What the pipeline is, worked out by rendering every step on made-up outputs (scope.ts, sample mode): the order
 * the steps run in, what each reads and what reads it, the fields nothing reads, and every problem: a name that is
 * not there, a schema that cannot be made, steps that read each other, a record no output fills.
 */
import { located } from './names.ts';
import { z } from 'zod';
import { follow } from './path.ts';
import type { Project } from './project.ts';
import { RECORDS } from './records.ts';
import { leaves, sample } from './schema.ts';
import { CycleError, Scope } from './scope.ts';
import type { RunStore } from './store.ts';
import { newAccess, Views } from './track.ts';
import type { Example } from './types.ts';

interface StepInfo {
  id: string;
  /** The steps it reads. */
  reads: string[];
  /** The steps and records that read it. */
  readBy: string[];
  /** Fields of its output nothing reads, by canonical path. */
  unread: string[];
  /** Every field of its output (by canonical path), with the steps and records that read it. */
  fields: Record<string, string[]>;
  problems: string[];
}

interface RecordInfo {
  name: string;
  from?: string;
  problems: string[];
}

export interface Analysis {
  /** The steps in the order they run (each after every step it reads). */
  order: string[];
  /** The steps by subject, as pipeline/order.yaml lists them; a step it leaves out is in a last group of its own. */
  groups: { name: string; steps: string[] }[];
  steps: Record<string, StepInfo>;
  records: RecordInfo[];
  /** Problems of the pipeline as a whole (unreadable files, steps that read each other). */
  problems: string[];
}

export function analyze(project: Project, example: Example, store: RunStore): Analysis {
  const scope = new Scope(project, example, store, 'sample');
  const reads = new Set<string>();
  /** For each field read, who reads it. */
  const readers = new Map<string, Set<string>>();
  const note = (who: string, fields: Iterable<string>) => {
    for (const f of fields) {
      reads.add(f);
      readers.set(f, (readers.get(f) ?? new Set()).add(who));
    }
  };
  const steps: Record<string, StepInfo> = {};
  const problems = [...project.problems];
  for (const id of project.steps.keys()) {
    const access = newAccess();
    let p: string[] = [];
    try {
      const prepared = scope.prepare(id, access);
      p = prepared.problems;
      // A check reads the answer itself: paths that find nothing in a made-up answer (which holds every kind of
      // item a list can) are misspelt.
      const call = prepared.calls[0];
      const answer = call && sample(call.schema, id);
      const finds = (at: string) => {
        const f = follow(answer, at);
        return f.kind === 'many' ? f.items.length > 0 : f.kind === 'one' && f.value !== undefined;
      };
      for (const ch of call?.checks ?? []) if (!ch.in.some(finds)) p.push(`checks: ${ch.in.map((at) => `"${at}"`).join(' and ')} find nothing in the answer`);
      for (const at of call?.names?.own ?? []) if (!located(answer, at).length) p.push(`names: "${at}" finds no name in the answer`);
    } catch (e) {
      p = [(e as Error).message];
      if (e instanceof CycleError && !problems.includes(e.message)) problems.push(e.message);
    }
    access.deps.delete(id);
    note(id, access.reads);
    steps[id] = { id, reads: [...access.deps].sort(), readBy: [], unread: [], fields: {}, problems: p };
  }

  const records: RecordInfo[] = [];
  for (const [name, schema] of Object.entries(RECORDS)) {
    const from = project.records[name];
    const info: RecordInfo = { name, from, problems: [] };
    records.push(info);
    if (!from) {
      info.problems.push('No output fills it (pipeline/records.yaml)');
      continue;
    }
    const access = newAccess();
    try {
      const f = follow(new Views(scope, access).root(), from);
      if (f.kind !== 'one' || f.value == null) info.problems.push(`"${from}" is not there`);
      else {
        // Checking the shape reads exactly the fields the record takes.
        const ok = (schema as z.ZodType).safeParse(f.value);
        // Made-up text cannot match a pattern (a color's hex), so only the shape is checked.
        const wrong = ok.success ? [] : ok.error.issues.filter((i) => i.code !== 'invalid_format');
        if (wrong.length) info.problems.push(z.prettifyError({ ...ok.error!, issues: wrong } as z.ZodError).slice(0, 600));
      }
    } catch (e) {
      info.problems.push((e as Error).message);
    }
    note(`record ${name}`, access.reads);
    for (const d of access.deps) steps[d]?.readBy.push(`record ${name}`);
  }
  for (const name of Object.keys(project.records)) if (!(name in RECORDS)) problems.push(`records.yaml names "${name}", which is not one of the game's records (${Object.keys(RECORDS).join(', ')})`);

  for (const s of Object.values(steps)) for (const d of s.reads) steps[d]?.readBy.unshift(s.id);
  for (const s of Object.values(steps)) {
    try {
      const fields = [...leaves(scope.schemaOf(s.id), s.id)];
      s.unread = fields.filter((f) => !reads.has(f));
      s.fields = Object.fromEntries(fields.map((f) => [f, [...(readers.get(f) ?? [])].filter((r) => r !== s.id)]));
    } catch {
      /* its problem is already listed */
    }
  }

  // The list of order.yaml: each step once, after every step it reads.
  const groups = project.groups.map((g) => ({ name: g.name, steps: g.steps.filter((id) => project.steps.has(id)) }));
  const listed = groups.flatMap((g) => g.steps);
  for (const g of project.groups) for (const id of g.steps) if (!project.steps.has(id)) problems.push(`order.yaml lists "${id}" in ${g.name}, and there is no such step`);
  for (const id of new Set(listed)) if (listed.indexOf(id) !== listed.lastIndexOf(id)) problems.push(`order.yaml lists "${id}" more than once`);
  for (const id of listed) {
    const late = (steps[id]?.reads ?? []).filter((d) => listed.indexOf(d) > listed.indexOf(id));
    if (late.length) problems.push(`order.yaml lists "${id}" before ${late.map((d) => `"${d}"`).join(' and ')}, which it reads`);
  }
  // A project without an order.yaml lists its steps in the order they run, as one group.
  const unlisted = [...project.steps.keys()].filter((id) => !listed.includes(id));
  if (!project.groups.length) groups.push({ name: 'Steps', steps: unlisted });
  else if (unlisted.length) {
    problems.push(`order.yaml does not list ${unlisted.map((d) => `"${d}"`).join(', ')}`);
    groups.push({ name: 'Not in order.yaml', steps: unlisted });
  }

  // Each step after everything it reads, otherwise as listed; steps that read each other are a problem.
  const order: string[] = [];
  const state = new Map<string, 'doing' | 'done'>();
  const visit = (id: string, trail: string[]) => {
    if (state.get(id) === 'done') return;
    if (state.get(id) === 'doing') {
      const loop = `These steps read each other: ${[...trail.slice(trail.indexOf(id)), id].join(' → ')}`;
      if (!problems.includes(loop)) problems.push(loop);
      return;
    }
    state.set(id, 'doing');
    for (const d of steps[id]?.reads ?? []) if (steps[d]) visit(d, [...trail, id]);
    state.set(id, 'done');
    order.push(id);
  };
  for (const id of groups.flatMap((g) => g.steps)) visit(id, []);
  if (!project.groups.length) groups[0]!.steps = [...order];
  return { order, groups, steps, records, problems };
}
