import { describe, expect, it } from 'vitest';
import { genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';

describe('quest work in conversations follows rules', () => {
  it('gives a side job to anyone who asks unless they are disliked, and a case is won by meeting their concerns, not by asking again', async () => {
    const w = structuredClone(await genWorld('A windswept island kingdom of fishing villages and sea caves'));
    const job = w.quests.find((q) => !q.main && q.giverNpcId && !q.prerequisites.length && !q.autoStart)!;
    const giver = job.giverNpcId!;
    // A second side job of the same person's becomes a case to put to them.
    const other = w.quests.find((q) => !q.main && q.id !== job.id && !q.prerequisites.length)!;
    other.objectives = [{ id: 'o0', type: 'persuade', npcId: giver, description: 'Persuade them to lend the boat' }];
    const adv = adventures.create(w, 'u1', 'Tester', 'rules', [hero(w, 'Mara', 'melee')]);
    adv.join({ userId: 'u1', send: () => {} });
    const rt = adv.state.npcs[giver]!;
    const heroId = adv.state.players.u1!.party[0]!.id;

    // Disliked: no work, however it is asked for.
    await adv.dialogue.open('u1', giver);
    rt.regard[heroId] = { value: -60, reasons: [] };
    await adv.dialogue.say('u1', 'Do you have any work for me?');
    expect(adv.state.quests[job.id]).toBeUndefined();
    // Not disliked: the job is given.
    rt.regard[heroId] = { value: 0, reasons: [] };
    await adv.dialogue.say('u1', 'Do you have any work for me?');
    expect(adv.state.quests[job.id]?.status).toBe('active');

    // Asking again and again moves nobody; a case argued at length does.
    expect(adv.quests.start(other.id)).toBe(true);
    for (let i = 0; i < 4; i++) await adv.dialogue.say('u1', 'Please, lend us the boat.');
    expect(adv.state.quests[other.id]!.objectives.o0?.done ?? false).toBe(false);
    await adv.dialogue.say('u1', 'I will bring it back by dusk, patch the hull myself, and leave my own net with you until then.');
    expect(adv.state.quests[other.id]!.status).toBe('completed');
    adv.dialogue.close('u1');
  }, 60000);
});
