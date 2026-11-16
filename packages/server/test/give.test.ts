import { describe, expect, it } from 'vitest';
import { HAND_REACH, Rng, inventoryCapacity, type ServerMessage } from '@daydream/shared';
import { genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { makeItem } from '../src/game/loot.ts';

describe('giving items to another player', () => {
  it('hands over whole items and parts of stacks to a player standing near, and refuses what cannot go', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const r = w.ruleset;
    const adv = adventures.create(w, 'ua', 'Ann', 'giving', [hero(w, 'Ann', 'melee')]);
    adv.addPlayer('ub', 'Bob', [hero(w, 'Bob', 'ranged')]);
    const got: Record<string, ServerMessage[]> = { ua: [], ub: [] };
    adv.join({ userId: 'ua', send: (m) => got.ua!.push(m) });
    const bobConn = { userId: 'ub', send: (m: ServerMessage) => got.ub!.push(m) };
    adv.join(bobConn);
    const [ann, bob] = [adv.state.players.ua!, adv.state.players.ub!];
    const errors = () => got.ua!.filter((m) => m.t === 'toast' && m.kind === 'bad').map((m) => (m as { text: string }).text);
    const rng = new Rng(1);
    const potion = r.items.find((b) => b.category === 'potion' && b.stackable)!;
    const gear = r.items.find((b) => b.category === 'equipment')!;
    ann.inventory = [makeItem(r, rng, potion.id, 1, r.rarities[0]!.id, 6), makeItem(r, rng, gear.id, 1, r.rarities[0]!.id)];
    bob.inventory = [];
    const [annLead, bobLead] = [adv._charActors('ua')[0]!, adv._charActors('ub')[0]!];
    bobLead.x = annLead.x + 1;
    bobLead.y = annLead.y;

    // Part of a stack, then a whole item: both arrive in Bob's pack, and Bob is told who gave what.
    adv.handle('ua', { t: 'give_item', itemId: ann.inventory[0]!.id, toUserId: 'ub', qty: 2 });
    expect(ann.inventory[0]!.qty).toBe(4);
    expect(bob.inventory.find((i) => i.baseId === potion.id)?.qty).toBe(2);
    const sword = ann.inventory[1]!;
    adv.handle('ua', { t: 'give_item', itemId: sword.id, toUserId: 'ub' });
    expect(ann.inventory.some((i) => i.id === sword.id)).toBe(false);
    expect(bob.inventory.some((i) => i.id === sword.id)).toBe(true);
    expect(got.ub!.some((m) => m.t === 'toast' && m.text.startsWith('Ann gave you'))).toBe(true);
    // A nonsense amount gives the whole stack, never more than there is.
    adv.handle('ua', { t: 'give_item', itemId: ann.inventory[0]!.id, toUserId: 'ub', qty: -5 });
    expect(ann.inventory.some((i) => i.baseId === potion.id)).toBe(false);
    expect(bob.inventory.find((i) => i.baseId === potion.id)?.qty).toBe(6);

    // Story items are everyone's already; nothing changes hands.
    const story = Object.values(w.uniqueItems).find((u) => u.questItem)!;
    const kept = { ...makeItem(r, rng, potion.id, 1, r.rarities[0]!.id), uniqueId: story.id, bound: true };
    ann.inventory.push(kept);
    adv.handle('ua', { t: 'give_item', itemId: kept.id, toUserId: 'ub' });
    expect(ann.inventory).toContain(kept);
    ann.inventory = ann.inventory.filter((i) => i !== kept);

    // Too far apart: refused until they stand close.
    const bread = makeItem(r, rng, potion.id, 1, r.rarities[0]!.id, 1);
    ann.inventory.push(bread);
    bobLead.x = annLead.x + HAND_REACH + 2;
    adv.handle('ua', { t: 'give_item', itemId: bread.id, toUserId: 'ub' });
    expect(ann.inventory).toContain(bread);
    expect(errors().pop()).toMatch(/closer/);
    bobLead.x = annLead.x + 1;

    // A full pack takes nothing new (a stack it already has still tops up).
    const fill = Array.from({ length: inventoryCapacity(r, bob) }, () => makeItem(r, rng, gear.id, 1, r.rarities[0]!.id));
    const before = bob.inventory;
    bob.inventory = [...before.filter((i) => i.baseId === potion.id), ...fill.slice(1)];
    const extra = makeItem(r, rng, gear.id, 1, r.rarities[0]!.id);
    ann.inventory.push(extra);
    adv.handle('ua', { t: 'give_item', itemId: extra.id, toUserId: 'ub' });
    expect(ann.inventory).toContain(extra);
    expect(errors().pop()).toMatch(/full/);
    adv.handle('ua', { t: 'give_item', itemId: bread.id, toUserId: 'ub' });
    expect(ann.inventory).not.toContain(bread);
    expect(bob.inventory.find((i) => i.baseId === potion.id)?.qty).toBe(7);

    // Only players in the game can be given things.
    adv.leave(bobConn);
    adv.handle('ua', { t: 'give_item', itemId: extra.id, toUserId: 'ub' });
    expect(ann.inventory).toContain(extra);
  }, 60000);
});
