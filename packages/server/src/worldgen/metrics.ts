/**
 * A world's build records: what each job on it took, kept in its folder as metrics/<job>.json, so they travel with
 * the world and outlive the job queue's logs. Each holds the job's tallies (genai/meter.ts: dollars, calls, tokens,
 * pictures, GPU and queue time, step time and tries, by step, by model purpose, and by model), its active time (what
 * it ran, restarts, and waits for a worker left out) and, for a build that finished, what the world holds. The review
 * before the world was created (worldgen/review.ts) is kept as metrics/review.json.
 *
 * From the finished builds' records come the rates the creation page's estimate uses (`measuredRates`), in place of
 * the defaults in shared/rules/estimate.ts once enough builds are recorded.
 */
import fs from 'node:fs';
import path from 'node:path';
import { BUILD_RATES, type BuildRates, type WorldDefinition } from '@daydream/shared';
import { closeTally, emptyTally, openTally, type JobTally, type Tally } from '../genai/meter.ts';
import { listWorlds, worldDir } from '../storage.ts';

/** What a built world holds, the things its cost and time grow with. */
interface BuiltCounts {
  towns: number;
  areas: number;
  tiles: number;
  people: number;
  heroes: number;
  creatures: number;
  bosses: number;
  items: number;
  sounds: number;
  voices: number;
}

export interface JobMetrics extends JobTally {
  job: string;
  kind: string;
  /** When it first started, and when its record was last written. */
  started: number;
  updated: number;
  /** Milliseconds it was running, across every start. */
  activeMs: number;
  status: 'running' | 'done' | 'failed' | 'cancelled' | 'paused';
  /** What the world held when a build finished. */
  counts?: BuiltCounts;
}

const dir = (worldId: string) => path.join(worldDir(worldId), 'metrics');
const fileOf = (worldId: string, jobId: string) => path.join(dir(worldId), `${jobId.replace(/[^\w-]/g, '_')}.json`);

function read(file: string): JobMetrics | undefined {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as JobMetrics;
  } catch {
    return undefined;
  }
}

/** Every record kept with a world, oldest first. */
export function worldMetrics(worldId: string): JobMetrics[] {
  if (!fs.existsSync(dir(worldId))) return [];
  return fs.readdirSync(dir(worldId)).filter((f) => f.endsWith('.json')).map((f) => read(path.join(dir(worldId), f))).filter((m): m is JobMetrics => !!m).sort((a, b) => a.started - b.started);
}

/** What a built world holds. */
function builtCounts(w: WorldDefinition): BuiltCounts {
  const assets = Object.values(w.assets);
  return {
    towns: w.zones.filter((z) => z.kind === 'town').length,
    areas: w.zones.filter((z) => z.kind !== 'town').length,
    tiles: w.zones.reduce((n, z) => n + z.tiles[0] * z.tiles[1], 0),
    people: w.npcs.length,
    heroes: w.origins.length * (w.ruleset?.kins.length ?? 0),
    creatures: w.families.reduce((n, f) => n + f.members.length, 0),
    bosses: w.bosses.filter((b) => !b.member).length,
    items: assets.filter((a) => a.kind === 'icon' || a.kind === 'object').length,
    sounds: Object.keys(w.sounds ?? {}).length,
    voices: Object.keys(w.voices ?? {}).length,
  };
}

/** How often a running job's record is written, so a crash loses little. */
const SAVE_EVERY_MS = 15_000;

/**
 * Record a job's work from now until `close`: its tallies are opened (continuing its record when it resumes) and
 * written with the world every few seconds and at the end.
 */
export function recordJob(worldId: string, jobId: string, kind: string) {
  const file = fileOf(worldId, jobId);
  const before = read(file);
  const m: JobMetrics = before ?? { job: jobId, kind, started: Date.now(), updated: Date.now(), activeMs: 0, status: 'running', ...emptyTally() };
  m.status = 'running';
  openTally(worldId, jobId, m);
  let since = Date.now();
  const save = () => {
    if (!fs.existsSync(worldDir(worldId))) return; // deleted meanwhile
    const now = Date.now();
    m.activeMs += now - since;
    since = now;
    m.updated = now;
    fs.mkdirSync(dir(worldId), { recursive: true });
    fs.writeFileSync(file, JSON.stringify(m));
  };
  const timer = setInterval(save, SAVE_EVERY_MS);
  timer.unref();
  return {
    metrics: m,
    /** Stop recording, with how the job ended (and, for a finished build, what the world holds). */
    close(status: JobMetrics['status'], world?: WorldDefinition) {
      clearInterval(timer);
      m.status = status;
      if (world) m.counts = builtCounts(world);
      save();
      closeTally(worldId, jobId);
    },
  };
}

// ------------------------------------------------------------------------------------ rates from records

/** Finished builds needed before their rates replace the experiments' figures. */
const MEASURED_BUILDS = 3;

const sum = (ts: Tally[], k: keyof Tally) => ts.reduce((n, t) => n + (t[k] ?? 0), 0);
const stepsOf = (m: JobMetrics, test: (step: string) => boolean) => Object.entries(m.steps).filter(([s]) => test(s)).map(([, t]) => t);
const isText = (s: string) => s.startsWith('pipeline ');
const isPlace = (s: string) => s.startsWith('places') || s.startsWith('Painting') || s.startsWith('Settling');

/**
 * The estimate's rates from the records of finished builds, once there are MEASURED_BUILDS of them: each rate the
 * records can measure is the builds' totals over what they built (dollars of places over places, GPU minutes of
 * painting over tiles); the rest stay the defaults (BUILD_RATES). Null until then.
 */
export function measuredRates(worlds: WorldDefinition[] = listWorlds()): { rates: BuildRates; builds: number } | null {
  const records = worlds.map((w) => worldMetrics(w.id));
  const builds = records.flatMap((ms) => ms.filter((m) => m.kind === 'world' && m.status === 'done' && m.counts));
  if (builds.length < MEASURED_BUILDS) return null;
  const total = (f: (m: JobMetrics) => number) => builds.reduce((n, m) => n + f(m), 0);
  const c = (k: keyof BuiltCounts) => total((m) => m.counts![k]);
  const places = c('towns') + c('areas');
  const actors = (k: BuiltCounts) => k.people + k.heroes + k.creatures + k.bosses;
  // Animation: worlds built and then animated, each animation's jobs against the world's actors. Its time is from
  // the first run to the last, as the owner waits: the runs are short, and most of it is the batches out at OpenAI.
  const animated = records.flatMap((ms) => {
    const built = ms.find((m) => m.kind === 'world' && m.status === 'done' && m.counts);
    const anims = ms.filter((m) => m.kind === 'animate' && m.status === 'done');
    const wallMs = anims.length ? Math.max(...anims.map((m) => m.updated)) - Math.min(...anims.map((m) => m.started)) : 0;
    return built && anims.length ? [{ actors: actors(built.counts!), usd: anims.reduce((n, m) => n + (m.total.usd ?? 0), 0), ms: wallMs }] : [];
  });
  const r = structuredClone(BUILD_RATES);
  const text = (m: JobMetrics) => stepsOf(m, isText);
  const placeSteps = (m: JobMetrics) => stepsOf(m, isPlace);
  // Text: dollars a world (its towns' share is in it).
  r.textUsd = total((m) => sum(text(m), 'usd')) / builds.length;
  // Places: their GPU time (the ways out among it) over their tiles; their dollars (a town's door plan among them)
  // over places.
  r.gpu.tile = total((m) => sum(placeSteps(m), 'gpuMs')) / 60_000 / Math.max(1, c('tiles'));
  r.placeUsd = total((m) => sum(placeSteps(m), 'usd')) / Math.max(1, places);
  r.gpu.sound = total((m) => sum(stepsOf(m, (s) => s === 'sounds'), 'gpuMs')) / 60_000 / Math.max(1, c('sounds'));
  r.gpu.voices = total((m) => sum(stepsOf(m, (s) => s === 'voices'), 'gpuMs')) / 60_000 / builds.length;
  // Art: the pictures' dollars over the pictures (actors and items alike). Only the art's own pictures: GPT Image's
  // plans of the places are pictures too, counted with the places.
  const art = (m: JobMetrics) => stepsOf(m, (s) => s.startsWith('art'));
  const images = total((m) => sum(art(m), 'images'));
  const artUsd = total((m) => sum(art(m), 'usd'));
  if (images) r.artUsd = { actor: artUsd / images, item: artUsd / images };
  // Time: everything but the GPU's own minutes (the text steps, waits for the GPU and for reading) is the rest of the
  // measured build time.
  const gpuMinutes = total((m) => (m.total.gpuMs ?? 0) / 60_000);
  const activeMinutes = total((m) => m.activeMs / 60_000);
  r.textMinutes = Math.max(0, activeMinutes - gpuMinutes) / builds.length;
  if (animated.length) {
    const perActor = animated.reduce((n, a) => n + a.usd, 0) / Math.max(1, animated.reduce((n, a) => n + a.actors, 0));
    r.animationUsd = { fighter: perActor, townsperson: perActor };
    r.animationHours = animated.reduce((n, a) => n + a.ms, 0) / 3_600_000 / animated.length;
  }
  return { rates: r, builds: builds.length };
}
