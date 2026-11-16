/**
 * Check the game's Pocket TTS runtime (speech/pocketModel.ts) against PyTorch, and measure it on this machine.
 * Usage: node src/cli/pocketcheck.ts [<models folder>] [--bench] [--model <name>]
 *
 * For every model the export (speech/pocket_export.py) wrote to the folder (default models/pocket), or the one named:
 * - the text: how each of the export's test texts is split into chunks and tokenized, against pocket-tts's own;
 * - the audio: the export's check line spoken from its clip with PyTorch's recorded noise by the float32 model,
 *   against PyTorch's audio over the first 5 frames (later frames drift apart from rounding alone, as two PyTorch
 *   builds would; the small model's one-step sampler magnifies it soonest). It fails above -60 dB.
 * With --bench, the int8 model as the game speaks with it, on one thread per line: the time to make a voice's state,
 * and the first audio and real-time factor of ten game lines, spoken one at a time and two at once. Pin it to the
 * cores the server would use (`taskset -c 0,1` on Linux). Nothing is written outside a temporary folder.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ROOT_DIR } from '../paths.ts';
import { PocketEngine, pocketModels } from '../speech/pocket.ts';
import { PocketModel } from '../speech/pocketModel.ts';
import { decodeWav } from '../sound/wav.ts';
import { mono } from '../sound/dsp.ts';
import { prepareTextPrompt, splitIntoBestSentences } from '../speech/pocketText.ts';

interface Check {
  line: string;
  noise: number[][];
  samples: number;
  texts: { text: string; chunks: { prompt: string; framesAfterEos: number; tokens: number[] }[] }[];
}

const args = process.argv.slice(2);
const given = args.find((a, i) => !a.startsWith('--') && args[i - 1] !== '--model');
const folder = given ? path.resolve(given) : pocketModels();
const named = args.includes('--model') ? args[args.indexOf('--model') + 1] : undefined;
const models = named ? [named] : fs.readdirSync(folder).filter((d) => fs.existsSync(path.join(folder, d, 'model.json')));
const FRAMES_COMPARED = 5;
let failed = false;

async function checkModel(dir: string) {
  const check = JSON.parse(fs.readFileSync(path.join(dir, 'check.json'), 'utf8')) as Check;
  const model = await PocketModel.load(dir, 1, 'lm.onnx');
  const s = model.settings;

  let textErrors = 0;
  for (const t of check.texts) {
    const chunks = splitIntoBestSentences(model.tokenizer, t.text, s.maxTokensPerChunk, s.text).map((c) => {
      const p = prepareTextPrompt(c, s.text);
      return { prompt: p.text, framesAfterEos: p.framesAfterEos, tokens: model.tokenizer.encode(p.text) };
    });
    if (JSON.stringify(chunks) !== JSON.stringify(t.chunks)) {
      textErrors++;
      console.log(`  text differs: ${JSON.stringify(t.text)}\n    pocket-tts: ${JSON.stringify(t.chunks)}\n    here:       ${JSON.stringify(chunks)}`);
    }
  }
  console.log(`  text: ${check.texts.length - textErrors} of ${check.texts.length} texts split and tokenized as pocket-tts does`);

  let draw = 0;
  const noise = (n: number) => {
    const z = Float32Array.from(check.noise[draw++]!);
    if (z.length !== n) throw new Error('the noise drawn differs from PyTorch\'s');
    return z;
  };
  const clip = mono(decodeWav(fs.readFileSync(path.join(dir, 'check.wav'))));
  const voice = await model.voice(clip, noise);
  const audio: Float32Array[] = [];
  for await (const a of model.speak(voice, check.line, () => audio.length >= FRAMES_COMPARED, noise)) audio.push(a);
  const ours = Float32Array.from(audio.flatMap((a) => [...a]));
  const bin = fs.readFileSync(path.join(dir, 'check.bin'));
  const ref = new Float32Array(bin.buffer, bin.byteOffset, bin.length / 4).subarray(0, ours.length);
  let err = 0;
  let energy = 0;
  ref.forEach((r, i) => {
    err += (r - ours[i]!) ** 2;
    energy += r * r;
  });
  const gap = 10 * Math.log10(err / energy);
  console.log(`  audio: ${gap.toFixed(1)} dB from PyTorch over the first ${FRAMES_COMPARED} frames`);
  if (textErrors || !(gap < -60)) failed = true;
}

/** The game's engine on `lines` slots of one thread, speaking the lines `lines` at a time. */
async function benchEngine(lines: number, clip: string, texts: string[], cacheDir: string, model: string) {
  const engine = new PocketEngine({ models: folder, lines, threads: 1, model, smallModel: '' }, cacheDir);
  const say = (text: string, id: string) =>
    new Promise<{ first: number; total: number; audioMs: number }>((resolve, reject) => {
      const t0 = performance.now();
      let first = 0;
      let samples = 0;
      let rate = 24000;
      engine.speak({ lineId: id, voiceId: 'check', clip, text, deadline: Date.now() + 3_600_000, priority: 0 }, {
        started: (r) => (rate = r),
        audio: (pcm) => {
          first ||= performance.now() - t0;
          samples += pcm.length / 2;
        },
        end: (how, error) => (how === 'done' ? resolve({ first, total: performance.now() - t0, audioMs: (samples / rate) * 1000 }) : reject(new Error(error ?? how))),
      });
    });
  try {
    while (!engine.status().ready) await new Promise((r) => setTimeout(r, 100));
    await say('This line warms the engine up.', 'warm');
    const rows: { first: number; total: number; audioMs: number }[] = [];
    for (let i = 0; i < texts.length; i += lines) rows.push(...(await Promise.all(texts.slice(i, i + lines).map((t, j) => say(t, `l${i + j}`)))));
    const median = (xs: number[]) => xs.sort((a, b) => a - b)[xs.length >> 1]!;
    const rtfs = rows.map((r) => r.total / r.audioMs);
    console.log(`  ${lines === 1 ? 'one line' : `${lines} lines at once`}: first audio ${Math.round(median(rows.map((r) => r.first)))} ms (median), real-time factor ${median(rtfs).toFixed(3)} (median), ${Math.max(...rtfs).toFixed(3)} (worst)`);
  } finally {
    engine.stop();
  }
}

async function bench(name: string) {
  const dir = path.join(folder, name);
  const cast = JSON.parse(fs.readFileSync(path.join(ROOT_DIR, 'packages', 'server', 'speech', 'cast.json'), 'utf8')) as { shared: { text: string }[]; cast: { own: { text: string } }[] };
  const texts = [...cast.shared.map((l) => l.text), ...cast.cast.map((c) => c.own.text)];
  const clipFile = path.join(dir, 'check.wav');
  const model = await PocketModel.load(dir, 1);
  const clip = mono(decodeWav(fs.readFileSync(clipFile)));
  await model.voice(clip);
  const t = performance.now();
  await model.voice(clip);
  console.log(`  voice state: ${Math.round(performance.now() - t)} ms for ${(clip.length / model.sampleRate).toFixed(1)} s of clip`);
  const cacheDir = fs.mkdtempSync(path.join(os.tmpdir(), 'pocketcheck-'));
  try {
    await benchEngine(1, clipFile, texts, cacheDir, name);
    await benchEngine(2, clipFile, texts, cacheDir, name);
  } finally {
    fs.rmSync(cacheDir, { recursive: true, force: true });
  }
}

for (const name of models) {
  console.log(name);
  await checkModel(path.join(folder, name));
  if (args.includes('--bench')) await bench(name);
}
if (failed) {
  console.log('The runtime does not match PyTorch.');
  process.exitCode = 1;
}
