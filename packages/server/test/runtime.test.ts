/** The adventure's own rules around the fights: gatherings, conversations shared, loot, quantities, reloading. */
import { describe, expect, it } from 'vitest';
import { Rng, type ServerMessage, type Vec2 } from '@daydream/shared';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import type { Adventure } from '../src/game/adventure.ts';
import { makeItem, makeUnique } from '../src/game/loot.ts';
import { MonsterActor, NpcActor } from '../src/game/actors.ts';

/** Ann (two heroes) and Bob (one) in the game, in the town the story begins in. */
async function annAndBob() {
  const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
  const adv = adventures.create(w, 'ua', 'Ann', 'runtime', [hero(w, 'Ann', 'melee'), hero(w, 'Abe', 'ranged')]);
  adv.addPlayer('ub', 'Bob', [hero(w, 'Bob', 'ranged')]);
  const got: Record<string, ServerMessage[]> = { ua: [], ub: [] };
  const closed: string[] = [];
  for (const u of ['ua', 'ub']) adv.join({ userId: u, send: (m) => got[u]!.push(m), close: () => closed.push(u) });
  const [ann, bob] = [adv.state.players.ua!, adv.state.players.ub!];
  const errors = (u: string) => got[u]!.filter((m) => m.t === 'toast' && m.kind === 'bad').map((m) => (m as { text: string }).text);
  return { w, r: w.ruleset, adv, got, closed, ann, bob, errors, town: adv._live(ann.zoneId) };
}

/** Open ground between `min` and `max` meters from `p`, in sight of it. */
function groundNear(adv: Adventure, zoneId: string, p: Vec2, min: number, max: number): Vec2 {
  const nav = adv._live(zoneId).map.nav;
  for (let r = min; r <= max; r += 0.5)
    for (let i = 0; i < 24; i++) {
      const q = { x: p.x + Math.cos((i / 24) * Math.PI * 2) * r, y: p.y + Math.sin((i / 24) * Math.PI * 2) * r };
      if (nav.walkable(q.x, q.y) && nav.sees(q, p)) return q;
    }
  throw new Error('no open ground');
}

describe('the adventure runtime', () => {
  it('sends people home when their gathering is over, and forgets it', async () => {
    const { adv, ann, town } = await annAndBob();
    const people = [...town.actors.values()].filter((a): a is NpcActor => a instanceof NpcActor).slice(0, 2);
    expect(people).toHaveLength(2);
    const spot = adv._charActors('ua')[0]!;
    adv.state.events.push({ id: 'ev_test', day: 2, kind: 'gathering', zoneId: town.id, x: spot.x, y: spot.y, about: ann.party[0]!.id, reason: 'a birthday', npcIds: people.map((a) => a.id) });
    adv.handle('ua', { t: 'dev', action: 'time', day: 2 });
    for (const a of people) expect(Math.hypot(a.x - spot.x, a.y - spot.y)).toBeLessThan(6);
    expect(people.some((a) => a.homeX !== a.def.x || a.homeY !== a.def.y)).toBe(true);
    // The next day they keep where they always did, and walk (or are) there.
    adv.handle('ua', { t: 'dev', action: 'time', day: 3 });
    expect(adv.state.events).toHaveLength(0);
    for (const a of people) {
      expect([a.homeX, a.homeY]).toEqual([a.def.x, a.def.y]);
      const end = a.motion?.path[a.motion.path.length - 1] ?? a;
      expect(Math.hypot(end.x - a.def.x, end.y - a.def.y)).toBeLessThan(1.5);
    }
  }, 60_000);

  it('keeps a person with whoever still talks to them when a listener leaves', async () => {
    const { adv, town } = await annAndBob();
    const mara = [...town.actors.values()].find((a): a is NpcActor => a instanceof NpcActor)!;
    for (const u of ['ua', 'ub']) {
      mara.talkingTo = u;
      await adv.dialogue.open(u, mara.id);
    }
    adv.handle('ub', { t: 'end_dialog' });
    expect(mara.talkingTo).toBe('ua');
    adv.handle('ua', { t: 'end_dialog' });
    expect(mara.talkingTo).toBeNull();
  }, 60_000);

  it('takes a party into a fight by its leader, followers with it and never alone', async () => {
    const { w, adv, ann, bob } = await annAndBob();
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    for (const p of [ann, bob]) adv.transfer(p, wild.id);
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.alive() && !a.boss)!;
    const [lead, follower] = adv._charActors('ua');
    const [bobLead] = adv._charActors('ub');
    Object.assign(bobLead!, groundNear(adv, zone.id, monster, 1.2, 4));
    Object.assign(follower!, groundNear(adv, zone.id, monster, 3, 6));
    Object.assign(lead!, groundNear(adv, zone.id, monster, 22, 40));
    const fight = adv.startCombat(zone, monster, bobLead!)!;
    expect(bobLead!.combatId).toBe(fight.id);
    expect(follower!.combatId).toBeNull();
    // Ann's leader comes close: both of her heroes are in it.
    Object.assign(lead!, groundNear(adv, zone.id, monster, 4, 7));
    adv.startCombat(zone, monster, bobLead!);
    expect([lead!.combatId, follower!.combatId]).toEqual([fight.id, fight.id]);
    // The pack is closed in a fight, and a click on something waits for it to end.
    const potion = ann.inventory.find((i) => i.qty > 1)!;
    const had = potion.qty;
    adv.handle('ua', { t: 'drop_item', itemId: potion.id, qty: 1 });
    expect(potion.qty).toBe(had);
    adv.handle('ua', { t: 'dev', action: 'peace', on: true });
    adv.handle('ub', { t: 'dev', action: 'peace', on: true });
  }, 60_000);

  it('opens a chest only by using it, and closes what a player looked into when they leave', async () => {
    const { w, adv, got, bob, town } = await annAndBob();
    const bobLead = adv._charActors('ub')[0]!;
    const placed = Object.values(w.uniqueItems).find((u) => u.questItem)!;
    town.map.features.set('test_chest', { id: 'test_chest', kind: 'chest', name: 'Chest', x: bobLead.x + 1, y: bobLead.y, lootTier: 1, items: [placed.id] });
    adv.state.pouch = [];
    // Asking for what is in a chest nobody opened takes nothing and leaves it unopened.
    adv.handle('ub', { t: 'take_loot', sourceId: 'test_chest', all: true });
    expect(town.rt.features.test_chest?.lootBy).toBeUndefined();
    adv.handle('ub', { t: 'interact', targetId: 'test_chest', charId: bobLead.id, inspect: true });
    expect(adv.state.pouch.some((i) => i.uniqueId === placed.id)).toBe(true);
    const loot = () => got.ub!.filter((m): m is Extract<ServerMessage, { t: 'loot' }> => m.t === 'loot').pop()!;
    expect(loot().loot?.id).toBe('test_chest');
    // Going somewhere else closes it.
    adv.transfer(bob, w.zones.find((z) => z.id !== town.id)!.id);
    expect(loot().loot).toBeNull();
  }, 60_000);

  it('takes whole numbers of things only, and tells a find once', async () => {
    const { w, r, adv, got, ann, bob, errors, town } = await annAndBob();
    const rng = new Rng(1);
    const potion = r.items.find((b) => b.category === 'potion' && b.stackable)!;
    const merchant = w.npcs.find((n) => n.role === 'merchant' && n.zoneId === town.id) ?? w.npcs.find((n) => n.role === 'merchant')!;
    const purse = adv.state.npcs[merchant.id]!;
    ann.gold = bob.gold = 100_000;
    for (const u of ['ua', 'ub']) adv.openTrade(u, merchant.id);
    // Nonsense for an amount buys one, and both purses stay numbers; the friend at the same counter sees the stock change.
    const stock = purse.stock.find((i) => i.qty > 1) ?? purse.stock[0]!;
    const [had, seen] = [stock.qty, got.ub!.filter((m) => m.t === 'trade').length];
    adv.handle('ua', { t: 'buy', npcId: merchant.id, itemId: stock.id, qty: 'many' as unknown as number });
    expect(Number.isFinite(ann.gold) && ann.gold < 100_000).toBe(true);
    expect(Number.isFinite(purse.gold)).toBe(true);
    expect(purse.stock.find((i) => i.id === stock.id)?.qty ?? 0).toBe(had - 1);
    expect(got.ub!.filter((m) => m.t === 'trade').length).toBe(seen + 1);
    // Something a friend bought first is said to be gone.
    adv.handle('ub', { t: 'buy', npcId: merchant.id, itemId: 'it_gone' });
    expect(errors('ub').pop()).toMatch(/no longer/);
    // A negative amount drops the stack as it is: nothing is made from nothing.
    ann.inventory = [makeItem(r, rng, potion.id, 1, r.rarities[0]!.id, 6)];
    adv.handle('ua', { t: 'drop_item', itemId: ann.inventory[0]!.id, qty: -5 });
    expect(ann.inventory).toHaveLength(0);
    expect(town.rt.loot.at(-1)!.items[0]!.qty).toBe(6);
    // A unique thing put down and picked up again is no new find for the journal.
    const unique = { ...makeUnique(r, Object.values(w.uniqueItems)[0]!, 1), bound: false, baseId: r.items.find((b) => b.category === 'equipment')!.id };
    ann.inventory.push(unique);
    adv.handle('ua', { t: 'drop_item', itemId: unique.id });
    const told = adv.state.journal.length;
    adv.handle('ua', { t: 'interact', targetId: town.rt.loot.at(-1)!.id });
    await until(() => expect(ann.inventory.some((i) => i.uniqueId === unique.uniqueId)).toBe(true));
    expect(adv.state.journal).toHaveLength(told);
    // Only a quest in progress (or none) is pinned, and something that is not gear is not put on.
    adv.handle('ua', { t: 'pin_quest', questId: 7 as unknown as string });
    expect(ann.pinnedQuestId).toBeUndefined();
    adv.handle('ua', { t: 'pin_quest', questId: '' });
    expect(ann.pinnedQuestId).toBe('');
    ann.inventory.push(makeItem(r, rng, potion.id, 1, r.rarities[0]!.id));
    adv.handle('ua', { t: 'equip', charId: ann.party[0]!.id, itemId: ann.inventory.at(-1)!.id });
    expect(errors('ua').pop()).toMatch(/cannot be equipped/);
  }, 60_000);

  it('sizes a pack never fought to the heroes in its place, and leaves one that has fought as it is', async () => {
    const { w, adv, ann, bob, town } = await annAndBob();
    for (const u of ['ua', 'ub']) adv.handle(u, { t: 'dev', action: 'peace', on: true });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    const rts = () => adv.state.zones[wild.id]!.monsters;
    const sizes = () => Object.fromEntries(wild.spawns.filter((s) => !s.bossId && rts()[s.id]?.fitFor !== undefined).map((s) => [s.groupId, rts()[s.id]!.fitFor!]));
    // Ann's two heroes make the place live; Bob's one arrives after them.
    adv.transfer(ann, wild.id);
    expect(new Set(Object.values(sizes()))).toEqual(new Set([2]));
    adv.transfer(bob, wild.id);
    expect(new Set(Object.values(sizes()))).toEqual(new Set([3]));
    // One pack is fought, then everyone goes; Ann comes back alone.
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.alive() && !a.boss)!;
    const lead = adv._charActors('ua')[0]!;
    adv.handle('ua', { t: 'dev', action: 'peace', on: false });
    Object.assign(lead, groundNear(adv, zone.id, monster, 1.2, 4));
    expect(adv.startCombat(zone, monster, lead)).toBeTruthy();
    expect(monster.rt.fought).toBe(true);
    adv.handle('ua', { t: 'dev', action: 'peace', on: true });
    for (const p of [ann, bob]) adv.transfer(p, town.id);
    adv.transfer(ann, wild.id);
    const after = sizes();
    expect(after[monster.spawn.groupId]).toBe(3);
    const others = Object.entries(after).filter(([g]) => g !== monster.spawn.groupId).map(([, n]) => n);
    expect(others.length).toBeGreaterThan(0);
    expect(new Set(others)).toEqual(new Set([2]));
  }, 60_000);

  it('gives a level and nothing else, and lets ordinary piles go after a few days', async () => {
    const { w, r, adv, ann, town } = await annAndBob();
    const [hurt, down] = ann.party;
    hurt!.hp = 3;
    hurt!.statuses = [{ id: r.statuses[0]!.id, turns: 99, power: 1 }];
    Object.assign(down!, { hp: 0, downed: true });
    adv.handle('ua', { t: 'dev', action: 'xp', amount: 1_000_000 });
    expect(hurt!.level).toBeGreaterThan(1);
    expect(hurt!.hp).toBe(3);
    expect(hurt!.statuses).toHaveLength(1);
    expect(down!.downed).toBe(true);

    // A pile of gold, a hero's remains and a pile holding a quest's thing, all left now: days later only the first is gone.
    const at = adv._charActors('ua')[0]!;
    const pile = (id: string, more: object = {}) => ({ id, x: at.x + 8, y: at.y, items: [], gold: 5, label: id, ownerUserId: 'ub', createdAt: adv.state.clock, ...more });
    const quest = makeUnique(r, Object.values(w.uniqueItems).find((u) => u.questItem)!, 1);
    town.rt.loot.push(pile('lp_gold'), pile('lp_remains', { corpse: true }), pile('lp_quest', { items: [quest] }));
    adv.handle('ua', { t: 'dev', action: 'time', day: adv.day() + 2 });
    expect(town.rt.loot.map((l) => l.id)).toEqual(['lp_gold', 'lp_remains', 'lp_quest']);
    adv.handle('ua', { t: 'dev', action: 'time', day: adv.day() + 3 });
    expect(town.rt.loot.map((l) => l.id)).toEqual(['lp_remains', 'lp_quest']);
  }, 60_000);

  it('shows a friend the journal as it grows, and hands everyone to a fresh copy on a reload', async () => {
    const { adv, got, closed } = await annAndBob();
    const views = () => got.ub!.filter((m): m is Extract<ServerMessage, { t: 'player' }> => m.t === 'player');
    const main = Object.keys(adv.state.quests).find((id) => adv.questDef(id)?.main)!;
    adv.handle('ua', { t: 'dev', action: 'quest', questId: main, op: 'complete' });
    const entries = adv.state.journal.length;
    expect(entries).toBeGreaterThan(0);
    await until(() => expect(views().pop()!.player.journal).toHaveLength(entries));
    // A reload: both are disconnected (their clients connect again), and the next to come gets another copy.
    adventures.reload(adv.state.id);
    expect(closed.sort()).toEqual(['ua', 'ub']);
    const fresh = adventures.get(adv.state.id)!;
    expect(fresh).not.toBe(adv);
    expect(fresh.state.journal).toHaveLength(entries);
    adventures.release(fresh.state.id);
  }, 60_000);
});
