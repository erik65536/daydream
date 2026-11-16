/**
 * What a build has done, in counts alone (BuildActivity), for the page that shows a world being dreamed: steps
 * written, places painted and paintings set aside, pictures made by kind and redrawn, fights simulated, voices and
 * sounds made, model calls and GPU time. Nothing of the world itself (no names, places, or quests), so nothing is
 * spoiled.
 *
 * The build tells it what happens where only the build knows (a place finished, a painting set aside, fights
 * simulated); what the job's records count anyway (words written, model calls, GPU time: genai/meter.ts) and what
 * the world holds (its pictures) are read when it is shown. It is shown with the job every few seconds.
 */
import type { BuildActivity, Made, WorldDefinition } from '@daydream/shared';
import { tallyOf } from '../genai/meter.ts';
import type { Job } from '../jobs/job.ts';
import { artKeys, artStep } from './art.ts';

/** About how many words a token of English is. */
const WORDS_PER_TOKEN = 0.75;
/** How often the counts are shown. */
const SHOW_EVERY_MS = 2_500;

const made = (done = 0, total?: number, frac?: number): Made => ({ done, ...(total !== undefined && { total }), ...(frac !== undefined && { frac }) });

/** What kind of picture an asset is, as the page counts them. */
const kindOf = (key: string): 'characters' | 'creatures' | 'items' => {
  const step = artStep(key);
  return step === 'art.characters' ? 'characters' : step === 'art.creatures' ? 'creatures' : 'items';
};

export class Activity {
  private world?: WorldDefinition;
  private pictures = { characters: 0, creatures: 0, items: 0 };
  private repairs = 0;
  private timer: ReturnType<typeof setInterval>;
  readonly a: BuildActivity = {
    writing: { ...made(), words: 0 },
    places: { ...made(), paintings: 0, setAside: 0, relaid: 0 },
    characters: made(),
    creatures: made(),
    items: made(),
    prompts: 0,
    redrawn: 0,
    balance: { ...made(0, undefined, 0), fights: 0 },
    voices: made(0, undefined, 0),
    sounds: made(0, undefined, 0),
    calls: 0,
    gpuMinutes: 0,
  };
  private job: Job;

  constructor(job: Job) {
    this.job = job;
    this.timer = setInterval(() => this.show(), SHOW_EVERY_MS);
    this.timer.unref();
  }

  /** The world once it is assembled: its places and the pictures it will have. */
  assembled(world: WorldDefinition) {
    this.world = world;
    this.a.places.total = world.zones.length;
    this.pictures = { characters: 0, creatures: 0, items: 0 };
    for (const k of artKeys(world)) this.pictures[kindOf(k)]++;
  }

  /** Read what the records and the world hold, and show it all with the job. */
  show() {
    const t = tallyOf(this.job.worldId, this.job.id);
    if (t) {
      const text = Object.entries(t.steps).filter(([s]) => s.startsWith('pipeline '));
      this.a.writing.words = Math.round(text.reduce((n, [, x]) => n + (x.output ?? 0) - (x.reasoning ?? 0), 0) * WORDS_PER_TOKEN);
      this.a.calls = t.total.calls ?? 0;
      this.a.gpuMinutes = Math.round((t.total.gpuMs ?? 0) / 6_000) / 10;
    }
    const w = this.world;
    if (w) {
      const done = { characters: 0, creatures: 0, items: 0 };
      let again = 0;
      for (const [key, asset] of Object.entries(w.assets)) {
        if (asset.kind !== 'sprite' && asset.kind !== 'icon' && asset.kind !== 'object') continue;
        if (asset.status === 'ok') done[kindOf(key)]++;
        again += Math.max(0, (asset.attempts ?? 1) - 1);
      }
      for (const k of ['characters', 'creatures', 'items'] as const) this.a[k] = made(done[k], this.pictures[k]);
      this.a.redrawn = again + this.repairs;
      this.a.voices.done = Object.keys(w.voices ?? {}).length;
      this.a.sounds.done = Object.keys(w.sounds ?? {}).length;
    }
    this.job.show(structuredClone(this.a));
  }

  /** The text steps written, of all. */
  written(done: number, total: number) {
    this.a.writing.done = done;
    this.a.writing.total = total;
  }

  /** A place painted, read, and furnished. */
  place() {
    this.a.places.done++;
  }

  /** A painting of a place tried, set aside, or its layout redrawn (worldgen/mapdraw.ts). */
  painting(what: 'tried' | 'setAside' | 'relaid') {
    if (what === 'tried') this.a.places.paintings++;
    else this.a.places[what]++;
  }

  /** Image prompts written so far. */
  promptsWritten(n: number) {
    this.a.prompts = Math.max(this.a.prompts, n);
  }

  /** Pictures painted again by the repair pass (a weak one, from a rewritten prompt). */
  repaired(n: number) {
    this.repairs += n;
  }

  balance(frac: number, fights: number) {
    this.a.balance.frac = frac;
    this.a.balance.fights = fights;
  }

  voices(frac: number) {
    this.a.voices.frac = frac;
  }

  sounds(frac: number) {
    this.a.sounds.frac = frac;
  }

  /** The build ended (or stopped): show where it got to, and stop showing. */
  stop() {
    clearInterval(this.timer);
    this.show();
  }
}
