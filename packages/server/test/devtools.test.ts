import { describe, expect, it } from 'vitest';
import type { DevCommand, ServerMessage } from '@daydream/shared';
import { genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { Combat } from '../src/game/combat.ts';
import { MonsterActor } from '../src/game/actors.ts';

describe('developer commands', () => {
  it('set up any part of the game without playing up to it', async () => {
    Combat.instant = true;
    const w = await genWorld('A salt-marsh barony of reed villages and sunken abbeys');
    const adv = adventures.create(w, 'u1', 'Tester', 'dev run', [hero(w, 'Ash')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const p = adv.state.players.u1!;
    let req = 0;
    const dev = (cmd: DevCommand) => {
      const reqId = ++req;
      adv.handle('u1', { t: 'dev', reqId, ...cmd });
      const r = msgs.find((m): m is Extract<ServerMessage, { t: 'dev_result' }> => m.t === 'dev_result' && m.reqId === reqId);
      expect(r, `${cmd.action} answered`).toBeTruthy();
      return r!;
    };

    // The party: level, points, gold, items.
    expect(dev({ action: 'level', level: 6 }).ok).toBe(true);
    const ch = p.party[0]!;
    expect(ch.level).toBe(6);
    const points = ch.treePoints;
    dev({ action: 'points', amount: 3 });
    expect(ch.treePoints).toBe(points + 3);
    dev({ action: 'gold', amount: 250 });
    expect(p.gold).toBeGreaterThanOrEqual(250);
    const unique = Object.values(w.uniqueItems)[0]!;
    dev({ action: 'item', ref: unique.id });
    expect([...p.inventory, ...adv.state.pouch].some((i) => i.uniqueId === unique.id)).toBe(true);
    expect(dev({ action: 'item', ref: 'no_such_item' }).ok).toBe(false);
    ch.hp = 1;
    dev({ action: 'heal' });
    expect(ch.hp).toBeGreaterThan(1);

    // Creatures: spawn beside the party, and defeat them (experience, quest progress and loot as usual).
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    dev({ action: 'goto', zoneId: wild.id });
    expect(p.zoneId).toBe(wild.id);
    dev({ action: 'god', on: true });
    dev({ action: 'peace', on: true });
    const live = adv._live(wild.id);
    const before = [...live.actors.values()].filter((a) => a instanceof MonsterActor).length;
    expect(dev({ action: 'spawn', familyId: w.families[0]!.id, count: 3 }).ok).toBe(true);
    expect([...live.actors.values()].filter((a) => a instanceof MonsterActor && a.alive()).length).toBeGreaterThanOrEqual(before + 3);
    const xp = ch.xp;
    expect(dev({ action: 'kill', all: true }).text).toMatch(/Defeated/);
    expect([...live.actors.values()].some((a) => a instanceof MonsterActor && a.alive())).toBe(false);
    expect(ch.xp).toBeGreaterThan(xp);
    dev({ action: 'respawn' });
    // Every pack is back, fitted to the party again.
    const back = [...live.actors.values()].filter((a) => a instanceof MonsterActor && a.alive()).length;
    expect(back).toBeGreaterThan(0);
    expect(back).toBe(Object.values(adv.state.zones[wild.id]!.monsters).filter((m) => !m.absent && !m.dead).length);

    // Quests and the story.
    const main = w.quests.filter((q) => q.main);
    const third = main[2]!;
    expect(dev({ action: 'story', questId: third.id }).ok).toBe(true);
    expect(main.slice(0, 2).every((q) => adv.state.quests[q.id]?.status === 'completed')).toBe(true);
    expect(adv.state.quests[third.id]?.status).toBe('active');
    expect(adv.state.quests[main[3]!.id]).toBeUndefined();
    dev({ action: 'quest', questId: third.id, op: 'advance' });
    expect(Object.values(adv.state.quests[third.id]!.objectives).filter((o) => o.done).length).toBeGreaterThanOrEqual(1);
    dev({ action: 'quest', questId: third.id, op: 'complete' });
    expect(adv.state.quests[third.id]!.status).toBe('completed');
    expect(adv.state.quests[main[3]!.id]?.status).toBe('active');
    const side = w.quests.find((q) => !q.main)!;
    dev({ action: 'quest', questId: side.id, op: 'start' });
    expect(dev({ action: 'quest', questId: side.id, op: 'start' }).ok).toBe(false);
    dev({ action: 'quest', questId: side.id, op: 'reset' });
    expect(adv.state.quests[side.id]).toBeUndefined();
    const info = dev({ action: 'info' }).info!;
    expect(info.quests.find((q) => q.id === third.id)?.status).toBe('completed');
    expect(info.god).toBe(true);

    // The clock.
    dev({ action: 'time', day: 3, hour: 20 });
    expect(adv.day()).toBe(3);
    expect(adv.hour()).toBe(20);
  });
});
