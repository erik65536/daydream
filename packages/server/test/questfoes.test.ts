import { describe, expect, it } from 'vitest';
import type { ServerMessage, WorldDefinition } from '@daydream/shared';
import { genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import type { Adventure } from '../src/game/adventure.ts';
import { MonsterActor } from '../src/game/actors.ts';

const SETTING = 'A windswept island kingdom of fishing villages and sea caves';

/** A quest that sends the heroes to defeat a placed boss after a step of something else, not begun in a new adventure. */
function foeQuest(w: WorldDefinition, adv: Adventure) {
  for (const q of w.quests) {
    if (adv.state.quests[q.id]) continue;
    const at = q.objectives.findIndex((o) => o.type === 'kill_unique' && (o.step ?? 0) > 0);
    const o = q.objectives[at];
    const boss = o && w.bosses.find((b) => b.id === o.targetId);
    if (boss && w.zones.find((z) => z.id === boss.zoneId)?.spawns.some((s) => s.bossId === boss.id)) return { q, o, boss };
  }
  throw new Error('no quest to defeat a placed boss');
}

const bossIn = (adv: Adventure, zoneId: string, bossId: string) =>
  [...adv._live(zoneId).actors.values()].find((a): a is MonsterActor => a instanceof MonsterActor && a.boss?.id === bossId && a.alive());

describe('quest foes', () => {
  it('wait unseen until a quest sent to defeat them has begun', async () => {
    const w = await genWorld(SETTING);
    const adv = adventures.create(w, 'u1', 'Tester', 'foes wait', [hero(w, 'Mara')]);
    const { q, boss } = foeQuest(w, adv);
    expect(bossIn(adv, boss.zoneId, boss.id)).toBeUndefined();
    adv.quests.start(q.id);
    expect(bossIn(adv, boss.zoneId, boss.id)).toBeTruthy();
  });

  it('count when defeated before the quest comes to them', async () => {
    const w = await genWorld(SETTING);
    const adv = adventures.create(w, 'u1', 'Tester', 'foes count', [hero(w, 'Mara')]);
    const { q, o, boss } = foeQuest(w, adv);
    adv.quests.start(q.id);
    // Defeated while the quest is still on an earlier step: nothing yet.
    const foe = bossIn(adv, boss.zoneId, boss.id)!;
    adv.onDowned(foe, null);
    expect(adv.state.defeated).toContain(boss.id);
    expect(adv.state.quests[q.id]!.objectives[o.id]!.done).toBe(false);
    // What comes before it done (earlier steps, and its own way's objectives before it): it counts at once.
    for (const x of q.objectives.slice(0, q.objectives.indexOf(o)))
      if ((x.step ?? 0) < (o.step ?? 0) || x.way === o.way) adv.quests.completeObjective(q.id, x.id);
    expect(adv.state.quests[q.id]!.objectives[o.id]!.done).toBe(true);
  });
});

describe('narration during a conversation', () => {
  it('waits until the player leaves the conversation', async () => {
    const w = await genWorld(SETTING);
    const adv = adventures.create(w, 'u1', 'Tester', 'narration waits', [hero(w, 'Mara')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const p = adv.state.players.u1!;
    const npc = w.npcs.find((n) => n.zoneId === p.zoneId)!;
    await adv.dialogue.open('u1', npc.id);
    const told = () => msgs.filter((m) => m.t === 'narration' && m.title === 'A revelation');
    adv.narrate(['u1'], 'A revelation', 'The tide was never the problem.', 'arc');
    expect(told()).toHaveLength(0);
    adv.dialogue.close('u1');
    expect(told()).toHaveLength(1);
  });
});
