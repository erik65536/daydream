import { describe, expect, it } from 'vitest';
import { genWorld, validateWorld } from './helpers.ts';
import { checkQuests } from '../src/worldgen/questcheck.ts';

describe('a tiny world with a brief story', () => {
  it('has one town, one wild and one dungeon, and can be played through to its level cap', async () => {
    const w = await genWorld('A lighthouse island of smugglers and drowned caves', 'tiny', 'brief');
    expect(w.zones.map((z) => z.kind).sort()).toEqual(['dungeon', 'town', 'wilderness']);
    expect(w.maxLevel).toBe(5);
    expect(w.arcs).toHaveLength(1);
    expect(validateWorld(w)).toEqual([]);
    expect(checkQuests(w)).toEqual([]);
    // Every level up to the cap has content to reach it, and the top of the world is at the cap.
    expect(w.ruleset.progression.xp.length).toBe(w.maxLevel + 1);
    expect(Math.max(...w.zones.flatMap((z) => z.spawns.map((s) => s.level)))).toBeGreaterThanOrEqual(w.maxLevel - 1);
    expect(w.ruleset.classes.every((c) => w.ruleset.skills.some((s) => s.owner === c.id))).toBe(true);
  });
});
