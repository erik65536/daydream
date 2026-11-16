import { describe, expect, it } from 'vitest';
import { GpuQueue, type GpuModel } from '../src/worldgen/gpu.ts';

/** The order the queue runs tasks that are all waiting while a first task (for `loaded`) holds the GPU. */
async function order(loaded: GpuModel, waiting: [name: string, model: GpuModel, priority: number][]) {
  const gpu = new GpuQueue();
  const ran: string[] = [];
  let free!: () => void;
  const first = gpu.run(loaded, 0, () => new Promise<void>((r) => (free = r)));
  const rest = waiting.map(([name, model, priority]) => gpu.run(model, priority, async () => void ran.push(name)));
  free();
  await Promise.all([first, ...rest]);
  return ran;
}

describe('the build GPU queue', () => {
  it('paints the waiting places of a region together, then reads them together', async () => {
    const ran = await order('reader', [
      ['paint A', 'klein', 1.01],
      ['read A', 'reader', 1.01],
      ['paint B', 'klein', 1.02],
      ['read B', 'reader', 1.02],
      ['paint C', 'klein', 1.03],
    ]);
    expect(ran.slice(0, 2)).toEqual(['read A', 'read B']);
    expect(ran.slice(2)).toEqual(['paint A', 'paint B', 'paint C']);
  });

  it('runs the starting town before anything, whatever is loaded', async () => {
    const ran = await order('reader', [
      ['read A', 'reader', 1.01],
      ['paint town', 'klein', 0],
    ]);
    expect(ran).toEqual(['paint town', 'read A']);
  });

  it('runs a region before the next, and places before art', async () => {
    const ran = await order('klein', [
      ['art', 'klein', 10],
      ['paint region 2', 'klein', 2],
      ['read region 1', 'reader', 1.04],
    ]);
    expect(ran).toEqual(['read region 1', 'paint region 2', 'art']);
  });

  it('holds later work back until the places are done, even work queued before any place', async () => {
    const gpu = new GpuQueue();
    const ran: string[] = [];
    let placesDone!: () => void;
    gpu.holdFrom(10, new Promise<void>((r) => (placesDone = r)));
    const sound = gpu.run('sound-small', 30, async () => void ran.push('sound'));
    const voices = gpu.run('speech', 20, async () => void ran.push('voices'));
    await new Promise((r) => setTimeout(r, 10));
    expect(ran).toEqual([]);
    await gpu.run('klein', 1, async () => void ran.push('paint'));
    placesDone();
    await Promise.all([sound, voices]);
    expect(ran).toEqual(['paint', 'voices', 'sound']);
  });

  it('lets held work go when the places fail, so a stopped build cancels it', async () => {
    let stopped = false;
    const gpu = new GpuQueue(() => stopped);
    gpu.holdFrom(10, Promise.reject(new Error('a place failed')));
    stopped = true;
    await expect(gpu.run('sound-small', 30, async () => 'made')).rejects.toThrow('cancelled');
  });
});
