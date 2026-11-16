// What building one daydream cost, step by step: clock time, GPU time, CPU time, OpenAI dollars by model and tier,
// model calls, and retries. Reads the meter (data/logs/meter.jsonl, written by packages/server/src/genai/meter.ts),
// the job queue (stages, logs), the gateway's call log, and the world's own files (asset attempts, animation state).
//
//   node scripts/buildcost.mjs <worldId> [--data <dir>] [--out <dir>]
//
// Writes <out>/cost.json (everything), steps.csv, openai.csv, gpu.csv and retries.csv (default out: the current
// directory), so a later build can be compared with this one.
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

const args = process.argv.slice(2);
const opt = (name, def) => (args.includes(`--${name}`) ? args[args.indexOf(`--${name}`) + 1] : def);
const worldId = args[0];
if (!worldId || worldId.startsWith('--')) throw new Error('usage: node scripts/buildcost.mjs <worldId> [--data <dir>] [--out <dir>]');
const dataDir = path.resolve(opt('data', 'data'));
const outDir = path.resolve(opt('out', '.'));
fs.mkdirSync(outDir, { recursive: true });

// ------------------------------------------------------------------------------------ inputs

const db = new DatabaseSync(path.join(dataDir, 'daydream.sqlite'), { readOnly: true });
const jobs = db.prepare('SELECT id, kind, status, created_at, started_at, finished_at, attempts, phases FROM jobs WHERE world_id = ? ORDER BY created_at').all(worldId).map((j) => ({ ...j, phases: JSON.parse(j.phases) }));
const jobIds = new Set(jobs.map((j) => j.id));
const jobKind = Object.fromEntries(jobs.map((j) => [j.id, j.kind]));
const logOf = (id) => db.prepare('SELECT t, kind, msg FROM job_log WHERE job_id = ? ORDER BY t').all(id);

const lines = (file) => (fs.existsSync(file) ? fs.readFileSync(file, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : []);
const meter = lines(path.join(dataDir, 'logs', 'meter.jsonl'));
const mine = meter.filter((m) => m.worldId === worldId || jobIds.has(m.jobId));
const gateway = lines(path.join(dataDir, 'logs', 'genai.jsonl')).filter((c) => jobIds.has(c.jobId));

// ------------------------------------------------------------------------------------ steps

/** The logical steps of a build, in order, and the meter's steps each one covers. */
const STEPS = [
  ['concept', 'World concept', ['concept']],
  ['rules', 'Rules (ruleset design)', ['rules']],
  ['atlas', 'World plan (regions and places)', ['atlas']],
  ['families', 'Creature families', ['families']],
  ['story', 'Main story', ['story']],
  ['content', 'People, quests, and lore per place', ['content']],
  ['places.plan', 'Places: map plan', ['places.plan']],
  ['places.paint', 'Places: painting the map (all of it; its parts below)', ['places.paint']],
  ['places.paint.whole', 'Places: painting, whole-place paintings', ['places.paint.whole']],
  ['places.paint.check', 'Places: painting, soundness checks (view and walk reading)', ['places.paint.check']],
  ['places.paint.rewrite', 'Places: painting, layout rewrites', ['places.paint.rewrite']],
  ['places.paint.exits', 'Places: painting, ways out cut', ['places.paint.exits']],
  ['places.paint.close', 'Places: painting, unplanned openings closed', ['places.paint.close']],
  ['places.read', 'Places: reading walkable ground and spots', ['places.read']],
  ['places.furnish', 'Places: furnishing and game scale', ['places.furnish']],
  ['places.mist', 'Places: mist layer', ['places.mist']],
  ['places.upscale', 'Places: upscaling', ['places.upscale']],
  ['balance.sim', 'Balance: simulation', ['balance.sim']],
  ['balance.review', 'Balance: designer review', ['balance.review', 'balance']],
  ['companions', 'Companions', ['companions']],
  ['art.prompts', 'Art: image prompts', ['art.prompts']],
  ['art.characters', 'Art: characters (heroes, people)', ['art.characters']],
  ['art.creatures', 'Art: creatures and bosses', ['art.creatures']],
  ['art.objects', 'Art: objects', ['art.objects']],
  ['art.icons', 'Art: item icons', ['art.icons']],
  ['art.repair', 'Art: repairs of weak images', ['art.repair']],
  ['anim.brief', 'Animation: briefs', ['anim.brief']],
  ['anim.prepare', 'Animation: preparing requests', ['anim.prepare']],
  ['anim.paint', 'Animation: GPT Image through the Batch API', ['anim.paint']],
  ['anim.assemble', 'Animation: assembling clips', ['anim.assemble']],
];
const stepOf = new Map(STEPS.flatMap(([id, , covers]) => covers.map((c) => [c, id])));
const OTHER = 'other';
const groupOf = (step) => (step ? stepOf.get(step) ?? step : OTHER);

/** Total length of a set of [start, end] intervals with overlaps counted once. */
function union(iv) {
  const s = [...iv].sort((a, b) => a[0] - b[0]);
  let total = 0, cur = null;
  for (const [a, b] of s) {
    if (!cur || a > cur[1]) {
      if (cur) total += cur[1] - cur[0];
      cur = [a, b];
    } else cur[1] = Math.max(cur[1], b);
  }
  return total + (cur ? cur[1] - cur[0] : 0);
}

const blank = () => ({ spans: 0, busyMs: 0, intervals: [], first: Infinity, last: 0, calls: 0, usd: 0, gpuPrompts: 0, gpuFailed: 0, gpuMs: 0, gpuQueueMs: 0, cpuMs: 0, failedCalls: 0, tokens: { input: 0, cached: 0, output: 0, reasoning: 0, imageInput: 0 } });
const steps = new Map();
const at = (id) => (steps.has(id) || steps.set(id, blank()), steps.get(id));

for (const m of mine.filter((x) => x.kind === 'span')) {
  const s = at(groupOf(m.step));
  s.spans++;
  s.busyMs += m.ms;
  s.intervals.push([m.start, m.start + m.ms]);
  s.first = Math.min(s.first, m.start);
  s.last = Math.max(s.last, m.start + m.ms);
}

const openai = new Map();
for (const m of mine.filter((x) => x.kind === 'call')) {
  const s = at(groupOf(m.step));
  s.calls++;
  s.usd += m.usd;
  for (const k of Object.keys(s.tokens)) s.tokens[k] += m[k] ?? 0;
  const key = [groupOf(m.step), m.model, m.tier, m.api, m.purpose ?? ''].join('|');
  const o = openai.get(key) ?? { step: groupOf(m.step), model: m.model, tier: m.tier, api: m.api, purpose: m.purpose ?? '', calls: 0, usd: 0, input: 0, cached: 0, output: 0, reasoning: 0, imageInput: 0 };
  o.calls++;
  o.usd += m.usd;
  for (const k of ['input', 'cached', 'output', 'reasoning', 'imageInput']) o[k] += m[k] ?? 0;
  openai.set(key, o);
}

const gpu = new Map();
for (const m of mine.filter((x) => x.kind === 'gpu')) {
  const s = at(groupOf(m.step));
  s.gpuPrompts++;
  if (!m.ok) s.gpuFailed++;
  s.gpuMs += m.gpuMs;
  s.gpuQueueMs += m.queueMs;
  const key = `${groupOf(m.step)}|${m.workflow ?? '?'}`;
  const g = gpu.get(key) ?? { step: groupOf(m.step), workflow: m.workflow ?? '?', prompts: 0, failed: 0, gpuMs: 0, queueMs: 0, wallMs: 0 };
  g.prompts++;
  if (!m.ok) g.failed++;
  g.gpuMs += m.gpuMs;
  g.queueMs += m.queueMs;
  g.wallMs += m.wallMs;
  gpu.set(key, g);
}

// CPU samples are the worker's whole process (every thread); each is shared between this world's steps running then,
// by how many of each were running. Time with none of them running is counted to "other".
let cpuTotalMs = 0;
const myProcs = new Set(mine.map((m) => m.pid));
for (const m of meter.filter((x) => x.kind === 'cpu' && myProcs.has(x.pid))) {
  const ms = m.userMs + m.systemMs;
  const here = m.steps.filter((s) => jobIds.has(s.jobId));
  if (!here.length) {
    // A sample with no step of any job running belongs to this world only if no other job was running either.
    if (m.steps.length) continue;
    at(OTHER).cpuMs += ms;
    cpuTotalMs += ms;
    continue;
  }
  const n = here.reduce((a, s) => a + s.n, 0);
  for (const s of here) at(groupOf(s.step)).cpuMs += (ms * s.n) / n;
  cpuTotalMs += ms;
}

for (const c of gateway.filter((x) => !x.ok)) at(groupOf(c.step)).failedCalls++;

// ------------------------------------------------------------------------------------ retries

const chains = new Map();
for (const m of mine.filter((x) => x.kind === 'try')) {
  const c = chains.get(m.chain) ?? { layer: m.layer, label: m.label, step: groupOf(m.step), tries: [] };
  c.tries.push(m);
  chains.set(m.chain, c);
}
const retryRows = new Map();
const is429 = (t) => /\b429\b/.test(t.error ?? '');
let flex429 = { count: 0, waitMs: 0, chains: 0, chainsEndedOk: 0, chainsRanOut: 0 };
for (const c of chains.values()) {
  // Quality checks are told apart by what they check; the other layers by step.
  const what = c.layer === 'quality' ? c.label : '';
  const key = `${c.layer}|${c.step}|${what}`;
  const r = retryRows.get(key) ?? { layer: c.layer, step: c.step, check: what, chains: 0, retried: 0, rescued: 0, ranOut: 0, interrupted: 0, unfinished: 0, extraTries: 0, maxTries: 0 };
  const last = c.tries[c.tries.length - 1];
  const failedOnce = c.tries.some((t) => !t.ok);
  r.chains++;
  r.maxTries = Math.max(r.maxTries, c.tries.length);
  if (c.layer === 'gateway.transient') {
    // A transient chain is written only when it waited: every line but the last is one wait.
    const waits = c.tries.filter((t) => !t.ok && !t.final);
    r.extraTries += waits.length;
    if (waits.length) r.retried++;
    const w429 = waits.filter(is429);
    if (w429.length) {
      flex429.count += w429.length;
      flex429.waitMs += w429.reduce((a, t) => a + (t.waitMs ?? 0), 0);
      flex429.chains++;
      if (last.final && last.ok) flex429.chainsEndedOk++;
      if (last.final && !last.ok) flex429.chainsRanOut++;
    }
  } else {
    r.extraTries += c.tries.length - 1;
    if (c.tries.length > 1 || failedOnce) r.retried += failedOnce ? 1 : 0;
  }
  if (!last.final) r.unfinished++;
  else if (/^interrupted/.test(last.error ?? '')) r.interrupted++;
  else if (last.ok && failedOnce) r.rescued++;
  else if (!last.ok) r.ranOut++;
  retryRows.set(key, r);
}

// Retries kept in the world's own files: each image's attempts, and each animation part's.
const worldFile = path.join(dataDir, 'worlds', worldId, 'world.json');
const world = fs.existsSync(worldFile) ? JSON.parse(fs.readFileSync(worldFile, 'utf8')) : null;
const art = {};
for (const a of Object.values(world?.assets ?? {})) {
  // Places' paintings and mist, and animation sheets, are counted in their own steps.
  if (!['sprite', 'object', 'icon'].includes(a.kind)) continue;
  const g = groupOf(a.key.startsWith('spr_mon_') || a.key.startsWith('spr_boss_') ? 'art.creatures' : a.key.startsWith('spr_') ? 'art.characters' : a.key.startsWith('obj_') ? 'art.objects' : a.key.startsWith('icon_') ? 'art.icons' : `art.${a.kind}`);
  const r = (art[g] ??= { assets: 0, ok: 0, weak: 0, failed: 0, attempts: 0, firstTry: 0, scores: [] });
  r.assets++;
  r.attempts += a.attempts ?? 0;
  if ((a.attempts ?? 0) <= 1) r.firstTry++;
  if (a.status === 'ok') r.ok++;
  else r.failed++;
  if (a.status === 'ok' && a.error) r.weak++;
  if (a.score !== undefined) r.scores.push(a.score);
}
for (const r of Object.values(art)) {
  r.meanScore = r.scores.length ? +(r.scores.reduce((a, b) => a + b, 0) / r.scores.length).toFixed(2) : null;
  delete r.scores;
}
const anim = { actors: 0, animated: 0, failed: 0, parts: 0, partAttempts: 0, partsRetried: 0, errors: [] };
const animDir = path.join(dataDir, 'worlds', worldId, 'anim');
if (fs.existsSync(animDir))
  for (const key of fs.readdirSync(animDir)) {
    const f = path.join(animDir, key, 'state.json');
    if (!fs.existsSync(f)) continue;
    const s = JSON.parse(fs.readFileSync(f, 'utf8'));
    anim.actors++;
    if (s.error) anim.failed++, anim.errors.push(`${key}: ${s.error.slice(0, 160)}`);
    else if (world?.assets?.[key]?.clips || world?.assets?.[key]?.anim) anim.animated++;
    const parts = new Set([...Object.keys(s.placed ?? {}), ...Object.keys(s.attempts ?? {})]);
    anim.parts += parts.size;
    for (const p of parts) {
      const failedTries = s.attempts?.[p] ?? 0;
      anim.partAttempts += failedTries + (s.error?.startsWith(`${p}:`) ? 0 : 1);
      if (failedTries) anim.partsRetried++;
    }
  }

// Batches: how long each was out.
const sent = new Map(mine.filter((m) => m.kind === 'batch' && m.event === 'sent').map((m) => [m.id, m]));
const batches = mine.filter((m) => m.kind === 'batch' && m.event === 'back').map((m) => ({ id: m.id, requests: m.requests, state: m.state, outMs: sent.has(m.id) ? m.t - sent.get(m.id).t : null }));

// ------------------------------------------------------------------------------------ the build as a whole

const worldJobs = jobs.filter((j) => j.kind === 'world');
const animJobs = jobs.filter((j) => j.kind === 'animate');
const span = (js) => (js.length ? { start: Math.min(...js.map((j) => j.started_at ?? j.created_at)), end: Math.max(...js.map((j) => j.finished_at ?? Date.now())) } : null);
const build = span(worldJobs), animation = span(animJobs);
const worker = (js) => js.reduce((a, j) => a + ((j.finished_at ?? Date.now()) - (j.started_at ?? j.created_at)), 0);
const stepTries = (id) => logOf(id).filter((l) => /try \d+ failed/.test(l.msg)).map((l) => l.msg.slice(0, 200));

const rows = STEPS.map(([id, label]) => [id, label]).concat([...steps.keys()].filter((k) => !STEPS.some(([id]) => id === k)).map((k) => [k, k]));
const stepRows = rows.filter(([id]) => steps.has(id)).map(([id, label]) => {
  const s = steps.get(id);
  return {
    step: id, label,
    first: s.first === Infinity ? null : new Date(s.first).toISOString(), last: s.last ? new Date(s.last).toISOString() : null,
    clockMin: +(union(s.intervals) / 60000).toFixed(2), busyMin: +(s.busyMs / 60000).toFixed(2), spans: s.spans,
    gpuMin: +(s.gpuMs / 60000).toFixed(2), gpuQueueMin: +(s.gpuQueueMs / 60000).toFixed(2), gpuPrompts: s.gpuPrompts, gpuFailed: s.gpuFailed,
    cpuMin: +(s.cpuMs / 60000).toFixed(2),
    openaiCalls: s.calls, failedCalls: s.failedCalls, usd: +s.usd.toFixed(4),
    inputTokens: s.tokens.input, cachedTokens: s.tokens.cached, outputTokens: s.tokens.output, reasoningTokens: s.tokens.reasoning, imageInputTokens: s.tokens.imageInput,
  };
});
const sum = (k) => +stepRows.reduce((a, r) => a + (r[k] ?? 0), 0).toFixed(4);
const totals = {
  buildClockMin: build ? +((build.end - build.start) / 60000).toFixed(1) : null,
  animationClockMin: animation ? +((animation.end - animation.start) / 60000).toFixed(1) : null,
  endToEndMin: build ? +(((animation?.end ?? build.end) - build.start) / 60000).toFixed(1) : null,
  workerMin: { world: +(worker(worldJobs) / 60000).toFixed(1), animate: +(worker(animJobs) / 60000).toFixed(1) },
  gpuMin: sum('gpuMin'), gpuQueueMin: sum('gpuQueueMin'), gpuPrompts: sum('gpuPrompts'), gpuFailed: sum('gpuFailed'),
  cpuMin: +(cpuTotalMs / 60000).toFixed(2),
  openaiCalls: sum('openaiCalls'), failedCalls: sum('failedCalls'), usd: sum('usd'),
};
const byModel = {};
for (const o of openai.values()) {
  const k = `${o.model} (${o.tier})`;
  const r = (byModel[k] ??= { calls: 0, usd: 0 });
  r.calls += o.calls;
  r.usd = +(r.usd + o.usd).toFixed(4);
}

// ------------------------------------------------------------------------------------ beyond the totals

/** Percentiles of a list of numbers. */
const pct = (xs, ...ps) => {
  const s = [...xs].sort((a, b) => a - b);
  return Object.fromEntries(ps.map((p) => [`p${p}`, s.length ? s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))] : null]));
};
// How long OpenAI took to answer, per step and purpose (the gateway's log: every attempt, failed ones too). Answers
// that only rewrote fields over their size limits are counted apart.
const latency = new Map();
for (const c of gateway) {
  const fit = /fitted \d+ field/.test(c.preview ?? '') || /^fit limits/.test(c.error ?? '');
  const key = `${groupOf(c.step)}|${c.purpose}|${fit ? 'fit limits' : 'answer'}`;
  const l = latency.get(key) ?? { step: groupOf(c.step), purpose: c.purpose, kind: fit ? 'fit limits' : 'answer', calls: 0, failed: 0, ms: [] };
  l.calls++;
  if (!c.ok) l.failed++;
  l.ms.push(c.ms);
  latency.set(key, l);
}
const latencyRows = [...latency.values()].map(({ ms, ...l }) => ({ ...l, totalMin: +(ms.reduce((a, b) => a + b, 0) / 60000).toFixed(2), ...Object.fromEntries(Object.entries(pct(ms, 50, 90, 100)).map(([k, v]) => [`${k}s`, v === null ? null : +(v / 1000).toFixed(1)])) }));

// The GPU over the build: how much of the time it was running a prompt of this world, its idle gaps (time it waited
// on everything else, Luna mostly), and how often the model in use changed (a load each time).
const prompts = mine.filter((m) => m.kind === 'gpu').map((m) => ({ end: m.t, start: m.t - m.gpuMs, workflow: m.workflow ?? '?' })).sort((a, b) => a.start - b.start);
let switches = 0;
const gaps = [];
for (let i = 1; i < prompts.length; i++) {
  if (prompts[i].workflow !== prompts[i - 1].workflow) switches++;
  const g = prompts[i].start - prompts[i - 1].end;
  if (g > 0) gaps.push(g);
}
const gpuBusy = union(prompts.map((p) => [p.start, p.end]));
const switchPairs = {};
for (let i = 1; i < prompts.length; i++) if (prompts[i].workflow !== prompts[i - 1].workflow) switchPairs[`${prompts[i - 1].workflow} > ${prompts[i].workflow}`] = (switchPairs[`${prompts[i - 1].workflow} > ${prompts[i].workflow}`] ?? 0) + 1;
// What the GPU waited on while the world job ran and it had nothing of this world to paint: each idle second is
// shared between the OpenAI calls in flight then (by step and purpose, 429 waits included, from the gateway's log),
// or, with none in flight, the steps whose spans were open (work on the CPU, or between steps).
const idleBy = new Map();
if (build) {
  const busy = prompts.map((p) => [p.start, p.end]).sort((a, b) => a[0] - b[0]);
  const calls = gateway.map((c) => ({ from: c.at, to: c.at + c.ms, key: `OpenAI: ${groupOf(c.step)} / ${c.purpose}` }));
  const open = mine.filter((m) => m.kind === 'span').map((m) => ({ from: m.start, to: m.start + m.ms, key: `no call in flight: ${groupOf(m.step)}` }));
  let k = 0;
  for (let t = build.start; t < build.end; t += 1000) {
    while (k < busy.length && busy[k][1] <= t) k++;
    if (busy.slice(k, k + 4).some(([a, b]) => a <= t && t < b)) continue;
    let who = [...new Set(calls.filter((c) => c.from <= t && t < c.to).map((c) => c.key))];
    if (!who.length) who = [...new Set(open.filter((c) => c.from <= t && t < c.to).map((c) => c.key))];
    if (!who.length) who = ['nothing running (between steps)'];
    for (const w of who) idleBy.set(w, (idleBy.get(w) ?? 0) + 1 / who.length);
  }
}
const idleRows = [...idleBy.entries()].map(([waitingOn, s]) => ({ waitingOn, idleMin: +(s / 60).toFixed(2) })).sort((a, b) => b.idleMin - a.idleMin);
const gpuUse = {
  prompts: prompts.length,
  busyMin: +(gpuBusy / 60000).toFixed(1),
  shareOfBuild: build ? +(union(prompts.filter((p) => p.start <= build.end).map((p) => [p.start, Math.min(p.end, build.end)])) / (build.end - build.start)).toFixed(3) : null,
  modelSwitches: switches,
  switchPairs,
  idleMinWhileBuilding: +(idleRows.reduce((a, r) => a + r.idleMin, 0)).toFixed(1),
  idleGapsOver1Min: gaps.filter((g) => g > 60_000).length,
  idleMinInGapsOver1Min: +(gaps.filter((g) => g > 60_000).reduce((a, b) => a + b, 0) / 60000).toFixed(1),
  longestIdleMin: gaps.length ? +(Math.max(...gaps) / 60000).toFixed(1) : 0,
};
// nvidia-smi samples (every 10 s, scripts/gpusmi.mjs) over the build: the card's utilization and its energy (anything
// else using the GPU then is counted too), and its heat: temperature, core clock, and the share of samples it was
// slowing itself down (thermal or power), since a hot laptop GPU paints the same picture 40-50% slower.
const smiFile = path.join(dataDir, 'logs', 'gpu-smi.csv');
if (fs.existsSync(smiFile) && build) {
  const samples = fs.readFileSync(smiFile, 'utf8').split('\n').filter(Boolean).map((l) => l.split(',').map((x) => x.trim())).map(([t, u, , p, temp, clock, ...why]) => ({ t: Date.parse(t.replace(/\//g, '-').replace(' ', 'T')), util: parseFloat(u), watts: parseFloat(p), temp: parseFloat(temp), clock: parseFloat(clock), slowed: why.some((w) => w === 'Active') })).filter((s) => s.t >= build.start && s.t <= (animation?.end ?? build.end));
  if (samples.length) {
    gpuUse.smiSamples = samples.length;
    // A sample may read "[Unknown Error]" for utilization; those are left out of it.
    const read = samples.filter((s) => Number.isFinite(s.util));
    gpuUse.smiMeanUtil = +(read.reduce((a, s) => a + s.util, 0) / Math.max(1, read.length)).toFixed(1);
    gpuUse.smiShareOver50 = +(read.filter((s) => s.util > 50).length / Math.max(1, read.length)).toFixed(3);
    gpuUse.energyKWh = +((samples.reduce((a, s) => a + (s.watts || 0), 0) * 10) / 3.6e6).toFixed(3);
    const hot = samples.filter((s) => Number.isFinite(s.temp));
    if (hot.length) {
      const busyHot = hot.filter((s) => s.util > 50);
      Object.assign(gpuUse, {
        smiMeanTempC: +(hot.reduce((a, s) => a + s.temp, 0) / hot.length).toFixed(1),
        smiMaxTempC: Math.max(...hot.map((s) => s.temp)),
        smiMeanClockMHzWhileBusy: busyHot.length ? Math.round(busyHot.reduce((a, s) => a + s.clock, 0) / busyHot.length) : null,
        smiShareSlowedWhileBusy: busyHot.length ? +(busyHot.filter((s) => s.slowed).length / busyHot.length).toFixed(3) : null,
      });
    }
  }
}

// Model switches, from ComfyUI's own history (saved as data/logs/comfy-history*.json: GET /history through the broker).
// A prompt whose model loaders were not cached had to load its model first, and that load is part of its time. The
// cost of loading is how much longer such a prompt took than prompts of the same graph that found the model loaded;
// the gap before it, beyond the usual gap, is the unloading of the model before (and anything else in between).
const history = new Map();
for (const f of fs.readdirSync(path.join(dataDir, 'logs')).filter((f) => /^comfy-history.*\.json$/.test(f)))
  for (const [id, e] of Object.entries(JSON.parse(fs.readFileSync(path.join(dataDir, 'logs', f), 'utf8')))) if (e.prompt?.[3]?.daydream?.worldId === worldId) history.set(id, e);
const median = (xs) => (xs.length ? [...xs].sort((a, b) => a - b)[Math.floor(xs.length / 2)] : null);
let switching = null;
let gpuByGraph = [];
if (history.size) {
  const ps = [...history.values()].map((e) => {
    const at = (k) => e.status?.messages?.find((m) => m[0] === k)?.[1];
    const graph = e.prompt[2];
    const loaders = Object.entries(graph).filter(([, n]) => /Loader/.test(n.class_type)).map(([k]) => k);
    const cached = new Set(at('execution_cached')?.nodes ?? []);
    const models = Object.values(graph).filter((n) => /Loader/.test(n.class_type)).map((n) => Object.values(n.inputs).find((v) => typeof v === 'string' && /\.(safetensors|ckpt|pth|gguf)$/.test(v))).filter(Boolean).sort();
    return { start: at('execution_start')?.timestamp, end: at('execution_success')?.timestamp, workflow: e.prompt[3].daydream.workflow ?? '?', job: e.prompt[3].daydream.kind, signature: [...new Set(Object.values(graph).map((n) => n.class_type))].sort().join('+'), models: models.join('+'), cold: loaders.some((k) => !cached.has(k)) };
  }).filter((p) => p.start && p.end).sort((a, b) => a.start - b.start);
  const bySig = new Map();
  for (const p of ps) (bySig.get(p.signature) ?? bySig.set(p.signature, []).get(p.signature)).push(p);
  let loadMs = 0, coldWithBaseline = 0, coldNoBaseline = 0;
  const perModel = {};
  for (const list of bySig.values()) {
    const warm = median(list.filter((p) => !p.cold).map((p) => p.end - p.start));
    for (const p of list.filter((x) => x.cold)) {
      const m = (perModel[p.models || p.workflow] ??= { coldPrompts: 0, estLoadMin: 0 });
      m.coldPrompts++;
      if (warm === null) {
        coldNoBaseline++;
        continue;
      }
      const extra = Math.max(0, p.end - p.start - warm);
      loadMs += extra;
      coldWithBaseline++;
      m.estLoadMin += extra / 60000;
    }
  }
  for (const m of Object.values(perModel)) m.estLoadMin = +m.estLoadMin.toFixed(2);
  const gapsBefore = (cold) => ps.slice(1).map((p, i) => ({ p, gap: p.start - ps[i].end })).filter((x) => x.p.cold === cold && x.gap >= 0 && x.gap < 600_000).map((x) => x.gap);
  const warmGap = median(gapsBefore(false)) ?? 0;
  const extraGapMs = gapsBefore(true).reduce((a, g) => a + Math.max(0, g - warmGap), 0);
  // Second estimate, not trusting the cache flags (the broker frees the GPU between models, and a loader ComfyUI
  // keeps cached may still have to move its weights back): within one graph, prompts right after a change of model
  // against prompts right after one of the same model.
  let afterChangeMs = 0, afterChange = 0, afterChangeNoBaseline = 0;
  const sigs = new Map();
  ps.forEach((p, i) => {
    const changed = i > 0 && ps[i - 1].models !== p.models;
    const s = sigs.get(p.signature) ?? sigs.set(p.signature, { same: [], changed: [] }).get(p.signature);
    (changed ? s.changed : s.same).push(p.end - p.start);
  });
  for (const s of sigs.values()) {
    const base = median(s.same);
    if (base === null) {
      afterChangeNoBaseline += s.changed.length;
      continue;
    }
    for (const ms of s.changed) (afterChangeMs += Math.max(0, ms - base)), afterChange++;
  }
  // GPU time by kind of graph and step (each history prompt matched to the meter's line for it by its finish). The
  // painter is told by its diffusion model's file, since Klein and Qwen graphs share most node types.
  const kindOf = (e) => {
    const nodes = Object.values(e.prompt[2]);
    const t = new Set(nodes.map((n) => n.class_type));
    const unet = String(nodes.find((n) => n.class_type === 'UNETLoader')?.inputs?.unet_name ?? '');
    if (t.has('SaveAudio')) return 'Stable Audio (sound)';
    if (/klein/i.test(unet)) return t.has('ReferenceLatent') ? 'Klein box edit' : 'Klein paint (text to image)';
    if (/qwen/i.test(unet) || /qwen/.test(e.prompt[3].daydream.workflow ?? '')) return 'Qwen edit (map reading)';
    return `another graph (${unet || 'no diffusion model'})`;
  };
  const gpuLines = mine.filter((m) => m.kind === 'gpu');
  const byGraph = new Map();
  for (const e of history.values()) {
    const at = (k) => e.status?.messages?.find((m) => m[0] === k)?.[1]?.timestamp;
    const end = at('execution_success'), start = at('execution_start');
    if (!end || !start) continue;
    const line = gpuLines.reduce((best, m) => (Math.abs(m.t - end) < Math.abs((best?.t ?? Infinity) - end) ? m : best), undefined);
    const step = line && Math.abs(line.t - end) < 5000 ? groupOf(line.step) : '?';
    const key = `${step}|${kindOf(e)}`;
    const r = byGraph.get(key) ?? { step, graph: kindOf(e), prompts: 0, gpuMin: 0 };
    r.prompts++;
    r.gpuMin += (end - start) / 60000;
    byGraph.set(key, r);
  }
  gpuByGraph = [...byGraph.values()].map((r) => ({ ...r, gpuMin: +r.gpuMin.toFixed(2), meanSec: +((r.gpuMin * 60) / r.prompts).toFixed(1) })).sort((a, b) => b.gpuMin - a.gpuMin);
  switching = {
    afterChangeEstLoadMin: +(afterChangeMs / 60000).toFixed(1),
    afterChangePrompts: afterChange,
    afterChangeWithoutBaseline: afterChangeNoBaseline,
    prompts: ps.length,
    coldPrompts: ps.filter((p) => p.cold).length,
    modelChanges: ps.slice(1).filter((p, i) => p.models !== ps[i].models).length,
    estLoadMin: +(loadMs / 60000).toFixed(1),
    coldPromptsWithoutWarmBaseline: coldNoBaseline,
    estExtraGapMin: +(extraGapMs / 60000).toFixed(1),
    medianGapSecBeforeWarm: +(warmGap / 1000).toFixed(1),
    medianGapSecBeforeCold: +((median(gapsBefore(true)) ?? 0) / 1000).toFixed(1),
    perModel,
    note: `${coldWithBaseline} cold prompts compared with warm prompts of the same graph; ${coldNoBaseline} had no warm prompt to compare with and are left out of estLoadMin.`,
  };
}

// Each place: when its painting started and when it was ready (from the job log), and its size.
const placeRows = [];
for (const j of worldJobs) {
  const log = logOf(j.id);
  for (const z of world?.zones ?? []) {
    const ready = log.find((l) => l.msg === `${z.name} is ready`);
    const made = log.find((l) => l.msg.startsWith(`${z.name}: map made`));
    const painted = log.find((l) => l.msg.startsWith(`Painting ${z.name}: done in`));
    const settled = log.find((l) => l.msg.startsWith(`Settling ${z.name}: done in`));
    placeRows.push({ place: z.name, kind: z.kind, tiles: z.tiles ? `${z.tiles[0]}x${z.tiles[1]}` : '', paintAndReadMin: painted ? +(parseFloat(painted.msg.split('done in ')[1]) / 60).toFixed(1) : null, settleMin: settled ? +(parseFloat(settled.msg.split('done in ')[1]) / 60).toFixed(1) : null, mapMadeAt: made ? new Date(made.t).toISOString() : null, readyAt: ready ? new Date(ready.t).toISOString() : null, readyAfterMin: ready && build ? +((ready.t - build.start) / 60000).toFixed(1) : null });
  }
}

// Prompt caching and thinking: how much input came from the cache, how much output was reasoning.
const textCalls = mine.filter((m) => m.kind === 'call' && m.api !== 'openai-image');
const tok = (k) => textCalls.reduce((a, m) => a + (m[k] ?? 0), 0);
const tokens = { input: tok('input'), cached: tok('cached'), output: tok('output'), reasoning: tok('reasoning'), cachedShare: +(tok('cached') / Math.max(1, tok('input'))).toFixed(3), reasoningShare: +(tok('reasoning') / Math.max(1, tok('output'))).toFixed(3) };

const du = (dir) => {
  if (!fs.existsSync(dir)) return 0;
  let n = 0;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) n += e.isDirectory() ? du(path.join(dir, e.name)) : fs.statSync(path.join(dir, e.name)).size;
  return n;
};
const wdir = path.join(dataDir, 'worlds', worldId);
const disk = Object.fromEntries(['', 'assets', 'draft', 'anim'].map((d) => [d || 'all', +(du(path.join(wdir, d)) / 1e6).toFixed(1)]));

const out = {
  worldId, title: world?.concept?.title, input: world?.input, seed: world?.seed, measuredAt: new Date().toISOString(),
  world: world ? { places: world.zones?.length, people: world.npcs?.length, quests: world.quests?.length, bosses: world.bosses?.length, families: world.families?.length, assets: Object.keys(world.assets ?? {}).length } : null,
  jobs: jobs.map((j) => ({ id: j.id, kind: j.kind, status: j.status, starts: j.attempts, startedAt: j.started_at, finishedAt: j.finished_at, minutes: j.finished_at && j.started_at ? +((j.finished_at - j.started_at) / 60000).toFixed(2) : null, phases: j.phases, stepRetries: stepTries(j.id) })),
  totals, byModel, steps: stepRows,
  openai: [...openai.values()].map((o) => ({ ...o, usd: +o.usd.toFixed(5) })),
  gpu: [...gpu.values()].map((g) => ({ ...g, gpuMin: +(g.gpuMs / 60000).toFixed(2), queueMin: +(g.queueMs / 60000).toFixed(2) })),
  retries: [...retryRows.values()], flex429: { ...flex429, waitMin: +(flex429.waitMs / 60000).toFixed(2) },
  art, animation: { ...anim, batches },
  latency: latencyRows, gpuUse, gpuIdle: idleRows, gpuByGraph, modelSwitching: switching, places: placeRows, tokens, diskMB: disk,
};
fs.writeFileSync(path.join(outDir, 'cost.json'), JSON.stringify(out, null, 1));
const csv = (rows) => (rows.length ? [Object.keys(rows[0]).join(','), ...rows.map((r) => Object.values(r).map((v) => (typeof v === 'string' && /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? '')).join(','))].join('\n') + '\n' : '');
fs.writeFileSync(path.join(outDir, 'steps.csv'), csv(stepRows));
fs.writeFileSync(path.join(outDir, 'openai.csv'), csv(out.openai));
fs.writeFileSync(path.join(outDir, 'gpu.csv'), csv(out.gpu.map(({ gpuMs, queueMs, ...g }) => g)));
fs.writeFileSync(path.join(outDir, 'retries.csv'), csv(out.retries));
fs.writeFileSync(path.join(outDir, 'latency.csv'), csv(latencyRows));
fs.writeFileSync(path.join(outDir, 'places.csv'), csv(placeRows));
fs.writeFileSync(path.join(outDir, 'gpu-graphs.csv'), csv(gpuByGraph));
fs.writeFileSync(path.join(outDir, 'gpu-idle.csv'), csv(idleRows));
console.log(JSON.stringify({ totals, byModel, flex429: out.flex429, gpuUse, modelSwitching: switching, tokens }, null, 1));
