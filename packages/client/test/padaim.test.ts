import { describe, expect, it } from 'vitest';
import type { EntityView, Ruleset, SkillDef } from '@daydream/shared';
import { AIM_NEAR_M, aimPool, aimsAtAllies, nudge, snapNext, under } from '../src/input/padaim';

const who = (id: string, x: number, y: number, more: Partial<EntityView> = {}) => ({ id, x, y, kind: 'monster', hostile: true, ...more }) as EntityView;
const hero = (id: string, x: number, y: number, more: Partial<EntityView> = {}) => who(id, x, y, { kind: 'character', hostile: false, ...more });
const skill = (targeting: SkillDef['targeting']) => ({ targeting, effects: [] }) as unknown as SkillDef;
const ids = (list: EntityView[]) => list.map((e) => e.id);

describe('the controller cursor', () => {
  const me = { x: 0, y: 0 };

  it('aims what is used on an ally at allies, and anything else at foes', () => {
    const r = {} as Ruleset;
    expect(aimsAtAllies(r, skill('ally'))).toBe(true);
    expect(aimsAtAllies(r, skill('enemy'))).toBe(false);
    expect(aimsAtAllies(r, undefined)).toBe(false);
  });

  it('snaps between the heroes for what helps, the nearest first, the downed too but not the dead', () => {
    const all = [hero('far', 6, 0), hero('self', 0, 0), hero('down', 2, 0, { downed: true }), hero('gone', 1, 0, { dead: true }), who('foe', 1, 1)];
    expect(ids(aimPool(all, me, true, false))).toEqual(['self', 'down', 'far']);
  });

  it('snaps between the foes fighting in a fight, however far', () => {
    const all = [who('a', 20, 0, { inCombat: 'c1' }), who('b', 3, 0, { inCombat: 'c1' }), who('idle', 1, 0), who('dead', 2, 0, { inCombat: 'c1', dead: true }), hero('h', 0, 1)];
    expect(ids(aimPool(all, me, false, true))).toEqual(['b', 'a']);
  });

  it('snaps between the foes near outside a fight', () => {
    const all = [who('near', 4, 0), who('edge', AIM_NEAR_M, 0), who('far', AIM_NEAR_M + 1, 0)];
    expect(ids(aimPool(all, me, false, false))).toEqual(['near', 'edge']);
  });

  it('goes round the pool from the one it rests on, and to the first from open ground', () => {
    const pool = [who('a', 1, 0), who('b', 2, 0), who('c', 3, 0)];
    expect(snapNext(pool, { x: 1, y: 0 }, 1)?.id).toBe('b');
    expect(snapNext(pool, { x: 3, y: 0 }, 1)?.id).toBe('a');
    expect(snapNext(pool, { x: 1, y: 0 }, -1)?.id).toBe('c');
    expect(snapNext(pool, { x: 9, y: 9 }, 1)?.id).toBe('a');
    expect(snapNext([], me, 1)).toBeUndefined();
  });

  it('moves a meter to one of eight sides', () => {
    expect(nudge(me, 1, 0)).toEqual({ x: 1, y: 0 });
    expect(nudge(me, 0.1, -1)).toEqual({ x: 0, y: -1 });
    expect(nudge(me, -0.7, 0.7)).toEqual({ x: -1, y: 1 });
  });

  it('is on whoever stands within reach of it, never the dead', () => {
    const all = [who('dead', 5, 5, { dead: true }), who('there', 5.3, 5)];
    expect(under(all, { x: 5, y: 5 })?.id).toBe('there');
    expect(under(all, { x: 8, y: 8 })).toBeUndefined();
  });
});
