/**
 * The editor's API, on the pipeline runner the build uses. Every request reads the pipeline's files afresh, so
 * changes made outside the editor (by hand, or by Claude) show at once.
 */
import type { IncomingMessage, ServerResponse } from 'node:http';
import YAML from 'yaml';
import { Pipeline, type Mode, type StepDef } from '../../../server/src/pipeline/index.ts';
import { people, type Chat } from '../../../server/src/pipeline/chat.ts';
import { hash } from '../../../server/src/pipeline/store.ts';
import type { ChatView, Job, People, PreviewOut, RecordOut, RunSummary, State, StepEdit } from '../protocol.ts';

const pipeline = new Pipeline({ cap: Number(process.env.DAYDREAM_DESIGNER_CAP ?? 1) });
const jobs: Job[] = [];
/** Conversations open on the Talk page, by id; the oldest close when there are too many. */
const chats = new Map<string, Chat>();
const MAX_CHATS = 6;

function openChat(example: string, person: string) {
  const chat = pipeline.chat(example, person);
  chats.set(chat.id, chat);
  for (const [id, old] of chats) if (chats.size > MAX_CHATS) (old.close(), chats.delete(id));
  return chat;
}

function chat(id: string): Chat {
  const c = chats.get(id);
  if (!c) throw new Refused('That conversation has ended: start another');
  return c;
}
let nextJob = 1;

class Refused extends Error {}

/** A step's file as the editor edits it. */
function edit(id: string): StepEdit {
  const s = pipeline.step(id);
  return {
    purpose: s.purpose,
    model: s.model ?? '',
    reasoning: s.reasoning ?? '',
    maxTokens: s.maxTokens === undefined ? '' : String(s.maxTokens),
    forEach: s.forEach ?? '',
    when: s.when ?? '',
    system: s.system ?? '',
    user: s.user ?? '',
    schema: pipeline.project.stepSchemaText(id),
  };
}

/** An edit as a step, to show before it is saved. */
function draft(id: string, e: StepEdit): StepDef {
  let schema: StepDef['schema'];
  try {
    schema = YAML.parse(e.schema) ?? {};
  } catch (err) {
    throw new Refused(`The schema is not YAML: ${(err as Error).message.split('\n')[0]}`);
  }
  return {
    id,
    purpose: e.purpose as StepDef['purpose'],
    ...(e.model && { model: e.model }),
    ...(e.reasoning && { reasoning: e.reasoning as StepDef['reasoning'] }),
    ...(e.maxTokens && { maxTokens: Number(e.maxTokens) }),
    ...(e.forEach && { forEach: e.forEach }),
    ...(e.when && { when: e.when }),
    system: e.system,
    user: e.user,
    schema,
  };
}

function save(id: string, e: StepEdit) {
  draft(id, e); // refuses a schema that is not YAML
  if (e.maxTokens && !(Number(e.maxTokens) > 0)) throw new Refused('Max tokens is a number');
  pipeline.project.saveStep(id, {
    purpose: e.purpose as StepDef['purpose'],
    model: e.model || undefined,
    reasoning: (e.reasoning || undefined) as StepDef['reasoning'],
    maxTokens: e.maxTokens ? Number(e.maxTokens) : undefined,
    forEach: e.forEach || undefined,
    when: e.when || undefined,
    system: e.system,
    user: e.user,
    schema: e.schema,
  });
}

function state(example: string | undefined): State {
  pipeline.project.reload();
  const examples = [...pipeline.project.examples.keys()];
  const ex = example && examples.includes(example) ? example : examples[0]!;
  return {
    examples,
    example: ex,
    analysis: pipeline.analyze(ex),
    status: pipeline.status(ex),
    names: pipeline.names(ex),
    steps: Object.fromEntries([...pipeline.project.steps.values()].map((s) => [s.id, { purpose: s.purpose, forEach: s.forEach, when: s.when, stamp: hash(s) }])),
    spend: { spent: pipeline.budget.spent, cap: pipeline.budget.cap },
    jobs: jobs.slice(-20),
  };
}

/** Runs in the background; the page follows them through the state. */
function start(label: string, work: (report: (line: string) => void) => Promise<unknown>): Job {
  const job: Job = { id: nextJob++, label, started: Date.now(), lines: [], done: false };
  jobs.push(job);
  work((line) => job.lines.push(line))
    .catch((e) => (job.error = (e as Error).message))
    .finally(() => (job.done = true));
  return job;
}

const summary = (r: { id: string; at: number; ms: number; usage: { usd: number; calls: number }; error?: string }): RunSummary => ({ id: r.id, at: r.at, ms: r.ms, usd: r.usage.usd, calls: r.usage.calls, error: r.error });

type Handler = (q: URLSearchParams, body: any, params: string[]) => unknown;

const routes: [method: string, path: RegExp, handler: Handler][] = [
  ['GET', /^\/api\/state$/, (q) => state(q.get('example') ?? undefined)],
  ['GET', /^\/api\/step\/(\w+)$/, (_q, _b, [id]) => edit(id!)],
  ['PUT', /^\/api\/step\/(\w+)$/, (_q, b, [id]) => (save(id!, b as StepEdit), { ok: true })],
  ['POST', /^\/api\/step\/(\w+)\/duplicate$/, (_q, _b, [id]) => ({ id: pipeline.project.duplicateStep(id!) })],
  ['DELETE', /^\/api\/step\/(\w+)$/, (_q, _b, [id]) => (pipeline.project.deleteStep(id!), { ok: true })],
  ['POST', /^\/api\/steps$/, (_q, b) => (pipeline.project.createStep(String(b.id)), { id: b.id })],
  ['GET', /^\/api\/example\/(\w+)$/, (_q, _b, [id]) => ({ text: pipeline.project.exampleText(id!) })],
  ['PUT', /^\/api\/example\/(\w+)$/, (_q, b, [id]) => (pipeline.project.saveExample(id!, String(b.text)), { ok: true })],
  ['DELETE', /^\/api\/example\/(\w+)$/, (_q, _b, [id]) => (pipeline.project.deleteExample(id!), { ok: true })],
  ['POST', /^\/api\/examples$/, (_q, b) => (pipeline.project.createExample(String(b.id), b.from ? String(b.from) : undefined), { id: b.id })],
  ['GET', /^\/api\/constants$/, () => (pipeline.project.reload(), { text: pipeline.project.constantsText(), values: pipeline.project.constants })],
  ['PUT', /^\/api\/constants$/, (_q, b) => (pipeline.project.saveConstants(String(b.text)), { ok: true })],
  ['GET', /^\/api\/facts$/, (q) => pipeline.facts(q.get('example')!)],
  ['GET', /^\/api\/people$/, (q): People => people(pipeline.world(q.get('example')!))],
  ['POST', /^\/api\/chat$/, async (_q, b): Promise<ChatView> => {
    const c = openChat(String(b.example), String(b.person));
    await c.open();
    return c.view();
  }],
  ['POST', /^\/api\/chat\/(\w+)\/say$/, async (_q, b, [id]): Promise<ChatView> => {
    const c = chat(id!);
    await c.say(String(b.text).slice(0, 600));
    return c.view();
  }],
  ['DELETE', /^\/api\/chat\/(\w+)$/, (_q, _b, [id]) => (chats.get(id!)?.close(), chats.delete(id!), { ok: true })],
  ['GET', /^\/api\/record$/, (q): RecordOut => pipeline.record(q.get('example')!, q.get('name')!)],
  [
    'POST',
    /^\/api\/preview$/,
    (_q, b): PreviewOut => pipeline.preview(String(b.example), String(b.step), b.mode as Mode, b.draft ? draft(String(b.step), b.draft as StepEdit) : undefined),
  ],
  ['GET', /^\/api\/runs$/, (q) => pipeline.store.list(q.get('example')!, q.get('step')!).map(summary)],
  ['GET', /^\/api\/run$/, (q) => pipeline.store.get(q.get('example')!, q.get('step')!, q.get('id')!) ?? null],
  [
    'POST',
    /^\/api\/run$/,
    (_q, b) => {
      const examples: string[] = b.example === 'all' ? [...pipeline.project.examples.keys()] : [String(b.example)];
      const times = Math.max(1, Math.min(5, Number(b.times ?? 1)));
      const what = b.step === 'all' ? (b.stale ? 'every step out of date' : 'every step') : `${b.step}${times > 1 ? ` ×${times}` : ''}`;
      return start(`${what} on ${examples.join(', ')}`, (report) =>
        Promise.all(examples.map((ex) => (b.step === 'all' ? pipeline.runAll(ex, { stale: !!b.stale, report }) : pipeline.run(ex, String(b.step), times, report)))),
      );
    },
  ],
  [
    'POST',
    /^\/api\/cap$/,
    (_q, b) => {
      const cap = Number(b.cap);
      if (!(cap >= 0)) throw new Refused('The cap is an amount in dollars');
      pipeline.budget.cap = cap;
      return { ok: true };
    },
  ],
];

/** Only this machine's own pages may ask: the API writes files and spends money. */
function allowed(req: IncomingMessage): boolean {
  const local = /^(localhost|127\.0\.0\.1|\[::1\])(:\d+)?$/;
  if (!local.test(req.headers.host ?? '')) return false;
  const origin = req.headers.origin;
  if (origin && !local.test(origin.replace(/^https?:\/\//, ''))) return false;
  // A page elsewhere can only send JSON after asking, which this server never answers.
  return req.method === 'GET' || (req.headers['content-type'] ?? '').startsWith('application/json');
}

export async function api(req: IncomingMessage, res: ServerResponse): Promise<boolean> {
  const url = new URL(req.url ?? '/', 'http://localhost');
  if (!url.pathname.startsWith('/api/')) return false;
  const send = (status: number, value: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(value));
  };
  if (!allowed(req)) return (send(403, { error: 'Only this machine may use the editor' }), true);
  const route = routes.find(([m, p]) => m === req.method && p.test(url.pathname));
  if (!route) return (send(404, { error: 'No such request' }), true);
  try {
    let body: unknown = null;
    if (req.method !== 'GET') {
      const chunks: Buffer[] = [];
      for await (const c of req) chunks.push(c as Buffer);
      body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {};
    }
    send(200, await route[2](url.searchParams, body, route[1].exec(url.pathname)!.slice(1)));
  } catch (e) {
    send(e instanceof Refused ? 400 : 500, { error: (e as Error).message });
  }
  return true;
}
