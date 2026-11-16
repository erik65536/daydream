/**
 * One line slot of Pocket TTS (src/speech/pocket.ts): a worker thread holding the models, which makes voice states and
 * speaks one line at a time. ONNX Runtime computes on the calling thread, so the game server's own thread stays free.
 */
import fs from 'node:fs';
import path from 'node:path';
import { parentPort, workerData } from 'node:worker_threads';
import { PocketModel, type VoiceState } from './pocketModel.ts';
import { decodeWav } from '../sound/wav.ts';
import { mono } from '../sound/dsp.ts';

export interface WorkerSetup {
  /** Model name to its exported folder. */
  models: Record<string, string>;
  threads: number;
}

export type ToWorker =
  | { op: 'voice'; id: number; model: string; clip: string; file: string }
  | { op: 'speak'; lineId: string; model: string; text: string; voice: VoiceState }
  | { op: 'cancel'; lineId: string };

export type FromWorker =
  | { ev: 'ready' }
  | { ev: 'voice'; id: number; voice?: VoiceState; error?: string }
  | { ev: 'audio'; lineId: string; pcm: Uint8Array }
  | { ev: 'end'; lineId: string; how: 'done' | 'cancelled' | 'failed'; error?: string };

const port = parentPort!;
const setup = workerData as WorkerSetup;
const send = (m: FromWorker, transfer: ArrayBuffer[] = []) => port.postMessage(m, transfer);

const models = new Map<string, PocketModel>();
for (const [name, folder] of Object.entries(setup.models)) models.set(name, await PocketModel.load(folder, setup.threads));

/** A voice state in shared memory, read from its file or made from the clip (and then saved for every later start). */
async function voiceState(model: PocketModel, clip: string, file: string): Promise<VoiceState> {
  const shared = (floats: number) => new Float32Array(new SharedArrayBuffer(floats * 4));
  if (fs.existsSync(file)) {
    const bytes = fs.readFileSync(file);
    const data = shared(bytes.length / 4);
    data.set(new Float32Array(bytes.buffer, bytes.byteOffset, bytes.length / 4));
    return { frames: data.length / model.voiceFrameSize, data };
  }
  const wav = decodeWav(fs.readFileSync(clip));
  if (wav.rate !== model.sampleRate) throw new Error(`${clip}: a voice clip must be at ${model.sampleRate} Hz`);
  const voice = await model.voice(mono(wav), undefined, shared);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, voice.data);
  fs.renameSync(tmp, file);
  return voice;
}

let speaking: { lineId: string; stop: boolean } | null = null;

async function speak(m: Extract<ToWorker, { op: 'speak' }>) {
  const line = (speaking = { lineId: m.lineId, stop: false });
  try {
    for await (const audio of models.get(m.model)!.speak(m.voice, m.text, () => line.stop)) {
      const pcm = new Int16Array(audio.length);
      for (let i = 0; i < audio.length; i++) pcm[i] = Math.max(-1, Math.min(1, audio[i]!)) * 32767;
      send({ ev: 'audio', lineId: m.lineId, pcm: new Uint8Array(pcm.buffer) }, [pcm.buffer]);
    }
    send({ ev: 'end', lineId: m.lineId, how: line.stop ? 'cancelled' : 'done' });
  } catch (e) {
    send({ ev: 'end', lineId: m.lineId, how: 'failed', error: (e as Error).message });
  } finally {
    speaking = null;
  }
}

port.on('message', (m: ToWorker) => {
  if (m.op === 'cancel') {
    if (speaking?.lineId === m.lineId) speaking.stop = true;
  } else if (m.op === 'speak') void speak(m);
  else {
    voiceState(models.get(m.model)!, m.clip, m.file).then(
      (voice) => send({ ev: 'voice', id: m.id, voice }),
      (e: Error) => send({ ev: 'voice', id: m.id, error: e.message }),
    );
  }
});
send({ ev: 'ready' });
