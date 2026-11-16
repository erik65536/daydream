import { describe, expect, it, vi } from 'vitest';
import type { ServerMessage, WorldDefinition } from '@daydream/shared';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { callContext } from '../src/genai/context.ts';
import { sanitizeSpeech } from '../src/game/dialogue.ts';

const THEME = 'A windswept island kingdom of fishing villages and sea caves';

/** A judge's reading of a line, neutral but for what a test sets. */
const verdict = (over: Record<string, unknown> = {}) => ({ response: 'talk', probability: 1, feeling: null, move: 'chat', remember: 0, asksWay: 0, asksWork: 0, about: null, convinces: null, accepts: 1, caught: 0, ...over });

/** An adventure of one hero, with what the player was sent. */
function play(w: WorldDefinition, name: string) {
  const adv = adventures.create(w, 'u1', 'Tester', name, [hero(w, 'Mara', 'melee')]);
  const got: ServerMessage[] = [];
  adv.join({ userId: 'u1', send: (m) => got.push(m) });
  const dialog = () => got.filter((m): m is Extract<ServerMessage, { t: 'dialog' }> => m.t === 'dialog').pop()?.dialog;
  const heroId = adv.state.players.u1!.party[0]!.id;
  const engine = adv.dialogue as unknown as Record<'judge' | 'speak' | 'greet', (...a: never[]) => Promise<unknown>>;
  const today = (adv as unknown as { day(): number }).day();
  return { adv, got, dialog, heroId, engine, today };
}

/** Someone no quest has anything to do with. */
const bystander = (w: WorldDefinition) => w.npcs.find((n) => n.greeting && !w.quests.some((q) => q.giverNpcId === n.id || q.objectives.some((o) => o.npcId === n.id)))!;
const said = (adv: ReturnType<typeof play>['adv'], npcId: string) => (adv.state.conversations[npcId] ?? []).filter((t) => t.speaker === 'npc').map((t) => t.text);

describe('a turn of conversation', () => {
  it('is whole: a case agreed to in words the player walked away from is still agreed to, and the words are kept', async () => {
    const w = await genWorld(THEME);
    const quest = w.quests.find((q) => !q.main && q.giverNpcId && !q.prerequisites.length)!;
    const giver = quest.giverNpcId!;
    quest.objectives = [{ id: 'o0', type: 'persuade', npcId: giver, description: 'Persuade them to lend the boat' }];
    const { adv, engine } = play(w, 'whole');
    expect(adv.quests.start(quest.id)).toBe(true);
    await adv.dialogue.open('u1', giver);
    vi.spyOn(engine, 'judge').mockResolvedValue(verdict({ move: 'persuade', convinces: 4 }));
    let answer!: (v: unknown) => void;
    const speak = vi.spyOn(engine, 'speak').mockReturnValue(new Promise((r) => (answer = r)));
    const turn = adv.dialogue.say('u1', 'I will bring it back by dusk and patch the hull myself.');
    await until(() => expect(speak).toHaveBeenCalled());
    // The player walks off while the words are written.
    adv.dialogue.close('u1');
    answer({ speech: 'All right. Take the boat.', agrees: true });
    await turn;
    expect(adv.state.quests[quest.id]!.status).toBe('completed');
    expect(said(adv, giver).at(-1)).toBe('All right. Take the boat.');
  }, 60000);

  it('answers with stock words that say what was decided when there is no model, and never gives in words alone', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv } = play(w, 'stock');
    const had = adv.state.players.u1!.inventory.length;
    await adv.dialogue.open('u1', npc.id);
    await adv.dialogue.say('u1', 'Do you have any work for me?');
    expect(said(adv, npc.id).at(-1)).toBe('I have nothing for you to do right now.');
    expect(adv.state.players.u1!.inventory.length).toBe(had);
    adv.dialogue.close('u1');
  }, 60000);

  it('greets someone as new once, though they said nothing the first time', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, dialog } = play(w, 'greeting');
    await adv.dialogue.open('u1', npc.id);
    adv.dialogue.close('u1');
    await adv.dialogue.open('u1', npc.id);
    expect(said(adv, npc.id)).toEqual([npc.greeting]);
    expect(dialog()!.messages.filter((m) => m.text === npc.greeting).length).toBe(1);
    expect(dialog()!.messages.at(-1)!.speaker).toBe('npc');
    adv.dialogue.close('u1');
  }, 60000);

  it('lets news move a person once, from the day it reaches them, and not what they saw themselves', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, heroId, today } = play(w, 'news');
    const rt = adv.state.npcs[npc.id]!;
    const elsewhere = w.zones.find((z) => z.kind !== 'town')!.id;
    const item = { heroIds: [heroId], witnesses: [] as string[], reach: 'world' as const };
    adv.state.news.push(
      // Talk of the town since yesterday; word from elsewhere, three days on its way, arriving today; and something they saw.
      { ...item, id: 'n1', day: today - 1, text: 'Mara mended the sea wall.', zoneId: rt.zoneId, tone: 'good' },
      { ...item, id: 'n2', day: today - 3, text: 'Mara cleared the caves.', zoneId: elsewhere, tone: 'good' },
      { ...item, id: 'n3', day: today, text: `Mara threatened ${npc.name}.`, zoneId: rt.zoneId, tone: 'bad', witnesses: [npc.id] },
    );
    // They last talked the day before yesterday's news reached them.
    rt.lastTalk = { [heroId]: today - 1 };
    for (let i = 0; i < 3; i++) {
      await adv.dialogue.open('u1', npc.id);
      adv.dialogue.close('u1');
    }
    expect(rt.regard[heroId]!.value).toBe(16);
  }, 60000);

  it('weighs what a hero does without words, takes no more gold than they still have, and tells of a threat once a day', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, engine, heroId } = play(w, 'offer');
    const p = adv.state.players.u1!;
    p.gold = 50;
    await adv.dialogue.open('u1', npc.id);
    // The gold is spent elsewhere while the judge reads the moment.
    const judge = vi.spyOn(engine, 'judge').mockImplementation(async () => ((p.gold = 3), verdict({ accepts: 1 })));
    await adv.dialogue.say('u1', '', { giveGold: 10 });
    expect(judge).toHaveBeenCalledTimes(1);
    expect(p.gold).toBe(0);
    judge.mockResolvedValue(verdict({ move: 'threaten', feeling: 1 }));
    await adv.dialogue.say('u1', 'Hand it over or else.');
    await adv.dialogue.say('u1', 'I mean it.');
    expect(adv.state.news.filter((n) => n.text.includes('threatened') && n.heroIds.includes(heroId)).length).toBe(1);
    adv.dialogue.close('u1');
  }, 60000);

  it('is over when it has ended: nothing more is said in it, and whoever comes next starts a new one', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv } = play(w, 'ended');
    adv.addPlayer('u2', 'Wen', [hero(w, 'Wen', 'ranged')]);
    adv.join({ userId: 'u2', send: () => {} });
    await adv.dialogue.open('u1', npc.id);
    await adv.dialogue.say('u1', 'Farewell, then.');
    const over = adv.dialogue.session('u1')!;
    expect(over.ended).toBe(true);
    const lines = adv.state.conversations[npc.id]!.length;
    await adv.dialogue.say('u1', 'One more thing: any work?');
    expect(adv.state.conversations[npc.id]!.length).toBe(lines);
    expect(adv.dialogue.scenes()).toEqual([]);
    await adv.dialogue.open('u2', npc.id);
    expect(adv.dialogue.session('u2')).not.toBe(over);
    expect(adv.dialogue.session('u2')!.ended).toBe(false);
    adv.dialogue.close('u1');
    adv.dialogue.close('u2');
  }, 60000);

  it('keeps a remembered day until the person has brought it up in their own words', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, engine, heroId, today } = play(w, 'memory');
    const memory = { id: 'm1', text: "Mara's birthday", about: heroId, aboutName: 'Mara', day: today - 2, dueDay: today - 1, fulfilled: false as boolean | undefined };
    adv.state.npcs[npc.id]!.memories.push(memory);
    // No model: a stock greeting, so the day is still to be brought up.
    await adv.dialogue.open('u1', npc.id);
    expect(memory.fulfilled).toBeFalsy();
    adv.dialogue.close('u1');
    vi.spyOn(engine, 'speak').mockResolvedValue({ speech: 'I missed your birthday yesterday. I am sorry.' });
    await adv.dialogue.open('u1', npc.id);
    expect(memory.fulfilled).toBe(true);
    adv.dialogue.close('u1');
  }, 60000);

  it('charges a greeting to the one who walked up when no message of theirs set it off', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, engine } = play(w, 'payer');
    let payer: string | undefined;
    vi.spyOn(engine, 'greet').mockImplementation(async () => void (payer = callContext()?.userId));
    await adv.dialogue.open('u1', npc.id);
    expect(payer).toBe('u1');
    adv.dialogue.close('u1');
  }, 60000);

  it('lets gold lift opinion to what a gift is worth, so a stream of small gifts buys nothing more', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const { adv, heroId } = play(w, 'gold');
    const p = adv.state.players.u1!;
    const regard = () => adv.state.npcs[npc.id]!.regard[heroId]?.value ?? 0;
    p.gold = 1000;
    await adv.dialogue.open('u1', npc.id);
    for (let i = 0; i < 6; i++) await adv.dialogue.say('u1', '', { giveGold: 1 });
    expect(regard()).toBe(0);
    for (let i = 0; i < 3; i++) await adv.dialogue.say('u1', '', { giveGold: 100 });
    expect(regard()).toBe(10);
    await adv.dialogue.say('u1', '', { giveGold: 500 });
    expect(regard()).toBe(20);
    expect(p.gold).toBe(1000 - 6 - 300 - 500);
    adv.dialogue.close('u1');
  }, 60000);

  it('offers a lead only the places the person would know: home, its neighbours, and the places of their quests', async () => {
    const w = await genWorld(THEME);
    const npc = bystander(w);
    const home = w.zones.find((z) => z.id === npc.zoneId)!;
    const far = w.zones.find((z) => z.id !== home.id && !home.links.includes(z.id))!;
    const { adv } = play(w, 'lead');
    const places = (id: string) => (adv.dialogue as unknown as { leadPlaces(def: unknown): { id: string }[] }).leadPlaces(w.npcs.find((n) => n.id === id)!).map((z) => z.id);
    expect(places(npc.id).sort()).toEqual([home.id, ...home.links].sort());
    expect(places(npc.id)).not.toContain(far.id);
    // Someone a quest sends the heroes from knows where it sends them.
    const quest = w.quests.find((q) => q.giverNpcId && q.objectives.some((o) => o.zoneId))!;
    for (const o of quest.objectives) if (o.zoneId) expect(places(quest.giverNpcId!)).toContain(o.zoneId);
  }, 60000);

  it('holds back a tag still being written, so growing words never shrink', () => {
    expect(sanitizeSpeech('Mira: Go north <em', 'Mira', true)).toBe('Go north');
    expect(sanitizeSpeech('Go north <em>now</em>', 'Mira', true)).toBe('Go north now');
  });
});

describe('side quests', () => {
  it('can be abandoned only while under way, with a line in the journal and the pin taken off', async () => {
    const w = await genWorld(THEME);
    const [a, b] = w.quests.filter((q) => !q.main && !q.prerequisites.length);
    const { adv } = play(w, 'abandon');
    const p = adv.state.players.u1!;
    adv.quests.start(a!.id);
    p.pinnedQuestId = a!.id;
    adv.quests.abandon(a!.id);
    expect(adv.state.quests[a!.id]).toBeUndefined();
    expect(p.pinnedQuestId).toBeUndefined();
    expect(adv.state.journal.some((j) => j.text === `Abandoned: ${a!.title}`)).toBe(true);
    // A quest that is done stays done.
    adv.quests.start(b!.id);
    adv.quests.complete(b!.id);
    adv.quests.abandon(b!.id);
    expect(adv.state.quests[b!.id]!.status).toBe('completed');
  }, 60000);
});
