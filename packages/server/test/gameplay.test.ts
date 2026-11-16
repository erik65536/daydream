import { describe, expect, it } from 'vitest';
import { Rng, SPACING, SQUEEZE, type ServerMessage } from '@daydream/shared';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { Adventure } from '../src/game/adventure.ts';
import { Combat } from '../src/game/combat.ts';
import { makeItem } from '../src/game/loot.ts';
import { MonsterActor, CharActor, NpcActor } from '../src/game/actors.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));
const fightStarts = (adv: Adventure) =>
  until(() => {
    const combat = adv._combats()[0];
    expect(combat).toBeTruthy();
    return combat!;
  });

describe('gameplay simulation', () => {
  it('plays through dialogue, travel and combat', async () => {
    Combat.instant = true;
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves', 'small');
    const adv = adventures.create(w, 'u1', 'Tester', 'test run', [hero(w, 'Mara', 'melee')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const p = adv.state.players.u1!;
    expect(msgs.some((m) => m.t === 'welcome')).toBe(true);
    expect(msgs.some((m) => m.t === 'zone')).toBe(true);
    // The opening main quest auto-started.
    const main = Object.keys(adv.state.quests).find((id) => adv.questDef(id)?.main);
    expect(main).toBeTruthy();

    // Talk to the first quest giver via the procedural brain.
    const q = adv.questDef(main!)!;
    const giver = q.objectives[0]!.npcId!;
    await adv.dialogue.open('u1', giver);
    expect(adv.state.quests[main!]!.objectives[q.objectives[0]!.id]!.done).toBe(true);
    await adv.dialogue.say('u1', 'Hello! Is there any work for me?');
    const dlg = msgs.filter((m) => m.t === 'dialog').pop();
    expect(dlg && dlg.t === 'dialog' && dlg.dialog?.messages.length).toBeGreaterThan(0);
    adv.dialogue.close('u1');

    // Travel to a wilderness zone and pick a fight.
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    expect(p.zoneId).toBe(wild.id);
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    expect(monster).toBeTruthy();
    const me = adv._charActors('u1')[0]! as CharActor;
    // Give our hero a fighting chance and teleport next to the pack.
    me.ch.level = 3;
    me.x = monster.x + 1.2;
    me.y = monster.y;
    adv.handle('u1', { t: 'use_skill', charId: me.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    // Play the player's turns automatically until the fight ends: attack the nearest enemy or end turn.
    while (!combat.ended) {
      const act = combat.active;
      if (act instanceof CharActor) {
        const enemies = combat.participants().filter((x) => x.alive() && x instanceof MonsterActor);
        const target = enemies.sort((a, b) => Math.hypot(a.x - act.x, a.y - act.y) - Math.hypot(b.x - act.x, b.y - act.y))[0];
        if (target && act.ap >= 2) {
          if (Math.hypot(target.x - act.x, target.y - act.y) > 1.6) combat.move(act, { x: target.x + (target.x > act.x ? -1.1 : 1.1), y: target.y });
          const err = combat.useSkill(act, 'attack', target);
          if (err) combat.endTurn(act);
        } else combat.endTurn(act);
      }
      await wait(2);
    }
    expect(combat.ended).toBe(true);
    expect(p.stats.kills + p.stats.deaths).toBeGreaterThan(0);
    adv.leave({ userId: 'u1', send: () => {} } as never);
  }, 60000);
});

describe('playing together', () => {
  it('shares one story while each player keeps their own heroes, bag and gold', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'ua', 'Ann', 'together', [hero(w, 'Ann', 'melee')]);
    adv.addPlayer('ub', 'Bob', [hero(w, 'Bob', 'ranged'), hero(w, 'Cy', 'melee')]);
    const got: Record<string, ServerMessage[]> = { ua: [], ub: [] };
    adv.join({ userId: 'ua', send: (m) => got.ua!.push(m) });
    adv.join({ userId: 'ub', send: (m) => got.ub!.push(m) });
    const s = adv.state;
    const [ann, bob] = [s.players.ua!, s.players.ub!];
    // A story quest starts by going to its giver: the giver has work to give, so they carry the "!".
    const opening = Object.keys(s.quests).find((id) => adv.questDef(id)?.main)!;
    await until(() => expect(got.ua!.filter((m): m is Extract<ServerMessage, { t: 'player' }> => m.t === 'player').pop()!.player.npcMarkers[adv.questDef(opening)!.giverNpcId!]).toBe('quest'));
    // Each sees the introduction once; the story begins once, for both.
    for (const u of ['ua', 'ub']) expect(got[u]!.filter((m) => m.t === 'narration' && m.style === 'intro')).toHaveLength(1);
    const main = Object.keys(s.quests).find((id) => adv.questDef(id)?.main)!;
    expect(main).toBeTruthy();
    expect(Object.keys(s.quests).filter((id) => adv.questDef(id)?.main)).toHaveLength(1);
    // Bob does the first step; it is done for Ann too, and both hear of it in the journal.
    const giver = adv.questDef(main)!.objectives[0]!.npcId!;
    await adv.dialogue.open('ub', giver);
    expect(s.quests[main]!.objectives[adv.questDef(main)!.objectives[0]!.id]!.done).toBe(true);
    await adv.dialogue.say('ub', 'My birthday is tomorrow, will you remember?');
    adv.dialogue.close('ub');
    // People remember heroes: the one who spoke, not the account.
    expect(s.npcs[giver]!.memories.some((m) => m.about === bob.party[0]!.id && m.aboutName === 'Bob')).toBe(true);
    expect(s.conversations[giver]!.some((t) => t.speaker === 'player' && t.hero === 'Bob')).toBe(true);
    expect(got.ua!.some((m) => m.t === 'journal')).toBe(true);
    const views = (u: string) => got[u]!.filter((m): m is Extract<ServerMessage, { t: 'player' }> => m.t === 'player');
    // Quest items go to the shared pouch, wherever they were found; other things to the finder's own bag.
    const questItem = Object.values(w.uniqueItems).find((u) => u.questItem)!;
    adv.handle('ub', { t: 'dev', action: 'item', ref: questItem.id });
    adv.handle('ub', { t: 'dev', action: 'gold', amount: 50 });
    expect(s.pouch.some((i) => i.uniqueId === questItem.id)).toBe(true);
    expect([...ann.inventory, ...bob.inventory].some((i) => i.uniqueId === questItem.id)).toBe(false);
    expect(bob.gold - ann.gold).toBe(50);
    await until(() => expect(views('ua').pop()!.player.pouch.some((i) => i.uniqueId === questItem.id)).toBe(true));
    // A story item the world put in a chest is the party's as soon as the chest is opened, even when the one who
    // opened it only looked inside: nobody waits on them to come back for it.
    const placed = Object.values(w.uniqueItems).find((u) => u.questItem && u.id !== questItem.id) ?? questItem;
    const bobLead = adv._charActors('ub')[0]!;
    const zone = adv._live(bob.zoneId);
    zone.map.features.set('test_chest', { id: 'test_chest', kind: 'chest', name: 'Chest', x: bobLead.x + 1, y: bobLead.y, lootTier: 1, items: [placed.id] });
    s.pouch = s.pouch.filter((i) => i.uniqueId !== placed.id);
    adv.handle('ub', { t: 'interact', targetId: 'test_chest', charId: bobLead.id, inspect: true });
    expect(s.pouch.some((i) => i.uniqueId === placed.id)).toBe(true);
    expect(zone.rt.features.test_chest!.lootBy!.ub!.items.some((i) => i.uniqueId === placed.id)).toBe(false);
    expect(got.ua!.some((m) => m.t === 'toast' && m.text.includes(placed.name))).toBe(true);
    // A hero can be let fight on their own by its player, and only by them; out of fights the party still follows its
    // leader, so the lead stays where it is.
    const lead = bob.leaderId;
    adv.handle('ub', { t: 'set_ai', charId: bob.party[0]!.id, ai: true });
    expect(bob.party[0]!.ai).toBe(true);
    expect(bob.leaderId).toBe(lead);
    adv.handle('ua', { t: 'set_ai', charId: bob.party[1]!.id, ai: true });
    expect(bob.party[1]!.ai).toBeFalsy();
    // Friends see each other's heroes in the roster, sent again within a second of a change: Health, who fights on
    // their own.
    bob.party[1]!.hp = 5;
    const seen = await until(() => {
      const ub = got.ua!.filter((m): m is Extract<ServerMessage, { t: 'roster' }> => m.t === 'roster').pop()!.players.find((p) => p.userId === 'ub')!;
      // (Health comes back a little each second out of a fight: a part of the most a hero has, whatever that is.)
      expect(ub.heroes[1]!.hp).toBeLessThan(ub.heroes[1]!.maxHp / 2);
      return ub;
    });
    expect(seen.heroes.map((h) => h.name)).toEqual(['Bob', 'Cy']);
    expect(seen.heroes[0]!.ai).toBe(true);
    expect(seen.heroes[1]!.maxHp).toBeGreaterThan(30);
    // A display name changed on the account since is what friends see once the player comes in again.
    adv.join({ userId: 'ub', name: 'Robert', send: (m) => got.ub!.push(m) });
    expect(bob.name).toBe('Robert');
    expect(got.ua!.filter((m): m is Extract<ServerMessage, { t: 'roster' }> => m.t === 'roster').pop()!.players.find((p) => p.userId === 'ub')!.name).toBe('Robert');
    adv.leave({ userId: 'ua', send: () => {} } as never);
  }, 120_000);

  it('checks the room for heroes at joining, starts new heroes where the others are, and can let a player go', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'uc', 'Cat', 'room', [hero(w, 'Cat', 'melee'), hero(w, 'Dot', 'ranged')]);
    const got: Record<string, ServerMessage[]> = { uc: [], ud: [], ue: [] };
    const conn = (u: string) => ({ userId: u, send: (m: ServerMessage) => got[u]!.push(m), close: () => got[u]!.push({ t: 'log', text: 'closed' }) });
    expect(adv.join(conn('uc'))).toBe(true);
    adv.handle('uc', { t: 'dev', action: 'level', level: 5 });
    // No heroes yet: make them first.
    expect(adv.join(conn('ud'))).toBe(false);
    expect(got.ud!.pop()).toMatchObject({ t: 'error', code: 'heroes' });
    // Heroes made now start at the level of those in the game, with gear of it and points to spend.
    const d = adv.addPlayer('ud', 'Dee', [hero(w, 'Eli', 'melee'), hero(w, 'Fay', 'ranged'), hero(w, 'Gus', 'melee'), hero(w, 'Hal', 'melee'), hero(w, 'Ida', 'ranged')]);
    expect(d.party.every((c) => c.level === 5 && c.treePoints > 0)).toBe(true);
    expect(Object.values(d.party[0]!.equipment).every((it) => !it || it.level === 5)).toBe(true);
    // Two heroes in the game and five more would be seven: not until fewer come along.
    expect(adv.join(conn('ud'))).toBe(false);
    expect(got.ud!.pop()).toMatchObject({ t: 'error', code: 'full' });
    d.bench.push(...d.party.splice(3));
    expect(adv.join(conn('ud'))).toBe(true);
    expect(adv.heroesInGame()).toBe(5);
    // Letting a player go ends their connection; their heroes stay with the adventure.
    adv.kick('ud', 'You are no longer part of this adventure.');
    expect(got.ud!.slice(-2)).toMatchObject([{ t: 'error', code: 'removed' }, { t: 'log', text: 'closed' }]);
    expect(adv.state.players.ud!.party).toHaveLength(3);
  }, 120_000);

  it("keeps a dropped player's heroes with the AI for a while, gives them back on return, then lets them go", async () => {
    Adventure.awayMs = 300;
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'uf', 'Fen', 'away', [hero(w, 'Fen', 'melee')]);
    adv.addPlayer('ug', 'Gil', [hero(w, 'Gil', 'ranged')]);
    const fen: ServerMessage[] = [];
    adv.join({ userId: 'uf', send: (m) => fen.push(m) });
    const gil = { userId: 'ug', send: () => {} };
    adv.join(gil);
    const roster = () => (fen.filter((m) => m.t === 'roster').pop() as Extract<ServerMessage, { t: 'roster' }>).players.find((p) => p.userId === 'ug')!;
    expect(roster()).toMatchObject({ online: true, color: expect.stringMatching(/^#/) });
    // Gil drops out: his hero stays, played by the AI.
    adv.leave(gil);
    const [g] = adv._charActors('ug') as CharActor[];
    expect(g?.aiDriven()).toBe(true);
    expect(roster()).toMatchObject({ online: false, away: true });
    // Back in time: the same hero, his again.
    adv.join(gil);
    expect(adv._charActors('ug')[0]).toBe(g);
    expect(g!.aiDriven()).toBe(false);
    // Gone for longer: the hero leaves the game and the story remembers when he left.
    adv.leave(gil);
    await until(() => expect(adv._charActors('ug')).toHaveLength(0));
    expect(roster()).toMatchObject({ online: false });
    expect(adv.state.players.ug!.leftAt).toBeDefined();
    // The story moves on without him; coming back, he hears what happened.
    adv.state.clock += 5;
    const main = adv.state.quests[Object.keys(adv.state.quests).find((id) => adv.questDef(id)?.main)!]!;
    adv.handle('uf', { t: 'dev', action: 'quest', questId: main.questId, op: 'complete' });
    const back: ServerMessage[] = [];
    const gilAgain = { userId: 'ug', send: (m: ServerMessage) => back.push(m) };
    adv.join(gilAgain);
    await until(() => expect(back.some((m) => m.t === 'narration' && m.title === 'The story so far' && m.text.length > 10)).toBe(true));
    // Leaving on purpose takes the hero out at once.
    Adventure.awayMs = 60_000;
    adv.handle('ug', { t: 'leave' });
    adv.leave(gilAgain);
    await until(() => expect(adv._charActors('ug')).toHaveLength(0));
    // Dropped, then changing heroes on the adventure's page: the kept ones leave now, so the new choice comes back.
    adv.join(gilAgain);
    adv.leave(gilAgain);
    expect(adv._charActors('ug')).toHaveLength(1);
    expect(adv.settleAway('ug')).toBeNull();
    expect(adv._charActors('ug')).toHaveLength(0);
    adv.leave({ userId: 'uf', send: () => {} } as never);
  }, 120_000);
});

describe('talking together', () => {
  it('lets a friend join a conversation, speak in it, and stay when the first one leaves', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'uj', 'Jo', 'talk', [hero(w, 'Jo', 'melee')]);
    adv.addPlayer('uk', 'Kit', [hero(w, 'Kit', 'ranged')]);
    const got: Record<string, ServerMessage[]> = { uj: [], uk: [] };
    for (const u of ['uj', 'uk']) adv.join({ userId: u, send: (m) => got[u]!.push(m) });
    const npc = w.npcs.find((n) => n.zoneId === w.startZoneId)!;
    await adv.dialogue.open('uj', npc.id);
    // Kit hears that Jo is talking with them, and joins.
    const scenes = got.uk!.filter((m): m is Extract<ServerMessage, { t: 'scenes' }> => m.t === 'scenes').pop()!.scenes;
    expect(scenes).toEqual([expect.objectContaining({ npcId: npc.id, userIds: ['uj'], heroes: ['Jo'] })]);
    await adv.dialogue.open('uk', npc.id);
    await adv.dialogue.say('uk', 'Hello, what news?');
    const last = (u: string) => (got[u]!.filter((m): m is Extract<ServerMessage, { t: 'dialog' }> => m.t === 'dialog').pop()!.dialog);
    // Both see Kit's line, with his name, and the answer.
    for (const u of ['uj', 'uk']) expect(last(u)?.messages.some((m) => m.speaker === 'player' && m.name === 'Kit' && m.text === 'Hello, what news?')).toBe(true);
    // Jo walks off; the conversation goes on for Kit.
    adv.dialogue.close('uj');
    expect(last('uj')).toBeNull();
    expect(adv.dialogue.session('uk')?.members.has('uk')).toBe(true);
    expect(last('uk')?.messages.some((m) => m.speaker === 'narrator' && m.text.includes('Jo leaves'))).toBe(true);
    for (const u of ['uj', 'uk']) adv.leave({ userId: u, send: () => {} } as never);
  }, 120_000);
});

describe('fighting together', () => {
  it('lets heroes whose turns come together act at once, splits experience among them and gives each drop to one player', async () => {
    Combat.instant = false;
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'uh', 'Hal', 'together', [hero(w, 'Hal', 'melee')]);
    adv.addPlayer('ui', 'Ivy', [hero(w, 'Ivy', 'ranged')]);
    adv.join({ userId: 'uh', send: () => {} });
    adv.join({ userId: 'ui', send: () => {} });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    for (const u of ['uh', 'ui']) adv.handle(u, { t: 'dev', action: 'goto', zoneId: wild.id });
    const zone = adv._live(wild.id);
    const [hal] = adv._charActors('uh') as CharActor[];
    const [ivy] = adv._charActors('ui') as CharActor[];
    for (const u of ['uh', 'ui']) adv.handle(u, { t: 'dev', action: 'god', on: true });
    const monster = [...zone.actors.values()].find((x) => x instanceof MonsterActor && x.alive()) as MonsterActor;
    hal!.x = ivy!.x = monster.x + 1.5;
    hal!.y = monster.y;
    ivy!.y = monster.y + 1;
    const combat = adv.startCombat(zone as never, monster, hal!)!;
    expect(combat.participants()).toEqual(expect.arrayContaining([hal, ivy]));
    // The heroes come first and share the turn; each ends their own, then the creatures act.
    combat.order = [hal!, ivy!, ...combat.order.filter((x) => x !== hal && x !== ivy)];
    combat.idx = combat.order.length - 1;
    combat.advance();
    expect(combat.acting).toEqual(expect.arrayContaining([hal, ivy]));
    expect(combat.view().actingIds).toHaveLength(2);
    expect(combat.actingFor('ui')).toBe(ivy);
    adv.handle('uh', { t: 'end_turn' });
    expect(combat.acting).toEqual([ivy]);
    adv.handle('ui', { t: 'end_turn' });
    expect(combat.acting.every((x) => x instanceof MonsterActor)).toBe(true);
    // Defeating the pack: heroes alike get alike shares of the experience (one behind would catch up faster), and each
    // drop belongs to one of the players.
    ivy!.ch.xp = hal!.ch.xp;
    ivy!.ch.level = hal!.ch.level;
    const [xh, xi] = [hal!.ch.xp, ivy!.ch.xp];
    adv.handle('uh', { t: 'dev', action: 'kill' });
    expect(hal!.ch.xp - xh).toBeGreaterThan(0);
    expect(hal!.ch.xp - xh).toBe(ivy!.ch.xp - xi);
    const piles = adv.state.zones[wild.id]!.loot.filter((l) => !l.corpse);
    expect(piles.every((l) => l.ownerUserId === 'uh' || l.ownerUserId === 'ui')).toBe(true);
    Combat.instant = true;
    for (const u of ['uh', 'ui']) adv.leave({ userId: u, send: () => {} } as never);
  }, 120_000);
});

describe('fleeing', () => {
  it('carries the fallen along instead of ending in defeat', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    const adv = adventures.create(w, 'uf', 'Tester', 'flee', [hero(w, 'Ana', 'melee'), hero(w, 'Bo', 'ranged')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'uf', send: (m) => msgs.push(m) });
    const p = adv.state.players.uf!;
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    const [a, b] = adv._charActors('uf') as CharActor[];
    a!.x = monster.x + 1.2;
    a!.y = monster.y;
    adv.handle('uf', { t: 'use_skill', charId: a!.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    // Bo is down; Ana gets clear of the pack and flees on her turn.
    b!.ch.downed = true;
    b!.ch.hp = 0;
    for (const e of combat.participants()) if (e instanceof MonsterActor) e.x = a!.x + 30;
    combat.acting = [a!];
    adv.handle('uf', { t: 'flee' });
    expect(a!.combatId).toBeNull();
    expect(b!.combatId).toBeNull();
    expect(msgs.some((m) => m.t === 'narration' && m.style === 'death')).toBe(false);
    expect(p.zoneId).toBe(wild.id);
    // Bo gets up a few seconds later (the out-of-fight tick runs each second). The pack, moved off by hand rather than
    // left behind by the retreat, walks home past Ana: peace keeps it from starting another fight meanwhile.
    adv.handle('uf', { t: 'dev', reqId: 1, action: 'peace', on: true });
    await until(() => expect(b!.ch.downed).toBe(false));
  }, 300_000);
});

describe('a fight among several players', () => {
  it('takes a hero who comes close into this round, among the turns still to come', async () => {
    Combat.instant = true;
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'uj', 'Jo', 'join', [hero(w, 'Jo', 'melee')]);
    adv.addPlayer('uk', 'Kit', [hero(w, 'Kit', 'ranged')]);
    for (const u of ['uj', 'uk']) adv.join({ userId: u, send: () => {} });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    for (const u of ['uj', 'uk']) adv.handle(u, { t: 'dev', action: 'goto', zoneId: wild.id });
    for (const u of ['uj', 'uk']) adv.handle(u, { t: 'dev', action: 'god', on: true });
    const zone = adv._live(wild.id);
    const [jo] = adv._charActors('uj') as CharActor[];
    const [kit] = adv._charActors('uk') as CharActor[];
    const monster = [...zone.actors.values()].find((x) => x instanceof MonsterActor && x.alive()) as MonsterActor;
    jo!.x = monster.x + 1.5;
    jo!.y = monster.y;
    kit!.x = monster.x + 60;
    kit!.y = monster.y;
    const combat = adv.startCombat(zone as never, monster, jo!)!;
    expect(combat.participants()).not.toContain(kit);
    // Kit walks up while the fight is under way: in the order at once, after the turn at hand, so Kit acts this round.
    kit!.x = monster.x + 3;
    kit!.y = monster.y + 1;
    const round = combat.round;
    adv.startCombat(zone as never, monster, kit!);
    expect(combat.round).toBe(round);
    expect(combat.order).toContain(kit);
    expect(combat.order.indexOf(kit!)).toBeGreaterThan(combat.idx);
    expect(kit!.combatId).toBe(combat.id);
    expect(combat.view().order.map((o) => o.id)).toContain(kit!.id);
    Combat.instant = true;
    for (const u of ['uj', 'uk']) adv.leave({ userId: u, send: () => {} } as never);
  }, 120_000);

  it('retreats as one side: everyone fades out and gathers out of every creature\'s reach, the fallen of every player too', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    const adv = adventures.create(w, 'ur', 'Rae', 'retreat', [hero(w, 'Rae', 'melee')]);
    adv.addPlayer('us', 'Sol', [hero(w, 'Sol', 'ranged')]);
    const msgs: Record<string, ServerMessage[]> = { ur: [], us: [] };
    for (const u of ['ur', 'us']) adv.join({ userId: u, send: (m) => msgs[u]!.push(m) });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    for (const u of ['ur', 'us']) adv.handle(u, { t: 'dev', action: 'goto', zoneId: wild.id });
    adv.handle('ur', { t: 'dev', action: 'god', on: true });
    const zone = adv._live(wild.id);
    const [rae] = adv._charActors('ur') as CharActor[];
    const [sol] = adv._charActors('us') as CharActor[];
    const monster = [...zone.actors.values()].find((x) => x instanceof MonsterActor && x.alive()) as MonsterActor;
    rae!.x = sol!.x = monster.x + 1.5;
    rae!.y = monster.y;
    sol!.y = monster.y + 1;
    const combat = adv.startCombat(zone as never, monster, rae!)!;
    expect(combat.participants()).toEqual(expect.arrayContaining([rae, sol]));
    // Sol, the only hero of their player, is down; Rae calls the retreat while the pack is close enough to notice them.
    sol!.ch.downed = true;
    sol!.ch.hp = 0;
    const pack = combat.participants().filter((x): x is MonsterActor => x instanceof MonsterActor);
    rae!.x = Math.max(...pack.map((m) => m.x)) + 7.5;
    rae!.y = monster.y;
    combat.acting = [rae!];
    for (const u of ['ur', 'us']) msgs[u]!.length = 0;
    adv.handle('ur', { t: 'flee' });
    expect(combat.ended).toBe(true);
    expect(rae!.combatId).toBeNull();
    expect(sol!.combatId).toBeNull();
    // Nobody was defeated; both gathered together out of reach of every creature in the place, and say so on screen.
    expect(Object.values(msgs).flat().some((m) => m.t === 'narration' && m.style === 'death')).toBe(false);
    expect(msgs.us!.some((m) => m.t === 'toast' && /retreat/.test(m.text))).toBe(true);
    expect(msgs.us!.some((m) => m.t === 'fx' && m.events.some((e) => e.kind === 'relocate' && e.targetId === sol!.id))).toBe(true);
    expect(adv.state.players.us!.zoneId).toBe(wild.id);
    expect(Math.hypot(sol!.x - rae!.x, sol!.y - rae!.y)).toBeLessThan(3);
    const foes = [...zone.actors.values()].filter((x): x is MonsterActor => x instanceof MonsterActor && x.alive());
    for (const m of foes) expect(Math.hypot(m.x - rae!.x, m.y - rae!.y)).toBeGreaterThan(6.5);
    expect(pack.every((m) => m.hp === m.stats().maxHp)).toBe(true);
    // Sol gets up beside Rae, and no fight starts while they stand there.
    await until(() => expect(sol!.ch.downed).toBe(false));
    expect(adv._combats()).toHaveLength(0);
    for (const u of ['ur', 'us']) adv.leave({ userId: u, send: () => {} } as never);
  }, 300_000);
});

describe('combat movement', () => {
  it('lets allies squeeze past each other at a cost, but never stand together', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    const adv = adventures.create(w, 'ua', 'Tester', 'ally pass', [hero(w, 'Ana', 'melee'), hero(w, 'Bo', 'ranged')]);
    adv.join({ userId: 'ua', send: () => {} });
    const p = adv.state.players.ua!;
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    const [a, b] = adv._charActors('ua') as CharActor[];
    a!.x = monster.x + 1.2;
    a!.y = monster.y;
    adv.handle('ua', { t: 'use_skill', charId: a!.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    // On a hero's turn nothing else moves: the creatures' opening turns are over.
    await until(() => expect(combat.isActing(a!) || combat.isActing(b!)).toBe(true));
    // Stand Ana on open ground near the fight, Bo a meter from her, with open ground a meter beyond him.
    const dirs = [[1, 0], [-1, 0], [0, 1], [0, -1]] as const;
    const open = (p: { x: number; y: number }, [x, y]: readonly [number, number]) => [0, 1, 2].every((k) => combat.standable(a!, { x: p.x + x * k, y: p.y + y * k }));
    const spots = Array.from({ length: 21 * 21 }, (_, i) => ({ x: monster.x + (i % 21) - 10, y: monster.y + Math.floor(i / 21) - 10 }));
    const spot = spots.find((p) => dirs.some((d) => open(p, d)))!;
    const [dx, dy] = dirs.find((d) => open(spot, d))!;
    [a!.x, a!.y] = [spot.x, spot.y];
    b!.x = a!.x + dx!;
    b!.y = a!.y + dy!;
    expect(combat.occupant({ x: b!.x + 0.3, y: b!.y }, a)).toBe(b);
    // Nobody stops inside someone else.
    expect(combat.pathFor(a!, { x: b!.x, y: b!.y })).toBeNull();
    const beyond = { x: b!.x + dx!, y: b!.y + dy! };
    expect(combat.pathFor(a!, beyond)).not.toBeNull();
    // Walking straight through Bo costs extra for every meter within his body (sampled each quarter meter).
    const inside = [0.25, 0.5, 0.75, 1, 1.25, 1.5, 1.75, 2].filter((t) => Math.abs(t - 1) < SPACING - 0.01).length * 0.25;
    expect(combat.pathCost(a!, [beyond])).toBeCloseTo(2 + inside * SQUEEZE, 5);
  }, 300_000);
});

describe('defeat', () => {
  it('wakes the party in town at once, losing what the world says', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    w.ruleset.death = { recover: false, goldLoss: 0.25, xpLoss: 0.25 };
    const adv = adventures.create(w, 'ud', 'Tester', 'defeat', [hero(w, 'Ana', 'melee'), hero(w, 'Bo', 'ranged')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'ud', send: (m) => msgs.push(m) });
    const p = adv.state.players.ud!;
    const town = p.zoneId;
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    const monster = [...adv._live(wild.id).actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    const heroes = adv._charActors('ud') as CharActor[];
    heroes[0]!.x = monster.x + 1.2;
    heroes[0]!.y = monster.y;
    adv.handle('ud', { t: 'use_skill', charId: heroes[0]!.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    p.gold = 100;
    const bag = p.inventory.length;
    for (const h of heroes) h.ch.xp = 60;
    for (const h of heroes) {
      h.ch.downed = true;
      h.ch.hp = 0;
    }
    combat.checkEnd();
    // Already home, so the creatures that won cannot start another fight with the healed party where it fell.
    expect(p.zoneId).toBe(town);
    expect(heroes.every((h) => h.ch.hp > 0)).toBe(true);
    expect(p.gold).toBe(75);
    expect(heroes.map((h) => h.ch.xp)).toEqual([45, 45]);
    // Nothing to go back for: the pack came along.
    expect(p.inventory.length).toBe(bag);
    expect(adv.state.zones[wild.id]!.loot.some((l) => l.corpse)).toBe(false);
    expect(msgs.some((m) => m.t === 'narration' && m.style === 'death')).toBe(true);
    adv.leave({ userId: 'ud', send: () => {} } as never);
  }, 300_000);
});

describe('stun', () => {
  it('takes the whole turn: no action points and no acting', async () => {
    Combat.instant = true;
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    if (!w.ruleset.statuses.some((s) => s.control === 'stun')) w.ruleset.statuses.push({ id: 'st_test_stun', name: 'Dazed', color: '#ffffff', description: '', harmful: true, control: 'stun' } as never);
    const stun = w.ruleset.statuses.find((s) => s.control === 'stun')!;
    const adv = adventures.create(w, 'us', 'Tester', 'stun', [hero(w, 'Ana', 'melee')]);
    adv.join({ userId: 'us', send: () => {} });
    const p = adv.state.players.us!;
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    const monster = [...adv._live(wild.id).actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    const [ana] = adv._charActors('us') as CharActor[];
    ana!.x = monster.x + 1.2;
    ana!.y = monster.y;
    adv.handle('us', { t: 'use_skill', charId: ana!.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    ana!.statuses = [{ id: stun.id, turns: 1, power: 1 } as never];
    ana!.ap = 2;
    combat.order = [ana!, ...combat.order.filter((x) => x !== ana)];
    combat.idx = combat.order.length - 1;
    combat.advance();
    expect(combat.isActing(ana!)).toBe(false);
    expect(ana!.ap).toBe(2);
    // The lost turn was the stun's one turn: it is gone when that turn is over.
    expect(ana!.statuses.length).toBe(1);
    await until(() => expect(ana!.statuses).toEqual([]));
    adv.leave({ userId: 'us', send: () => {} } as never);
  }, 300_000);
});

describe('storage', () => {
  it('keeps items for each player at the town they were left in, within its slots, used only at the storage', async () => {
    const w = await genWorld('A quiet valley of mills and old shrines');
    w.ruleset.inventory.storage = 'each_town';
    const town = w.zones.find((z) => z.kind === 'town')!;
    if (!town.features.some((f) => f.kind === 'storage')) town.features.push({ id: `${town.id}_storage`, kind: 'storage', name: 'Storage', x: town.entry.x + 4, y: town.entry.y });
    const store = town.features.find((f) => f.kind === 'storage')!;
    const adv = adventures.create(w, 'us', 'Tester', 'storage', [hero(w, 'Ana', 'melee')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'us', send: (m) => msgs.push(m) });
    const p = adv.state.players.us!;
    const leader = (adv._charActors('us') as CharActor[])[0]!;
    const stand = (x: number, y: number) => ([leader.x, leader.y] = [x, y]);
    const toasts = () => msgs.filter((m) => m.t === 'toast').map((m) => (m as { text: string }).text);
    const rng = new Rng('storage');
    const gear = w.ruleset.items.filter((i) => i.category === 'equipment');
    p.inventory.push(...gear.slice(0, 2).map((g) => makeItem(w.ruleset, rng, g.id, 1, w.ruleset.rarities[0]!.id)));
    const item = p.inventory.at(-2)!;

    // Using the storage opens it.
    stand(store.x + 1, store.y);
    adv.handle('us', { t: 'interact', targetId: store.id });
    expect(msgs.some((m) => m.t === 'open' && m.panel === 'storage')).toBe(true);

    // In and out again, a whole stack at a time.
    adv.handle('us', { t: 'store_item', itemId: item.id, to: 'storage' });
    expect(p.inventory.some((i) => i.id === item.id)).toBe(false);
    expect(p.storage?.[town.id]?.map((i) => i.baseId)).toEqual([item.baseId]);
    const kept = p.storage![town.id]![0]!;

    // Away from it, nothing moves.
    stand(store.x + 12, store.y);
    adv.handle('us', { t: 'store_item', itemId: kept.id, to: 'bag' });
    expect(toasts()).toContain('That needs the storage in town.');
    expect(p.storage![town.id]).toHaveLength(1);

    stand(store.x + 1, store.y);
    adv.handle('us', { t: 'store_item', itemId: kept.id, to: 'bag' });
    expect(p.storage![town.id]).toHaveLength(0);
    expect(p.inventory.some((i) => i.baseId === item.baseId)).toBe(true);

    // Finite: a full store takes nothing more.
    w.ruleset.inventory.storageSlots = 0;
    const next = p.inventory.find((i) => !i.bound)!;
    adv.handle('us', { t: 'store_item', itemId: next.id, to: 'storage' });
    expect(toasts()).toContain('The storage is full.');
    expect(p.inventory.some((i) => i.id === next.id)).toBe(true);
    adv.leave({ userId: 'us', send: () => {} } as never);
  }, 300_000);
});

describe('following a friend', () => {
  it('lasts until the player gives their own party an order, and goes after the friend into other places', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const adv = adventures.create(w, 'ua', 'Ann', 'follow', [hero(w, 'Ann', 'melee')]);
    adv.addPlayer('ub', 'Bob', [hero(w, 'Bob', 'ranged')]);
    const got: Record<string, ServerMessage[]> = { ua: [], ub: [] };
    for (const u of ['ua', 'ub']) adv.join({ userId: u, send: (m) => got[u]!.push(m) });
    const [ann, bob] = [adv.state.players.ua!, adv.state.players.ub!];
    const following = () => got.ub!.filter((m): m is Extract<ServerMessage, { t: 'player' }> => m.t === 'player').pop()?.player.following;
    // The follower is told whom they follow, for the party display's button.
    adv.handle('ub', { t: 'follow', userId: 'ua' });
    await until(() => expect(following()).toBe('ua'));
    // Two players cannot follow each other.
    adv.handle('ua', { t: 'follow', userId: 'ub' });
    expect(got.ua!.some((m) => m.t === 'toast' && m.text === 'Bob is following you.')).toBe(true);
    // Going to something (a person, a pile, a chest) is the player's own errand: it ends following, which would
    // otherwise pull them back after their friend.
    const person = [...adv._live(bob.zoneId).actors.values()].find((x) => x instanceof NpcActor)!;
    adv.handle('ub', { t: 'interact', targetId: person.id });
    await until(() => expect(following()).toBe(null));
    // Followed again, Ann goes to another place: Bob goes after her.
    adv.handle('ub', { t: 'follow', userId: 'ua' });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(ann, wild.id);
    await until(() => expect(bob.zoneId).toBe(wild.id));
    expect(following()).toBe('ua');
    // A move of Bob's own ends it.
    const lead = adv._charActors('ub')[0]!;
    adv.handle('ub', { t: 'move', x: lead.x + 1, y: lead.y });
    await until(() => expect(following()).toBe(null));
    for (const u of ['ua', 'ub']) adv.leave({ userId: u, send: () => {} } as never);
  }, 120_000);
});

describe('aiming beyond reach', () => {
  it('walks into reach of a point on the ground before using a skill aimed there', async () => {
    Combat.instant = true;
    // A copy of the world, so the skill made a ground area here stays out of other tests.
    const w = structuredClone(await genWorld('A sunburnt frontier of mesas and copper mines'));
    const adv = adventures.create(w, 'ua', 'Tester', 'reach', [hero(w, 'Bo', 'ranged')]);
    const refusals: string[] = [];
    adv.join({ userId: 'ua', send: (m) => m.t === 'toast' && m.kind === 'bad' && refusals.push(m.text) });
    adv.handle('ua', { t: 'dev', action: 'god', on: true });
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(adv.state.players.ua!, wild.id);
    const me = adv._charActors('ua')[0] as CharActor;
    // A damage skill the hero knows (one of their own, or the first of their class's tree, learned here: a class's
    // first skill need not deal damage), aimed at the ground as ranged area skills are.
    const damaging = w.ruleset.skills.filter((s) => s.id !== 'attack' && s.effects.some((e) => e.kind === 'damage'));
    const skill = damaging.find((s) => me.skillIds().includes(s.id)) ?? damaging.find((s) => s.owner === me.ch.classId) ?? damaging[0]!;
    const node = w.ruleset.classes.flatMap((c) => c.nodes).find((n) => n.skillId === skill.id)!;
    if (!me.skillIds().includes(skill.id)) me.ch.tree[node.id] = 1;
    Object.assign(skill, { targeting: 'ground', range: 6, radius: 1.6, cooldown: 0 });
    const zone = adv._live(wild.id);
    const monster = [...zone.actors.values()].find((a) => a instanceof MonsterActor && a.alive()) as MonsterActor;
    me.x = monster.x + 1.2;
    me.y = monster.y;
    adv.handle('ua', { t: 'use_skill', charId: me.id, skillId: 'attack', targetId: monster.id });
    const combat = await fightStarts(adv);
    await until(() => expect(combat.isActing(me)).toBe(true));
    // Stand 8 m from the creature (2 m beyond the skill's reach), on open ground with a way toward it.
    const ring = Array.from({ length: 72 }, (_, i) => ({ x: monster.x + Math.cos((i / 36) * Math.PI) * 8, y: monster.y + Math.sin((i / 36) * Math.PI) * 8 }));
    const at = ring.find((p) => combat.standable(me, p) && combat.pathFor(me, { x: (p.x + monster.x * 2) / 3, y: (p.y + monster.y * 2) / 3 }));
    expect(at).toBeTruthy();
    [me.x, me.y] = [at!.x, at!.y];
    me.ap = 6;
    adv.handle('ua', { t: 'use_skill', charId: me.id, skillId: skill.id, x: monster.x, y: monster.y });
    await until(() => expect(me.ap).toBeLessThanOrEqual(6 - skill.ap));
    expect(refusals).not.toContain('Out of range.');
    expect(Math.hypot(me.x - monster.x, me.y - monster.y)).toBeLessThanOrEqual(6.01);
    adv.leave({ userId: 'ua', send: () => {} } as never);
  }, 300_000);
});
