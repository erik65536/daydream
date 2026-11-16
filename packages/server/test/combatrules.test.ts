import { describe, expect, it } from 'vitest';
import {
  FIGHTER_KINDS, Rng, SPACING, blockedBy, characterStats, consumableStats, controlText, fighterStats, invalidateRuleset, itemLines, rollDamage, skillLines,
  type ItemBaseDef, type ItemInstance, type Ruleset, type SkillDef, type StatBlock, type StatusDef,
} from '@daydream/shared';
import { NpcActor } from '../src/game/actors.ts';
import { addStatus, checkItemUse, checkSkill, executeSkill, startTurn, useConsumable } from '../src/game/effects.ts';
import { applyUse, buildBoard, indexOf } from '../src/game/tactics.ts';
import { buildPack, type PackMember } from '../src/rules/encounters.ts';
import { makeParty, setUpFight } from '../src/rules/sim.ts';
import { SimPool } from '../src/rules/simPool.ts';
import { fixtureRules } from './helpers.ts';

/** A status of the test's own, added to the rules. */
function status(r: Ruleset, def: Partial<StatusDef> & { id: string }): StatusDef {
  const s: StatusDef = { name: def.id, color: '#ffffff', description: '', harmful: false, ...def };
  r.statuses.push(s);
  invalidateRuleset(r);
  return s;
}

/** A skill of the test's own (used directly: nobody has to know it). */
const skill = (o: Partial<SkillDef> & { id: string }): SkillDef => ({ name: o.id, description: '', owner: 'general', targeting: 'enemy', range: 1.6, ap: 2, cooldown: 0, effects: [], rankBonus: 0, maxRank: 1, tags: ['weapon'], fx: 'slash', tune: 1, ...o });

/** A fight ready to start: heroes of the first classes at level 3 and soldiers of the first class. */
function stage(r: Ruleset, heroes = 2, foes = 2) {
  const rng = new Rng('combatrules');
  const party = makeParty(r, { classes: r.classes.slice(0, heroes).map((c) => c.id), level: 3, rng });
  const pack: PackMember[] = Array.from({ length: foes }, () => ({ fighter: 'soldier', classId: r.classes[0]!.id, member: 0, level: 3 }));
  return setUpFight(r, { party, pack, potions: 0, difficulty: 'normal', seed: 'combatrules' });
}

const blank = (r: Ruleset, o: Partial<StatBlock> = {}): StatBlock => ({ ...characterStats(r, { classId: r.classes[0]!.id, kinId: '', level: 3, tree: {}, equipment: {}, statuses: [] }), ...o });

describe('the numbers of a fight', () => {
  it('slows and hastens a creature as it does a hero', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_slow', harmful: true, modifiers: [{ stat: 'move', value: -0.5 }] });
    const of = (statuses: { id: string; turns: number; power: number }[]) => fighterStats(r, { level: 3, fighter: 'soldier', classIds: [r.classes[0]!.id], statuses }).move;
    expect(of([{ id: 'st_slow', turns: 2, power: 1 }])).toBeCloseTo(of([]) - 0.5, 6);
  });

  it('varies the basic attack between the least and the most its weapon shows', () => {
    const r = fixtureRules('woodland');
    const basic = r.skills.find((s) => s.id === r.basicAttackId)!;
    const hit = basic.effects[0]!;
    if (hit.kind !== 'damage') throw new Error('no damage');
    const a = blank(r, { crit: 0 }), t = blank(r, { mitigation: {}, taken: 1 });
    const low = rollDamage(r, a, t, basic, 1, hit, () => 0).amount, high = rollDamage(r, a, t, basic, 1, hit, () => 0.999999).amount;
    expect(low).toBe(Math.round(a.weapon.min));
    expect(high).toBe(Math.round(a.weapon.max));
    expect(high).toBeGreaterThan(low);
  });

  it('follows a status put on again more strongly, and powers a worn piece gains', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_weak', harmful: true, modifiers: [{ stat: 'power', value: -10 }] });
    const { host, chars } = stage(r);
    const a = chars[0]!;
    const power = () => a.stats().pct.power ?? 0;
    const plain = power();
    addStatus(host, a, 'st_weak', 3, 1, undefined, 1);
    expect(power() - plain).toBeCloseTo(-10, 6);
    addStatus(host, a, 'st_weak', 3, 1, undefined, 2);
    expect(power() - plain).toBeCloseTo(-20, 6);
    // A piece of gear forged into a legendary while worn.
    const before = a.stats().maxHp;
    const worn = Object.values(a.ch.equipment).find((i) => i)!;
    worn.uniqueMods = [{ stat: 'hpPct', value: 50 }];
    expect(a.stats().maxHp).toBeGreaterThan(before);
  });

  it('heals a little each turn from the smallest regeneration', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_regen', modifiers: [{ stat: 'hpRegen', value: 0.001 }] });
    const { host, chars } = stage(r);
    const a = chars[0]!;
    a.statuses = [{ id: 'st_regen', turns: 5, power: 1 }];
    expect(a.stats().hpRegen).toBeLessThan(0.5);
    a.hp = 10;
    startTurn(host, a);
    expect(a.hp).toBe(11);
  });

  it('steals life from the damage dealt, not from the blow', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_leech', modifiers: [{ stat: 'lifesteal', value: 25 }] });
    const { host, chars, monsters } = stage(r);
    const a = chars[0]!, m = monsters[0]!;
    a.statuses = [{ id: 'st_leech', turns: 5, power: 1 }];
    [a.x, a.y] = [m.x + 1.2, m.y];
    a.hp = 1;
    m.hp = 1;
    executeSkill(host, { user: a, skill: r.skills.find((s) => s.id === r.basicAttackId)!, target: m }, false);
    expect(m.alive()).toBe(false);
    expect(a.hp).toBe(1);
  });

  it('builds a boss pack from a family of swarms', () => {
    const r = fixtureRules('woodland');
    const pack = buildPack(r, new Rng('swarms'), { heroes: 4, level: 2, kind: 'boss', members: [{ fighter: 'swarm', classId: r.classes[0]!.id }] });
    expect(pack[0]!.boss).toBe(true);
  });
});

describe('what a skill may do', () => {
  it('strikes only foes: a person is nobody\'s target', () => {
    const r = fixtureRules('woodland');
    const { host, chars } = stage(r);
    const a = chars[0]!;
    const person = new NpcActor({ id: 'n1', name: 'Townsperson', level: 1, x: a.x + 1, y: a.y } as never, { hp: 10, alive: true, x: a.x + 1, y: a.y } as never, 'arena', r);
    host.actors.push(person);
    const basic = r.skills.find((s) => s.id === r.basicAttackId)!;
    expect(checkSkill(host, { user: a, skill: basic, target: person }, { inCombat: false })).toBe('They are no foe of yours.');
  });

  it('is stopped by a silence or a disarm as their text says, by one rule', () => {
    const r = fixtureRules('woodland');
    const basic = r.skills.find((s) => s.id === r.basicAttackId)!;
    const spell = skill({ id: 't_spell', tags: ['spell'] }), blow = skill({ id: 't_blow', tags: ['weapon'] });
    const silenced = blank(r, { silenced: true }), disarmed = blank(r, { disarmed: true });
    expect([basic, blow, spell].map((s) => blockedBy(silenced, s))).toEqual([null, null, 'silence']);
    expect([basic, blow, spell].map((s) => blockedBy(disarmed, s))).toEqual(['disarm', 'disarm', null]);
    expect(blockedBy(blank(r, { rooted: true }), skill({ id: 't_dash', effects: [{ kind: 'dash' }] }))).toBe('root');
    // The refusal is the status's own line.
    status(r, { id: 'st_mute', harmful: true, control: 'silence' });
    const { host, chars, monsters } = stage(r);
    const a = chars[0]!;
    a.statuses = [{ id: 'st_mute', turns: 2, power: 1 }];
    expect(checkSkill(host, { user: a, skill: spell, target: monsters[0]! }, { inCombat: false })).toBe(`${controlText(r, 'silence')}.`);
  });

  it('gives its user what it gives them even when its area catches nobody', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_bold', modifiers: [{ stat: 'power', value: 10 }] });
    const { host, chars } = stage(r);
    const a = chars[0]!;
    const nova = skill({ id: 't_nova', targeting: 'self', range: 0, radius: 1, effects: [{ kind: 'damage', coef: 1, typeId: r.damageTypes[0]!.id }, { kind: 'status', statusId: 'st_bold', chance: 1, turns: 2, self: true }] });
    executeSkill(host, { user: a, skill: nova }, false);
    expect(a.statuses.map((s) => s.id)).toEqual(['st_bold']);
  });

  it('ends with its user: one downed by the first foe struck does not strike the next', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_thorns', modifiers: [{ stat: 'thorns', value: 5 }] });
    const { host, chars, monsters } = stage(r);
    const a = chars[0]!, [m1, m2] = monsters as [typeof monsters[number], typeof monsters[number]];
    [m1.x, m1.y] = [a.x + 1, a.y];
    [m2.x, m2.y] = [a.x - 1, a.y];
    m1.statuses = [{ id: 'st_thorns', turns: 5, power: 1 }];
    a.hp = 1;
    const full = m2.hp;
    executeSkill(host, { user: a, skill: skill({ id: 't_sweep', targeting: 'self', range: 0, radius: 2, effects: [{ kind: 'damage', coef: 1, typeId: r.damageTypes[0]!.id }] }) }, false);
    expect(a.alive()).toBe(false);
    expect(m2.hp).toBe(full);
  });

  it('lets a rush be used from beside its target, without moving', () => {
    const r = fixtureRules('woodland');
    const { host, chars, monsters } = stage(r);
    const a = chars[0]!, m = monsters[0]!;
    [a.x, a.y] = [m.x - SPACING, m.y];
    const rush = skill({ id: 't_rush', range: 5.5, effects: [{ kind: 'dash' }, { kind: 'damage', coef: 1, typeId: r.damageTypes[0]!.id }] });
    expect(checkSkill(host, { user: a, skill: rush, target: m }, { inCombat: false })).toBeNull();
    const at = { x: a.x, y: a.y };
    executeSkill(host, { user: a, skill: rush, target: m }, false);
    expect({ x: a.x, y: a.y }).toEqual(at);
  });

  it('is refused by the compiler when its record breaks the world\'s rules, not made into something else', () => {
    // The office's healer revives, which only a world where special skills revive may have.
    expect(fixtureRules('office').skills.some((s) => s.effects.some((e) => e.kind === 'revive'))).toBe(true);
    for (const mode of ['heal', 'after_combat'] as const) expect(() => fixtureRules('office', (rec) => void (rec.rulesSystems.revive = mode))).toThrow(/revives/);
    // A silence in a world without magic.
    expect(() => fixtureRules('woodland', (rec) => {
      rec.rulesCore.classes.magical = null;
      rec.rulesStatuses.statuses.push({ name: 'Hush', color: '#ffffff', description: '', kind: 'debuff', effects: ['silence'] });
    })).toThrow(/silences/);
    // A blessing on allies in a skill that deals damage, a curse on enemies in one that heals.
    const first = (rec: Parameters<NonNullable<Parameters<typeof fixtureRules>[1]>>[0]) => Object.values(Object.values(rec.rulesSkills)[0]!)[0]![0]!;
    const some = (rec: Parameters<NonNullable<Parameters<typeof fixtureRules>[1]>>[0]) => rec.rulesStatuses.statuses[0]!.name;
    expect(() => fixtureRules('woodland', (rec) => void Object.assign(first(rec), { effects: ['damage', { status: some(rec), on: 'allies' }] }))).toThrow(/on allies/);
    expect(() => fixtureRules('woodland', (rec) => void Object.assign(first(rec), { effects: ['heal', { status: some(rec), on: 'enemies' }] }))).toThrow(/on enemies/);
  });
});

describe('consumables', () => {
  const bombOf = (r: Ruleset): { base: ItemBaseDef; item: ItemInstance } => {
    const base: ItemBaseDef = { id: 'c_test_bomb', name: 'Test Bomb', description: '', category: 'potion', use: { effects: [{ kind: 'damage', coef: 2, typeId: r.damageTypes[0]!.id }], ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false }, stackable: true, price: 1, dropWeight: 0, icon: 'bomb', tags: [] };
    r.items.push(base);
    invalidateRuleset(r);
    return { base, item: { id: 'i_bomb', baseId: base.id, level: 1, rarityId: r.rarities[0]!.id, affixes: [], qty: 1 } as ItemInstance };
  };

  it('are thrown only where the thrower sees, as far as their card and aim say', () => {
    const r = fixtureRules('woodland');
    const { item } = bombOf(r);
    const { host, chars } = stage(r);
    const a = chars[0]!;
    expect(checkItemUse(host, a, item, true, undefined, { x: a.x + 3, y: a.y })).toBeNull();
    expect(checkItemUse(host, a, item, true, undefined, { x: a.x + 8.3, y: a.y })).toBe('Out of range.');
    // In reach, behind a wall (the arena has none thick enough to hide anything).
    host.map.nav.sees = () => false;
    expect(checkItemUse(host, a, item, true, undefined, { x: a.x + 3, y: a.y })).toBe('No line of sight.');
  });

  it('cannot be used by someone downed', () => {
    const r = fixtureRules('woodland');
    const { item } = bombOf(r);
    const { host, chars } = stage(r);
    const a = chars[0]!;
    a.ch.hp = 0;
    a.ch.downed = true;
    expect(checkItemUse(host, a, item, false, undefined, { x: a.x + 2, y: a.y })).toBe('You cannot act right now.');
  });

  it('say on their card what their area is and whom it catches', () => {
    const r = fixtureRules('woodland');
    const { item } = bombOf(r);
    const lines = itemLines(r, item, undefined, 3);
    expect(lines.some((l) => l.endsWith('damage to each foe in the area'))).toBe(true);
    expect(lines).toContain('Area: 3.2 tiles across');
  });
});

describe('a consumable', () => {
  it('is the same for everyone: none of its user\'s bonuses, critical hits or life steal count', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_might', modifiers: [{ stat: 'power', value: 100 }, { stat: 'crit', value: 100 }, { stat: 'lifesteal', value: 25 }] });
    const base: ItemBaseDef = { id: 'c_test_bomb', name: 'Test Bomb', description: '', category: 'potion', use: { effects: [{ kind: 'damage', coef: 2, typeId: r.damageTypes[0]!.id }], ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false }, stackable: true, price: 1, dropWeight: 0, icon: 'bomb', tags: [] };
    r.items.push(base);
    invalidateRuleset(r);
    const item = { id: 'i_bomb', baseId: base.id, level: 1, rarityId: r.rarities[0]!.id, affixes: [], qty: 1 } as ItemInstance;
    const thrown = (mighty: boolean) => {
      const { host, chars, monsters } = stage(r);
      const a = chars[0]!, m = monsters[0]!;
      if (mighty) a.statuses = [{ id: 'st_might', turns: 5, power: 1 }];
      a.hp = 1;
      const full = m.hp;
      useConsumable(host, a, item, false, undefined, { x: m.x, y: m.y });
      return { dealt: full - m.hp, healed: a.hp - 1 };
    };
    // (The same fight and dice each time.)
    expect(thrown(true)).toEqual(thrown(false));
    expect(thrown(true).healed).toBe(0);
    const s = consumableStats(r, 3);
    expect([s.crit, s.lifesteal, s.pct]).toEqual([0, 0, {}]);
  });
});

describe('how long a status lasts', () => {
  /** A fight of one hero and one foe, the hero to act first; `pass` ends whoever's turn it is. */
  const duel = (r: Ruleset, heroes = 1) => {
    const s = stage(r, heroes, 1);
    for (const c of s.chars) c.ch.ai = undefined;
    // The foe only ever ends its turn, so what the status does shows in what it can do.
    s.combat.policy = () => ({ kind: 'end' });
    s.combat.start();
    s.combat.order = [...s.chars, ...s.monsters];
    s.combat.idx = s.combat.order.length - 1;
    s.combat.advance();
    return s;
  };

  it('holds a foe for its next turn when it is for one turn, and no longer', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_snare', harmful: true, control: 'root' });
    const { host, chars, monsters, combat } = duel(r);
    const a = chars[0]!, m = monsters[0]!;
    expect(combat.isActing(a)).toBe(true);
    addStatus(host, m, 'st_snare', 1, 1);
    combat.endTurn(a);
    // The foe's turn: it stands rooted through it.
    expect(combat.isActing(m)).toBe(true);
    expect(m.stats().rooted).toBe(true);
    expect(combat.move(m, { x: m.x - 1, y: m.y }).error).toBe('You are rooted in place.');
    host.run(50, () => combat.isActing(a));
    // Its turn over, the root is gone, and it is immune to control for the turns the rules give.
    expect(m.statuses).toEqual([]);
    expect(m.controlImmune).toBe(r.control.immunityTurns);
    expect(addStatus(host, m, 'st_snare', 1, 1)).toBe(false);
    // Each of its turns takes one from the immunity.
    for (let i = 0; i < r.control.immunityTurns; i++) {
      combat.endTurn(a);
      host.run(50, () => combat.isActing(a));
    }
    expect(m.controlImmune).toBe(0);
  });

  it('covers an ally\'s next turn when it is for one turn, and a turn of their own when they put it on themselves', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_bold', modifiers: [{ stat: 'power', value: 10 }] });
    const { host, chars, combat } = duel(r, 2);
    const [a, b] = chars as [typeof chars[number], typeof chars[number]];
    const bold = (c: typeof a) => c.statuses.some((s) => s.id === 'st_bold');
    // One hero's blessing on the other, and one on themselves, in the turn they share.
    addStatus(host, b, 'st_bold', 1, 1);
    addStatus(host, a, 'st_bold', 1, 1);
    combat.endTurn(a);
    combat.endTurn(b);
    host.run(50, () => combat.isActing(a));
    // Their next turn: both still have it, since what is gained during a turn starts counting with the next.
    expect([bold(a), bold(b)]).toEqual([true, true]);
    combat.endTurn(a);
    combat.endTurn(b);
    host.run(50, () => combat.isActing(a));
    expect([bold(a), bold(b)]).toEqual([false, false]);
  });

  it('deals damage over time at the start of each of its turns, as many times as it has turns', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_burn', harmful: true, dot: { coef: 1, typeId: r.damageTypes[0]!.id } });
    const { host, chars, monsters, combat } = duel(r);
    const a = chars[0]!, m = monsters[0]!;
    addStatus(host, m, 'st_burn', 2, 5);
    const hp = [m.hp];
    for (let i = 0; i < 3; i++) {
      combat.endTurn(a);
      host.run(50, () => combat.isActing(a));
      hp.push(m.hp);
    }
    expect(hp[1]).toBeLessThan(hp[0]!);
    expect(hp[2]).toBeLessThan(hp[1]!);
    expect(hp[3]).toBe(hp[2]);
  });
});

describe('the order of a fight', () => {
  it('gives a creature its kind\'s quickness and nothing for its level', () => {
    const r = fixtureRules('woodland');
    const of = (level: number, fighter: (typeof FIGHTER_KINDS)[number]) => fighterStats(r, { level, fighter, classIds: [r.classes[0]!.id], statuses: [] }).initiative;
    for (const k of FIGHTER_KINDS) expect(of(r.progression.maxLevel, k)).toBe(of(1, k));
    expect(of(1, 'soldier')).toBe(10 + r.fighters.soldier.initiative);
  });
});

describe('what a skill\'s card says', () => {
  it('counts the user\'s bonuses to its damage, as the blow does', () => {
    const r = fixtureRules('woodland');
    const s = r.skills.find((x) => x.id !== r.basicAttackId && x.effects[0]?.kind === 'damage')!;
    const amount = (stats: StatBlock) => Number(/\d+/.exec(skillLines(r, s, 1, stats)[0]!)![0]);
    const plain = amount(blank(r, { pct: {} })), strong = amount(blank(r, { pct: { power: 50 } }));
    // (Whole numbers of a small amount.)
    expect(strong / plain).toBeGreaterThan(1.3);
    expect(strong / plain).toBeLessThan(1.7);
  });
});

describe('the fight\'s turns', () => {
  it('lets a player end a hero\'s turn while the AI plays another of the shared turn', () => {
    const r = fixtureRules('woodland');
    const { chars, monsters, combat } = stage(r, 2, 1);
    for (const c of chars) c.ch.ai = undefined;
    combat.start();
    // The two heroes first, sharing a turn.
    combat.order = [...chars, ...monsters];
    combat.idx = combat.order.length - 1;
    combat.advance();
    expect(combat.acting).toEqual(chars);
    combat.aiTakeOver(chars[1]!);
    expect(combat.endTurn(chars[0]!)).toBeNull();
    expect(combat.acting).toEqual([chars[1]]);
  });

  it('leaves nothing of a fight on heroes who withdraw from it', () => {
    const r = fixtureRules('woodland');
    const { chars, combat } = stage(r);
    combat.start();
    chars[0]!.controlImmune = 2;
    chars[0]!.ap = 3;
    combat.withdraw();
    expect([chars[0]!.controlImmune, chars[0]!.ap, chars[0]!.combatId]).toEqual([0, 0, null]);
  });
});

describe('the combat AI', () => {
  it('values a cleanse by what the status it removes was doing', () => {
    const r = fixtureRules('woodland');
    status(r, { id: 'st_weak', harmful: true, modifiers: [{ stat: 'power', value: -30 }] });
    const { host, chars } = stage(r);
    const [a, b] = chars as [typeof chars[number], typeof chars[number]];
    a.statuses = [{ id: 'st_weak', turns: 3, power: 1, strength: 1 }];
    const board = buildBoard(r, host.actors, b);
    const cleanse = skill({ id: 't_cleanse', targeting: 'ally', range: 30, effects: [{ kind: 'cleanse' }] });
    const after = applyUse(board, { by: indexOf(board, b), skill: cleanse, target: indexOf(board, a), from: { x: b.x, y: b.y } });
    // Its damage comes back: 100% against the 70% it dealt weakened.
    expect(after.units[indexOf(board, a)]!.off.map((m) => m.mult)[0]).toBeCloseTo(1 / 0.7, 1);
  });
});

describe('the simulation pool', () => {
  it('fails an evaluation whose fight fails, rather than leave it waiting', async () => {
    // (No rules were given to the thread, so its one fight throws.)
    const pool = new SimPool(1);
    try {
      await expect(pool.play([{ scenario: { level: 1, kind: 'normal', difficulty: 'normal' }, tag: 't', index: 0 }])).rejects.toThrow();
    } finally {
      pool.close();
    }
  }, 20_000);
});

describe('brewing', () => {
  it('follows the consumables: a world without gear crafting still brews them', () => {
    const r = fixtureRules('woodland', (rec) => void (rec.rulesSystems.crafting = false));
    const potions = r.items.filter((i) => i.category === 'potion');
    expect(potions.length).toBeGreaterThan(0);
    expect(r.recipes.map((x) => ('itemId' in x.output ? x.output.itemId : '')).sort()).toEqual(potions.map((p) => p.id).sort());
    expect(r.crafts.map((c) => c.id)).toContain('brew');
    expect(r.crafts.map((c) => c.id)).not.toContain('craft');
  });
});
