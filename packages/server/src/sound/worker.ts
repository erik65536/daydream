/**
 * The thread that makes generated takes game-ready (sound/ready.ts): decoding, resampling, the loop search, and the
 * Opus encoding take up to a few seconds for a long piece of music, which would stall a game server sharing the
 * process. Started on first use by `readyTake` (sound/make.ts).
 */
import { parentPort } from 'node:worker_threads';
import type { SoundKind, SoundShape } from '@daydream/shared';
import { decodeFlac } from './flac.ts';
import { makeReady, oggOpus } from './ready.ts';
import { frames } from './dsp.ts';

export interface TakeJob {
  id: number;
  flac: Uint8Array;
  spec: { kind: SoundKind; shape: SoundShape };
  bpm?: number;
  /** Opus bit rate for both channels. */
  kbps: number;
}

export type TakeResult = { id: number; ok: true; main: Uint8Array; intro?: Uint8Array } | { id: number; ok: false; problem: string };

parentPort!.on('message', (job: TakeJob) => {
  let out: TakeResult;
  try {
    const r = makeReady(decodeFlac(job.flac), job.spec, job.bpm);
    out = r.ok
      ? { id: job.id, ok: true, main: oggOpus(r.main, job.kbps), intro: r.intro && frames(r.intro) ? oggOpus(r.intro, job.kbps) : undefined }
      : { id: job.id, ok: false, problem: r.problem };
  } catch (e) {
    out = { id: job.id, ok: false, problem: `could not be read: ${(e as Error).message}` };
  }
  parentPort!.postMessage(out);
});
