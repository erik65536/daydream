/**
 * Making sounds from their orders (sound/make.ts) with a generator that returns a known take: what is kept, and that a
 * sound made again gets new takes, never the same ones twice.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { soundSpec } from '@daydream/shared';
import { makeSounds } from '../src/sound/make.ts';
import type { SoundOrder } from '../src/sound/prompts.ts';

const seeds: number[] = [];
vi.mock('../src/worldgen/comfy.ts', () => ({
  stableAudio: async (_model: string, _prompt: string, _seconds: number, seed: number) => {
    seeds.push(seed);
    return fs.readFileSync(path.join(__dirname, 'fixtures', 'tone-lpc.flac'));
  },
}));

describe('making sounds', () => {
  it('makes new takes of a sound made again, counted beside the sounds\' folder', async () => {
    const dir = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'sounds-')), 'sounds');
    const orders: SoundOrder[] = [{ key: 'tap', prompt: 'a tap', model: 'small', seconds: 1, spec: soundSpec('tap')! }];
    const making = { dir, seedBase: 'w_test', report: () => undefined, shouldStop: () => false };
    const first = await makeSounds(orders, { ...making, have: {} });
    expect(first.tap!.files).toEqual(['tap.0.opus']);
    expect(fs.existsSync(path.join(dir, 'tap.0.opus'))).toBe(true);
    // What is there is kept: nothing is generated.
    await makeSounds(orders, { ...making, have: first });
    expect(seeds.length).toBe(1);
    // Made anew, as `--again` does (the folder emptied, nothing kept): another take, with another seed.
    fs.rmSync(dir, { recursive: true });
    await makeSounds(orders, { ...making, have: {} });
    expect(seeds.length).toBe(2);
    expect(seeds[1]).not.toBe(seeds[0]);
    expect(JSON.parse(fs.readFileSync(`${dir}.takes.json`, 'utf8'))).toEqual({ tap: 2 });
    // Without a count (the game's own sounds, whose every run has a seed base of its own), takes start from the first.
    await makeSounds(orders, { ...making, have: {}, takesFile: null });
    expect(seeds[2]).toBe(seeds[0]);
  });
});
