/**
 * The controller's ground cursor: where it goes and whom it snaps to. One cursor serves a fight (to walk, attack and
 * aim) and aiming outside one (a skill or an item for an own hero or a spot on the ground). gamepad.ts moves it and
 * shows it; what is decided here needs no screen.
 */
import { isHarmful, type EntityView, type Ruleset, type SkillDef, type Vec2 } from '@daydream/shared';

/** How far (m) from the one aiming foes are snapped to outside a fight (in one, everyone fighting is). */
export const AIM_NEAR_M = 12;
/** How near (m) the cursor is to someone to be on them, and to count as resting on a target it snapped to. */
const ON_M = 0.6, SNAPPED_M = 0.3;

/** Whether what is aimed is for allies: used on one, or put on the ground to help. Anything else is aimed at foes. */
export function aimsAtAllies(r: Ruleset, skill: SkillDef | undefined): boolean {
  return !!skill && (skill.targeting === 'ally' || (skill.targeting === 'ground' && !isHarmful(r, skill.effects)));
}

/**
 * Those the cursor snaps between, nearest to `from` first: the heroes for what helps, else the foes (in a fight those
 * fighting, outside one those near).
 */
export function aimPool(entities: Iterable<EntityView>, from: Vec2, allies: boolean, fighting: boolean): EntityView[] {
  const d = (e: EntityView) => Math.hypot(e.x - from.x, e.y - from.y);
  const pool = [...entities].filter((e) => !e.dead && (allies ? e.kind === 'character' && !e.hostile : e.hostile && (fighting ? !!e.inCombat : d(e) <= AIM_NEAR_M)));
  return pool.sort((a, b) => d(a) - d(b));
}

/** The next of the pool after the one the cursor rests on (`dir` 1) or the one before it (-1), going round. */
export function snapNext<T extends Vec2>(pool: T[], cursor: Vec2, dir: 1 | -1): T | undefined {
  const at = pool.findIndex((e) => Math.hypot(e.x - cursor.x, e.y - cursor.y) < SNAPPED_M);
  return pool[(at + dir + pool.length) % Math.max(1, pool.length)];
}

/** The cursor a meter on the way the stick is pushed (to one of eight sides). */
export function nudge(cursor: Vec2, lx: number, ly: number): Vec2 {
  const len = Math.hypot(lx, ly) || 1, dx = lx / len, dy = ly / len;
  return { x: cursor.x + (Math.abs(dx) > 0.38 ? Math.sign(dx) : 0), y: cursor.y + (Math.abs(dy) > 0.38 ? Math.sign(dy) : 0) };
}

/** Whoever the cursor is on. */
export function under(entities: Iterable<EntityView>, cursor: Vec2): EntityView | undefined {
  for (const e of entities) if (!e.dead && Math.hypot(e.x - cursor.x, e.y - cursor.y) < ON_M) return e;
  return undefined;
}
