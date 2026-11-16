import { describe, expect, it } from 'vitest';
import {
  CRAFT_RANKS, ITEM_GROWTH, Rng, characterStats, craftedLevel, expectedDamage, itemMods, rollDamage, rx, statusPower, upgradeBlock, upgradedLevel, wieldBlock,
  type Ruleset, type ServerMessage, type StatBlock,
} from '@daydream/shared';
import { makeItem, merchantStock } from '../src/game/loot.ts';
import { statPrice } from '../src/rules/worldRules.ts';
import { fixtureRules, genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';

/** The power % one gear bonus at the first level and a common quality is worth (worldRules.ts). */
const AFFIX_WORTH = 5;

describe('gear bonuses', () => {
  const r = fixtureRules('woodland');
  const kinds = r.damageTypes.map((t) => t.id);

  it('are each worth the same in a fight: a common bonus is the budget over its stat\'s price', () => {
    // (Within the rounding of a small value to four places.)
    for (const a of r.affixes) expect(Math.abs(a.value * statPrice(a.stat, kinds, r.resolution.critMult) / AFFIX_WORTH - 1)).toBeLessThan(0.01);
  });

  it('only act in a fight: nothing that changes prices or loot, nothing worth nothing', () => {
    const stats = r.affixes.map((a) => a.stat);
    for (const gone of ['barter', 'lootFind', 'initiative']) expect(stats).not.toContain(gone);
  });

  it("respect the world's rules: Healing only where heroes heal, crit and dodge only where they exist", () => {
    const noHealing = fixtureRules('woodland', (rec) => void (rec.rulesSystems.healing = false));
    expect(r.affixes.some((a) => a.stat === 'healing')).toBe(true);
    expect(noHealing.affixes.some((a) => a.stat === 'healing')).toBe(false);
    const plain = fixtureRules('woodland', (rec) => Object.assign(rec.rulesSystems, { crit: false, dodge: false, regeneration: false }));
    for (const s of ['crit', 'critDmg', 'dodge', 'hpRegen']) expect(plain.affixes.some((a) => a.stat === s)).toBe(false);
  });

  it("grow with the item's level alike, whatever the stat, by a quarter over the world's levels, with no cap of their own", () => {
    const rng = new Rng('growth');
    for (const base of r.items.filter((b) => b.category === 'equipment' && !b.weapon && !b.defense)) {
      const at1 = makeItem(r, rng, base.id, 1, r.rarities[4]!.id);
      const at = (level: number) => itemMods(r, { ...at1, level });
      const top = r.progression.maxLevel;
      at(top).forEach((m, i) => expect(m.value / at(1)[i]!.value).toBeCloseTo(1 + ITEM_GROWTH, 6));
    }
  });

  it('put critical damage at about a quarter of the old amount a common bonus gave', () => {
    // A critical damage bonus was 50% on a common item at the first level, far more than its worth.
    const crit = r.affixes.find((a) => a.stat === 'critDmg')!;
    expect(crit.value).toBeLessThanOrEqual(25);
  });
});

describe('dodging', () => {
  const r = fixtureRules('woodland');
  const blank = (o: Partial<StatBlock> = {}): StatBlock => ({ ...characterStats(r, { classId: r.classes[0]!.id, kinId: '', level: 3, tree: {}, equipment: {}, statuses: [] }), ...o });
  const skill = r.skills.find((s) => s.id !== r.basicAttackId && s.effects.some((e) => e.kind === 'damage'))!;
  const hit = skill.effects.find((e) => e.kind === 'damage')!;

  it('counts against every blow, a skill\'s as an attack\'s', () => {
    if (hit.kind !== 'damage') throw new Error('no damage');
    const a = blank(), t = blank({ dodge: 0 }), dodgy = blank({ dodge: 0.3 });
    expect(expectedDamage(r, a, dodgy, skill, 1, hit)).toBeCloseTo(expectedDamage(r, a, t, skill, 1, hit) * 0.7, 6);
    // The roll itself is the hit's; the dodge is rolled once for the whole blow, before it (effects.ts).
    expect('dodged' in rollDamage(r, a, dodgy, skill, 1, hit, () => 0)).toBe(false);
  });
});

describe('statuses a hero puts on', () => {
  const r = fixtureRules('woodland');
  const dot = r.statuses.find((s) => s.dot);
  const hot = r.statuses.find((s) => s.hot);
  const stats = (pct: Record<string, number>): StatBlock => ({ ...characterStats(r, { classId: r.classes[0]!.id, kinId: '', level: 3, tree: {}, equipment: {}, statuses: [] }), pct });

  it('deal their damage and healing with the bonuses the hero\'s own blows and heals have', () => {
    if (dot) expect(statusPower(r, stats({ power: 10, [`dmg:${dot.dot!.typeId}`]: 10 }), dot.id, 1) / statusPower(r, stats({}), dot.id, 1)).toBeCloseTo(1.2, 6);
    if (hot) expect(statusPower(r, stats({ healing: 25 }), hot.id, 1) / statusPower(r, stats({}), hot.id, 1)).toBeCloseTo(1.25, 6);
    expect(dot ?? hot).toBeTruthy();
  });
});

describe('crafting and improving', () => {
  const r = fixtureRules('woodland');
  const top = r.progression.maxLevel;

  it('make gear at the first level where the world has improving, and at the player\'s level where it does not', () => {
    expect(craftedLevel(r, top)).toBe(1);
    const noImproving: Ruleset = { ...r, crafts: r.crafts.filter((c) => c.id !== 'upgrade') };
    expect(craftedLevel(noImproving, 4)).toBe(4);
  });

  it('can bring crafted gear all the way to the player\'s level, at any rank, and never past it', () => {
    const weapon = r.items.find((b) => b.weapon)!;
    for (let rank = 1; rank <= CRAFT_RANKS; rank++) {
      const item = makeItem(r, new Rng(`craft:${rank}`), weapon.id, craftedLevel(r, top), r.rarities[0]!.id);
      let steps = 0;
      while (!upgradeBlock(r, item, rank, top)) {
        item.level = upgradedLevel(r, item, rank, top);
        steps++;
      }
      expect(item.level).toBe(top);
      expect(steps).toBe(Math.ceil((top - 1) / rank));
    }
  });
});

describe('weapons', () => {
  const r = fixtureRules('office');

  it('belong to the class whose gear made them, every class with weapons of its own', () => {
    const weapons = r.items.filter((b) => b.weapon);
    for (const w of weapons) expect(rx(r).cls.has(w.classId!)).toBe(true);
    for (const c of r.classes) expect(weapons.some((w) => w.classId === c.id)).toBe(true);
  });

  it("are wielded by heroes of their class, and by any hero who has spent a point in that class's tree", () => {
    const [own, other] = r.classes;
    const theirs = r.items.find((b) => b.weapon && b.classId === other!.id)!;
    const ch = { classId: own!.id, tree: {} as Record<string, number> };
    expect(wieldBlock(r, ch, r.items.find((b) => b.weapon && b.classId === own!.id))).toBeNull();
    expect(wieldBlock(r, ch, theirs)).toMatch(new RegExp(other!.name));
    ch.tree[other!.nodes[0]!.id] = 1;
    expect(wieldBlock(r, ch, theirs)).toBeNull();
    // Gear without a class (armor, accessories) is anyone's.
    expect(wieldBlock(r, { classId: own!.id, tree: {} }, r.items.find((b) => b.defense))).toBeNull();
  });

  it("cannot be put in a hero's hands against the rule, in the game", async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const wr = w.ruleset;
    const adv = adventures.create(w, 'ua', 'Ann', 'wielding', [hero(w, 'Ann', 'melee')]);
    const said: ServerMessage[] = [];
    adv.join({ userId: 'ua', send: (m) => said.push(m) });
    const p = adv.state.players.ua!;
    const ann = p.party[0]!;
    const other = wr.classes.find((c) => c.id !== ann.classId)!;
    const weapon = makeItem(wr, new Rng(2), wr.items.find((b) => b.weapon && b.classId === other.id)!.id, 1, wr.rarities[0]!.id);
    p.inventory.push(weapon);
    const slot = wr.slots.find((s) => s.kind === 'weapon')!.id;
    adv.handle('ua', { t: 'equip', charId: ann.id, itemId: weapon.id });
    expect(ann.equipment[slot]?.id).not.toBe(weapon.id);
    expect(said.some((m) => m.t === 'toast' && m.kind === 'bad' && m.text.includes(other.name))).toBe(true);
    ann.tree[other.nodes[0]!.id] = 1;
    adv.handle('ua', { t: 'equip', charId: ann.id, itemId: weapon.id });
    expect(ann.equipment[slot]?.id).toBe(weapon.id);
  });
});

describe('a weapons seller', () => {
  it('has a weapon for every class, whatever the draw', () => {
    const r = fixtureRules('woodland');
    const ix = rx(r);
    const classes = new Set(r.items.filter((b) => b.weapon && b.classId).map((b) => b.classId));
    expect(classes.size).toBeGreaterThan(1);
    for (let seed = 0; seed < 40; seed++) {
      const stock = merchantStock(r, new Rng(`shop:${seed}`), 'weapons', 3);
      const has = new Set(stock.map((i) => ix.item.get(i.baseId)!).filter((b) => b.weapon).map((b) => b.classId));
      for (const c of classes) expect(has.has(c)).toBe(true);
    }
  });
});
