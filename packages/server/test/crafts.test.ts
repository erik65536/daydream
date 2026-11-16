import { describe, expect, it } from 'vitest';
import { CRAFT_RANKS, Rng, affixPool, brewBatch, characterStats, craftPoints, craftPointsLeft, craftedRarity, curve, enchantCost, fighterSkills, itemLines, itemPrice, sellPrice, slotKindOf, treePointsAt, upgradeBlock, upgradeCost, upgradedLevel } from '@daydream/shared';
import { solveEconomy } from '../src/rules/bind.ts';
import { makeItem } from '../src/game/loot.ts';
import { CharActor } from '../src/game/actors.ts';
import { createCharacter } from '../src/game/characters.ts';
import { fixtureRules, genWorld } from './helpers.ts';

describe('crafts (the utility tree)', () => {
  const r = fixtureRules('woodland');
  const weapon = r.items.find((i) => i.weapon)!;
  const item = { baseId: weapon.id, level: 4, rarityId: r.rarities[0]!.id, affixes: [] };

  it('are the world\'s own, named by its rules', () => {
    expect(r.crafts.map((c) => c.id).sort()).toEqual(['brew', 'craft', 'enchant', 'upgrade']);
    expect(r.crafts.every((c) => c.name && c.description)).toBe(true);
  });

  it('give a player points with levels, never enough for everything', () => {
    const all = r.crafts.length * CRAFT_RANKS;
    expect(craftPoints(r, 1)).toBe(1);
    expect(craftPoints(r, r.progression.maxLevel)).toBeLessThan(all);
    expect(craftPoints(r, r.progression.maxLevel)).toBeGreaterThan(all / 2);
    // Shared by the player's heroes: the highest level counts, not how many heroes there are.
    const one = { party: [{ level: 5 }], crafts: {} }, six = { party: Array.from({ length: 6 }, () => ({ level: 5 })), crafts: {} };
    expect(craftPointsLeft(r, six)).toBe(craftPointsLeft(r, one));
  });

  it('need a rank, and do more with each', () => {
    const top = r.progression.maxLevel;
    expect(upgradeCost(r, item, 0, top)).toBeNull();
    expect(enchantCost(r, item, 0)).toBeNull();
    // A higher rank of improving raises an item more levels at once, for the cost of one improvement.
    expect(upgradedLevel(r, item, 1, top)).toBe(item.level + 1);
    expect(upgradedLevel(r, item, 3, top)).toBe(item.level + 3);
    expect(upgradedLevel(r, item, 3, item.level + 1)).toBe(item.level + 1);
    expect(enchantCost(r, item, CRAFT_RANKS)!.gold).toBeLessThan(enchantCost(r, item, 1)!.gold);
    expect(craftedRarity(r, 1)).toBe(r.rarities[0]!.id);
    expect(craftedRarity(r, CRAFT_RANKS)).not.toBe(r.rarities.at(-1)!.id);
    expect(brewBatch(1)).toBe(1);
    expect(brewBatch(CRAFT_RANKS)).toBe(CRAFT_RANKS);
  });
});

describe('gear', () => {
  const r = fixtureRules('woodland');
  const rng = new Rng('gear');
  const common = r.rarities[0]!.id;

  it('always does something: an accessory, with nothing of its own, rolls a bonus even when common', () => {
    const accessories = r.items.filter((i) => slotKindOf(r, i) === 'accessory');
    expect(accessories.length).toBeGreaterThan(0);
    for (const a of accessories) for (let i = 0; i < 5; i++) expect(makeItem(r, rng, a.id, 3, common).affixes.length).toBe(1);
    // Weapons and armor carry their damage or defense, so a common one has no bonus.
    expect(makeItem(r, rng, r.items.find((i) => i.weapon)!.id, 3, common).affixes).toEqual([]);
  });

  it("a weapon's damage bonus is for its own kind of damage", () => {
    for (const w of r.items.filter((i) => i.weapon)) {
      const kinds = affixPool(r, w).filter((a) => a.stat.startsWith('dmg:')).map((a) => a.stat);
      expect(kinds).toEqual([`dmg:${w.weapon!.typeId}`]);
    }
  });

  it("improving raises an item's level: it becomes the item found a level higher, up to its owner's level", () => {
    const acc = r.items.find((i) => slotKindOf(r, i) === 'accessory')!;
    const it = makeItem(r, rng, acc.id, 2, r.rarities[2]!.id);
    const higher = { ...it, level: 3 };
    expect(itemLines(r, higher)).not.toEqual(itemLines(r, it));
    // The same item found at level 3 reads the same as this one improved to it.
    expect(itemLines(r, higher)).toEqual(itemLines(r, { ...it, level: 3 }));
    // Stats follow too: a hero wearing it is stronger.
    const slot = r.slots.find((s) => s.id === acc.slotId)!.id;
    const ch = { classId: r.classes[0]!.id, kinId: '', level: 5, tree: {}, statuses: [] };
    const power = (x: typeof it) => characterStats(r, { ...ch, equipment: { [slot]: x } });
    expect(JSON.stringify(power(higher))).not.toEqual(JSON.stringify(power(it)));
    expect(upgradeBlock(r, { ...it, level: 4 }, CRAFT_RANKS, 4)).toMatch(/your level/);
    expect(upgradeBlock(r, it, CRAFT_RANKS, 4)).toBeNull();
  });

  it('worn gear improved or enchanted in place changes its wearer at once', () => {
    const acc = r.items.find((i) => slotKindOf(r, i) === 'accessory')!;
    const it = makeItem(r, rng, acc.id, 2, r.rarities[2]!.id);
    const { ch } = createCharacter(r, { name: 'Smith', classId: r.classes[0]!.id, kinId: r.kins[0]!.id }, rng);
    ch.level = 5;
    ch.equipment[acc.slotId!] = it;
    const hero = new CharActor(ch, 'test', 'zone', 0, 0, r);
    const read = () => JSON.stringify(hero.stats());
    const before = read();
    it.level++;
    const improved = read();
    expect(improved).not.toEqual(before);
    const other = affixPool(r, acc).find((a) => a.id !== it.affixes[0]!.affixId)!;
    it.affixes[0] = { affixId: other.id, value: it.affixes[0]!.value };
    expect(read()).not.toEqual(improved);
  });

  it("creatures know a tier's skills once a hero all-in on the class could have taken one", () => {
    const cls = r.classes[0]!;
    for (let level = 1; level <= r.progression.maxLevel; level++) {
      const points = treePointsAt(r, level);
      const known = new Set(fighterSkills(r, [cls.id], level));
      for (const n of cls.nodes.filter((x) => x.kind === 'skill')) expect(known.has(n.skillId!)).toBe(points > (r.progression.tierRequirements[n.tier] ?? 0));
    }
  });
});

describe('consumables (they have no level: see inventory.test.ts)', () => {
  const r = fixtureRules('woodland');
  it('cost the same number of kills at every level', () => {
    const potion = r.items.find((i) => i.category === 'potion')!;
    const kills = (level: number) => itemPrice(r, { baseId: potion.id, level: 1, rarityId: r.rarities[0]!.id, affixes: [] }, level) / curve(r.economy.goldPerKill, level);
    expect(kills(r.progression.maxLevel) / kills(1)).toBeCloseTo(1, 1);
  });

  it('sell back, a full batch, for less than the materials cost to buy', () => {
    for (const rc of r.recipes) {
      if (!('itemId' in rc.output)) continue;
      for (const level of [1, r.progression.maxLevel]) {
        // A merchant who thinks nothing of the player asks 1.25 times the price and pays the world's sell ratio.
        const out = sellPrice(r, { baseId: rc.output.itemId, level: 1, rarityId: r.rarities[0]!.id, affixes: [] }, level, r.economy.sellRatio) * rc.output.qty * brewBatch(CRAFT_RANKS);
        const cost = rc.inputs.reduce((n, i) => n + itemPrice(r, { baseId: i.itemId, level: 1, rarityId: r.rarities[0]!.id, affixes: [] }, level) * 1.25 * i.qty, 0);
        expect(out).toBeLessThan(cost);
      }
    }
  });
});

describe('the economy', () => {
  it('prices things from what the world pays', async () => {
    const w = await genWorld('A misty kingdom of dragons and ruined castles');
    const r = w.ruleset;
    solveEconomy(r, w);
    let total = 0;
    for (const z of w.zones) {
      for (const s of z.spawns) total += curve(r.economy.goldPerKill, s.level) * 0.55 * (s.bossId && !w.bosses.find((b) => b.id === s.bossId)?.member ? 6 : 1);
      for (const f of z.features) if (f.kind === 'chest') total += curve(r.economy.goldPerKill, f.lootTier ?? z.levelRange[1]) * 2.25;
    }
    for (const q of w.quests) total += q.rewards.gold;
    const perLevel = total / r.progression.maxLevel;
    const mid = Math.ceil(r.progression.maxLevel / 2);
    const weapon = r.items.find((i) => i.weapon)!;
    const price = itemPrice(r, { baseId: weapon.id, level: mid, rarityId: r.rarities[0]!.id, affixes: [] }, mid);
    expect(price / perLevel).toBeGreaterThan(0.3);
    expect(price / perLevel).toBeLessThan(0.5);
    expect(r.inventory.upgradeCost / perLevel).toBeGreaterThan(0.6);
  });
});
