/**
 * A playtest run: one agent playing as one player, written down as it goes so it can be read afterwards.
 *
 *   data/playtests/<date>-<time>-<agent>-p<n>/
 *     log.jsonl      every command, its result as the agent saw it, and its screenshot
 *     shots/         the screenshots (0001-look.jpg …)
 *     report.md      what the agent reported (bugs, feedback, notes, its verdict) first, then the whole run step by
 *                    step with its screenshots; rewritten after every report and at the end
 *   data/playtests/index.md   every run, newest first, with its counts of bugs and feedback
 */
import fs from 'node:fs';
import path from 'node:path';
import { PLAYTEST_DIR } from './files.ts';

type FindingKind = 'bug' | 'feedback' | 'note';
export const SEVERITIES = ['blocker', 'major', 'minor', 'polish'] as const;
export type Severity = (typeof SEVERITIES)[number];

interface Finding {
  kind: FindingKind;
  step: number;
  at: number;
  text: string;
  severity?: Severity;
  shot?: string;
  /** Where it happened: place, position, adventure, and what was on screen. */
  context: string;
}

export interface Verdict {
  summary: string;
  fun?: number;
  clarity?: number;
  looks?: number;
  best?: string;
  worst?: string;
}

interface Step {
  step: number;
  at: number;
  command: string;
  args: string[];
  text: string;
  shot?: string;
}

const stamp = (t: number) => new Date(t).toISOString().slice(0, 16).replace('T', '-').replace(':', '');
const slug = (s: string) => s.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 24) || 'agent';

export class Run {
  readonly dir: string;
  readonly started = Date.now();
  private steps: Step[] = [];
  private findings: Finding[] = [];
  verdict?: Verdict;
  ended?: number;

  readonly agent: string;
  readonly player: number;
  readonly username: string;
  readonly adventure: string;

  constructor(agent: string, player: number, username: string, adventure: string) {
    this.agent = agent;
    this.player = player;
    this.username = username;
    this.adventure = adventure;
    this.dir = path.join(PLAYTEST_DIR, `${stamp(this.started)}-${slug(agent)}-p${player}`);
    fs.mkdirSync(path.join(this.dir, 'shots'), { recursive: true });
    this.writeReport();
  }

  get stepCount() {
    return this.steps.length;
  }

  /** Where the next screenshot goes. */
  shotPath(command: string) {
    return path.join(this.dir, 'shots', `${String(this.steps.length + 1).padStart(4, '0')}-${slug(command)}.jpg`);
  }

  record(command: string, args: string[], text: string, shot?: string) {
    const s: Step = { step: this.steps.length + 1, at: Date.now(), command, args, text, shot };
    this.steps.push(s);
    fs.appendFileSync(path.join(this.dir, 'log.jsonl'), JSON.stringify(s) + '\n');
    return s.step;
  }

  report(f: Omit<Finding, 'step' | 'at'>) {
    const finding = { ...f, step: this.steps.length, at: Date.now() };
    this.findings.push(finding);
    fs.appendFileSync(path.join(this.dir, 'findings.jsonl'), JSON.stringify(finding) + '\n');
    this.writeReport();
    return this.findings.filter((x) => x.kind === f.kind).length;
  }

  end(v: Verdict) {
    this.verdict = v;
    this.ended = Date.now();
    this.writeReport();
  }

  counts() {
    const n = (k: FindingKind) => this.findings.filter((f) => f.kind === k).length;
    return { bugs: n('bug'), feedback: n('feedback'), notes: n('note') };
  }

  writeReport() {
    const rel = (p?: string) => (p ? path.relative(this.dir, p).split(path.sep).join('/') : '');
    const minutes = Math.round(((this.ended ?? Date.now()) - this.started) / 60000);
    const out: string[] = [
      `# Playtest by ${this.agent} (player ${this.player}, ${this.username})`,
      '',
      `Started ${new Date(this.started).toLocaleString()}; ${this.ended ? `ended after ${minutes} min` : `running for ${minutes} min so far`}, ${this.steps.length} steps. Adventure \`${this.adventure}\`.`,
      '',
    ];
    if (this.verdict) {
      const v = this.verdict;
      const score = (name: string, x?: number) => (x ? `${name} ${x}/5` : '');
      out.push('## Verdict', '', v.summary, '');
      const scores = [score('Fun', v.fun), score('Clarity', v.clarity), score('Looks', v.looks)].filter(Boolean).join(' · ');
      if (scores) out.push(scores, '');
      if (v.best) out.push(`**Best:** ${v.best}`, '');
      if (v.worst) out.push(`**Worst:** ${v.worst}`, '');
    }
    const section = (title: string, kind: FindingKind) => {
      const list = this.findings.filter((f) => f.kind === kind);
      if (!list.length) return;
      const order = (f: Finding) => (f.severity ? SEVERITIES.indexOf(f.severity) : 9);
      out.push(`## ${title} (${list.length})`, '');
      for (const f of [...list].sort((a, b) => order(a) - order(b) || a.step - b.step)) {
        out.push(`### ${f.severity ? `[${f.severity}] ` : ''}${headline(f.text)}`, '');
        if (headline(f.text) !== f.text) out.push(f.text, '');
        out.push(`*After step ${f.step}. ${f.context}*`, '');
        if (f.shot) out.push(`![](${rel(f.shot)})`, '');
      }
    };
    section('Bugs', 'bug');
    section('Feedback', 'feedback');
    section('Notes', 'note');
    out.push('## Steps', '');
    for (const s of this.steps) {
      out.push(`<details><summary>${s.step}. <code>${[s.command, ...s.args.map((a) => (/\s/.test(a) ? JSON.stringify(a) : a))].join(' ').replace(/</g, '&lt;').slice(0, 160)}</code></summary>`, '');
      out.push('```text', s.text, '```', '');
      if (s.shot) out.push(`![](${rel(s.shot)})`, '');
      out.push('</details>', '');
    }
    fs.writeFileSync(path.join(this.dir, 'report.md'), out.join('\n'));
    writeIndex();
  }
}

/** A finding's first sentence, or its first words when that is long. */
function headline(text: string): string {
  const first = /^[^\n]*?[.!?](?=\s|$)/.exec(text)?.[0] ?? text.split('\n')[0]!;
  return first.length <= 100 ? first : `${first.slice(0, first.lastIndexOf(' ', 97))}…`;
}

/** "2 bugs, 1 piece of feedback, no notes". */
export function tally(c: { bugs: number; feedback: number; notes: number }) {
  const n = (k: number, one: string, many: string) => `${k || 'no'} ${k === 1 ? one : many}`;
  return [n(c.bugs, 'bug', 'bugs'), n(c.feedback, 'piece of feedback', 'pieces of feedback'), n(c.notes, 'note', 'notes')].join(', ');
}

/** data/playtests/index.md: every run, newest first. */
function writeIndex() {
  const runs = fs
    .readdirSync(PLAYTEST_DIR, { withFileTypes: true })
    .filter((d) => d.isDirectory() && fs.existsSync(path.join(PLAYTEST_DIR, d.name, 'report.md')))
    .map((d) => d.name)
    .sort()
    .reverse();
  const lines = ['# Playtests', '', 'Every run in this checkout, newest first. Each report lists bugs and feedback first, then every step.', ''];
  for (const name of runs) {
    const findings = (() => {
      try {
        return fs.readFileSync(path.join(PLAYTEST_DIR, name, 'findings.jsonl'), 'utf8').trim().split('\n').filter(Boolean).map((l) => JSON.parse(l) as Finding);
      } catch {
        return [];
      }
    })();
    const n = (k: FindingKind) => findings.filter((f) => f.kind === k).length;
    lines.push(`- [${name}](${name}/report.md): ${tally({ bugs: n('bug'), feedback: n('feedback'), notes: n('note') })}`);
  }
  fs.writeFileSync(path.join(PLAYTEST_DIR, 'index.md'), lines.join('\n') + '\n');
}
