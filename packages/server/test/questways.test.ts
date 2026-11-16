import { describe, expect, it } from 'vitest';
import { currentWays, onLastStep, passedBy, questSteps, type QuestDef, type QuestObjective, type QuestProgress } from '@daydream/shared';

const o = (id: string, step: number, way: number): QuestObjective => ({ id, type: 'talk', description: id, step, way });
/** Talk to A; then fight (one objective) or bring something (find it, then hand it over); then go back. */
const def: QuestDef = {
  id: 'q', title: 'Q', summary: '', main: false, level: 1, prerequisites: [], rewards: { xp: 0, gold: 0, items: [] },
  objectives: [o('talk', 0, 0), o('fight', 1, 0), o('find', 1, 1), o('hand', 1, 1), o('back', 2, 0)],
};
const prog = (...done: string[]): QuestProgress => ({ questId: 'q', status: 'active', log: [], startedDay: 0, objectives: Object.fromEntries(done.map((id) => [id, { progress: 1, done: true }])) });
const ids = (list: QuestObjective[]) => list.map((x) => x.id);

describe('quest steps and their ways', () => {
  it('groups objectives into steps of ways', () => {
    expect(questSteps(def).map((ways) => ways.map(ids))).toEqual([[['talk']], [['fight'], ['find', 'hand']], [['back']]]);
  });

  it('offers the next objective of each way, and either way does the step', () => {
    expect(ids(currentWays(def, prog()))).toEqual(['talk']);
    expect(ids(currentWays(def, prog('talk')))).toEqual(['fight', 'find']);
    // Halfway along one way: that way goes on, the other is still there.
    expect(ids(currentWays(def, prog('talk', 'find')))).toEqual(['fight', 'hand']);
    expect(ids(currentWays(def, prog('talk', 'find', 'hand')))).toEqual(['back']);
    expect(ids(currentWays(def, prog('talk', 'fight')))).toEqual(['back']);
    expect(currentWays(def, prog('talk', 'fight', 'back'))).toEqual([]);
  });

  it('knows the last step and the way not taken', () => {
    expect(onLastStep(def, prog('talk'))).toBe(false);
    expect(onLastStep(def, prog('talk', 'fight'))).toBe(true);
    const find = def.objectives[2]!;
    expect(passedBy(def, prog('talk'), find)).toBe(false);
    expect(passedBy(def, prog('talk', 'fight'), find)).toBe(true);
  });

  it('treats objectives without steps as a step each', () => {
    const plain: QuestDef = { ...def, objectives: [{ id: 'a', type: 'talk', description: 'a' }, { id: 'b', type: 'talk', description: 'b' }] };
    expect(questSteps(plain).map((ways) => ways.map(ids))).toEqual([[['a']], [['b']]]);
    expect(ids(currentWays(plain, prog('a')))).toEqual(['b']);
  });
});
