/**
 * The animation job: every actor's animation is painted through OpenAI's Batch API (half price, answered within a
 * day, usually minutes), so a run never waits on the model. Each run, quickly:
 *  1. reads the world's batches that finished: each answer is saved in its actor's directory; a request that failed
 *     (or a batch that ended without answering) is asked again, three attempts in all, after which the actor keeps
 *     its still image (`failed`);
 *  2. for each actor to animate, writes its brief (brief.ts) if it has none, and asks for what it can: its
 *     turnaround and the parts of its own view first, then the other views' parts (they start from the turnaround);
 *  3. sends everything asked for in batches, one per purpose (a batch holds one model; a few when there is a lot);
 *  4. assembles every actor whose parts are all in (assemble.ts) and saves it onto the world as it is on disk then;
 *  5. queues itself again, to look in a minute or two, while anything is still out.
 * An actor's parts: the turnaround and the clip sheets (the `image.animation` purpose, GPT Image 2.5), and with the
 * `image.walk` purpose its walk as one GIF per view (GPT Image 2.6). The GIFs replace the sheets' walk, so only the
 * sheets with attack and hit are painted then, keeping their walk row: the model draws each sheet at its own size,
 * and that row measures it for the frames beside it.
 * Actors to animate: in a world built with animation (`input.animate`), every actor without current sheets;
 * in any world, the ones asked for by name (`cli/animate.ts`). Steps are kept in the actor's directory
 * (data/worlds/<id>/anim/<key>/) with the painting they were made from (its content's hash: a repainted actor keeps
 * its file name), so a repainted actor starts again and nothing finished is asked for twice.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import type { AssetRecord, WorldDefinition } from '@daydream/shared';
import { ACTOR_CLIPS, clipKey } from '@daydream/shared';
import type { Job as WorldGenJob } from '../jobs/job.ts';
import { batchResults } from '../genai/images.ts';
import { genai } from '../genai/service.ts';
import { atStep, meterBatch } from '../genai/meter.ts';
import { loadWorld, saveWorld, worldAssetDir, worldDir } from '../storage.ts';
import { monsterSprite } from '../worldgen/art.ts';
import { enqueueAnimation } from '../jobs/queue.ts';
import { actorSprites, fights, needsAnimation, ownView, paintingHash } from './actors.ts';
import { assemble, cell, gifBackdrop, gifSheet, paleHaze, type Painted } from './assemble.ts';
import { writeBrief, type AnimBrief } from './brief.ts';
import { faceLeft, LEFT_VIEWS } from './facing.ts';
import { cellWidth, clipSheet, GIF_FRAMES, gridOf, sheetsFor, turnaround, VIEWS, walkGif, type ClipRow, type Sheet, type View } from './paint.ts';

/** Attempts per request (the first and two more). */
const MAX_ATTEMPTS = 3;
/** Requests per batch (each carries its picture; a batch file may hold 200 MB). */
const PER_BATCH = 100;
/** How soon a run looks again while batches are out. */
const POLL_MS = 90_000;

/** A part of an actor's animation asked for in a batch: its turnaround, a view's clip sheet, or a view's walk GIF. */
type Walk = `walk_${View}`;
type Part = 'turn' | View | Walk;
const walkOf = (view: View): Walk => `walk_${view}`;
const isWalk = (part: Part): part is Walk => part.startsWith('walk_');
/** The purposes animation is painted by: sheets, and walks. */
type AnimPurpose = 'image.animation' | 'image.walk';

interface ActorState {
  /** The painting this state is for, by its file and its content: a repainted actor starts again. */
  file: string;
  hash?: string;
  brief?: AnimBrief;
  /** Asked for by name: animated even in a world built without animation. */
  requested?: boolean;
  /** How each part was placed when asked for: input pixels per figure pixel, and the input's width. */
  placed: Partial<Record<Part, { k: number; inWidth: number }>>;
  /** Parts out in a batch (by batch id). */
  pending: Partial<Record<Part, string>>;
  attempts: Partial<Record<Part, number>>;
  /** Gave up: why. */
  error?: string;
}

/** A batch out: what paints it, and the parts it carries (`<key>|<part>`). */
interface Batch { purpose: AnimPurpose; items: string[] }

const jobDir = (worldId: string, key: string) => path.join(worldDir(worldId), 'anim', key);
const stateFile = (worldId: string, key: string) => path.join(jobDir(worldId, key), 'state.json');
const partFile = (worldId: string, key: string, part: Part) => path.join(jobDir(worldId, key), `${part}.${isWalk(part) ? 'gif' : 'png'}`);
/** Whether walks are painted as GIFs. */
const gifWalks = () => genai().configured('image.walk');
const batchesFile = (worldId: string) => path.join(worldDir(worldId), 'anim', 'batches.json');

function readState(worldId: string, rec: AssetRecord): ActorState {
  const hash = paintingHash(worldId, rec);
  const fresh = (): ActorState => ({ file: rec.file ?? '', hash, placed: {}, pending: {}, attempts: {} });
  try {
    const s = JSON.parse(fs.readFileSync(stateFile(worldId, rec.key), 'utf8')) as ActorState;
    // (A painting that cannot be read just now is not a new one.)
    if (s.file === rec.file && (!hash || s.hash === hash)) return s;
    // A new painting: what was painted from the old one goes (a request out for it is ignored when it returns).
    for (const f of fs.readdirSync(jobDir(worldId, rec.key))) if (/\.(png|gif)$/.test(f)) fs.rmSync(path.join(jobDir(worldId, rec.key), f), { force: true });
    return { ...fresh(), requested: s.requested };
  } catch {
    return fresh();
  }
}
function writeState(worldId: string, key: string, s: ActorState) {
  fs.mkdirSync(jobDir(worldId, key), { recursive: true });
  fs.writeFileSync(stateFile(worldId, key), JSON.stringify(s, null, 1));
}
const has = (worldId: string, key: string, part: Part) => fs.existsSync(partFile(worldId, key, part));

/** The world's batches out, by id. */
function readBatches(worldId: string): Record<string, Batch> {
  try {
    return JSON.parse(fs.readFileSync(batchesFile(worldId), 'utf8')) as Record<string, Batch>;
  } catch {
    return {};
  }
}
function writeBatches(worldId: string, b: Record<string, Batch>) {
  fs.mkdirSync(path.dirname(batchesFile(worldId)), { recursive: true });
  fs.writeFileSync(batchesFile(worldId), JSON.stringify(b, null, 1));
}

/** Whether any of a world's animation is out at OpenAI. */
export const workOut = (worldId: string): boolean => Object.keys(readBatches(worldId)).length > 0;

/** Mark actors as asked for by name: animated (again) even in a world built without animation. */
export function markRequested(w: WorldDefinition, keys: string[]) {
  for (const key of keys) {
    const rec = w.assets[key];
    if (!rec?.file) continue;
    writeState(w.id, key, { ...readState(w.id, rec), requested: true, error: undefined, attempts: {} });
  }
}

/**
 * Mark actors as asked for with their clip sheets painted again (in the views `sheetsFor` names now), keeping their
 * turnarounds and walks: the sheets' files are removed, and the actor is assembled anew once they are back.
 */
export function repaintSheets(w: WorldDefinition, keys: string[]) {
  for (const key of keys) {
    const rec = w.assets[key];
    if (!rec?.file) continue;
    const s = readState(w.id, rec);
    for (const view of VIEWS) {
      fs.rmSync(partFile(w.id, key, view), { force: true });
      delete s.placed[view];
    }
    writeState(w.id, key, s);
  }
  markRequested(w, keys);
}

/** Actors still to animate, most wanted first: the heroes, the first place, then by place, bosses last. */
export function animationQueue(w: WorldDefinition): AssetRecord[] {
  if (!genai().configured('image.animation')) return [];
  const zoneOrder = new Map(w.zones.map((z, i) => [z.id, z.id === w.startZoneId ? -1 : i]));
  const where = new Map<string, number>();
  for (const n of w.npcs) where.set(`spr_npc_${n.id}`, zoneOrder.get(n.zoneId) ?? 99);
  for (const z of w.zones) for (const f of z.familyIds ?? []) for (const i of (w.families.find((x) => x.id === f)?.members ?? []).keys()) {
    const k = monsterSprite(f, i);
    where.set(k, Math.min(where.get(k) ?? 99, zoneOrder.get(z.id) ?? 99));
  }
  const rank = (k: string) => (k.startsWith('spr_hero_') ? -10 : k.startsWith('spr_boss_') ? 1000 : where.get(k) ?? 500);
  return actorSprites(w)
    .filter((a) => {
      const s = readState(w.id, a);
      if (s.requested) return true;
      return !!w.input.animate && needsAnimation(w, a) && !s.error;
    })
    .sort((a, b) => rank(a.key) - rank(b.key));
}

/** Queue the world's animation job when it has actors waiting (and none is queued). */
export function queueAnimation(w: WorldDefinition, owner: { id: string; name: string }, after?: number) {
  if (animationQueue(w).length || workOut(w.id)) enqueueAnimation(w.id, owner, after);
}

/**
 * Why an answer is not kept (asked again, like a failed request), or null when it is. A sheet painted on a backdrop:
 * far more pale haze than the figure it was painted from (the painting, or for the other views the turnaround), so a
 * pale ghost still passes. A walk GIF with other than the frames asked for, or with a backdrop at its edges.
 */
async function unfit(worldId: string, rec: AssetRecord, part: Part, image: Buffer): Promise<string | null> {
  if (isWalk(part)) {
    const frames = (await sharp(image, { animated: true }).metadata()).pages ?? 1;
    if (frames !== GIF_FRAMES) return `it painted ${frames} frames, not ${GIF_FRAMES}`;
    return (await gifBackdrop(image)) > 0.2 ? 'it painted a backdrop behind the figure' : null;
  }
  const from = part === 'turn' || part === ownView(rec) || !has(worldId, rec.key, 'turn') ? path.join(worldAssetDir(worldId), rec.file!) : partFile(worldId, rec.key, 'turn');
  const haze = await paleHaze(image);
  return haze > 0.05 && haze > 3 * (await paleHaze(fs.readFileSync(from))) ? 'it painted a pale backdrop behind the figure' : null;
}

/**
 * A part with its figures that should face the picture's left and face its right mirrored, and which cells those
 * were: the turnaround's SW, W, and NW views (not the painting's own), or the frames of a SW, W, or NW sheet that the
 * game draws (its move rows only measure it while the walks are GIFs).
 */
async function facedLeft(rec: AssetRecord, part: Part, image: Buffer): Promise<{ png: Buffer; mirrored: number[] }> {
  if (part === 'turn') return faceLeft(image, 3, 2, 'standing', LEFT_VIEWS.filter((v) => v !== ownView(rec)).map((v) => VIEWS.indexOf(v)));
  const rows = (LEFT_VIEWS as Part[]).includes(part) ? sheetsFor(fights(rec), gifWalks())[part as View] : undefined;
  if (!rows) return { png: image, mirrored: [] };
  const g = gridOf(rows.length);
  const cells = rows.length === 1 ? undefined : rows.flatMap((r, i) => (r === 'move' && gifWalks() ? [] : Array.from({ length: g.cols }, (_, c) => i * g.cols + c)));
  return faceLeft(image, g.cols, g.rows, 'acting', cells);
}

/** One view cut out of a turnaround (3 × 2), trimmed. */
async function viewOf(turn: Buffer, view: View): Promise<Buffer> {
  const c = await cell(turn, 3, 2, VIEWS.indexOf(view));
  return sharp(c.png).trim({ threshold: 1 }).png().toBuffer();
}

/** One run of the animation job (`queue: false`: not queued again, for a caller that runs it in a loop itself). */
export async function runAnimateJob(job: WorldGenJob, worldId: string, opts: { queue?: boolean } = {}): Promise<void> {
  const w0 = loadWorld(worldId);
  if (!w0) throw new Error('The world no longer exists.');
  // The Batch API of a purpose; a walk batch whose purpose was since turned off is read through the sheets' provider.
  const api = (p: AnimPurpose) => genai().imageBatch(p === 'image.walk' && gifWalks() ? 'image.walk' : 'image.animation');
  const batches = readBatches(worldId);
  const say = (m: string, kind: 'step' | 'info' | 'warn' = 'info') => job.push(m, kind);
  const what = (p: AnimPurpose, n: number) => `${n} ${p === 'image.walk' ? 'walk' : 'sheet'}${n === 1 ? '' : 's'}`;
  /** Placements made while building request bodies, by item (saved with the item once it is sent). */
  const placedOf = new Map<string, Partial<Record<Part, { k: number; inWidth: number }>>>();

  // 1. Batches that finished.
  for (const [id, { purpose, items }] of Object.entries(batches)) {
    const st = await api(purpose).status(id);
    if (st.state === 'running') continue;
    // (A batch that ended early is read for what it did answer: those answers are billed.)
    const { answers } = await atStep('anim.paint', () => batchResults(api(purpose), st));
    meterBatch({ id, event: 'back', requests: items.length, state: st.detail });
    for (const item of items) {
      const [key, part] = item.split('|') as [string, Part];
      const rec = w0.assets[key];
      if (!rec) continue;
      const s = readState(worldId, rec);
      if (s.pending[part] !== id) continue; // for an earlier painting
      delete s.pending[part];
      const a = answers.get(item);
      let why: string | null = a?.image ? null : a?.error ?? `the batch ${st.detail}`;
      // An answer that cannot be read is a failed one: left to throw, it would end the run with its batch still noted,
      // and every later run would read (and count) the batch again and end at the same answer.
      try {
        why ??= await unfit(worldId, rec, part, a!.image!);
        if (!why) {
          // Figures that should face the picture's left and face its right: a turnaround's views are mirrored before
          // anything is painted from them; a sheet is asked for again, and mirrored frame by frame on its last attempt
          // (the checker misses some of a sheet's wrong frames, and a mirrored frame holds its gear in the other hand).
          const faced = await atStep('anim.facing', () => facedLeft(rec, part, a!.image!));
          const last = part === 'turn' || (s.attempts[part] ?? 0) + 1 >= MAX_ATTEMPTS;
          if (faced.mirrored.length && !last) why = 'it painted a frame facing the wrong way';
          else {
            if (faced.mirrored.length) say(`Mirrored ${key}'s ${part === 'turn' ? `${faced.mirrored.map((i) => VIEWS[i]).join(' and ')} view${faced.mirrored.length > 1 ? 's' : ''}` : `${part} sheet's frames ${faced.mirrored.map((i) => i + 1).join(', ')}`}: painted facing the wrong way`);
            fs.writeFileSync(partFile(worldId, key, part), faced.png);
          }
        }
      } catch (e) {
        why = `its picture could not be used (${(e as Error).message.slice(0, 160)})`;
      }
      if (why) {
        s.attempts[part] = (s.attempts[part] ?? 0) + 1;
        if (s.attempts[part]! >= MAX_ATTEMPTS) (s.error = `${part}: ${why}`), (s.requested = false), say(`Could not animate ${key}: ${why}`, 'warn');
      }
      writeState(worldId, key, s);
    }
    delete batches[id];
    writeBatches(worldId, batches);
    say(`A batch came back (${st.detail}): ${what(purpose, items.length)}`, 'step');
  }

  // 2. What each actor can ask for now.
  const ask: { item: string; purpose: AnimPurpose; body: Promise<Record<string, unknown>> }[] = [];
  const done: AssetRecord[] = [];
  for (const rec of animationQueue(w0)) {
    if (job.cancelled) break;
    const s = readState(worldId, rec);
    if (s.error) continue;
    const painting = fs.readFileSync(path.join(worldAssetDir(worldId), rec.file!));
    const { width: pw, height: ph } = (await sharp(painting).metadata()) as { width: number; height: number };
    if (!s.brief) {
      const [desc, ...role] = String(rec.prompt ?? '').split(',');
      s.brief = await atStep('anim.brief', () => writeBrief(painting, desc!.trim(), role.join(',').trim(), w0.concept?.artStyle ?? ''));
      say(`Animation brief for ${rec.key}: ${s.brief.locomotion}`);
    }
    const brief = s.brief;
    const sheets = sheetsFor(fights(rec), gifWalks());
    const walks = gifWalks() ? VIEWS.map(walkOf) : [];
    const own = ownView(rec), cw = cellWidth(pw, ph);
    const turn = has(worldId, rec.key, 'turn') ? fs.readFileSync(partFile(worldId, rec.key, 'turn')) : null;
    const want = (part: Part) => !has(worldId, rec.key, part) && !s.pending[part] && (s.attempts[part] ?? 0) < MAX_ATTEMPTS;
    const request = (part: Part, purpose: AnimPurpose, sheet: Promise<Sheet>) =>
      ask.push({ item: `${rec.key}|${part}`, purpose, body: sheet.then((sh) => (placedOf.set(`${rec.key}|${part}`, { [part]: { k: sh.k, inWidth: sh.inWidth } }), api(purpose).body(sh.req))) });
    if (want('turn')) request('turn', 'image.animation', turnaround(painting, own, brief));
    // The painting's own view starts from the painting itself; the others from the turnaround.
    const figure = (view: View) => (view === own ? Promise.resolve(painting) : viewOf(turn!, view));
    for (const [view, rows] of Object.entries(sheets) as [View, ClipRow[]][])
      if (want(view) && (view === own || turn)) request(view, 'image.animation', figure(view).then((fig) => clipSheet(fig, cw, view, rows, brief)));
    for (const view of VIEWS)
      if (gifWalks() && want(walkOf(view)) && (view === own || turn)) request(walkOf(view), 'image.walk', figure(view).then((fig) => walkGif(fig, cw, view, brief)));
    writeState(worldId, rec.key, s);
    if (turn && [...Object.keys(sheets), ...walks].every((p) => has(worldId, rec.key, p as Part))) done.push(rec);
  }

  // 3. One batch per purpose for everything asked (a few when there is a lot).
  for (const purpose of ['image.animation', 'image.walk'] as const) {
    const mine = ask.filter((a) => a.purpose === purpose);
    for (let i = 0; i < mine.length && !job.cancelled; i += PER_BATCH) {
      const chunk = mine.slice(i, i + PER_BATCH);
      const bodies = await atStep('anim.prepare', () => Promise.all(chunk.map((a) => a.body)));
      const id = await atStep('anim.paint', () => api(purpose).submit(chunk.map((a, j) => ({ id: a.item, body: bodies[j]! }))));
      batches[id] = { purpose, items: chunk.map((a) => a.item) };
      writeBatches(worldId, batches);
      for (const a of chunk) {
        const [key, part] = a.item.split('|') as [string, Part];
        const s = readState(worldId, w0.assets[key]!);
        s.pending[part] = id;
        // How it was placed, recorded while its body was built.
        writeState(worldId, key, { ...s, placed: { ...s.placed, ...placedOf.get(a.item) } });
      }
      say(`Sent ${what(purpose, chunk.length)} to be painted (batch ${id})`, 'step');
    }
  }

  // 4. Actors whose parts are all in.
  for (const rec of done) {
    if (job.cancelled) break;
    try {
      await atStep('anim.assemble', () => finish(worldId, rec));
      say(`Animated ${rec.key}`, 'step');
    } catch (e) {
      const s = readState(worldId, rec);
      writeState(worldId, rec.key, { ...s, error: (e as Error).message.slice(0, 500), requested: false });
      say(`Could not assemble ${rec.key}: ${(e as Error).message.slice(0, 300)}`, 'warn');
    }
  }

  // 5. Look again while anything is out.
  const w = loadWorld(worldId);
  if (w && !job.cancelled && opts.queue !== false) queueAnimation(w, job.owner, workOut(worldId) ? Date.now() + POLL_MS : undefined);
}

/** Assemble an actor's clips from its painted parts and save them with its world. */
async function finish(worldId: string, rec: AssetRecord) {
  const s = readState(worldId, rec);
  if (!s.brief || !s.placed.turn) throw new Error('its brief or turnaround is missing');
  const painting = fs.readFileSync(path.join(worldAssetDir(worldId), rec.file!));
  const ph = (await sharp(painting).metadata()).height!;
  const turn = fs.readFileSync(partFile(worldId, rec.key, 'turn'));
  // Turnaround pixels per painting pixel: its own view's cell, the painting repainted, against the painting (the
  // model paints it larger than it was placed, up to a third), or where it was placed when that cell is far off.
  const own = ownView(rec);
  let turnScale = s.placed.turn.k * ((await sharp(turn).metadata()).width! / s.placed.turn.inWidth);
  const fit = Math.sqrt((await cell(turn, 3, 2, VIEWS.indexOf(own))).area / (await cell(painting, 1, 1, 0)).area);
  if (fit > turnScale / 2 && fit < turnScale * 2) turnScale = fit;
  const idle = await Promise.all(VIEWS.map(async (v) => (v === own ? { view: v, png: painting, perPainting: 1 } : { view: v, png: await viewOf(turn, v), perPainting: turnScale })));
  // Pixels of a part per painting pixel: how the figure was placed on its canvas, and how much the model scaled that.
  const perPainting = (view: View, part: Part, width: number) => {
    const p = s.placed[part];
    if (!p) throw new Error(`how the ${part} part was placed is not recorded`);
    return (view === own ? 1 : turnScale) * p.k * (width / p.inWidth);
  };
  const gifs = VIEWS.every((v) => has(worldId, rec.key, walkOf(v)));
  const painted: Painted[] = [];
  for (const [view, rows] of Object.entries(sheetsFor(fights(rec), gifs)) as [View, ClipRow[]][]) {
    const png = fs.readFileSync(partFile(worldId, rec.key, view));
    painted.push({ png, view, rows, perPainting: perPainting(view, view, (await sharp(png).metadata()).width!) });
  }
  // The walk GIFs come last: a later sheet's walk replaces an earlier one's in its view.
  if (gifs)
    for (const view of VIEWS) {
      const gif = fs.readFileSync(partFile(worldId, rec.key, walkOf(view)));
      const { png, frames } = await gifSheet(gif);
      painted.push({ png, view, rows: ['move'], frames, perPainting: perPainting(view, walkOf(view), (await sharp(gif).metadata()).width!) });
    }
  const from = paintingHash(worldId, rec);
  const r = await assemble(s.brief.locomotion, from, ph, idle, painted);
  // Onto the world as it is now (a build or a console tool may have saved it meanwhile), if the picture is still this one.
  const w = loadWorld(worldId);
  if (!w || w.assets[rec.key]?.file !== rec.file || paintingHash(worldId, w.assets[rec.key]!) !== from) return;
  saveAnimation(w, rec.key, r);
  saveWorld(w);
  writeState(worldId, rec.key, { ...s, requested: false });
}

/**
 * Save assembled sheets with a world's assets: each clip as `<key>@anim-<clip>` (a versioned file name, so browsers
 * may cache it forever), and the clip timing and layout on the sprite's own record. Clips not painted are removed.
 */
export function saveAnimation(w: WorldDefinition, key: string, r: Awaited<ReturnType<typeof assemble>>) {
  const dir = worldAssetDir(w.id);
  fs.mkdirSync(dir, { recursive: true });
  const stamp = Date.now().toString(36);
  for (const clip of ACTOR_CLIPS) {
    const k = clipKey(key, clip);
    const old = w.assets[k]?.file;
    if (old) fs.rmSync(path.join(dir, old), { force: true });
    const sheet = r.sheets[clip];
    if (!sheet) {
      delete w.assets[k];
      continue;
    }
    const file = `${k.replace('@', '_')}_${stamp}.webp`;
    fs.writeFileSync(path.join(dir, file), sheet.webp);
    w.assets[k] = { key: k, kind: 'sheet', file, prompt: `${clip} of ${key}`, status: 'ok', ref: key, width: sheet.width, height: sheet.height };
  }
  if (w.assets[key]) w.assets[key]!.anim = r.anim;
}

/** Remove every actor's animation from a world (its sheets and records, and its painting steps). Returns how many. */
export function clearAnimations(w: WorldDefinition): number {
  const dir = worldAssetDir(w.id);
  let n = 0;
  for (const rec of Object.values(w.assets)) {
    if (rec.kind === 'sheet' && rec.ref) {
      if (rec.file) fs.rmSync(path.join(dir, rec.file), { force: true });
      delete w.assets[rec.key];
    } else if (rec.anim) {
      delete rec.anim;
      n++;
    }
  }
  fs.rmSync(path.join(worldDir(w.id), 'anim'), { recursive: true, force: true });
  return n;
}

/** Why an actor has no sheets (for the world viewer and `cli/animate.ts`): animated, waiting (its batches out), failed with this error, or off. */
export function animationState(w: WorldDefinition, rec: AssetRecord): { state: 'animated' | 'waiting' | 'failed' | 'off'; error?: string } {
  if (!genai().configured('image.animation')) return { state: 'off' };
  const s = readState(w.id, rec);
  if (s.error) return { state: 'failed', error: s.error };
  if (!needsAnimation(w, rec) && !s.requested) return { state: 'animated' };
  return { state: s.requested || w.input.animate ? 'waiting' : 'off' };
}

/** Actors whose animation failed for their current picture, with the error. */
export function failedActors(w: WorldDefinition): { key: string; error?: string }[] {
  return actorSprites(w).flatMap((a) => {
    const s = readState(w.id, a);
    return s.error ? [{ key: a.key, error: s.error }] : [];
  });
}

/**
 * How far a world's animation has got: actors animated, still to do, and given up on (each keeps its painting).
 * Undefined for a world with no animation made or asked for.
 */
export function animationProgress(w: WorldDefinition): { done: number; waiting: number; failed: number } | undefined {
  const waiting = animationQueue(w).length, failed = failedActors(w).length;
  const done = actorSprites(w).filter((a) => !needsAnimation(w, a)).length;
  return done || waiting || failed ? { done, waiting, failed } : undefined;
}

/** Try a failed actor again: its failure and attempts are forgotten and the world's animation job queued. */
export function retryActor(w: WorldDefinition, key: string): boolean {
  const rec = w.assets[key];
  if (!rec || !readState(w.id, rec).error) return false;
  markRequested(w, [key]);
  queueAnimation(w, { id: w.ownerId, name: w.ownerName });
  return true;
}
