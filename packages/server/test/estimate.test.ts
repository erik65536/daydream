import { describe, expect, it } from 'vitest';
import { BUILD_RATES, ESTIMATE_MARGIN, SIZE_PROFILES, WORLD_SIZES, buildEstimate } from '@daydream/shared';
import { TILE_RANGE } from '../src/worldgen/mapdraw.ts';

describe('world sizes', () => {
  it('give every size room for its places at their smallest, and grow with the size', () => {
    for (const s of WORLD_SIZES) {
      const p = SIZE_PROFILES[s];
      const smallest = p.towns * TILE_RANGE.town.min[0] * TILE_RANGE.town.min[1] + p.wilds * TILE_RANGE.wilderness.min[0] * TILE_RANGE.wilderness.min[1] + p.dungeons * TILE_RANGE.dungeon.min[0] * TILE_RANGE.dungeon.min[1];
      expect(p.tiles).toBeGreaterThanOrEqual(smallest);
      // Room for every place at its usual size and some to spare, and never for every place at its largest.
      const all = (at: 'usual' | 'max') => p.towns * TILE_RANGE.town[at][0] * TILE_RANGE.town[at][1] + p.wilds * TILE_RANGE.wilderness[at][0] * TILE_RANGE.wilderness[at][1] + p.dungeons * TILE_RANGE.dungeon[at][0] * TILE_RANGE.dungeon[at][1];
      expect(p.tiles).toBeGreaterThan(all('usual'));
      expect(p.tiles).toBeLessThan(all('max'));
    }
    const e = WORLD_SIZES.map((s) => buildEstimate(s, 'short'));
    for (let i = 1; i < e.length; i++) {
      expect(e[i]!.hours).toBeGreaterThan(e[i - 1]!.hours);
      expect(e[i]!.usd).toBeGreaterThan(e[i - 1]!.usd);
      expect(e[i]!.animationUsd).toBeGreaterThan(e[i - 1]!.animationUsd);
    }
  });

  it('price a small world as the builds so far, a little high: about an hour and a dollar to play, about three more to animate', () => {
    const e = buildEstimate('small', 'short');
    expect(e.hours).toBeGreaterThan(0.3);
    expect(e.hours).toBeLessThan(1.1);
    expect(e.usd).toBeGreaterThan(0.7);
    expect(e.usd).toBeLessThan(1.5);
    expect(e.animationUsd).toBeGreaterThan(2);
    expect(e.animationUsd).toBeLessThan(4);
  });

  it('come from the rates given (measured from build records in place of the experiments’)', () => {
    const doubled = { ...BUILD_RATES, placeUsd: BUILD_RATES.placeUsd * 2 };
    const a = buildEstimate('medium', 'medium'), b = buildEstimate('medium', 'medium', doubled);
    expect(b.usd - a.usd).toBeCloseTo(8 * BUILD_RATES.placeUsd * ESTIMATE_MARGIN, 6);
  });
});
