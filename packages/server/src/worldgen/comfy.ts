/**
 * ComfyUI calls for painting and reading places: FLUX 3 Image Klein (paint, edit with layout boxes) and Qwen-Image 2.1
 * (edit: a map redrawn as a walk plan, door marks, when GPT Image does not read the maps); and for a world's sounds,
 * Stable Audio 3. Everything goes over ComfyUI's HTTP API through the GPU broker (the configured comfyui provider's baseUrl, COMFY_URL overrides it), which gives every
 * installation's work its turn on the GPU and unloads one model before the next needs the memory.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { DATA_DIR, ROOT_DIR } from '../paths.ts';
import { ComfyError, savedAudio, savedImages, submitAndWait, uploadImage, viewImage } from '../genai/comfyclient.ts';

const KLEIN = 'flux3-image-klein-int8-convrot.safetensors';
/** Klein's distilled model: 16 steps (8 are visibly softer), no guidance. */
const KLEIN_STEPS = 16;
const QWEN = 'qwen_image_2.1_turbo_int8_convrot.safetensors';
/** Stable Audio 3: Small SFX for sound effects, Medium for music and the moments that are small pieces of music. */
const STABLE_AUDIO = { small: 'stable_audio_3_small_sfx.safetensors', medium: 'stable_audio_3_medium.safetensors' } as const;

const CACHE = path.join(DATA_DIR, 'cache');

export { comfyBase, ComfyError } from '../genai/comfyclient.ts';

type Workflow = Record<string, { class_type: string; inputs: Record<string, unknown> }>;

function workflow(name: string, vars: Record<string, string | number>): unknown {
  const fill = (node: unknown): unknown => {
    if (typeof node === 'string') {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1]! in vars) return vars[whole[1]!];
      return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(node)) return node.map(fill);
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, fill(v)]));
    return node;
  };
  return fill(JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'config', 'comfyui', name), 'utf8')) as Workflow);
}

const upload = (png: Buffer) => uploadImage(png);

/** Queue a workflow (the broker gives it its turn on the GPU) and return every image it saved (empty when it saved none). */
async function run(model: string, wf: unknown, timeoutMs = 900_000): Promise<Buffer[]> {
  const entry = await submitAndWait(wf, { workflow: model, timeoutMs });
  const out: Buffer[] = [];
  for (const img of savedImages(entry)) out.push(await viewImage(img));
  return out;
}

const one = (imgs: Buffer[], what: string) => {
  if (!imgs[0]) throw new ComfyError(`${what} returned no image`);
  return imgs[0];
};

/** FLUX 3 Image Klein, text to image (width and height multiples of 16). */
export async function kleinPaint(prompt: string, width: number, height: number, seed: number): Promise<Buffer> {
  return one(await run(KLEIN, workflow('klein_t2i.json', { prompt, width, height, seed, steps: KLEIN_STEPS, cfg: 1, checkpoint: KLEIN })), 'Klein');
}

/**
 * Klein editing a picture: `ref` is <ref_image_0> in the prompt, whose layout rows (`from`, `src_bbox`, `tgt_bbox`
 * on a 0–1000 grid, [top, left, bottom, right]) say what changes where. The output, at the reference's size, redraws
 * the whole picture slightly, so callers paste back only what they asked to change.
 */
export async function kleinEdit(ref: Buffer, prompt: string, seed: number): Promise<Buffer> {
  const meta = await sharp(ref).metadata();
  const width = Math.round(meta.width! / 16) * 16, height = Math.round(meta.height! / 16) * 16;
  const png = await sharp(ref).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  const out = one(await run(KLEIN, workflow('klein_edit.json', { ref: await upload(png), prompt, width, height, seed, steps: KLEIN_STEPS, checkpoint: KLEIN })), 'Klein edit');
  return sharp(out).resize(meta.width!, meta.height!, { fit: 'fill' }).png().toBuffer();
}

/**
 * Qwen-Image 2.1 Turbo, edit: the model sees `ref` and paints what `prompt` asks of it at the reference's size (a
 * multiple of 16). `more` are further references at the same size ("Picture 2", ...). Deterministic for a seed, so
 * cached like the reader's answers.
 *
 * Nothing passes `more` yet: the extra references are kept on purpose (from an experiment) so a later step can show
 * Qwen a second picture, such as a style or a character to match, without rebuilding the workflow.
 */
export async function qwenEdit(ref: Buffer, prompt: string, seed: number, more: Buffer[] = []): Promise<Buffer> {
  const meta = await sharp(ref).metadata();
  const width = Math.round(meta.width! / 16) * 16, height = Math.round(meta.height! / 16) * 16;
  const sized = (b: Buffer) => sharp(b).resize(width, height, { fit: 'fill' }).removeAlpha().png().toBuffer();
  const png = await sized(ref), extra = await Promise.all(more.map(sized));
  const c = cached('qwenedit', Buffer.concat([png, ...extra]), `${prompt}|${seed}`);
  const hit = c.get();
  if (hit) return hit[0]!;
  const wf = workflow('qwen21_edit.json', { ref_1: await upload(png), prompt, width, height, seed, checkpoint: QWEN }) as Workflow;
  for (const [i, b] of extra.entries()) {
    wf[`ref${i + 2}`] = { class_type: 'LoadImage', inputs: { image: await upload(b) } };
    wf['6']!.inputs[`images.image_${i + 2}`] = [`ref${i + 2}`, 0];
  }
  const out = await run(QWEN, wf).catch((e: Error) => {
    if (/DaydreamQwenEncode|version: '\d+' not in/.test(e.message)) throw new ComfyError(`ComfyUI's copy of Daydream's nodes is missing or out of date: install config/comfyui/daydream-nodes (docs/gpu-broker.md). ${e.message}`);
    throw e;
  });
  return c.put([one(out, 'Qwen edit')])[0]!;
}

/**
 * Stable Audio 3, text to sound (its released settings: 8 steps, cfg 1, an empty negative prompt), lowered 6 dB before
 * it is saved so loud takes keep their peaks: the take as FLAC, ComfyUI's audio format.
 */
export async function stableAudio(model: keyof typeof STABLE_AUDIO, prompt: string, seconds: number, seed: number): Promise<Buffer> {
  const entry = await submitAndWait(workflow('stable_audio_3.json', { checkpoint: STABLE_AUDIO[model], prompt, seconds, seed }), { workflow: STABLE_AUDIO[model], timeoutMs: 300_000 });
  const file = savedAudio(entry)[0];
  if (!file) throw new ComfyError('Stable Audio returned no sound');
  return viewImage(file);
}

/** A disk cache keyed by the image and the request (Qwen edits are deterministic). */
function cached(kind: string, png: Buffer, key: string) {
  const dir = path.join(CACHE, kind, crypto.createHash('sha1').update(png).update(`|${key}`).digest('hex'));
  return {
    get: (): Buffer[] | null => (fs.existsSync(path.join(dir, 'done')) ? fs.readdirSync(dir).filter((n) => n.endsWith('.png')).sort().map((n) => fs.readFileSync(path.join(dir, n))) : null),
    put: (imgs: Buffer[]) => {
      fs.mkdirSync(dir, { recursive: true });
      imgs.forEach((m, i) => fs.writeFileSync(path.join(dir, `${String(i).padStart(3, '0')}.png`), m));
      fs.writeFileSync(path.join(dir, 'done'), '');
      return imgs;
    },
  };
}
