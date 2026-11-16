import { describe, expect, it } from 'vitest';
import type { EntityView, Ruleset, SkillDef, StatBlock } from '@daydream/shared';
import { aimVerdict, type Aiming } from '../src/render/aiming';

const who = (id: string, x: number, y: number, more: Partial<EntityView> = {}) => ({ id, x, y, kind: 'monster', hostile: true, ...more }) as EntityView;
const hero = (id: string, x: number, y: number, more: Partial<EntityView> = {}) => who(id, x, y, { kind: 'character', hostile: false, ...more });
const skill = (more: Partial<SkillDef>) => ({ targeting: 'ground', range: 6, tags: [], effects: [{ kind: 'damage', coef: 1 }], ...more }) as SkillDef;
const everyone = [hero('me', 0, 0), hero('friend', 5, 1), hero('down', 5, -1, { downed: true }), who('wolf', 5, 0), who('far', 9, 0), who('dead', 5, 0.5, { dead: true })];
const aim = (more: Partial<Aiming>): Aiming => ({
  r: { revive: 'item' } as unknown as Ruleset, stats: {} as StatBlock, from: { x: 0, y: 0 }, point: { x: 5, y: 0 }, sees: () => true, entities: everyone, at: (e) => e, ...more,
});

describe('the verdict on what is aimed', () => {
  it('reaches within range and in sight, with nothing to say', () => {
    const v = aimVerdict(aim({ skill: skill({}) }));
    expect(v).toMatchObject({ range: 6, reaches: true, walks: false, ok: true, note: null });
  });

  it('is still good beyond reach for a skill: its user walks into range first', () => {
    const v = aimVerdict(aim({ skill: skill({}), point: { x: 9, y: 0 } }));
    expect(v).toMatchObject({ reaches: false, walks: true, ok: true, note: { text: 'Walk into range', ok: true } });
  });

  it('is no good beyond reach or out of sight for an item', () => {
    expect(aimVerdict(aim({ thrown: skill({ range: 8 }), point: { x: 9, y: 0 } }))).toMatchObject({ ok: false, note: { text: 'Out of range', ok: false } });
    expect(aimVerdict(aim({ thrown: skill({ range: 8 }), sees: () => false }))).toMatchObject({ ok: false, note: { text: 'No line of sight', ok: false } });
  });

  it('needs no line of sight up close', () => {
    expect(aimVerdict(aim({ skill: skill({ range: 2 }), point: { x: 1.5, y: 0 }, sees: () => false })).reaches).toBe(true);
  });

  it('lands on its user when it is for them alone, wherever the pointer is', () => {
    const v = aimVerdict(aim({ skill: skill({ targeting: 'self', range: 0 }), point: null }));
    expect(v.center).toEqual({ x: 0, y: 0 });
    expect(v.ok).toBe(true);
  });

  it('has no verdict to give while the pointer is off the place', () => {
    expect(aimVerdict(aim({ skill: skill({}), point: null }))).toMatchObject({ center: null, ok: false, note: null });
  });

  it('catches the foes standing in a harmful area, not allies, the dead, or those beyond it', () => {
    const v = aimVerdict(aim({ skill: skill({ radius: 1.5 }) }));
    expect(v.harmful).toBe(true);
    expect(v.caught).toEqual(['wolf']);
  });

  it('catches the allies standing in a helpful area, the downed only when it raises them', () => {
    const heal = skill({ radius: 1.5, effects: [{ kind: 'heal', share: 0.2 }] as SkillDef['effects'] });
    expect(aimVerdict(aim({ skill: heal })).caught).toEqual(['friend']);
    expect(aimVerdict(aim({ skill: heal, r: { revive: 'heal' } as unknown as Ruleset })).caught).toEqual(['friend', 'down']);
  });
});
