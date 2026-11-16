import { describe, expect, it } from 'vitest';
import { SIGHT_RADIUS, type EntityView } from '@daydream/shared';
import { dimAt, eyesOf, heroesOf } from '../src/render/sight';

const who = (id: string, more: Partial<EntityView> = {}) => ({ id, x: 0, y: 0, kind: 'monster', hostile: true, ...more }) as EntityView;
const hero = (id: string, ownerUserId: string) => who(id, { kind: 'character', hostile: false, ownerUserId });
const ids = (list: EntityView[]) => list.map((e) => e.id);

describe('who a screen sees by', () => {
  const all = [hero('theirs', 'friend'), who('wolf'), hero('mine', 'me'), who('fighting', { inCombat: 'c1' }), who('fallen', { inCombat: 'c1', dead: true }), who('keeper', { kind: 'npc', hostile: false })];

  it('counts every player\'s heroes, the player\'s own first', () => {
    expect(ids(heroesOf(all, 'me'))).toEqual(['mine', 'theirs']);
    expect(ids(heroesOf(all, 'friend'))).toEqual(['theirs', 'mine']);
  });

  it('sees from every hero, whoever plays them', () => {
    expect(ids(eyesOf(all, false))).toEqual(['theirs', 'mine']);
  });

  it('sees from everyone standing in a fight while the player is in one', () => {
    expect(ids(eyesOf(all, true))).toEqual(['theirs', 'mine', 'fighting']);
  });

  it('leaves ground in sight clear and dims remembered ground smoothly past it', () => {
    expect(dimAt(0)).toBe(0);
    expect(dimAt(SIGHT_RADIUS)).toBe(0);
    const mid = dimAt(SIGHT_RADIUS + 2.5), far = dimAt(SIGHT_RADIUS + 5.01);
    expect(mid).toBeGreaterThan(0);
    expect(mid).toBeLessThan(far);
    expect(dimAt(SIGHT_RADIUS + 50)).toBe(far);
  });
});
