/**
 * Art for everything drawn over the paintings: characters, creatures, objects, and item icons. Luna writes each
 * prompt and picks its chroma-key backdrop; a painter paints it and cuts it out; the checker judges its content (right
 * subject, framing, pose). Attempts repeat in rounds (another key color when the colors clash) until one passes; the
 * best attempt is kept. Two painters (`painterOf`, by the purpose's provider):
 * - GPT Image (the default): on its own transparent background, a round's paintings together through the Batch API;
 * - Klein (ComfyUI, the backup): one picture at a time on the GPU, on the chroma-key backdrop, keyed out (cutout.ts).
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { hashOf } from '@daydream/shared';
import type { AssetRecord } from '@daydream/shared';
import { genai } from './service.ts';
import type { BatchStatus } from './providers.ts';
import type { Purpose } from './types.ts';
import { KEY_COLORS, KEY_NAMES, backdropSentence, cutout, cutoutProblems, finishCutout, type Cutout, type FinishedImage, type KeyColor } from './cutout.ts';

type AssetKind = Exclude<AssetRecord['kind'], 'painting' | 'texture' | 'sheet'>;
/** An image this pipeline makes (places are painted elsewhere). */
export type ImageRecord = AssetRecord & { kind: AssetKind };
/** How an actor is shown: from the front (people, upright figures) or from the side (animals and other body plans). */
export type View = 'front' | 'side';

/** How the image model wants its prompts (Klein: long, natural captions). */
const WRITER_NOTES = 'This model likes natural, flowing captions. Keep the subject description concrete and visual. Avoid mentioning anything that should not appear.';

// ------------------------------------------------------------------------------------ briefs and prompts

const KIND_PURPOSE: Record<AssetKind, Purpose> = { sprite: 'image.sprite', object: 'image.sprite', icon: 'image.icon' };

/** The base view of every actor: its still image, and the view its animation is painted from. */
const VIEW_FRAMING: Record<View, string> = {
  front:
    'one whole figure seen from straight in front, facing the viewer, in a neutral, relaxed pose with its limbs a little away from its body and anything carried held at its side; centered, all of it visible with a little empty space around it',
  side: 'one whole creature seen exactly from the side, in profile facing the left edge of the picture, in a neutral pose; centered, all of it visible with a little empty space around it',
};

/** Framing every brief carries (the prompt writer must respect it). */
function framing(rec: ImageRecord): string {
  switch (rec.kind) {
    case 'sprite':
      return rec.view
        ? `A game character model: ${VIEW_FRAMING[rec.view]}.`
        : `A game creature model. If its body runs lengthwise (four or more legs, a crab, an insect, a serpent or eel, a fish, a bird, a crawling body), show ${VIEW_FRAMING.side} (view: side). Otherwise (an upright figure on two legs, or a body with no front and back: a swarm, a cloud, an ooze, a floating shape), show ${VIEW_FRAMING.front} (view: front).`;
    case 'object':
      return 'A game prop seen from a high three-quarter angle (about 35 degrees from above, as the figures of a top-down game are drawn): one object shown whole and centered, as it rests on the ground, with empty space around it.';
    case 'icon':
      return 'A game inventory icon: one item centered and shown whole, slightly angled, filling most of a square frame, no hands.';
  }
}

/** Brief handed to the image.prompt LLM. */
export function assetBrief(rec: ImageRecord, style: string): string {
  return `${rec.kind.toUpperCase()}. ${framing(rec)} Subject: ${rec.prompt}. Art style: ${style}.`;
}

/** How the prompt writer picks the backdrop (one of the chroma keys) for each asset. */
const BACKDROP_GUIDE = `For each brief also choose the backdrop the image is painted on, so the subject can be cut out of it cleanly afterwards: green (chroma-key green), blue (chroma-key blue) or magenta (bright magenta). Choose the one whose hue the subject uses least, judged by its large areas and by its outline, highlights, rim light, glows, and anything translucent or wispy, since the backdrop tints soft edges. Small accents matter less than outlines. Skin, wood, leather, brass, and rust do not rule out magenta. See-through and glowing parts (glass, crystal, ice, smoke, a ghost, a jelly, a glow) are cut out by their color too, so the same rule holds for them: choose the key their own tint uses least (a pale-blue ghost or blue ice on green, green glass on magenta or blue, a pink jelly on green). Never mention the backdrop in the prompt itself.`;

/** System prompt for the LLM that turns briefs into image prompts. */
export function imagePromptSystem(): string {
  return `You are the art director of a game, writing prompts for an image model trained on long descriptive captions. For each brief, describe the finished image as an observer would, in one English paragraph of 100 to 180 words, present tense, third person.

Open with one sentence naming the medium, the art style, and the subject. Then describe the subject in order: for a figure, build, posture, face, hair, then each garment with its color and material, then anything held and in which hand; for an object, its shape, materials, colors, wear, and details. Use positional phrases (in the upper part of the frame, at the left hip, along the lower edge). Name colors with modifiers (deep navy, muted olive) and materials precisely (weathered oak, brushed iron).

Describe only the subject itself. Characters, creatures, props, and icons stand alone on nothing: write nothing about surroundings, ground, floor, base, backdrop, weather, sky, atmosphere, or effects drifting around the subject, and no cast shadow. Express the world's mood through the subject's own design, colors, materials, and wear, not through lighting effects. Give the lighting one short sentence: soft, even studio light with a gentle rim light, so the subject reads clearly with good contrast and mid-tones; in a dark or grim world use deep, rich colors rather than darkness.

Respect every framing requirement in the brief, and for creatures say which view you chose. No quality boosters (masterpiece, 8k), no instructions to the model, no quotation marks, and no text, letters, or signage in the image.

${BACKDROP_GUIDE}

${WRITER_NOTES}`;
}

/** What the prompt writer returns per brief. */
export const promptEntry = <K extends [string, ...string[]]>(keys: K) =>
  z.object({ key: z.enum(keys), prompt: z.string().min(40).max(2400), backdrop: z.enum(KEY_NAMES), view: z.enum(['front', 'side']) });

/** For an asset the prompt writer left out: a plain observer-style paragraph assembled from the brief. */
function describeFallback(rec: ImageRecord, style: string): string {
  const medium = rec.kind === 'icon' ? 'game icon illustration' : 'game asset illustration';
  return `The image is a ${style} ${medium} of ${rec.prompt}. ${framing({ ...rec, view: rec.view ?? 'front' })} The lighting is soft and even with a gentle rim light, giving the forms volume and clear contrast. The overall composition is clean and readable, with a cohesive palette and a clear silhouette.`;
}

/** The full image prompt of an asset painted on `key`. */
export function buildPrompt(rec: ImageRecord, style: string, key: KeyColor): string {
  return `${rec.imagePrompt ?? describeFallback(rec, style)} ${backdropSentence(key)}`;
}

/** Longest side of the kept image: actors keep detail for their animation; icons are shown small. */
const MAX_SIDE: Record<AssetKind, number> = { sprite: 768, object: 512, icon: 256 };

// ------------------------------------------------------------------------------------ content check

const CRITERIA: Record<AssetKind, string> = {
  sprite: 'exactly one full-body character or creature, fully visible (not cut off), clean silhouette, well lit, and readable, no text, no extra characters, no scenery.',
  object: 'exactly one object, fully visible, clean silhouette, well lit, and readable, no text, no scenery.',
  icon: 'exactly one clearly readable item centered, no text, no hands, no scenery.',
};

/** Quality levels, each with what it means for a game asset (checkers calibrate on the descriptions). */
const LEVELS = [
  'unusable: broken, garbled, the wrong subject, or unreadable at game size',
  'poor: clear defects such as artifacts, wrong framing, or missing parts',
  'mediocre: usable but with noticeable flaws',
  'acceptable: fits the game, only minor flaws',
  'good: clean, readable, well made game art that fits its description',
  'excellent: polished, professional game art',
];
const MATCH_LEVELS = [
  'unrelated: shows something else',
  'barely: a few elements of the description',
  'partly: the right kind of thing, but important details differ',
  'mostly: the subject is right, small details differ',
  'closely: the subject and its main details match',
  'exactly: everything described is there',
];

const POSE_QUESTION: Record<View, string> = {
  front: 'Is it seen from straight in front, facing the viewer (or does it have no front), in a neutral pose, with all of it visible?',
  side: 'Is it seen from the side, in profile, in a neutral pose, with all of it visible?',
};

export interface Review {
  score: number;
  problems: string[];
  /** Side views: which way the creature faces (the game wants left). */
  facing?: 'left' | 'right' | 'front';
}

/** The checker did not answer: the painting is unchecked, which is not a pass. */
export class Unchecked extends Error {}

/**
 * Score the painting 0-10 for content with the checker (Luna's decision model). It sees the painting itself, on its
 * plain key-color backdrop: the cut is judged by the known-backdrop score, not here. Null when no checker is
 * configured; when one is and its call fails, the painting is Unchecked.
 */
async function qualityCheck(painting: Buffer, rec: Pick<ImageRecord, 'kind' | 'prompt' | 'view'>, key: KeyColor): Promise<Review | null> {
  const g = genai();
  if (!g.configured('image.check')) return null;
  const view = await sharp(painting).removeAlpha().resize(512, 512, { fit: 'inside' }).png().toBuffer();
  const pose = rec.kind === 'sprite' ? POSE_QUESTION[rec.view ?? 'front'] : undefined;
  const state = `A generated game asset, painted on a plain ${key} studio backdrop (the backdrop is not part of it; separate pieces of one subject, such as coins in a heap or a swarm, are fine). It should depict: "${rec.prompt}". Requirements: ${CRITERIA[rec.kind]}`;
  try {
    const a = await g.decide('image.check', {
      state,
      images: [view],
      questions: {
        quality: { type: 'score', instructions: 'Judged as a game asset shown small on screen (not as a standalone artwork): how usable is it?', criteria: LEVELS },
        match: { type: 'score', instructions: 'How well does the image match the description?', criteria: MATCH_LEVELS },
        single: { type: 'noul', instructions: 'Does the image show a single subject: one character, creature, object, or item? A pile, set, swarm, or arrangement that forms one thing counts as one.' },
        whole: { type: 'noul', instructions: 'Is the whole subject visible, not cut off by the image edge?' },
        dark: { type: 'noul', instructions: 'Is the subject so dark or murky that its shape and details are hard to make out?' },
        text: { type: 'noul', instructions: 'Does the image contain any text, letters, watermark, or signature?' },
        ...(pose ? { pose: { type: 'noul' as const, instructions: pose } } : {}),
        ...(rec.view === 'side' ? { facing: { type: 'choice' as const, instructions: "Which side of the image does it face?", criteria: { left: 'the left edge of the image', right: 'the right edge of the image', front: 'it faces the viewer' } } } : {}),
      },
    });
    if (process.env.DAYDREAM_DEBUG_CHECK) console.log('[check]', JSON.stringify(Object.fromEntries(Object.entries(a).map(([k, v]) => [k, v.type === 'score' ? +v.score.toFixed(2) : v.type === 'noul' ? +v.noul.toFixed(2) : v.choice]))));
    const lvl = (k: string) => {
      const x = a[k];
      return x?.type === 'score' ? (x.score / (LEVELS.length - 1)) * 10 : 5;
    };
    const yes = (k: string) => {
      const x = a[k];
      return x?.type === 'noul' ? x.noul : 0.5;
    };
    const problems: string[] = [];
    let score = Math.min(lvl('quality'), lvl('match') + 1);
    const penalize = (cond: boolean, why: string, by = 3) => {
      if (!cond) return;
      score -= by;
      problems.push(why);
    };
    penalize(yes('single') < 0.5, 'more than one subject');
    penalize(yes('whole') < 0.5, 'subject cut off');
    penalize(yes('dark') > 0.55, 'too dark to read');
    penalize(yes('text') > 0.5, 'contains text');
    if (pose) penalize(yes('pose') < 0.5, rec.view === 'side' ? 'not seen from the side in a neutral pose' : 'not seen from the front in a neutral standing pose');
    if (lvl('match') < 4) problems.push('does not match the description');
    const f = a.facing;
    const facing = f?.type === 'choice' && (f.probabilities[f.choice] ?? 0) > 0.7 ? (f.choice as Review['facing']) : undefined;
    return { score: Math.max(0, Math.min(10, score)), problems, facing };
  } catch (e) {
    throw new Unchecked((e as Error).message);
  }
}

// ------------------------------------------------------------------------------------ painters

/** A painting asked for in a round: the asset, its key color (Klein's backdrop, the checker's for GPT Image) and attempt. */
interface Ask {
  rec: ImageRecord;
  key: KeyColor;
  attempt: number;
}

/** A painting cut out, before the content check. */
interface Candidate {
  img: FinishedImage;
  cut: Pick<Cutout, 'judgeable' | 'clash'>;
  key: KeyColor;
  /** The painting as the checker sees it: on its backdrop. */
  painting: Buffer;
  /** The key color clashed with the subject: the next attempt uses another. */
  clash: boolean;
  problems: string[];
}

/** What a round of painting runs with. */
interface Round {
  style: string;
  worldSeed: string;
  /** Where the batches submitted and not yet read are noted. */
  batches: string;
  /** Klein's paintings take their turn on the GPU through this. */
  gpu: <T>(work: () => Promise<T>) => Promise<T>;
  shouldStop?: () => boolean;
}

/** How an asset is painted and cut out. */
interface Painter {
  canvas(rec: ImageRecord): { width: number; height: number };
  prompt(rec: ImageRecord, style: string, key: KeyColor): string;
  /** A round's paintings by asset key (or why there is none); undefined when the round was stopped. */
  paint(asks: Ask[], round: Round): Promise<Map<string, Buffer | Error> | undefined>;
  cut(painting: Buffer, ask: Ask): Promise<Candidate>;
}

/** Klein, on the GPU: one picture at a time on the chroma-key backdrop Luna picked, keyed out (cutout.ts). */
const klein: Painter = {
  canvas: (rec) => (rec.kind === 'sprite' ? ((rec.view ?? 'front') === 'side' ? { width: 1216, height: 832 } : { width: 832, height: 1216 }) : { width: 1024, height: 1024 }),
  prompt: (rec, style, key) => buildPrompt(rec, style, key),
  async paint(asks, round) {
    const out = new Map<string, Buffer | Error>();
    for (const { rec, key, attempt } of asks) {
      if (round.shouldStop?.()) return undefined;
      const seed = hashOf(round.worldSeed, rec.key, attempt + (rec.roll ?? 0) * 1000) % 2147483647;
      const req = { prompt: klein.prompt(rec, round.style, key), seed, ...klein.canvas(rec) };
      out.set(rec.key, await round.gpu(() => genai().image(KIND_PURPOSE[rec.kind], req)).catch((e: Error) => e));
    }
    return out;
  },
  async cut(painting, { rec, key }) {
    const cut = await cutout(painting);
    const img = await finishCutout(cut, MAX_SIDE[rec.kind]);
    const problems = cutoutProblems(cut);
    return { img, key, painting, cut: { judgeable: cut.judgeable, clash: cut.clash }, clash: problems.length > 0, problems: [...problems, ...img.problems] };
  },
};

/** What ends a GPT Image prompt in place of the backdrop sentence. */
const ALONE = 'The subject stands alone on a fully transparent background: nothing behind or around it, no ground and no cast shadow.';
/** Seconds between looks at a running batch, and requests per batch. */
const BATCH_POLL_S = 20, PER_BATCH = 200;

/** A batch's answers by request id (the picture, or why there is none), and how the batch ended. */
interface BatchAnswers {
  answers: Map<string, { image?: Buffer; error?: string }>;
  detail: string;
}
/** The part of a purpose's Batch API (genai().imageBatch) that waiting for a batch needs. */
export interface BatchReader {
  status(id: string): Promise<BatchStatus>;
  results(st: BatchStatus): Promise<BatchAnswers['answers']>;
}
/**
 * What a batch that is no longer running answered. One that ended early (expired, cancelled) is read too when it has
 * answers: OpenAI bills those, so they are used and counted rather than asked for again.
 */
export async function batchResults(api: BatchReader, st: BatchStatus): Promise<BatchAnswers> {
  return { answers: st.state === 'done' || st.output ? await api.results(st) : new Map(), detail: st.detail };
}
/**
 * Wait for a batch and read its answers. Undefined when `stopped` says to stop waiting: the batch stays out, to be
 * read by whoever noted it.
 */
export async function batchAnswers(api: BatchReader, id: string, stopped?: () => boolean): Promise<BatchAnswers | undefined> {
  let st = await api.status(id);
  while (st.state === 'running') {
    if (stopped?.()) return undefined;
    await new Promise((r) => setTimeout(r, BATCH_POLL_S * 1000));
    st = await api.status(id);
  }
  return batchResults(api, st);
}
interface SavedBatch {
  id: string;
  purpose: Purpose;
  items: string[];
}

/**
 * GPT Image (docs/experiments/gpt-art): on its own transparent background, whose alpha is the cut (a pale frog on
 * green came out see-through from the key and whole from GPT's own alpha), at the least size it paints (655,360 px:
 * kept images are trimmed to MAX_SIDE, and larger or medium-quality paintings were no better at game size) and low
 * quality. A round's paintings go together, through the Batch API at half price unless the purpose says `batch: false`;
 * the checker sees each painting on the key color Luna picked, which it is calibrated on.
 */
const gptImage: Painter = {
  canvas: (rec) => (rec.kind === 'sprite' ? ((rec.view ?? 'front') === 'side' ? { width: 976, height: 672 } : { width: 672, height: 976 }) : { width: 816, height: 816 }),
  prompt: (rec, style) => `${rec.imagePrompt ?? describeFallback(rec, style)} ${ALONE}`,
  async paint(asks, round) {
    const out = new Map<string, Buffer | Error>();
    const g = genai();
    const req = ({ rec, key }: Ask) => ({ prompt: gptImage.prompt(rec, round.style, key), seed: 0, quality: 'low' as const, transparent: true, ...gptImage.canvas(rec) });
    // A request's id names the asset, its attempt, and its prompt, so an answer is only ever used for what it was asked.
    const idOf = (a: Ask) => `${a.rec.key}|${a.attempt}_${a.rec.roll ?? 0}|${hashOf(req(a).prompt)}`;
    const waiting: SavedBatch[] = [];
    for (const purpose of new Set(asks.map((a) => KIND_PURPOSE[a.rec.kind]))) {
      const mine = asks.filter((a) => KIND_PURPOSE[a.rec.kind] === purpose);
      if (g.purpose(purpose).batch === false) {
        await Promise.all(mine.map(async (a) => out.set(a.rec.key, await g.image(purpose, req(a)).catch((e: Error) => e))));
        continue;
      }
      // A batch noted earlier (a stopped build) is waited for instead of asking again.
      const ids = new Set(mine.map(idOf));
      const known = savedBatches(round.batches).filter((b) => b.purpose === purpose && b.items.some((i) => ids.has(i)));
      const asked = new Set(known.flatMap((b) => b.items));
      const fresh = mine.filter((a) => !asked.has(idOf(a)));
      const api = g.imageBatch(purpose);
      for (let i = 0; i < fresh.length; i += PER_BATCH) {
        const chunk = fresh.slice(i, i + PER_BATCH);
        const id = await api.submit(chunk.map((a) => ({ id: idOf(a), body: api.paintBody(req(a)) })), '/v1/images/generations');
        const b = { id, purpose, items: chunk.map(idOf) };
        saveBatches(round.batches, [...savedBatches(round.batches), b]);
        known.push(b);
      }
      waiting.push(...known);
    }
    const keyOf = new Map(asks.map((a) => [idOf(a), a.rec.key]));
    for (const b of waiting) {
      const back = await batchAnswers(g.imageBatch(b.purpose), b.id, round.shouldStop);
      if (!back) return undefined;
      for (const item of b.items) {
        const key = keyOf.get(item);
        if (!key) continue;
        const a = back.answers.get(item);
        out.set(key, a?.image ?? new Error(a?.error ?? `the batch ${back.detail}`));
      }
      saveBatches(round.batches, savedBatches(round.batches).filter((x) => x.id !== b.id));
    }
    return out;
  },
  async cut(painting, { rec, key }) {
    const { data, info } = await sharp(painting).ensureAlpha().raw().toBuffer({ resolveWithObject: true });
    const img = await finishCutout({ data: Buffer.from(data), width: info.width, height: info.height, key, judgeable: true, clash: 0 }, MAX_SIDE[rec.kind]);
    const shown = await sharp(painting).flatten({ background: KEY_COLORS[key].hex }).png().toBuffer();
    return { img, key, painting: shown, cut: { judgeable: true, clash: 0 }, clash: false, problems: img.problems };
  },
};

/** The batches a world's art has submitted and not yet read (so a stopped build picks up their answers). */
const batchFile = (dir: string) => path.join(dir, '.gpt-batches.json');
const savedBatches = (dir: string): SavedBatch[] => (fs.existsSync(batchFile(dir)) ? JSON.parse(fs.readFileSync(batchFile(dir), 'utf8')) : []);
function saveBatches(dir: string, batches: SavedBatch[]) {
  if (!batches.length) return fs.rmSync(batchFile(dir), { force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(batchFile(dir), JSON.stringify(batches));
}

/** Who paints an asset: GPT Image when its purpose is on an OpenAI image model, otherwise Klein. */
const painterOf = (rec: Pick<ImageRecord, 'kind'>): Painter => (genai().providerType(KIND_PURPOSE[rec.kind]) === 'openai-image' ? gptImage : klein);
/** Canvas per asset, by its painter: actors in their view's orientation, props and icons square. */
export const canvasOf = (rec: ImageRecord) => painterOf(rec).canvas(rec);

// ------------------------------------------------------------------------------------ rounds

/** One attempt at an asset, as judged (for tools that show the work). */
export interface Attempt {
  painting: Buffer;
  png: Buffer;
  key: KeyColor;
  cut: Pick<Cutout, 'judgeable' | 'clash'>;
  score: number;
  problems: string[];
}

interface Production {
  style: string;
  /** Where the kept images are written. */
  outDir: string;
  /** Where GPT Image's batches are noted until read (default `outDir`; a folder that outlives a stopped build). */
  batches?: string;
  worldSeed: string;
  /** Each asset once it is finished: kept (ok), failed, or skipped (no painter configured). */
  onDone: (rec: ImageRecord) => void;
  onAttempt?: (rec: ImageRecord, attempt: Attempt) => void;
  shouldStop?: () => boolean;
  /** Klein's paintings run through this (a build's GPU queue). */
  gpu?: <T>(work: () => Promise<T>) => Promise<T>;
}

/**
 * Produce assets in rounds: every pending asset is painted (Klein's one at a time on the GPU, GPT Image's together in a
 * batch), cut out, and checked (the checks all at once); the rejects are painted again in the next round, up to the
 * purpose's `maxAttempts`, and the best attempt is kept. A painting the checker did not answer for is unchecked: it
 * is never kept, and its asset is painted again like a reject; assets left with nothing but unchecked paintings fail
 * the whole production (Unchecked), to be taken up again once the checker works, rather than accepting everything.
 */
export async function produceAssets(recs: ImageRecord[], o: Production): Promise<void> {
  const g = genai();
  const purposeOf = (r: ImageRecord) => KIND_PURPOSE[r.kind];
  const limit = (r: ImageRecord) => g.purpose(purposeOf(r)).maxAttempts ?? 3;
  const round: Round = { style: o.style, worldSeed: o.worldSeed, batches: o.batches ?? o.outDir, gpu: o.gpu ?? ((work) => work()), shouldStop: o.shouldStop };
  const active = recs.filter((r) => g.configured(purposeOf(r)));
  for (const r of recs) if (!g.configured(purposeOf(r))) o.onDone({ ...r, status: 'skipped' });
  const best = new Map<string, { c: Candidate; score: number; problems: string[] }>();
  const attempts = new Map<string, number>();
  const errors = new Map<string, string>();
  /** Assets whose last painting the checker did not answer for, and why; and those left with no checked painting at all. */
  const unchecked = new Map<string, string>(), blind = new Map<string, string>();
  /** Key colors each asset still has to try (the writer's pick first). */
  const keys = new Map(active.map((r) => [r.key, [r.backdrop ?? 'green', ...KEY_NAMES.filter((k) => k !== (r.backdrop ?? 'green'))] as KeyColor[]]));
  const finished = new Set<string>();
  const minScore = g.config.purposes['image.check']?.minScore ?? 6;
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  const finish = (rec: ImageRecord) => {
    if (finished.has(rec.key)) return;
    finished.add(rec.key);
    const b = best.get(rec.key);
    if (!b) return o.onDone({ ...rec, status: 'failed', error: errors.get(rec.key), attempts: attempts.get(rec.key) });
    // The best attempt is always kept. A weak one carries its problems in `error`, and the art job repairs it with a
    // rewritten prompt.
    fs.mkdirSync(o.outDir, { recursive: true });
    const file = fileFor(rec.key);
    fs.writeFileSync(path.join(o.outDir, file), b.c.img.png);
    o.onDone({ ...rec, status: 'ok', file, backdrop: b.c.key, score: b.score, attempts: attempts.get(rec.key), width: b.c.img.width, height: b.c.img.height, anchorY: b.c.img.anchorY, error: b.score < minScore || b.problems.length ? b.problems.join('; ') || undefined : undefined });
  };
  let pending = active;
  for (let n = 0; pending.length; n++) {
    // Paint: each painter its own asks, side by side.
    const asks = pending.map((rec) => ({ rec, key: keys.get(rec.key)![0]!, attempt: n }));
    const rounds = await Promise.all([klein, gptImage].map((p) => p.paint(asks.filter((a) => painterOf(a.rec) === p), round)));
    if (rounds.some((r) => !r)) return;
    const painted = new Map(rounds.flatMap((r) => [...r!]));
    // Cut out and check every painting (also when stopping: they are paid for).
    await Promise.all(asks.map(async (ask) => {
      const { rec } = ask;
      attempts.set(rec.key, (attempts.get(rec.key) ?? 0) + 1);
      const p = painted.get(rec.key);
      if (!p || p instanceof Error) return void (unchecked.delete(rec.key), errors.set(rec.key, p?.message ?? 'not painted'));
      const c = await painterOf(rec).cut(p, ask);
      // Colors that clash are not tried again (a clash is the subject's colors, not bad luck).
      if (c.clash && keys.get(rec.key)!.length > 1) keys.get(rec.key)!.shift();
      const review = await qualityCheck(c.painting, rec, c.key).catch((e: Error) => {
        if (!(e instanceof Unchecked)) throw e;
        unchecked.set(rec.key, e.message);
        return undefined;
      });
      if (review === undefined) return;
      unchecked.delete(rec.key);
      // The game draws side views facing left (mirrored to go right).
      if (review?.facing === 'right') c.img = { ...c.img, png: await sharp(c.img.png).flop().png().toBuffer() };
      const problems = [...c.problems, ...(review?.problems ?? []), ...c.img.notes];
      let score = review ? review.score : 7;
      if (c.problems.length) score = Math.min(score, 4);
      score -= c.img.notes.length;
      o.onAttempt?.(rec, { painting: c.painting, png: c.img.png, key: c.key, cut: c.cut, score, problems });
      const prev = best.get(rec.key);
      if (!prev || score > prev.score) best.set(rec.key, { c, score, problems });
      if (score >= minScore && !c.problems.length) finish(rec);
    }));
    // Out of attempts: keep the best try. An asset with none because the checker never answered is left unfinished.
    const out = pending.filter((rec) => !finished.has(rec.key) && (attempts.get(rec.key) ?? 0) >= limit(rec));
    for (const rec of out) {
      if (best.has(rec.key) || !unchecked.has(rec.key)) finish(rec);
      else blind.set(rec.key, unchecked.get(rec.key)!);
    }
    pending = pending.filter((r) => !finished.has(r.key) && !blind.has(r.key));
    if (!pending.length && blind.size) throw new Unchecked(`The art checker did not answer for ${blind.size} picture${blind.size === 1 ? '' : 's'} (last: ${[...blind.values()].at(-1)!.slice(0, 200)}). Resume once it is working.`);
    // Stopping: approved images are saved; the rest are painted again next time.
    if (o.shouldStop?.()) return;
  }
}
