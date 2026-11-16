import { describe, expect, it } from 'vitest';
import type { WorldDefinition } from '@daydream/shared';
import { genWorld } from './helpers.ts';
import { StepFailed, checkWorldQuests } from '../src/worldgen/build.ts';
import { checkQuests, questVerdict } from '../src/worldgen/questcheck.ts';

const mainQuests = (w: WorldDefinition) => w.quests.filter((q) => q.main);

describe('quest check', () => {
  it('passes a built world and finds quests that cannot be finished', async () => {
    const built = await genWorld('A misty river delta of stilt towns and drowned temples');
    expect(checkQuests(built)).toEqual([]);
    const texts = (w: WorldDefinition) => checkQuests(w).map((p) => p.text).join(' | ');

    // An item delivered in one story quest and asked for again in the next is gone.
    let w = structuredClone(built);
    const [a, b] = mainQuests(w);
    const u = 'u_test_letter';
    w.uniqueItems[u] = { id: u, baseId: 'quest_item', name: 'Sealed Letter', description: 'A letter.', rarityId: w.ruleset.rarities[0]!.id, mods: [], questItem: true };
    w.zones.find((z) => z.id === w.startZoneId)!.features.push({ id: 'f_test_letter', kind: 'chest', name: 'Letter box', x: 5, y: 5, items: [u] });
    a!.objectives.push({ id: 'ox', type: 'deliver', description: 'Hand it over', itemUniqueId: u, npcId: a!.giverNpcId, count: 1 });
    b!.objectives.unshift({ id: 'oy', type: 'deliver', description: 'Hand it over again', itemUniqueId: u, npcId: b!.giverNpcId, count: 1 });
    expect(checkQuests(w).map((p) => [p.questId, p.objectiveId])).toEqual([[b!.id, 'oy']]);
    expect(texts(w)).toMatch(/already handed over/);

    // Creatures to fight where none live, a place no way out leads to.
    w = structuredClone(built);
    const q = mainQuests(w)[0]!;
    const town = w.zones.find((z) => z.kind === 'town')!;
    const wild = w.zones.find((z) => z.kind !== 'town')!;
    q.objectives.push({ id: 'ok', type: 'kill', description: 'Clear them from the square', familyId: w.families[0]!.id, zoneId: town.id, count: 3 });
    for (const z of w.zones) z.features = z.features.filter((f) => !(f.kind === 'exit' && f.targetZoneId === wild.id));
    expect(texts(w)).toMatch(/live in/);
    expect(texts(w)).toMatch(/no way out leads/);

    // A ring of prerequisites never starts.
    w = structuredClone(built);
    mainQuests(w)[0]!.prerequisites = [mainQuests(w).at(-1)!.id];
    expect(texts(w)).toMatch(/ring/);

    // A person to defeat (people are not fought); an item on a quest foe that only appears with a later quest.
    w = structuredClone(built);
    const [first, ...rest] = mainQuests(w);
    first!.objectives.push({ id: 'op', type: 'kill_unique', description: 'Defeat them', targetId: w.npcs[0]!.id });
    const late = rest.findLast((x) => x.objectives.some((o) => o.type === 'kill_unique' && w.bosses.some((b) => b.id === o.targetId)))!;
    const foe = w.bosses.find((b) => late.objectives.some((o) => o.targetId === b.id))!;
    foe.drops = [u];
    w.uniqueItems[u] = { id: u, baseId: 'quest_item', name: 'Sealed Letter', description: 'A letter.', rarityId: w.ruleset.rarities[0]!.id, mods: [], questItem: true };
    first!.objectives.push({ id: 'oc', type: 'collect', description: 'Take the letter', itemUniqueId: u, count: 1 });
    expect(texts(w)).toMatch(/is a person/);
    expect(texts(w)).toMatch(/appears only with/);
  });
});

describe('the build after its quest check', () => {
  it('stops for a main story that cannot be finished, and only warns of a side quest, keeping both on the world', async () => {
    const built = await genWorld('A misty river delta of stilt towns and drowned temples');
    const said: string[] = [];
    const job = { push: (m: string) => void said.push(m) };
    const problemsOf = (w: WorldDefinition) => (w as WorldDefinition & { questProblems?: { questId: string }[] }).questProblems;

    // A sound world passes, with nothing kept on it.
    let w = structuredClone(built);
    checkWorldQuests(job, w);
    expect(problemsOf(w)).toBeUndefined();

    // A side quest that sends the party to a person who does not exist: a warning, kept on the world.
    const side = w.quests.find((q) => !q.main)!;
    side.objectives.push({ id: 'o_nobody', type: 'talk', description: 'Find them', npcId: 'n_nobody', count: 1 });
    expect(questVerdict(w)).toMatchObject({ story: [], side: [{ questId: side.id }] });
    said.length = 0;
    checkWorldQuests(job, w);
    expect(said.join('\n')).toMatch(/cannot be finished/);
    expect(problemsOf(w)!.map((p) => p.questId)).toEqual([side.id]);

    // A story whose quests wait on each other in a ring: the build stops, naming it.
    w = structuredClone(built);
    const main = mainQuests(w);
    main[0]!.prerequisites = [main.at(-1)!.id];
    expect(() => checkWorldQuests(job, w)).toThrow(StepFailed);
    expect(() => checkWorldQuests(job, w)).toThrow(/The main story cannot be finished: .*ring/);
    expect(problemsOf(w)!.length).toBeGreaterThan(0);
  });
});
