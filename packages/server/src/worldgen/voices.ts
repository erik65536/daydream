/**
 * A world's voices (docs/voices.md, "Building a world's voices"): every person, boss, and the world's narrator gets a
 * voice designed from its description, and every line known at build time is spoken once and kept.
 *
 * 1. VoiceDesign turns each description into a ten-second reference clip (`assets/voices/<id>.wav`), the whole world
 *    in one batch; each clip is transcribed, and one that does not say its passage is designed again.
 * 2. The runner speaks every fixed line (greetings, barks, taunts, the story's narration, signs, and notes), sentence by
 *    sentence as the game will ask for them, into `assets/speech/<hash>.opus`.
 * 3. Each voice's loudness is measured on both engines (the GPU from its lines, the CPU from a passage spoken by
 *    Pocket TTS), and its gains bring it to the game's level; the files are written at that level.
 *
 * Steps 1 and 2 run on the GPU as one queued broker session, its time metered as GPU time; step 3 runs after it, on
 * this machine's CPU. What exists already is kept, so a stopped build resumes.
 */
import fs from 'node:fs';
import path from 'node:path';
import OpusModule from '@discordjs/opus';
import { writeOggOpus, type VoiceDef, type WorldDefinition } from '@daydream/shared';
import { genai } from '../genai/service.ts';
import { meterGpu } from '../genai/meter.ts';
import { resolveSecret } from '../genai/providers.ts';
import type { ProviderConfig } from '../genai/types.ts';
import { worldAssetDir } from '../storage.ts';
import { returnGreetings } from '../game/dialogue.ts';
import { NARRATOR } from '../game/voices.ts';
import { GpuEngine } from '../speech/gpu.ts';
import { PocketEngine, pocketModels } from '../speech/pocket.ts';
import type { SpeechEngine } from '../speech/engine.ts';
import { gainFor, loudness } from '../speech/loudness.ts';
import { fixedLineFile } from '../speech/speech.ts';
import { sayable, sentences, spokenText } from '../speech/text.ts';

const { OpusEncoder } = OpusModule as unknown as { OpusEncoder: new (rate: number, ch: number) => { encode(b: Buffer): Buffer; setBitrate(b: number): void } };

/** Spoken by every voice to measure its loudness (with its own lines, on the GPU). */
const CALIBRATION = 'Good morning to you. The road was long, but the fire is warm, and there is bread on the table for anyone who wants it. Sit down and tell me what you saw on the way.';
/** A clip whose transcript has fewer of its passage's words than this is designed again (up to twice). */
const CLIP_WORDS_RIGHT = 0.8;

interface Speaker {
  id: string;
  description: string;
}

/** Everyone who speaks in a world, with how they sound. */
export function speakersOf(w: WorldDefinition): Speaker[] {
  return [
    ...w.npcs.map((n) => ({ id: n.id, description: n.voice })),
    ...w.bosses.map((b) => ({ id: b.id, description: b.voice })),
    { id: NARRATOR, description: w.concept.narratorVoice },
  ].filter((s) => s.description?.trim());
}

/** Every line known at build time, by speaker: each sentence as the game cuts it (see speech/text.ts). */
export function fixedLines(w: WorldDefinition): { speakerId: string; text: string }[] {
  const out = new Map<string, { speakerId: string; text: string }>();
  const add = (speakerId: string, text: string | undefined) => {
    for (const s of sentences(text ?? '')) {
      const words = spokenText(s.text);
      if (sayable(words)) out.set(`${speakerId}\n${words}`, { speakerId, text: words });
    }
  };
  // Return greetings: each person's own, or the stock ones that hold no hero's name.
  const greetings = Object.values(returnGreetings('\u0000')).flat().filter((g) => !g.includes('\u0000'));
  for (const n of w.npcs) {
    add(n.id, n.greeting);
    for (const b of n.barks) add(n.id, b);
    for (const g of n.returning ? Object.values(n.returning) : greetings) add(n.id, g);
  }
  for (const b of w.bosses) add(b.id, b.taunt);
  add(NARRATOR, w.concept.intro);
  for (const a of w.arcs) add(NARRATOR, a.revelation);
  add(NARRATOR, w.ending);
  for (const z of w.zones) for (const f of z.features) if (f.kind === 'sign') add(NARRATOR, f.text);
  for (const l of w.lore) add(NARRATOR, l.text);
  return [...out.values()];
}

/** The GPU broker behind the `speech.gpu` purpose (the comfyui provider whose address and token it shares). */
function gpuSpeechProvider(): ProviderConfig | null {
  const g = genai();
  if (!g.configured('speech.gpu')) return null;
  const pc = g.providerConfig(g.purpose('speech.gpu').provider);
  return pc.type === 'comfyui' && pc.baseUrl ? pc : null;
}

interface VoiceBuild {
  report(msg: string, level?: 'warn'): void;
  shouldStop(): boolean;
  progress?(frac: number): void;
  /** What the broker shows for this work (the job and world). */
  tag?: Record<string, unknown>;
  /** Run the GPU session in its turn (the build's GPU queue; by default at once). */
  gpu?: <T>(fn: () => Promise<T>) => Promise<T>;
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** 16-bit mono PCM as a WAV file. */
function wav(pcm: Buffer, rate: number): Buffer {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0);
  h.writeUInt32LE(36 + pcm.length, 4);
  h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16);
  h.writeUInt16LE(1, 20);
  h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24);
  h.writeUInt32LE(rate * 2, 28);
  h.writeUInt16LE(2, 32);
  h.writeUInt16LE(16, 34);
  h.write('data', 36);
  h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

/** How much of a passage a transcript has: the share of its words found, in order. */
function wordsRight(expected: string, heard: string): number {
  const words = (s: string) => s.toLowerCase().replace(/[^a-z0-9' ]+/g, ' ').split(/\s+/).filter(Boolean);
  const want = words(expected), got = words(heard);
  let j = 0, hit = 0;
  for (const w of want) {
    const k = got.indexOf(w, j);
    if (k >= 0) {
      hit++;
      j = k + 1;
    }
  }
  return want.length ? hit / want.length : 1;
}

/** Speak a line on an engine and wait for all of it: its PCM and sample rate. */
function speakAll(engine: SpeechEngine, lineId: string, voiceId: string, clip: string, text: string): Promise<{ pcm: Buffer; rate: number }> {
  return new Promise((resolve, reject) => {
    const parts: Buffer[] = [];
    let rate = 0;
    engine.speak(
      { lineId, voiceId, clip, text, deadline: Date.now() + 3600_000, priority: 5 },
      {
        started: (r) => (rate = r),
        audio: (pcm) => parts.push(Buffer.from(pcm)),
        end: (how, error) => (how === 'done' ? resolve({ pcm: Buffer.concat(parts), rate }) : reject(new Error(`a line was ${how}${error ? `: ${error}` : ''}`))),
      },
    );
  });
}

function scaled(pcm: Buffer, gain: number): Buffer {
  const out = Buffer.alloc(pcm.length - (pcm.length % 2));
  for (let i = 0; i < out.length; i += 2) out.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(pcm.readInt16LE(i) * gain))), i);
  return out;
}

function oggOpus(pcm: Buffer, rate: number): Uint8Array {
  const enc = new OpusEncoder(rate, 1);
  enc.setBitrate(32_000);
  const frame = (rate / 50) * 2;
  const packets: Buffer[] = [];
  for (let at = 0; at < pcm.length; at += frame) {
    const piece = Buffer.alloc(frame);
    pcm.copy(piece, 0, at, Math.min(pcm.length, at + frame));
    packets.push(enc.encode(piece));
  }
  return writeOggOpus(packets, rate);
}

/** Wait for a speech engine's connection (the broker, Pocket TTS loading its models). */
async function connected(ok: () => boolean, what: string, ms: number, b: VoiceBuild) {
  for (const t0 = Date.now(); !ok(); await sleep(250)) {
    if (b.shouldStop()) throw new Error('stopped');
    if (Date.now() - t0 > ms) throw new Error(`${what} is not answering`);
  }
}

/**
 * Make (or finish) a world's voices; sets `world.voices`. Without GPU speech configured the world gets none (it
 * plays with text alone).
 */
export async function buildVoices(world: WorldDefinition, b: VoiceBuild): Promise<void> {
  const provider = gpuSpeechProvider();
  if (!provider) {
    b.report('Voices: no GPU speech is configured (purpose speech.gpu), so this world has none.', 'warn');
    world.voices = {};
    return;
  }
  const dir = worldAssetDir(world.id);
  const clipDir = path.join(dir, 'voices'), speechDir = path.join(dir, 'speech');
  fs.mkdirSync(clipDir, { recursive: true });
  fs.mkdirSync(speechDir, { recursive: true });
  const clipOf = (id: string) => path.join(clipDir, `${id}.wav`);
  const speakers = speakersOf(world);
  const lines = fixedLines(world);
  const voiceId = (id: string) => `${world.id}/${id}`;
  const v: Voicing = { world, b, provider, speakers, lines, clipOf, speechDir, voiceId };
  const { measure, gpuGain } = await (b.gpu ?? ((fn) => fn()))(() => voiceOnGpu(v));

  // 3. The CPU's loudness of each voice: the passage spoken by Pocket TTS on this machine.
  const cpuGain = new Map<string, number>();
  const cpuCfg = genai().configured('speech.cpu') ? genai().providerConfig(genai().purpose('speech.cpu').provider) : null;
  if (cpuCfg?.type === 'pocket-tts' && fs.existsSync(pocketModels(cpuCfg.models)) && measure.length) {
    const pocket = new PocketEngine({ models: cpuCfg.models, lines: 1, threads: cpuCfg.threads, model: cpuCfg.model, smallModel: '' });
    try {
      await connected(() => pocket.status().ready, 'Pocket TTS', 180_000, b);
      for (const [i, sp] of measure.entries()) {
        if (b.shouldStop()) throw new Error('stopped');
        const out = await speakAll(pocket, `p${i}`, voiceId(sp.id), clipOf(sp.id), CALIBRATION);
        cpuGain.set(sp.id, gainFor(loudness(out.pcm, out.rate)));
        b.progress?.(0.9 + (0.1 * (i + 1)) / measure.length);
      }
    } finally {
      pocket.stop();
    }
  } else if (measure.length) b.report('Voices: no Pocket TTS here (speech.cpu), so the CPU plays every voice at its own level', 'warn');

  const voices: Record<string, VoiceDef> = {};
  for (const sp of speakers) {
    if (!fs.existsSync(clipOf(sp.id))) continue;
    const before = world.voices?.[sp.id]?.gain;
    voices[sp.id] = { gain: { gpu: gpuGain.get(sp.id) ?? before?.gpu ?? 1, cpu: cpuGain.get(sp.id) ?? before?.cpu ?? 1 } };
  }
  world.voices = voices;
  const missing = speakers.length - Object.keys(voices).length;
  b.report(`Voices: ${Object.keys(voices).length} voices and ${lines.length} fixed lines${missing ? `; ${missing} voice${missing > 1 ? 's' : ''} could not be made` : ''}.`, missing ? 'warn' : undefined);
  b.progress?.(1);
}

/** What the voices' two parts share. */
interface Voicing {
  world: WorldDefinition;
  b: VoiceBuild;
  provider: ProviderConfig;
  speakers: Speaker[];
  lines: { speakerId: string; text: string }[];
  clipOf: (id: string) => string;
  speechDir: string;
  voiceId: (id: string) => string;
}

/**
 * Steps 1 and 2 in one broker session: the reference clips designed and every fixed line spoken, written at each
 * voice's GPU loudness. Returns the voices measured and their GPU gains. The session's time running is GPU time.
 */
async function voiceOnGpu({ world, b, provider, speakers, lines, clipOf, speechDir, voiceId }: Voicing): Promise<{ measure: Speaker[]; gpuGain: Map<string, number> }> {
  const base = provider.baseUrl!.replace(/\/+$/, '');
  const auth: Record<string, string> = resolveSecret(provider.apiKey) ? { authorization: `Bearer ${resolveSecret(provider.apiKey)}` } : {};
  const known = new Set(Object.keys(world.voices ?? {}));
  const gpu = new GpuEngine({ baseUrl: base, token: resolveSecret(provider.apiKey) });
  let session: string | null = null;
  const asked = Date.now();
  let began = 0, ok = false;
  try {
    await connected(() => gpu.isOpen(), 'GPU speech (the broker)', 60_000, b);
    // A turn with the GPU, queued with everything else.
    const res = await fetch(`${base}/broker/speech/sessions`, { method: 'POST', headers: { 'content-type': 'application/json', ...auth }, body: JSON.stringify({ rank: 2, tag: b.tag }) });
    if (!res.ok) throw new Error(`the broker refused a speech session: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
    const s = (await res.json()) as { id: string; key: string };
    session = s.id;
    for (let told = false; ; await sleep(500)) {
      if (b.shouldStop()) throw new Error('stopped');
      const st = (await (await fetch(`${base}/broker/speech/sessions/${s.id}`, { headers: auth })).json()) as { state: string; position: number; error?: string };
      if (st.state === 'running') {
        began = Date.now();
        break;
      }
      if (st.state !== 'queued') throw new Error(`the speech session ended before it began (${st.state}${st.error ? `: ${st.error}` : ''})`);
      if (!told) b.report(`Voices: waiting for the GPU (${st.position} in the queue)`);
      told = true;
    }
    await gpu.session(s.key);

    // 1. Reference clips, checked by ear (a transcript), designed again when they are garbled.
    const check = genai().configured('speech.input');
    for (let round = 0; round < 3; round++) {
      const todo = speakers.filter((sp) => !fs.existsSync(clipOf(sp.id)));
      if (!todo.length) break;
      b.report(`Voices: designing ${todo.length} voice${todo.length > 1 ? 's' : ''}${round ? ' again' : ''}`);
      const { sampleRate, clips, text } = await gpu.design(todo.map((sp) => ({ id: sp.id, description: sp.description })));
      let redo = 0;
      await Promise.all(todo.map(async (sp) => {
        const pcm = clips.get(sp.id);
        if (!pcm?.length) return void redo++;
        const file = wav(pcm, sampleRate);
        if (check && round < 2) {
          const heard = await genai().transcribe('speech.input', file, 'audio/wav', 'en').catch(() => text);
          if (wordsRight(text, heard) < CLIP_WORDS_RIGHT) return void redo++;
        }
        fs.writeFileSync(clipOf(sp.id), file);
      }));
      if (redo) b.report(`Voices: ${redo} clip${redo > 1 ? 's' : ''} did not say their passage clearly`);
      b.progress?.(0.15 * (round + 1));
    }

    // 2. Every fixed line and the calibration passage, all at once (the runner has many slots); written once each
    //    voice's loudness is known.
    const byVoice = new Map<string, { file: string; pcm: Buffer; rate: number }[]>();
    const level = new Map<string, Buffer[]>();
    const rateOf = new Map<string, number>();
    const todo = lines.filter((l) => !fs.existsSync(fixedLineFile(speechDir, l.speakerId, l.text)));
    const measure = speakers.filter((sp) => !known.has(sp.id) || todo.some((l) => l.speakerId === sp.id));
    b.report(`Voices: speaking ${todo.length} of ${lines.length} fixed lines, measuring ${measure.length} voices`);
    let done = 0;
    const failed: string[] = [];
    const jobs = [
      ...todo.map((l, i) => async () => {
        // A line the runner cannot say is left to be spoken live.
        const out = await speakAll(gpu, `f${i}`, voiceId(l.speakerId), clipOf(l.speakerId), l.text).catch((e: Error) => void failed.push(`"${l.text.slice(0, 60)}": ${e.message}`));
        if (!out) return;
        (byVoice.get(l.speakerId) ?? byVoice.set(l.speakerId, []).get(l.speakerId)!).push({ file: fixedLineFile(speechDir, l.speakerId, l.text), ...out });
        (level.get(l.speakerId) ?? level.set(l.speakerId, []).get(l.speakerId)!).push(out.pcm);
        rateOf.set(l.speakerId, out.rate);
      }),
      ...measure.map((sp, i) => async () => {
        const out = await speakAll(gpu, `c${i}`, voiceId(sp.id), clipOf(sp.id), CALIBRATION);
        (level.get(sp.id) ?? level.set(sp.id, []).get(sp.id)!).push(out.pcm);
        rateOf.set(sp.id, out.rate);
      }),
    ];
    // At most this many waiting on the runner at a time, so a stop is quick.
    let next = 0;
    await Promise.all(Array.from({ length: 24 }, async () => {
      while (next < jobs.length) {
        if (b.shouldStop()) throw new Error('stopped');
        await jobs[next++]!();
        b.progress?.(0.45 + (0.45 * ++done) / jobs.length);
      }
    }));
    if (failed.length) b.report(`Voices: ${failed.length} line${failed.length > 1 ? 's' : ''} could not be spoken and will be spoken live (first: ${failed[0]})`, 'warn');
    const gpuGain = new Map(measure.map((sp) => [sp.id, gainFor(loudness(Buffer.concat(level.get(sp.id) ?? []), rateOf.get(sp.id) ?? 48000))]));
    for (const [id, files] of byVoice) for (const f of files) fs.writeFileSync(f.file, oggOpus(scaled(f.pcm, gpuGain.get(id) ?? world.voices?.[id]?.gain.gpu ?? 1), f.rate));
    ok = true;
    return { measure, gpuGain };
  } finally {
    // The GPU is given back before the CPU's part.
    if (session) await fetch(`${base}/broker/speech/sessions/${session}`, { method: 'DELETE', headers: auth }).catch(() => undefined);
    gpu.stop();
    if (began) meterGpu({ workflow: 'speech', gpuMs: Date.now() - began, queueMs: began - asked, wallMs: Date.now() - asked, ok });
  }
}
