/**
 * A world's sounds (docs/sound.md, "Building a world's sounds"): the build's sounds step writes what the world makes
 * every sound from (its plan), and each sound is made on the GPU, made game-ready, and kept in `assets/sounds/`. Without a ComfyUI provider (tests, an installation without the GPU) a world gets no sounds and
 * plays with the game's own.
 */
import fs from 'node:fs';
import path from 'node:path';
import type { SoundDef, SoundKey, WorldDefinition } from '@daydream/shared';
import { comfyProvider } from '../genai/comfyclient.ts';
import { worldAssetDir } from '../storage.ts';
import { worldOrders, type SoundModel, type SoundPlan } from '../sound/prompts.ts';
import { makeSounds } from '../sound/make.ts';

interface SoundBuild {
  report(msg: string, level?: 'warn'): void;
  shouldStop(): boolean;
  progress?(frac: number): void;
  /** Run GPU work in its turn (the build's GPU queue). */
  gpu?: <T>(model: SoundModel, fn: () => Promise<T>) => Promise<T>;
  /** Called as sounds are finished, to save the world now and then. */
  onSound?(): void;
  /** Make every sound again (new takes), not only those missing. */
  again?: boolean;
}

export const soundsDir = (worldId: string) => path.join(worldAssetDir(worldId), 'sounds');
/** Make (or finish) a world's sounds from its plan; sets `world.sounds`. */
export async function buildSounds(world: WorldDefinition, plan: SoundPlan, b: SoundBuild): Promise<void> {
  if (!comfyProvider()) {
    b.report('Sounds: no ComfyUI is configured, so this world plays with the game\'s own sounds.', 'warn');
    world.sounds = {};
    return;
  }
  const dir = soundsDir(world.id);
  if (b.again) fs.rmSync(dir, { recursive: true, force: true });
  const orders = worldOrders(world, plan);
  const have: Record<SoundKey, SoundDef> = b.again ? {} : { ...world.sounds };
  world.sounds = await makeSounds(orders, {
    dir, have, seedBase: world.id, gpu: b.gpu, report: b.report, shouldStop: b.shouldStop, progress: b.progress,
    onSound: (key, def) => {
      if (def) have[key] = def;
      world.sounds = { ...have };
      b.onSound?.();
    },
  });
  // Files of sounds no longer in the set (a world whose places changed) go.
  const used = new Set(Object.values(world.sounds).flatMap((d) => [...d.files, ...(d.intro ? [d.intro] : [])]));
  for (const f of fs.readdirSync(dir)) if (!used.has(f)) fs.rmSync(path.join(dir, f), { force: true });
  b.report(`Sounds: ${Object.keys(world.sounds).length} of ${orders.length} made.`);
}
