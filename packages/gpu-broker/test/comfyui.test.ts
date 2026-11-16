import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ComfyAdapter } from '../src/adapters/comfyui.ts';
import { fakeComfy } from './fakecomfy.ts';

describe('ComfyUI adapter', () => {
  const comfy = fakeComfy();
  let adapter: ComfyAdapter;
  beforeAll(async () => {
    await new Promise<void>((r) => comfy.server.listen(0, '127.0.0.1', r));
    adapter = new ComfyAdapter({ url: `http://127.0.0.1:${(comfy.server.address() as AddressInfo).port}`, pollMs: 5, freeSettleMs: 5 });
  });
  afterAll(() => comfy.server.close());

  const frees = () => comfy.calls.filter((c) => c === 'POST /free').length;

  it('sends /free again until ComfyUI has given its memory back', async () => {
    comfy.gpu.used = 9 * 2 ** 30;
    comfy.gpu.lostFrees = 1;
    const before = frees();
    await adapter.unload();
    expect(comfy.gpu.used).toBe(0);
    // The lost one, the one that worked, and one that freed nothing more.
    expect(frees() - before).toBe(3);
  });

  it('stops after one repeat when the first /free worked', async () => {
    comfy.gpu.used = 9 * 2 ** 30;
    const before = frees();
    await adapter.unload();
    expect(comfy.gpu.used).toBe(0);
    expect(frees() - before).toBe(2);
  });
});
