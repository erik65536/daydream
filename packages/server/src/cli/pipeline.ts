/**
 * The build pipeline from the command line (docs/build-pipeline.md), on the same files and runner as the editor.
 * Made to be read by people and by Claude: short by default, everything exact a flag away. Answers print as YAML.
 *
 * Usage: node src/cli/pipeline.ts <command> [...] [--example <id>]
 * (the example is the one run last unless --example names one; every command says which it used)
 *
 * Looking
 *   steps                       every step by subject (order.yaml): its state, what it reads, what reads it, fields nothing reads
 *   check                       only the problems (exits 1 when there are any)
 *   readers <step>[.<field>]    each field of a step's answer with the steps and records that read it
 *   render <step>               what a step sends: system and user text, and the answer's shape
 *       --body                  the request body exactly as sent instead of the shape
 *       --item <id> | --all     a step run once per item shows its first call, unless one or all are asked for
 *       --sample                the steps it reads as made-up answers instead of their newest runs
 *   examples                    the examples and how far each has run
 *   facts [--at <path>]         what templates read from the example: input and map
 *   constants                   what templates read as constants
 *   record <name>               a game record: what fills it, its shape, and what the example's runs fill it with
 * Talking
 *   chat                        the people of the example's world, town by town
 *   chat <person> ["line" ...]  talk with one of them (by id or part of their name) in the game's own conversation:
 *                               they greet the hero, then each line is said in turn; prints what they say and, at
 *                               the end, what they think of the hero, the quests begun, and the journal
 *       --sheet                 also print what the speaking model is told about who they are
 * Runs
 *   runs <step>                 a step's runs, newest first
 *   show <step> [--run <id>] [--at <path>] [--json]
 *                               a run's answer (the newest unless --run); --at prints only a part (arcs.arc1.quests.0);
 *                               --example all shows the newest answer on every example
 *   diff <step> [<other step>] [--run <id>] [--with <id>]
 *                               two answers line by line: a step's newest two runs, or the newest runs of two steps
 *                               (a variant beside what it was copied from)
 *   run <step|all> [--times n] [--stale] [--cap dollars]
 *                               run a step (n times side by side), or every step in order (--stale: only those out of
 *                               date); --example all runs on every example; spending stops at the cap (default $0.50)
 *
 * Runs go to data/pipeline/ (DAYDREAM_DATA_DIR); the model config is the server's (DAYDREAM_GENAI_CONFIG, or
 * config/genai.json, and .env).
 */
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
import YAML from 'yaml';
import { Pipeline, type RunRecord } from '../pipeline/index.ts';
import { people } from '../pipeline/chat.ts';
import { shapeText } from '../pipeline/shape.ts';

const args = process.argv.slice(2);
const flag = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i < 0 ? undefined : (args.splice(i, 2)[1] ?? '');
};
const has = (name: string) => {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && !!args.splice(i, 1).length;
};
const opts = {
  example: flag('example'),
  times: Number(flag('times') ?? 1),
  cap: Number(flag('cap') ?? 0.5),
  run: flag('run'),
  with: flag('with'),
  item: flag('item'),
  at: flag('at'),
  stale: has('stale'),
  sample: has('sample'),
  sheet: has('sheet'),
  body: has('body'),
  all: has('all'),
  json: has('json'),
};
const [command, a, b] = args;

const p = new Pipeline({ cap: opts.cap });
// Each value in full where it appears (no anchors), and each text on one line, so answers diff line by line.
const yaml = (v: unknown) => YAML.stringify(v, { lineWidth: 0, aliasDuplicateObjects: false }).trimEnd();
const money = (usd: number) => `$${usd.toFixed(4)}`;
const when = (at: number) => new Date(at).toLocaleString(undefined, { month: 'short', day: 'numeric', hour: '2-digit', minute: '2-digit' });

/** The newest run of any step on an example, or 0. */
const lastRun = (ex: string) => Math.max(0, ...[...p.project.steps.keys()].map((s) => p.store.newest(ex, s)?.at ?? 0));

/** The example a command is about: the one named, else the one run last, else the first. Said on the first line. */
function example(): string {
  const all = [...p.project.examples.keys()];
  if (opts.example) {
    p.example(opts.example); // refuses an example that does not exist, naming those that do
    console.log(`On ${opts.example}.`);
    return opts.example;
  }
  const ex = all.reduce((best, x) => (lastRun(x) > lastRun(best) ? x : best), all[0]!);
  console.log(`On ${ex}, the example run last (--example <id> for another).`);
  return ex;
}

/** A part of a value by a dotted path (`arcs.arc1.quests.0`). */
function at(value: unknown, path: string | undefined): unknown {
  if (!path) return value;
  let v = value;
  for (const k of path.split('.')) {
    if (v === null || typeof v !== 'object' || !(k in v)) throw new Error(`"${path}" is not there: at "${k}" there is ${v && typeof v === 'object' ? Object.keys(v).join(', ') : 'nothing more'}`);
    v = (v as Record<string, unknown>)[k];
  }
  return v;
}

const runLine = (r: RunRecord) => `${r.id}  ${when(r.at)}  ${(r.ms / 1000).toFixed(0)} s  ${money(r.usage.usd)}  ${r.usage.calls} call${r.usage.calls === 1 ? '' : 's'}  ${r.usage.output} tokens out${r.error ? '  FAILED' : ''}`;

/** A step's run: the one named, else its newest with an answer; with the reason when there is none. */
function pickRun(ex: string, step: string, id?: string): RunRecord {
  p.step(step);
  const run = id ? p.store.get(ex, step, id) : p.store.latest(ex, step);
  if (!run) {
    const others = [...p.project.examples.keys()].filter((x) => p.store.latest(x, step));
    throw new Error(id ? `${step} has no run "${id}" on ${ex} (runs ${step} lists them)` : `${step} has not run on ${ex}${others.length ? `; it has on ${others.join(', ')}` : ''}`);
  }
  return run;
}

/** Two texts line by line, with two lines of context around each change. */
function diff(left: string, right: string): string {
  const x = left.split('\n');
  const y = right.split('\n');
  // The longest common subsequence, from the end, to walk forwards.
  const lcs = Array.from({ length: x.length + 1 }, () => new Array<number>(y.length + 1).fill(0));
  for (let i = x.length - 1; i >= 0; i--) for (let j = y.length - 1; j >= 0; j--) lcs[i]![j] = x[i] === y[j] ? lcs[i + 1]![j + 1]! + 1 : Math.max(lcs[i + 1]![j]!, lcs[i]![j + 1]!);
  const lines: [' ' | '-' | '+', string][] = [];
  let i = 0;
  let j = 0;
  while (i < x.length || j < y.length) {
    if (i < x.length && j < y.length && x[i] === y[j]) lines.push([' ', x[i++]!]), j++;
    // What was removed is said before what replaced it.
    else if (i < x.length && (j >= y.length || lcs[i + 1]![j]! >= lcs[i]![j + 1]!)) lines.push(['-', x[i++]!]);
    else lines.push(['+', y[j++]!]);
  }
  const near = lines.map((_, k) => lines.slice(Math.max(0, k - 2), k + 3).some(([t]) => t !== ' '));
  const out: string[] = [];
  lines.forEach(([t, l], k) => {
    if (near[k]) out.push(`${t} ${l}`);
    else if (near[k - 1]) out.push('  …');
  });
  return out.join('\n');
}

function steps(ex: string, onlyProblems: boolean): number {
  const an = p.analyze(ex);
  const st = p.status(ex);
  let problems = an.problems.length;
  for (const pr of an.problems) console.log(`! ${pr}`);
  for (const { name, id } of an.groups.flatMap((g) => g.steps.map((id, i) => ({ name: i ? '' : g.name, id })))) {
    const s = an.steps[id]!;
    problems += s.problems.length;
    if (!onlyProblems && name) console.log(`\n── ${name}`);
    if (onlyProblems && !s.problems.length) continue;
    const each = p.step(id).forEach;
    console.log(`\n${id}  ${st[id]!.state}${st[id]!.why ? ` (${st[id]!.why})` : ''}${each ? `  once for each of ${each}` : ''}`);
    if (!onlyProblems) {
      console.log(`  reads    ${s.reads.join(', ') || 'only the input'}`);
      console.log(`  read by  ${s.readBy.join(', ') || 'nothing: a variant, or unused'}`);
      if (s.unread.length) console.log(`  unread   ${s.unread.join(', ')}`);
    }
    for (const pr of s.problems) console.log(`  ! ${pr}`);
  }
  for (const r of an.records) {
    problems += r.problems.length;
    if (onlyProblems && !r.problems.length) continue;
    console.log(`\nrecord ${r.name}  filled from ${r.from ?? 'nothing'}`);
    for (const pr of r.problems) console.log(`  ! ${pr.replace(/\n/g, '\n    ')}`);
  }
  return problems;
}

/** The commands whose first argument is a step, checked before anything else is said. */
const ON_A_STEP = new Set(['readers', 'render', 'runs', 'show', 'diff']);

async function main() {
  if (a && ON_A_STEP.has(command!)) p.step(a.split(/[.[]/)[0]!);
  if (command === 'diff' && b) p.step(b);
  switch (command) {
    case 'steps':
      steps(example(), false);
      break;
    case 'check': {
      const n = steps(example(), true);
      console.log(n ? `\n${n} problem${n > 1 ? 's' : ''}.` : 'No problems.');
      process.exitCode = n ? 1 : 0;
      break;
    }
    case 'readers': {
      if (!a) throw new Error('readers <step>[.<field>]');
      const step = a.split(/[.[]/)[0]!;
      p.step(step);
      const s = p.analyze(example()).steps[step]!;
      const loose = (f: string) => f.replace(/\[[^\]]*\]/g, '');
      const fields = Object.entries(s.fields).filter(([f]) => loose(f).startsWith(loose(a)));
      if (!fields.length) throw new Error(`${step}'s answer has no field "${a}"; its fields are ${Object.keys(s.fields).join(', ')}`);
      const width = Math.max(...fields.map(([f]) => f.length));
      for (const [f, by] of fields) console.log(`${f.padEnd(width)}  ${by.length ? by.join(', ') : 'NOTHING READS IT'}`);
      break;
    }
    case 'render': {
      if (!a) throw new Error('render <step>');
      const ex = example();
      const pv = p.preview(ex, a, opts.sample ? 'sample' : 'saved');
      if (pv.missing.length) console.log(`Made-up answers stand in for ${pv.missing.join(', ')}, which ${pv.missing.length > 1 ? 'have' : 'has'} not run on ${ex}.`);
      if (!pv.runs) console.log(`Its "only when" finds nothing on ${ex}, so it would not be called.`);
      for (const pr of pv.problems) console.log(`! ${pr}`);
      let calls = pv.calls;
      if (calls.length > 1) {
        if (opts.item) calls = calls.filter((c) => c.item === opts.item);
        else if (!opts.all) calls = calls.slice(0, 1);
        if (!calls.length) throw new Error(`There is no call for "${opts.item}": the items are ${pv.calls.map((c) => c.item).join(', ')}`);
        console.log(`${pv.calls.length} calls, one for each of ${pv.calls.map((c) => c.item).join(', ')}${opts.all || opts.item ? '' : `. Showing ${calls[0]!.item}; --item <id> or --all for others`}.`);
      }
      for (const c of calls) {
        if (c.item && pv.calls.length > 1) console.log(`\n======== ${c.item}`);
        console.log(`\n──── system\n${c.system || '(none)'}\n\n──── user\n${c.user}\n`);
        if (opts.body) console.log(`──── request body\n${JSON.stringify(c.body, null, 2)}\n`);
        else console.log(`──── answer shape (--body for the request body)\n${shapeText(c.schema)}\n`);
      }
      break;
    }
    case 'examples': {
      const all = [...p.project.examples.keys()];
      const width = Math.max(...all.map((x) => x.length));
      const problems = p.project.problems;
      for (const x of all) {
        const st = Object.values(p.status(x));
        const count = (s: string) => st.filter((v) => v.state === s).length;
        const input = p.example(x).input;
        const last = lastRun(x);
        const parts = [`${input.size}, ${input.length}`, `${count('fresh')} up to date`, count('stale') && `${count('stale')} out of date`, count('missing') && `${count('missing')} not run`, count('failed') && `${count('failed')} failed`, last ? `last run ${when(last)}` : 'never run'];
        console.log(`${x.padEnd(width)}  ${parts.filter(Boolean).join(' · ')}`);
        for (const pr of problems.filter((q) => q.startsWith(`examples/${x}.yaml:`))) console.log(`${''.padEnd(width)}  ! ${pr}`);
      }
      break;
    }
    case 'facts': {
      const f = p.facts(example());
      // A place or person inside another (a dungeon's `off`, a resident's `town`, an arc's `reach`) is its id.
      console.log(yaml(at({ input: f.input, map: f.map, game: f.game }, opts.at)));
      break;
    }
    case 'constants':
      console.log(p.project.constantsText().trimEnd());
      break;
    case 'record': {
      if (!a) throw new Error(`record <name>: ${p.analyze(example()).records.map((r) => r.name).join(', ')}`);
      const ex = example();
      const r = p.record(ex, a);
      console.log(`Filled from ${r.from ?? 'nothing (pipeline/records.yaml)'}.\n\n──── shape\n${shapeText(r.shape)}\n`);
      console.log(`──── on ${ex}`);
      console.log(r.missing.length ? `Not filled yet: ${r.missing.join(', ')} ${r.missing.length > 1 ? 'have' : 'has'} not run.` : yaml(r.value));
      break;
    }
    case 'chat': {
      const ex = example();
      if (!a) {
        for (const t of people(p.world(ex))) {
          console.log(`\n${t.town}`);
          for (const n of t.people) console.log(`  ${n.id.padEnd(10)} ${n.name}, ${n.title} (${n.role}${n.story ? ', in the story' : ''})`);
        }
        break;
      }
      const chat = p.chat(ex, a);
      let shown = 0;
      const show = () => {
        const v = chat.view();
        for (const m of v.messages.slice(shown)) console.log(`${m.speaker === 'person' ? v.person.name : m.speaker === 'hero' ? 'Ash' : '..'}: ${m.text}`);
        shown = v.messages.length;
      };
      const v0 = chat.view();
      console.log(`Talking with ${v0.person.name}, ${v0.person.title}, in ${v0.person.home}.${opts.sheet ? `\n\n──── what the speaking model is told\n${v0.sheet}\n` : ''}\n`);
      await chat.open();
      show();
      for (const line of args.slice(2)) {
        await chat.say(line);
        show();
      }
      const v = chat.view();
      console.log(`\n──── after\n${v.person.name} ${v.regard.feeling} (${v.regard.value})${v.regard.reasons.length ? `: ${v.regard.reasons.join('; ')}` : ''}.`);
      if (v.quests.length) console.log(`Quests: ${v.quests.map((q) => `${q.title} (${q.status}${q.main ? ', main' : ''})`).join('; ')}`);
      if (v.journal.length) console.log(`Journal:\n${v.journal.map((j) => `  ${j}`).join('\n')}`);
      console.log(`Spent ${money(v.usd)}.`);
      chat.close();
      break;
    }
    case 'runs': {
      if (!a) throw new Error('runs <step>');
      p.step(a);
      const ex = example();
      const runs = p.store.list(ex, a);
      if (!runs.length) throw new Error(`${a} has not run on ${ex}`);
      const st = p.status(ex)[a]!;
      console.log(`${a} is ${st.state}${st.why ? ` (${st.why})` : ''}. Later steps read the newest run with an answer.`);
      for (const r of runs) console.log(runLine(r));
      break;
    }
    case 'show': {
      if (!a) throw new Error('show <step>');
      const all = opts.example === 'all';
      for (const ex of all ? [...p.project.examples.keys()] : [example()]) {
        if (all) {
          console.log(`\n== ${ex}`);
          if (!p.store.list(ex, a).length) { console.log('No runs.'); continue; }
        }
        const run = pickRun(ex, a, opts.run);
        console.log(runLine(run));
        if (run.error) console.log(`! ${run.error}${run.partial ? `\nWhere the answer had reached:\n…${run.partial.slice(-1500)}` : ''}`);
        else if (run.output === null) console.log('Its "only when" found nothing, so it was not called.');
        else {
          const part = at(run.output, opts.at);
          console.log(opts.json ? JSON.stringify(part, null, 2) : yaml(part));
        }
      }
      break;
    }
    case 'diff': {
      if (!a) throw new Error('diff <step> [<other step>]');
      const ex = example();
      const other = b ?? a;
      // `-` is the first step's run, `+` the other's; for one step, `-` is the run before and `+` the newest.
      let left = pickRun(ex, a, opts.run);
      let right: RunRecord;
      if (opts.with) right = pickRun(ex, other, opts.with);
      else if (other !== a) right = pickRun(ex, other);
      else {
        const older = p.store.list(ex, a).filter((r) => r.output !== undefined && r.at < left.at);
        if (!older.length) throw new Error(`${a} has no run on ${ex} before ${left.id}: run it again, or name another step to compare with`);
        [left, right] = [older[0]!, left];
      }
      console.log(`- ${a}  ${runLine(left)}\n+ ${other}  ${runLine(right)}\n`);
      const text = (r: RunRecord) => (r.error ? `! ${r.error}` : yaml(at(r.output, opts.at)));
      const d = diff(text(left), text(right));
      console.log(d.trim() ? d : 'The two answers are the same.');
      break;
    }
    case 'run': {
      if (!a) throw new Error('run <step|all>');
      if (a !== 'all') p.step(a);
      const examples = opts.example === 'all' ? [...p.project.examples.keys()] : [example()];
      const report = (line: string) => console.log(line);
      await Promise.all(examples.map((ex) => (a === 'all' ? p.runAll(ex, { stale: opts.stale, report }) : p.run(ex, a, opts.times, report))));
      console.log(`Spent ${money(p.budget.spent)} of the cap of $${opts.cap.toFixed(2)}.`);
      break;
    }
    default: {
      // The usage is this file's own header.
      const header = fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').match(/\/\*\*([\s\S]*?)\*\//)![1]!;
      console.log(header.replace(/^ \* ?/gm, '').trim());
      if (command && command !== 'help') process.exitCode = 1;
    }
  }
}

main().catch((e) => {
  console.error((e as Error).message);
  process.exitCode = 1;
});
