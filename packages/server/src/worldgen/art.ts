/**
 * World art besides the painted places: every character (heroes, people, creatures, bosses) in one neutral base
 * view (front for people, side for animals: what its animation is painted from), the few objects the game draws
 * over the paintings (a chest, a sign, the waypoint), and item icons. Each image's brief comes from the world; Luna
 * writes the image prompts and picks their backdrops, and checks the results.
 */
import type { KinDef, Presentation, WorldDefinition } from '@daydream/shared';
import { atStep } from '../genai/meter.ts';
import { heroSprite } from '../game/characters.ts';
import { z } from 'zod';
import { assetBrief, imagePromptSystem, produceAssets, promptEntry, Unchecked, type ImageRecord as AssetRecord } from '../genai/images.ts';
import { genai } from '../genai/service.ts';
import fs from 'node:fs';
import path from 'node:path';
import { worldAssetDir, writeJsonAtomic } from '../storage.ts';
import { attempt, Halted, StepFailed } from './retry.ts';

/** Each kin is one gender: its heroes are drawn as it, and it must read at a glance from the front, at game size. */
const PRESENTATION_SUBJECT: Record<Presentation, string> = {
  feminine: 'a woman (clearly female if not human)',
  masculine: 'a man (clearly male if not human)',
  androgynous: 'an androgynous person, neither clearly male nor female',
};

const PRESENTATION_LOOK: Record<Presentation, string> = {
  feminine: 'Her face, build, and hair read as unmistakably feminine at a glance from the front (hair visible around the face or shoulders), and her outfit is cut for her, keeping its colors and pieces.',
  masculine: 'His face, build, and hair read as unmistakably masculine at a glance from the front, and his outfit is cut for him, keeping its colors and pieces.',
  androgynous: 'Their face, build, and hair are deliberately ambiguous, neither clearly male nor female, and their outfit keeps its colors and pieces.',
};

/**
 * The objects the game draws over every painting, one look per world: what each is for, so the prompt writer designs
 * it from the world (which it is given beside the briefs).
 */
const OBJECTS: Record<string, string> = {
  obj_chest: 'Something players open to find treasure',
  obj_loot: 'A bag of loot',
  obj_sign: 'A signpost with a blank face',
  obj_waypoint: 'A landmark players use to travel between places',
  obj_craft_station: 'Where players make and improve their gear',
  obj_storage: "Storage for players' belongings",
};

// ------------------------------------------------------------------------------------ plan

/** One asset the world uses: its brief, and whether the next art job paints it (missing, failed, or a new brief). */
interface PlannedAsset {
  rec: AssetRecord;
  stale: boolean;
}

/** Every asset the world uses. */
function collectAssets(w: WorldDefinition): PlannedAsset[] {
  const out: PlannedAsset[] = [];
  const add = (key: string, kind: AssetRecord['kind'], prompt: string, extra: Partial<AssetRecord> = {}) => {
    const prev = w.assets[key];
    const stale = !prev || prev.status !== 'ok' || prev.prompt !== prompt;
    // A written prompt is kept while its brief stands, with the backdrop and view chosen with it.
    const reuse = prev?.prompt === prompt && prev.imagePrompt && prev.backdrop ? { imagePrompt: prev.imagePrompt, backdrop: prev.backdrop, view: prev.view } : {};
    out.push({ rec: { key, kind, prompt, status: 'pending', ...reuse, ...extra }, stale });
  };
  // People are seen from the front; the prompt writer picks a creature's view by its body plan. A hero is painted
  // for every class and kin: the kin's body and gender in the class's outfit.
  const kin = (k: KinDef) => `${PRESENTATION_SUBJECT[k.presentation]} of the ${k.name} (${k.appearance})`;
  for (const o of w.origins) for (const k of w.ruleset?.kins ?? []) add(heroSprite(o.id, k.id), 'sprite', `The player's hero, ${kin(k)}, a ${o.name}: ${o.appearance}. ${PRESENTATION_LOOK[k.presentation]}`, { view: 'front' });
  for (const n of w.npcs) add(`spr_npc_${n.id}`, 'sprite', `${n.appearance}, ${n.title}`, { view: 'front' });
  for (const f of w.families) f.members.forEach((m, i) => add(monsterSprite(f.id, i), 'sprite', `${m.appearance || m.name}, ${m.name}, hostile creature`));
  // A named foe is drawn as the creature it is one of.
  for (const b of w.bosses) if (!b.member) add(`spr_boss_${b.id}`, 'sprite', `${b.appearance}, ${b.name}, imposing boss`);
  // Objects the places hold, and the spoils foes drop.
  const used = new Set([...w.zones.flatMap((z) => z.features.map((f) => `obj_${f.kind}`)), ...(w.families.length || w.bosses.length ? ['obj_loot'] : [])]);
  for (const [key, what] of Object.entries(OBJECTS)) if (used.has(key)) add(key, 'object', what);
  for (const b of w.ruleset.items) if (b.category !== 'quest' && b.category !== 'key') add(`icon_${b.id}`, 'icon', `${b.name}${b.description ? `, ${b.description}` : ''}`);
  return out;
}

/** The sprite of a family's member (by its place in the family). */
export const monsterSprite = (familyId: string, member: number) => `spr_mon_${familyId}_${member}`;

/** The assets an art job would paint (only = limit to these keys). */
export function planAssets(w: WorldDefinition, only?: Set<string>): AssetRecord[] {
  return collectAssets(w)
    .filter((x) => x.stale && (!only || only.has(x.rec.key)))
    .map((x) => x.rec);
}

/** The key of every asset the world uses, painted or not. */
export const artKeys = (w: WorldDefinition): string[] => collectAssets(w).map((x) => x.rec.key);

/** Point world entities at generated assets. */
export function linkAssets(w: WorldDefinition) {
  const ok = (k: string) => (w.assets[k]?.status === 'ok' ? k : undefined);
  for (const o of w.origins) {
    o.assets = Object.fromEntries((w.ruleset?.kins ?? []).map((k) => [k.id, ok(heroSprite(o.id, k.id))]).filter((x): x is [string, string] => !!x[1]));
  }
  for (const n of w.npcs) n.asset = ok(`spr_npc_${n.id}`);
  for (const f of w.families) f.members.forEach((m, i) => (m.asset = ok(monsterSprite(f.id, i))));
  for (const b of w.bosses) b.asset = ok(`spr_boss_${b.id}`);
}

// ------------------------------------------------------------------------------------ prompts

export const PromptBatch = z.object({ prompts: z.array(promptEntry(['key'])) });

interface PromptWriting {
  report: (msg: string) => void;
  shouldStop?: () => boolean;
  onCount?: (done: number, total: number) => void;
  /** What was wrong with earlier paintings, by asset key. */
  notes?: Map<string, string>;
  keep?: boolean;
}

/**
 * Turn short asset briefs into full descriptive prompts, each with its chroma-key backdrop and (for creatures) the
 * view, in batches written side by side. An owner's own image prompt is kept; the writer then only picks its
 * backdrop and view. Assets the writer leaves out fall back to a template. Each prompt is kept on the world's record of
 * its asset as soon as it is written, unless `keep` is false (a repair's prompts are tried, not kept: repairWeak).
 */
export async function writeImagePrompts(w: WorldDefinition, plan: AssetRecord[], { report, shouldStop, onCount, notes, keep = true }: PromptWriting): Promise<void> {
  if (!genai().configured('image.prompt')) return;
  const todo = plan.filter((r) => !r.imagePrompt || !r.backdrop);
  const system = imagePromptSystem();
  const BATCH = 6;
  let written = 0, finished = 0;
  const batches: AssetRecord[][] = [];
  for (let i = 0; i < todo.length; i += BATCH) batches.push(todo.slice(i, i + BATCH));
  // Batches run side by side (as many as the provider's concurrency allows); each is kept as soon as it is written.
  await Promise.all(batches.map(async (batch) => {
    if (shouldStop?.()) return;
    const briefs = batch
      .map((r) => `[${r.key}] ${assetBrief(r, w.concept.artStyle)}${r.imagePrompt ? `\nTHE PROMPT IS GIVEN (return it unchanged; choose only its backdrop and view): ${r.imagePrompt}` : ''}${notes?.get(r.key) ? `\nEARLIER ATTEMPTS WERE REJECTED: ${notes.get(r.key)}. Write the prompt so the image avoids this.` : ''}`)
      .join('\n\n');
    // Exactly one prompt per brief, keyed by the briefs' own keys (enforced by strict structured output).
    const schema = z.object({ prompts: z.array(promptEntry(batch.map((r) => r.key) as [string, ...string[]])).min(batch.length).max(batch.length) });
    try {
      const out = await attempt('Image prompts', () => genai().structured('image.prompt', {
        system,
        prompt: `World: ${w.concept.title}: ${w.concept.pitch}\nPalette: ${Object.values(w.concept.palette).join(', ')}.\nWrite one prompt per brief below. Return each with the key shown in brackets.\n\n${briefs}`,
        schema,
        name: 'image_prompts',
        maxTokens: 400 * batch.length + 200,
      }), { report, halt: () => (shouldStop?.() ? new Halted() : undefined) });
      for (const p of out.prompts) {
        const rec = batch.find((r) => r.key === p.key);
        if (!rec) continue;
        rec.imagePrompt ??= p.prompt.trim();
        rec.backdrop = p.backdrop;
        // People keep the front view their brief asks for.
        rec.view = rec.kind === 'sprite' ? (rec.view ?? p.view) : undefined;
        if (keep) w.assets[rec.key] = { ...(w.assets[rec.key] ?? rec), prompt: rec.prompt, imagePrompt: rec.imagePrompt, backdrop: rec.backdrop, view: rec.view };
        written++;
      }
    } catch (e) {
      // Stopped between tries: the batch is written next time.
      if (e instanceof Halted) return;
      throw e;
    } finally {
      onCount?.(Math.min(todo.length, ++finished * BATCH), todo.length);
    }
    report(`Wrote ${written}/${todo.length} image prompts`);
  }));
}

// ------------------------------------------------------------------------------------ production

interface ArtOptions {
  report: (msg: string) => void;
  /** Only these keys. */
  only?: Set<string>;
  /** After each image is kept (to save the world). */
  onAsset?: () => void;
  onCount?: (done: number, total: number) => void;
  /** Image prompts written of those to write, and pictures painted again by a repair pass. */
  onPrompts?: (done: number, total: number) => void;
  onRepair?: (n: number) => void;
  shouldStop?: () => boolean;
  /** Paintings on the GPU (Klein's) take their turn through this (a build's GPU queue). */
  gpu?: <T>(work: () => Promise<T>) => Promise<T>;
}

/** The step an asset's painting is counted to (genai/meter.ts): characters, creatures, objects, or icons. */
export const artStep = (key: string) => `art.${key.startsWith('spr_mon_') || key.startsWith('spr_boss_') ? 'creatures' : key.startsWith('spr_') ? 'characters' : key.startsWith('obj_') ? 'objects' : 'icons'}`;

/**
 * Paint what a world's art lacks (art.ts, the file comment). When the art checker does not answer, nothing is accepted
 * unchecked: the job stops as a failed step, and what was kept before stays.
 */
export async function generateArt(w: WorldDefinition, o: ArtOptions): Promise<void> {
  try {
    await paintArt(w, o);
  } catch (e) {
    if (e instanceof Unchecked) throw new StepFailed(e.message);
    throw e;
  }
}

async function paintArt(w: WorldDefinition, o: ArtOptions): Promise<void> {
  const plan = planAssets(w, o.only);
  // A repair that a stop interrupted is taken up again, though nothing else is left to paint.
  if (!plan.length && !repairNote(w)) return;
  await atStep('art.prompts', () => writeImagePrompts(w, plan, { report: o.report, shouldStop: o.shouldStop, onCount: o.onPrompts }));
  let done = 0;
  const kept = (res: AssetRecord) => {
    w.assets[res.key] = res;
    o.onCount?.(++done, plan.length);
    o.report(`${res.status === 'ok' ? 'Painted' : res.status === 'skipped' ? 'Skipped' : 'Failed'} ${res.key}${res.score !== undefined ? ` (score ${res.score.toFixed(1)}, ${res.attempts} tries)` : ''}${res.error ? ` (${res.error.slice(0, 120)})` : ''}`);
    linkAssets(w);
    o.onAsset?.();
  };
  // Each step (characters, creatures, objects, icons) is produced in rounds of its own, side by side, so each is
  // metered apart; GPT Image paints a step's round in one batch, Klein one picture per GPU turn.
  const steps = [...new Set(plan.map((r) => artStep(r.key)))];
  const production = { style: w.concept.artStyle, outDir: worldAssetDir(w.id), worldSeed: w.id, onDone: kept, shouldStop: o.shouldStop, gpu: o.gpu };
  await Promise.all(steps.map((step) => atStep(step, () => produceAssets(plan.filter((r) => artStep(r.key) === step), production))));
  if (o.shouldStop?.()) return;
  await atStep('art.repair', () => repairWeak(w, plan, o));
}

/** A repair pass under way: the assets under repair as planned, and the pass's rewritten records (repairWeak). */
interface RepairNote {
  pass: number;
  scope: AssetRecord[];
  recs: AssetRecord[];
}
const repairFile = (w: WorldDefinition) => path.join(worldAssetDir(w.id), '.repair.json');
function repairNote(w: WorldDefinition): RepairNote | undefined {
  if (!fs.existsSync(repairFile(w))) return undefined;
  const note = JSON.parse(fs.readFileSync(repairFile(w), 'utf8')) as RepairNote;
  // Assets the world no longer has (its rules were written anew meanwhile) are not repaired.
  const has = new Set(artKeys(w));
  return { ...note, scope: note.scope.filter((r) => has.has(r.key)), recs: note.recs.filter((r) => has.has(r.key)) };
}

/**
 * Images that never passed are painted again from a rewritten prompt: the prompt writer sees what was wrong (text
 * on a sign, the wrong pose, a backdrop color that clashed) and avoids it. A repair replaces the image only when it
 * scores better, so nothing gets worse; after the last pass the best attempt stays, with the prompt that painted it.
 * A pass's rewritten records are noted with the assets (`.repair.json`) until it is done, so a build stopped in the
 * middle takes the same pass up again and reads the batch it had sent rather than paying for another.
 */
async function repairWeak(w: WorldDefinition, plan: AssetRecord[], o: ArtOptions) {
  const minScore = genai().config.purposes['image.check']?.minScore ?? 6;
  const outDir = worldAssetDir(w.id);
  const tmp = path.join(outDir, '.repair');
  const fileFor = (key: string) => `${key.replace(/[^a-z0-9_.-]/gi, '_')}.png`;
  let note = repairNote(w);
  const scope = [...plan, ...(note?.scope ?? []).filter((r) => !plan.some((p) => p.key === r.key))];
  for (let pass = note?.pass ?? 1; pass <= 2; pass++) {
    if (o.shouldStop?.()) return;
    let recs = note?.recs ?? [];
    if (!note) {
      const weak = scope.filter((r) => {
        const a = w.assets[r.key];
        return !a || a.status === 'failed' || (a.status === 'ok' && ((a.score ?? 10) < minScore || !!a.error));
      });
      if (!weak.length) break;
      o.report(`Repairing ${weak.length} weak image${weak.length === 1 ? '' : 's'} (pass ${pass})`);
      o.onRepair?.(weak.length);
      const notes = new Map(weak.map((r) => [r.key, w.assets[r.key]?.error || 'it scored poorly with the art checker']));
      recs = weak.map((r) => ({ ...r, status: 'pending', roll: (r.roll ?? 0) + 100 * pass, imagePrompt: undefined, backdrop: undefined, view: r.key.startsWith('spr_hero_') || r.key.startsWith('spr_npc_') ? 'front' : undefined }));
      await writeImagePrompts(w, recs, { report: o.report, shouldStop: o.shouldStop, notes, keep: false });
      if (o.shouldStop?.()) return;
      writeJsonAtomic(repairFile(w), { pass, scope, recs } satisfies RepairNote);
    }
    note = undefined;
    const kept = new Map(recs.map((r) => [r.key, w.assets[r.key]]));
    fs.rmSync(tmp, { recursive: true, force: true });
    fs.mkdirSync(tmp, { recursive: true });
    await produceAssets(recs, { style: w.concept.artStyle, outDir: tmp, batches: outDir, worldSeed: w.id, shouldStop: o.shouldStop, gpu: o.gpu, onDone: (res) => {
      const old = kept.get(res.key);
      const improves = res.status === 'ok' && (!old || old.status !== 'ok' || (res.score ?? 0) > (old.score ?? 0));
      if (!improves) return;
      fs.copyFileSync(path.join(tmp, res.file!), path.join(outDir, fileFor(res.key)));
      w.assets[res.key] = { ...res, file: fileFor(res.key) };
      o.report(`Repaired ${res.key} (score ${(old?.score ?? 0).toFixed(1)} → ${(res.score ?? 0).toFixed(1)})`);
      linkAssets(w);
      o.onAsset?.();
    } });
    fs.rmSync(tmp, { recursive: true, force: true });
    // Stopped in the middle: the pass stays noted and is taken up again.
    if (o.shouldStop?.()) return;
    fs.rmSync(repairFile(w), { force: true });
  }
  fs.rmSync(repairFile(w), { force: true });
}
