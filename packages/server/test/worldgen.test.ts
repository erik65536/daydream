import { describe, expect, it } from 'vitest';
import { Nav, Rng, makeNav } from '@daydream/shared';
import { populate } from '../src/worldgen/zones.ts';
import { artKeys, planAssets } from '../src/worldgen/art.ts';
import { WorldGenJob, places, runGeneration } from '../src/worldgen/build.ts';
import { worldDir } from '../src/storage.ts';
import fs from 'node:fs';
import path from 'node:path';
import { genWorld, plainPlaces, validateWorld } from './helpers.ts';

describe('world generation', () => {
  it('builds a valid world', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    expect(w.status).toBe('ready');
    expect(validateWorld(w)).toEqual([]);
    expect(w.quests.some((q) => q.main)).toBe(true);
    expect(w.finalQuestId).toBeTruthy();
  });
  it('builds a valid medium world', async () => {
    const w = await genWorld('A derelict space station orbiting a dying star, robots and aliens', 'medium');
    expect(validateWorld(w)).toEqual([]);
    // A crafter (and the crafting station at their workshop) in every town of a world with crafting.
    if (w.ruleset.crafting.enabled) for (const t of w.zones.filter((z) => z.kind === 'town')) expect(t.features.some((f) => f.kind === 'craft_station')).toBe(true);
    for (const t of w.zones.filter((z) => z.kind === 'town')) expect(t.features.some((f) => f.kind === 'storage')).toBe(w.ruleset.inventory.storage !== 'none');
    // Waypoints and a way home in a bottle come with fast travel, and only with it.
    const travel = w.ruleset.systems.fastTravel;
    expect(w.zones.some((z) => z.features.some((f) => f.kind === 'waypoint'))).toBe(travel);
    expect(w.ruleset.items.some((i) => i.use?.tool === 'recall')).toBe(travel);
    // Every place sized within its kind, the world within its tile budget.
    expect(w.zones.reduce((n, z) => n + z.tiles[0] * z.tiles[1], 0)).toBeLessThanOrEqual(55);
    // Heroes are painted per class and kin; each kin is one gender.
    expect(w.ruleset.kins.every((k) => ['feminine', 'masculine', 'androgynous'].includes(k.presentation) && k.appearance)).toBe(true);
  }, 180_000);
});

describe('a build that fails', () => {
  it('waits for its other pieces to stop, then leaves the world alone', async () => {
    // (The mock models are set up by the first world built.)
    await genWorld('A misty kingdom of dragons and ruined castles');
    const restore = plainPlaces();
    const settle = places.settle;
    let late = 0, first = '';
    places.settle = async (w, z, painted, ctx) => {
      first ||= z.id;
      if (z.id === first) throw new Error('the painter is away');
      // Still at work when the first place gives up.
      await new Promise((r) => setTimeout(r, 400));
      late++;
      return settle(w, z, painted, ctx);
    };
    const job = new WorldGenJob(`w_test_${Math.random().toString(36).slice(2, 8)}`, { theme: 'A misty kingdom of dragons and ruined castles', size: 'small', length: 'short', communication: 2 }, { id: 'u1', name: 'Tester' });
    try {
      await expect(runGeneration(job)).rejects.toThrow(/failed 4 times/);
      // The other places finished what they were doing before the build ended, and nothing was tried again after.
      expect(late).toBeGreaterThan(0);
      expect(job.log.some((l) => /try 1 failed \((stopped|cancelled)/.test(l.msg))).toBe(false);
      const file = path.join(worldDir(job.worldId), 'world.json'), written = fs.statSync(file).mtimeMs;
      await new Promise((r) => setTimeout(r, 600));
      expect(fs.statSync(file).mtimeMs).toBe(written);
    } finally {
      restore();
    }
  }, 180_000);
});

describe('populating a place', () => {
  it('only something solid blocks a line of sight, not a thin strip or the cover at either end', () => {
    // Open ground 20 m wide with a 0.5 m strip of ferns at x = 6 and a 3 m wall at x = 12-15, both blocking sight.
    const fern = (x: number) => x >= 6 && x < 6.5, wall = (x: number) => x >= 12 && x < 15;
    const nav = new Nav(makeNav(20, 10, (x) => !fern(x) && !wall(x), (x) => !fern(x) && !wall(x)));
    expect(nav.sees({ x: 2, y: 5 }, { x: 10, y: 5 })).toBe(true);
    expect(nav.sees({ x: 10, y: 5 }, { x: 18, y: 5 })).toBe(false);
    // Standing right behind the wall's near face still sees out past it.
    expect(nav.sees({ x: 11.6, y: 5 }, { x: 2, y: 5 })).toBe(true);
  });

  it('a party coming in through a narrow way in stands on the open ground past it', () => {
    // A 4 m gap through the barrier at the top edge, then a 2 m path 7 m long, into a 14 m clearing.
    const nav = new Nav(makeNav(30, 30, (x, y) => (x > 13 && x < 17 && y < 3) || (x > 14 && x < 16 && y < 10) || (x > 8 && x < 22 && y >= 10 && y < 24)));
    const a = nav.arrival({ x: 15, y: 4 }, 14);
    expect(a.y).toBeGreaterThan(10);
    expect(nav.walkable(a.x, a.y)).toBe(true);
    // A door on open ground: a step off it.
    const b = nav.arrival({ x: 15, y: 17 });
    expect(Math.hypot(b.x - 15, b.y - 17)).toBeLessThan(2.5);
  });

  it('gathers packs in open rooms, not passages, and puts the boss in its lair', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const z = w.zones.find((x) => x.kind === 'dungeon' || x.kind === 'wilderness')!;
    // Two 14 m rooms joined by a long 2 m corridor.
    const room = (x: number, y: number) => (x > 1 && x < 15 && y > 1 && y < 15) || (x > 45 && x < 59 && y > 1 && y < 15);
    const nav = new Nav(makeNav(60, 16, (x, y) => room(x, y) || (x >= 15 && x <= 45 && y > 7 && y < 9)));
    z.spawns = [];
    z.features = z.features.filter((f) => f.kind !== 'exit');
    z.entry = { x: 4, y: 8 };
    const boss = w.bosses.find((b) => b.zoneId === z.id) ?? { ...w.bosses[0]!, zoneId: z.id };
    if (!w.bosses.includes(boss)) w.bosses.push(boss);
    populate(w, z, nav, new Rng('t'), 400, [], new Map([[boss.id, { x: 52, y: 8 }]]));
    const packs = new Map<string, { x: number; y: number }[]>();
    for (const s of z.spawns) packs.set(s.groupId!, [...(packs.get(s.groupId!) ?? []), s]);
    for (const [, members] of packs) {
      const cx = members.reduce((a, m) => a + m.x, 0) / members.length;
      expect(cx < 15 || cx > 45).toBe(true);
    }
    const b = z.spawns.find((s) => s.bossId === boss.id)!;
    expect(Math.hypot(b.x - 52, b.y - 8)).toBeLessThan(4);
  });

  // With nothing near the way in, and with a named foe's lair taking the nearest ground (packs then keep their distance).
  it.each([false, true])('meets a party with packs of the place\'s lowest level first and harder ones deeper in (lair by the way in: %s)', async (lairNear) => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const z = w.zones.find((x) => x.kind === 'dungeon' || x.kind === 'wilderness')!;
    // One long open hall, entered at its west end.
    const nav = new Nav(makeNav(80, 18, (x, y) => x > 1 && x < 79 && y > 1 && y < 17));
    z.spawns = [];
    z.features = z.features.filter((f) => f.kind !== 'exit');
    z.entry = { x: 3, y: 9 };
    z.levelRange = [1, 4];
    const boss = { ...w.bosses[0]!, id: 'b_near', zoneId: z.id };
    w.bosses = [...w.bosses.filter((b) => b.zoneId !== z.id), ...(lairNear ? [boss] : [])];
    populate(w, z, nav, new Rng('levels'), 2400, [], lairNear ? new Map([[boss.id, { x: 18, y: 9 }]]) : undefined);
    const far = (p: { x: number; y: number }) => Math.hypot(p.x - z.entry.x, p.y - z.entry.y);
    const packs = new Map<string, { x: number; y: number; level: number }[]>();
    for (const s of z.spawns) if (!s.groupId!.endsWith(boss.id)) packs.set(s.groupId!, [...(packs.get(s.groupId!) ?? []), s]);
    const byNear = [...packs.values()]
      .map((m) => ({ d: far({ x: m.reduce((a, s) => a + s.x, 0) / m.length, y: m.reduce((a, s) => a + s.y, 0) / m.length }), level: Math.max(...m.map((s) => s.level)) }))
      .sort((a, b) => a.d - b.d);
    expect(byNear.length).toBeGreaterThanOrEqual(3);
    expect(byNear[0]!.level).toBe(1);
    expect(byNear.at(-1)!.level).toBeGreaterThan(byNear[0]!.level);
  });

  it('guards what a quest sends the party to find with nothing above the quest\'s level, however deep it lies', async () => {
    const w = structuredClone(await genWorld('A misty kingdom of dragons and ruined castles'));
    const z = w.zones.find((x) => x.kind === 'dungeon' || x.kind === 'wilderness')!;
    const nav = new Nav(makeNav(80, 18, (x, y) => x > 1 && x < 79 && y > 1 && y < 17));
    z.features = z.features.filter((f) => f.kind !== 'exit' && !f.questId);
    z.entry = { x: 3, y: 9 };
    z.levelRange = [1, 4];
    w.bosses = w.bosses.filter((b) => b.zoneId !== z.id);
    const packsNear = (p: { x: number; y: number }) => {
      const groups = new Map<string, { x: number; y: number; level: number }[]>();
      for (const s of z.spawns) groups.set(s.groupId!, [...(groups.get(s.groupId!) ?? []), s]);
      return [...groups.values()].filter((m) => Math.hypot(m[0]!.x - p.x, m[0]!.y - p.y) < 10).map((m) => Math.max(...m.map((s) => s.level)));
    };
    // The far end of the hall is the hardest ground; something a level 1 quest wants lies there.
    const find = { x: 76, y: 9 };
    z.spawns = [];
    populate(w, z, nav, new Rng('levels'), 2400, []);
    expect(Math.max(...packsNear(find))).toBeGreaterThan(1);
    const quest = w.quests[0]!;
    quest.level = 1;
    z.features.push({ id: 'find_test', kind: 'chest', name: 'Old wire', items: [], questId: quest.id, ...find });
    z.spawns = [];
    populate(w, z, nav, new Rng('levels'), 2400, []);
    expect(packsNear(find).length).toBeGreaterThan(0);
    expect(Math.max(...packsNear(find))).toBe(1);
  });

  it('gives every creature of a place its own id, two named foes in one place included', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const z = w.zones.find((x) => x.kind === 'wilderness')!;
    const first = w.bosses.find((b) => b.zoneId === z.id) ?? { ...w.bosses[0]!, zoneId: z.id };
    w.bosses = [...w.bosses.filter((b) => b !== first), first, { ...first, id: `${first.id}_second` }];
    z.spawns = [];
    populate(w, z, new Nav(z.nav!), new Rng('t'), 1200, []);
    const ids = z.spawns.map((s) => s.id);
    expect(new Set(ids).size).toBe(ids.length);
    expect(z.spawns.filter((s) => s.bossId).map((s) => s.bossId)).toEqual(expect.arrayContaining([first.id, `${first.id}_second`]));
  });

  it('links every way out to a way back', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    for (const z of w.zones)
      for (const f of z.features.filter((x) => x.kind === 'exit')) {
        const back = w.zones.find((x) => x.id === f.targetZoneId)?.features.find((x) => x.id === f.targetFeatureId);
        expect(back, `${f.id} -> ${f.targetZoneId}/${f.targetFeatureId}`).toBeTruthy();
        expect(back!.targetZoneId).toBe(z.id);
        expect(back!.targetFeatureId).toBe(f.id);
      }
    expect(validateWorld(w)).toEqual([]);
  });
});

describe('art planning', () => {
  it('plans one base image per actor: people from the front, creatures in the view the prompt writer picks', async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const plan = planAssets(w);
    expect(plan.some((r) => r.key.includes('@'))).toBe(false);
    const people = plan.filter((r) => r.key.startsWith('spr_npc_') || r.key.startsWith('spr_hero_'));
    expect(people.length).toBeGreaterThan(0);
    expect(people.every((r) => r.view === 'front')).toBe(true);
    expect(plan.filter((r) => r.key.startsWith('spr_mon_')).every((r) => r.view === undefined)).toBe(true);
  });

  it("paints again only what is missing, failed or has a new brief (a repair pass's seeds do not count)", async () => {
    const w = await genWorld('A sleepy harbor town plagued by smugglers.');
    const plan = planAssets(w);
    expect(plan.map((r) => r.key).sort()).toEqual(artKeys(w).sort());
    // Everything painted, one of them by a repair pass with fresh seeds.
    for (const r of plan) w.assets[r.key] = { ...r, status: 'ok', file: `${r.key}.png` };
    w.assets[plan[0]!.key]!.roll = 100;
    expect(planAssets(w)).toHaveLength(0);
    const npc = w.npcs[0]!;
    w.assets[`spr_npc_${npc.id}`]!.status = 'failed';
    npc.appearance = 'A tall figure in a yellow raincoat';
    expect(planAssets(w).map((r) => r.key)).toEqual([`spr_npc_${npc.id}`]);
    expect(planAssets(w, new Set(['spr_nothing']))).toHaveLength(0);
  });
});
