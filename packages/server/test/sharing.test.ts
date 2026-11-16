import { describe, expect, it } from 'vitest';
import { currentWays, type QuestDef, type ServerMessage, type Vec2, type WorldDefinition } from '@daydream/shared';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { Combat } from '../src/game/combat.ts';
import { makeUnique } from '../src/game/loot.ts';
import { MonsterActor } from '../src/game/actors.ts';
import type { Adventure } from '../src/game/adventure.ts';

/** Two players in one adventure, Ann with two heroes and Bob with one, both in the first wild place. */
async function twoPlayers(setting: string, shape: (w: WorldDefinition) => void = () => {}) {
  Combat.instant = true;
  const w = await genWorld(setting);
  shape(w);
  const adv = adventures.create(w, 'ua', 'Ann', 'sharing', [hero(w, 'Ann', 'melee'), hero(w, 'Ada', 'ranged')]);
  adv.addPlayer('ub', 'Bob', [hero(w, 'Bob', 'ranged')]);
  const got: Record<string, ServerMessage[]> = { ua: [], ub: [] };
  for (const u of ['ua', 'ub']) adv.join({ userId: u, send: (m) => got[u]!.push(m) });
  const wild = w.zones.find((z) => z.kind === 'wilderness')!;
  for (const u of ['ua', 'ub']) adv.transfer(adv.state.players[u]!, wild.id);
  return { w, adv, got, wild, zone: adv._live(wild.id) };
}

/** Begin every quest that sends the heroes to defeat a boss or named foe, so all of them are out. */
function foesOut(adv: Adventure) {
  for (const q of adv.world.quests) if (q.objectives.some((o) => o.type === 'kill_unique')) adv.quests.start(q.id);
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

describe('playing together', () => {
  it("keeps each player's loot their own, and rolls a boss's loot for every hero who fought it", async () => {
    const { adv, zone } = await twoPlayers('A drowned forest of stilt houses and lantern boats');
    const [ann] = adv._charActors('ua');
    const pile = (owner: string, gold: number) => ({ id: `lp_${owner}_${gold}`, x: ann!.x + 0.5, y: ann!.y, items: [], gold, label: 'pile', ownerUserId: owner, createdAt: Date.now() });
    zone.rt.loot.push(pile('ub', 7), pile('ua', 5));
    const gold = adv.state.players.ua!.gold;
    // Ann's click on Bob's pile does nothing; on her own it takes hers and leaves his.
    adv.handle('ua', { t: 'interact', targetId: 'lp_ub_7' });
    adv.handle('ua', { t: 'interact', targetId: 'lp_ua_5' });
    await until(() => expect(adv.state.players.ua!.gold).toBe(gold + 5));
    expect(zone.rt.loot.map((l) => l.id)).toEqual(['lp_ub_7']);

    // A boss felled by Ann's two heroes and Bob's one: a whole boss's loot for each hero, in one pile per player.
    const bossDef = adv.world.bosses.find((b) => !b.member)!;
    foesOut(adv);
    for (const u of ['ua', 'ub']) adv.transfer(adv.state.players[u]!, bossDef.zoneId);
    const bz = adv._live(bossDef.zoneId);
    const boss = [...bz.actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.isBoss)!;
    for (const [i, a] of [...adv._charActors('ua'), ...adv._charActors('ub')].entries()) Object.assign(a, groundNear(adv, bz.id, boss, 2 + i * 0.7, 7), { motion: null });
    const fight = adv.startCombat(bz, boss, adv._charActors('ua')[0]!)!;
    expect(fight.participants().filter((a) => !(a instanceof MonsterActor))).toHaveLength(3);
    bz.rt.loot = [];
    boss.rt.hp = 0;
    adv.onDowned(boss, adv._charActors('ua')[0]!);
    // A boss's roll holds two or three things at least (stacks merge, so counted by quantity): two rolls for Ann, one for Bob.
    const things = (u: string) => bz.rt.loot.filter((l) => l.ownerUserId === u).flatMap((l) => l.items).filter((it) => !it.uniqueId).reduce((n, it) => n + it.qty, 0);
    expect(bz.rt.loot.filter((l) => l.ownerUserId === 'ua')).toHaveLength(1);
    expect(bz.rt.loot.filter((l) => l.ownerUserId === 'ub')).toHaveLength(1);
    expect(things('ua')).toBeGreaterThanOrEqual(4);
    expect(things('ub')).toBeGreaterThanOrEqual(2);
  }, 120_000);

  it('leaves a player away from a fight free, and takes them in when they walk up to it', async () => {
    const { adv, zone, got } = await twoPlayers('A sunburnt frontier of mesas and copper mines');
    const monster = [...zone.actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.alive() && !a.boss)!;
    const [ann] = adv._charActors('ua');
    const [bob] = adv._charActors('ub');
    Object.assign(ann!, groundNear(adv, zone.id, monster, 1.2, 4));
    const far = groundNear(adv, zone.id, monster, 22, 40);
    for (const a of adv._charActors('ub')) Object.assign(a, far);
    adv.handle('ua', { t: 'use_skill', charId: ann!.id, skillId: 'attack', targetId: monster.id });
    const fight = await until(() => {
      const c = adv._combats()[0];
      expect(c).toBeTruthy();
      return c!;
    });
    // Bob, far off, is not in it, and is told of it only as a fight he watches: he may walk.
    expect(bob!.combatId).toBeFalsy();
    expect(got.ub!.some((m) => m.t === 'combat' && m.combat)).toBe(false);
    const watched = got.ub!.filter((m): m is Extract<ServerMessage, { t: 'fights' }> => m.t === 'fights').at(-1)?.fights;
    expect(watched?.map((f) => f.id)).toEqual([fight.id]);
    adv.handle('ub', { t: 'move', x: far.x + 1, y: far.y });
    expect(got.ub!.some((m) => m.t === 'toast' && m.text === 'Not your turn.')).toBe(false);
    // Walking up within sight of the fight takes his party into it, this round.
    const near = groundNear(adv, zone.id, monster, 3, 6);
    for (const a of adv._charActors('ub')) Object.assign(a, near, { motion: null });
    await until(() => expect(bob!.combatId).toBe(fight.id));
    expect(fight.view().order.some((o) => o.ownerUserId === 'ub')).toBe(true);
  }, 120_000);

  it('keeps two fights in one place apart: each player has their own, and watches the other', async () => {
    const { adv, wild, got } = await twoPlayers('A sunburnt frontier of mesas and copper mines');
    foesOut(adv);
    const zone = adv._live(wild.id);
    const foes = [...zone.actors.values()].filter((a): a is MonsterActor => a instanceof MonsterActor && a.alive() && !a.boss);
    const first = foes[0]!;
    const second = foes.find((m) => Math.hypot(m.x - first.x, m.y - first.y) > 30 && m.spawn.groupId !== first.spawn.groupId)!;
    const [ann] = adv._charActors('ua');
    const [bob] = adv._charActors('ub');
    for (const a of adv._charActors('ua')) Object.assign(a, groundNear(adv, zone.id, first, 1.2, 4));
    for (const a of adv._charActors('ub')) Object.assign(a, groundNear(adv, zone.id, second, 1.2, 4));
    adv.handle('ua', { t: 'use_skill', charId: ann!.id, skillId: 'attack', targetId: first.id });
    adv.handle('ub', { t: 'use_skill', charId: bob!.id, skillId: 'attack', targetId: second.id });
    await until(() => expect(adv._combats()).toHaveLength(2));
    const mine = (u: string) => got[u]!.filter((m): m is Extract<ServerMessage, { t: 'combat' }> => m.t === 'combat').at(-1)?.combat?.id;
    const others = (u: string) => got[u]!.filter((m): m is Extract<ServerMessage, { t: 'fights' }> => m.t === 'fights').at(-1)?.fights.map((f) => f.id);
    await until(() => {
      expect(mine('ua')).toBe(ann!.combatId);
      expect(mine('ub')).toBe(bob!.combatId);
      expect(others('ua')).toEqual([bob!.combatId]);
      expect(others('ub')).toEqual([ann!.combatId]);
    });
  }, 120_000);

  it("shows a quest's find only once the quest has begun", async () => {
    const { w, adv } = await twoPlayers('A misty kingdom of dragons and ruined castles');
    const find = w.zones.flatMap((z) => z.features).find((f) => f.questId && !adv.state.quests[f.questId]);
    expect(find).toBeTruthy();
    const zoneId = w.zones.find((z) => z.features.includes(find!))!.id;
    adv.transfer(adv.state.players.ua!, zoneId);
    const states = () => (adv as unknown as { featureStates(z: string, u: string): { id: string; unseen?: boolean }[] }).featureStates(zoneId, 'ua');
    expect(states().find((f) => f.id === find!.id)?.unseen).toBe(true);
    adv.quests.start(find!.questId!);
    expect(states().find((f) => f.id === find!.id)?.unseen).toBeFalsy();
  }, 120_000);

  it("puts a quest's find in the shared pouch for whichever hero takes it, and says so", async () => {
    const { w, adv, got } = await twoPlayers('A misty kingdom of dragons and ruined castles');
    const find = w.zones.flatMap((z) => z.features).find((f) => f.questId && f.items?.length)!;
    const zoneId = w.zones.find((z) => z.features.includes(find))!.id;
    adv.quests.start(find.questId!);
    for (const u of ['ua', 'ub']) adv.transfer(adv.state.players[u]!, zoneId);
    for (const a of [...adv._charActors('ua'), ...adv._charActors('ub')]) Object.assign(a, groundNear(adv, zoneId, find, 0.6, 1.4), { motion: null });
    const toasts = (u: string) => got[u]!.filter((m): m is Extract<ServerMessage, { t: 'toast' }> => m.t === 'toast').map((m) => m.text);
    for (const u of ['ua', 'ub']) got[u]!.length = 0;
    // Ann's second hero opens it: the thing is the party's, told to everyone, and nothing claims the find was empty
    // (the quest's step may be done by it too, when finding it is the step the quest is on).
    const ada = adv._charActors('ua')[1]!;
    adv.handle('ua', { t: 'interact', targetId: find.id, charId: ada.id });
    expect(adv.state.pouch.map((it) => it.uniqueId)).toEqual(find.items);
    for (const u of ['ua', 'ub']) expect(toasts(u).filter((t) => !t.startsWith('✔'))).toEqual([expect.stringContaining(`${ada.name} found`)]);
    // Bob, coming after, finds it taken.
    adv.handle('ub', { t: 'interact', targetId: find.id });
    expect(toasts('ub').at(-1)).toBe('Nothing left to take.');
    expect(adv.state.pouch).toHaveLength(1);
  }, 120_000);

  it('finishes a quest in the conversation that hands its last thing over', async () => {
    // A choice (bring the thing, or find another way), then going back to the one who asked.
    let def!: QuestDef;
    const { w, adv } = await twoPlayers('A misty kingdom of dragons and ruined castles', (w) => {
      const [giver, other] = w.npcs;
      const thing = Object.values(w.uniqueItems).find((u) => u.questItem)!;
      def = {
        id: 'q_back', title: 'Back to the asker', summary: '', main: false, level: 1, giverNpcId: giver!.id, zoneId: giver!.zoneId, prerequisites: [], rewards: { xp: 10, gold: 1, items: [] },
        objectives: [
          { id: 'o0', type: 'deliver', itemUniqueId: thing.id, npcId: giver!.id, count: 1, step: 0, way: 0, description: 'Bring it' },
          { id: 'o1', type: 'persuade', npcId: other!.id, step: 0, way: 1, description: 'Find another way' },
          { id: 'o2', type: 'talk', npcId: giver!.id, step: 1, way: 0, hidden: true, description: 'Return' },
        ],
      };
      w.quests.push(def);
    });
    adv.quests.start(def.id);
    const prog = adv.state.quests[def.id]!;
    adv.state.pouch.push(makeUnique(w.ruleset, w.uniqueItems[def.objectives[0]!.itemUniqueId!]!, 1));
    // Talking with the one who asked, the heroes hand it over: the quest is done there and then.
    adv.dialogue.scenes = () => [{ npcId: def.giverNpcId!, userIds: ['ua'] }];
    adv.quests.tryDeliver(def.giverNpcId!, adv.state.players.ua!);
    expect(currentWays(def, prog)).toHaveLength(0);
    expect(prog.status).toBe('completed');
  }, 120_000);
});
