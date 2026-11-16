/**
 * Pocket TTS (Kyutai: MIT code, CC-BY-4.0 weights) on ONNX Runtime, for the models speech/pocket_export.py exports. It
 * follows pocket-tts 4.0.1's own generation (TTSModel.generate_audio_stream and get_state_for_audio_prompt) step for
 * step; `src/cli/pocketcheck.ts` compares it with PyTorch's audio and measures it.
 *
 *     const model = await PocketModel.load(folder, threads);
 *     const voice = await model.voice(clip);             // a voice's state, from its 24 kHz clip
 *     for await (const audio of model.speak(voice, text)) ...   // 80 ms of float32 audio at a time
 *
 * ONNX Runtime runs a session on the thread that calls it, so a model speaks one line at a time on its thread
 * (src/speech/pocket.ts gives each line slot a worker thread).
 */
import fs from 'node:fs';
import path from 'node:path';
import ort from 'onnxruntime-node';
import { Tokenizer, prepareTextPrompt, splitIntoBestSentences, type TextOptions } from './pocketText.ts';

/** One streaming state of a graph: keys and values appended to (`kv`), or a buffer replaced on every call. */
type StateEntry =
  | { name: string; kind: 'kv'; heads: number; dim: number; context: number | null }
  | { name: string; kind: 'state'; shape: number[] };

/** model.json, written by the export. */
interface PocketSettings {
  model: string;
  exportId: string;
  sampleRate: number;
  frameSize: number;
  decoderStepsPerFrame: number;
  dim: number;
  latentDim: number;
  temperature: number;
  eosThreshold: number;
  minFramesBeforeEos: number;
  framesAfterEos: number | null;
  tokensPerSecond: number;
  paddingSeconds: number;
  maxTokensPerChunk: number;
  text: TextOptions;
  lm: StateEntry[];
  decoder: StateEntry[];
  tables: Record<string, { offset: number; shape: number[] }>;
}

/**
 * A voice's state: the language model's keys and values after hearing the clip, `frames` rows of every layer's keys
 * then values. Its data may be a SharedArrayBuffer's, shared by every worker thread.
 */
export interface VoiceState {
  frames: number;
  data: Float32Array;
}

/** Standard normal draws, `n` at a time: the sampler's noise. */
type Noise = (n: number) => Float32Array;

const randomNoise: Noise = (n) => {
  const out = new Float32Array(n);
  for (let i = 0; i < n; i += 2) {
    const r = Math.sqrt(-2 * Math.log(1 - Math.random()));
    const a = 2 * Math.PI * Math.random();
    out[i] = r * Math.cos(a);
    if (i + 1 < n) out[i + 1] = r * Math.sin(a);
  }
  return out;
};

/** The keys and values of one attention layer, as rows of heads × dim, grown in place. */
class KvRows {
  k = new Float32Array(0);
  v = new Float32Array(0);
  rows = 0;
  readonly heads: number;
  readonly dim: number;
  readonly window: number | null;

  constructor(heads: number, dim: number, window: number | null) {
    this.heads = heads;
    this.dim = dim;
    this.window = window;
  }

  get rowSize() {
    return this.heads * this.dim;
  }

  /** Room for `rows` in all. */
  reserve(rows: number) {
    const n = rows * this.rowSize;
    if (this.k.length >= n) return;
    const grow = (a: Float32Array) => {
      const b = new Float32Array(n);
      b.set(a.subarray(0, this.rows * this.rowSize));
      return b;
    };
    this.k = grow(this.k);
    this.v = grow(this.v);
  }

  feeds(name: string, feeds: Record<string, ort.Tensor>) {
    const n = this.rows * this.rowSize;
    const dims = [1, this.rows, this.heads, this.dim];
    feeds[`${name}_k`] = new ort.Tensor('float32', this.k.subarray(0, n), dims);
    feeds[`${name}_v`] = new ort.Tensor('float32', this.v.subarray(0, n), dims);
  }

  /** Append new rows; with a window, only the last `window` stay. */
  append(k: Float32Array, v: Float32Array) {
    const s = this.rowSize;
    const t = k.length / s;
    if (this.window && this.rows + t > this.window) {
      const keep = Math.max(0, this.window - t);
      this.k.copyWithin(0, (this.rows - keep) * s, this.rows * s);
      this.v.copyWithin(0, (this.rows - keep) * s, this.rows * s);
      this.rows = keep;
    }
    this.reserve(this.rows + t);
    this.k.set(k, this.rows * s);
    this.v.set(v, this.rows * s);
    this.rows += t;
  }
}

/** A graph's streaming state across calls. */
class GraphState {
  kv = new Map<string, KvRows>();
  buffers = new Map<string, Float32Array>();
  private layout: StateEntry[];

  constructor(layout: StateEntry[]) {
    this.layout = layout;
    for (const e of layout) {
      if (e.kind === 'kv') this.kv.set(e.name, new KvRows(e.heads, e.dim, e.context));
      else this.buffers.set(e.name, new Float32Array(e.shape.reduce((a, b) => a * b, 1)));
    }
  }

  feeds(feeds: Record<string, ort.Tensor>) {
    for (const e of this.layout) {
      if (e.kind === 'kv') this.kv.get(e.name)!.feeds(e.name, feeds);
      else feeds[e.name] = new ort.Tensor('float32', this.buffers.get(e.name)!, e.shape);
    }
    return feeds;
  }

  update(out: ort.InferenceSession.OnnxValueMapType) {
    for (const e of this.layout) {
      if (e.kind === 'kv') this.kv.get(e.name)!.append(out[`${e.name}_k_new`]!.data as Float32Array, out[`${e.name}_v_new`]!.data as Float32Array);
      else this.buffers.set(e.name, out[`${e.name}_new`]!.data as Float32Array);
    }
  }
}

const int64 = (n: number) => new ort.Tensor('int64', BigInt64Array.of(BigInt(n)), []);

/** rows [n, k] times Wᵀ, W [m, k]. */
function timesTransposed(x: Float32Array, n: number, w: Float32Array, m: number): Float32Array {
  const k = w.length / m;
  const out = new Float32Array(n * m);
  for (let r = 0; r < n; r++) {
    for (let j = 0; j < m; j++) {
      let s = 0;
      for (let i = 0; i < k; i++) s += x[r * k + i]! * w[j * k + i]!;
      out[r * m + j] = s;
    }
  }
  return out;
}

export class PocketModel {
  readonly tokenizer: Tokenizer;
  private tables: Record<string, Float32Array> = {};
  readonly settings: PocketSettings;
  private lm: ort.InferenceSession;
  private decoder: ort.InferenceSession;
  private encoder: ort.InferenceSession;

  private constructor(
    settings: PocketSettings,
    tablesFile: Buffer,
    vocabulary: string,
    lm: ort.InferenceSession,
    decoder: ort.InferenceSession,
    encoder: ort.InferenceSession,
  ) {
    this.settings = settings;
    this.lm = lm;
    this.decoder = decoder;
    this.encoder = encoder;
    const all = new Float32Array(tablesFile.buffer, tablesFile.byteOffset, tablesFile.byteLength / 4);
    for (const [name, t] of Object.entries(settings.tables)) this.tables[name] = all.subarray(t.offset, t.offset + t.shape.reduce((a, b) => a * b, 1));
    this.tokenizer = new Tokenizer(JSON.parse(vocabulary));
  }

  /** The model exported to `folder`, its sessions on `threads` threads; `lmFile` lm.onnx is the float32 original. */
  static async load(folder: string, threads = 1, lmFile = 'lm_int8.onnx'): Promise<PocketModel> {
    const settings = JSON.parse(fs.readFileSync(path.join(folder, 'model.json'), 'utf8')) as PocketSettings;
    const opts: ort.InferenceSession.SessionOptions = { intraOpNumThreads: threads, interOpNumThreads: 1, executionMode: 'sequential', graphOptimizationLevel: 'all' };
    const session = (name: string) => ort.InferenceSession.create(path.join(folder, name), opts);
    const [lm, decoder, encoder] = await Promise.all([session(lmFile), session('decoder.onnx'), session('encoder.onnx')]);
    return new PocketModel(settings, fs.readFileSync(path.join(folder, 'tables.bin')), fs.readFileSync(path.join(folder, 'tokenizer.json'), 'utf8'), lm, decoder, encoder);
  }

  get sampleRate() {
    return this.settings.sampleRate;
  }

  /** Floats in a voice state per frame. */
  get voiceFrameSize() {
    return this.settings.lm.reduce((s, e) => s + (e.kind === 'kv' ? 2 * e.heads * e.dim : 0), 0);
  }

  private async step(x: Float32Array, state: GraphState, offset: number, noise: Noise) {
    const { dim, latentDim, temperature } = this.settings;
    const z = noise(latentDim).map((v) => v * Math.sqrt(temperature));
    const out = await this.lm.run(state.feeds({ x: new ort.Tensor('float32', x, [1, x.length / dim, dim]), noise: new ort.Tensor('float32', z, [1, latentDim]), offset: int64(offset) }));
    state.update(out);
    return { latent: out.latent!.data as Float32Array, eos: (out.eos!.data as Float32Array)[0]! };
  }

  /**
   * The model's state after hearing a clip (mono, at the model's rate; the first 30 s), ended on a short pause: a
   * clip that stops on speech makes the model continue it. The state is written into `into` when given (a shared
   * buffer, say), which must hold `voiceFrameSize` floats per frame.
   */
  async voice(clip: Float32Array, noise: Noise = randomNoise, into?: (floats: number) => Float32Array): Promise<VoiceState> {
    const { frameSize, sampleRate, dim } = this.settings;
    const ended = endOnPause(clip.subarray(0, 30 * sampleRate), sampleRate);
    const audio = new Float32Array(Math.ceil(ended.length / frameSize) * frameSize);
    audio.set(ended);
    const latent = (await this.encoder.run({ audio: new ort.Tensor('float32', audio, [1, 1, audio.length]) })).latent!;
    const n = latent.dims[1]!;
    const before = this.tables.bosBeforeVoice;
    const x = new Float32Array(((before ? 1 : 0) + n) * dim);
    if (before) x.set(before);
    x.set(timesTransposed(latent.data as Float32Array, n, this.tables.speakerProj!, dim), before ? dim : 0);
    const state = new GraphState(this.settings.lm);
    await this.step(x, state, 0, noise);
    const frames = x.length / dim;
    const data = into ? into(frames * this.voiceFrameSize) : new Float32Array(frames * this.voiceFrameSize);
    let at = 0;
    for (const rows of state.kv.values()) {
      for (const a of [rows.k, rows.v]) {
        data.set(a.subarray(0, frames * rows.rowSize), at);
        at += frames * rows.rowSize;
      }
    }
    return { frames, data };
  }

  /** The line's audio, 80 ms at a time as it is made. `stopped` ends it early. */
  async *speak(voice: VoiceState, text: string, stopped: () => boolean = () => false, noise: Noise = randomNoise): AsyncGenerator<Float32Array> {
    const s = this.settings;
    for (const chunk of splitIntoBestSentences(this.tokenizer, text, s.maxTokensPerChunk, s.text)) {
      if (stopped()) return;
      const prompt = prepareTextPrompt(chunk, s.text);
      yield* this.speakChunk(voice, prompt.text, s.framesAfterEos ?? prompt.framesAfterEos + 2, stopped, noise);
    }
  }

  /** One chunk, from the voice's state afresh. */
  private async *speakChunk(voice: VoiceState, text: string, framesAfterEos: number, stopped: () => boolean, noise: Noise) {
    const s = this.settings;
    const tokens = this.tokenizer.encode(text);
    const maxFrames = Math.ceil((tokens.length / s.tokensPerSecond + s.paddingSeconds) * (s.sampleRate / s.frameSize));
    const lm = new GraphState(s.lm);
    let at = 0;
    for (const rows of lm.kv.values()) {
      const n = voice.frames * rows.rowSize;
      rows.reserve(voice.frames + tokens.length + maxFrames);
      rows.k.set(voice.data.subarray(at, at + n));
      rows.v.set(voice.data.subarray(at + n, at + 2 * n));
      rows.rows = voice.frames;
      at += 2 * n;
    }
    const x = new Float32Array(tokens.length * s.dim);
    tokens.forEach((t, i) => x.set(this.tables.embed!.subarray(t * s.dim, (t + 1) * s.dim), i * s.dim));
    let offset = voice.frames;
    await this.step(x, lm, offset, noise);
    offset += tokens.length;

    const decoder = new GraphState(s.decoder);
    let latent = this.tables.bos!;
    let eosAt: number | null = null;
    for (let step = 0; step < maxFrames && !stopped(); step++) {
      const out = await this.step(timesTransposed(latent, 1, this.tables.inputLinear!, s.dim), lm, offset++, noise);
      latent = out.latent;
      if (out.eos > s.eosThreshold && eosAt === null && step >= s.minFramesBeforeEos) eosAt = step;
      if (eosAt !== null && step >= eosAt + framesAfterEos) return;
      const decoded = await this.decoder.run(decoder.feeds({ latent: new ort.Tensor('float32', latent, [1, 1, s.latentDim]), offset: int64(step * s.decoderStepsPerFrame) }));
      decoder.update(decoded);
      const audio = decoded.audio!.data as Float32Array;
      if (step === 0) {
        // A fresh decoder puts a small step in its first samples, heard as a click: fade the first 5 ms in.
        const n = s.sampleRate / 200;
        for (let i = 0; i < n; i++) audio[i]! *= i / (n - 1);
      }
      yield audio;
    }
  }
}

/**
 * Ends a voice prompt on exactly `pauseSec` of silence: the trailing silence (20 ms frames more than `floorDb` below
 * the loudest) is cut and the end faded out (pocket-tts's data/audio_utils.py).
 */
function endOnPause(wav: Float32Array, sampleRate: number, pauseSec = 0.08, fadeSec = 0.02, floorDb = 35): Float32Array {
  const frame = Math.max(1, Math.floor(0.02 * sampleRate));
  const n = Math.floor(wav.length / frame);
  if (n === 0) return wav;
  const db = Array.from({ length: n }, (_, f) => {
    let sum = 0;
    for (let i = f * frame; i < (f + 1) * frame; i++) sum += wav[i]! * wav[i]!;
    return 20 * Math.log10(Math.sqrt(sum / frame) + 1e-12);
  });
  const loudest = Math.max(...db);
  let last = n - 1;
  while (!(db[last]! > loudest - floorDb)) last--;
  const end = (last + 1) * frame;
  const out = new Float32Array(end + Math.floor(pauseSec * sampleRate));
  out.set(wav.subarray(0, end));
  const fade = Math.min(Math.floor(fadeSec * sampleRate), end);
  for (let i = 0; i < fade; i++) out[end - fade + i]! *= 1 - i / (fade - 1);
  return out;
}

