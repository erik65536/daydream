/** The current world's ruleset for drawing code (icons, fx, renderer) that runs outside React. */
import { rx, type FxLook, type FxMoves, type Ruleset } from '@daydream/shared';

let current: Ruleset | null = null;

export function setRules(r: Ruleset | null | undefined) {
  current = r ?? null;
}

export function rules(): Ruleset | null {
  return current;
}

/** Color of a kind of damage, a status, or 'heal'. */
export function kindColor(id: string | undefined, fallback = '#ffffff'): string {
  if (!id) return fallback;
  if (id === 'heal') return '#7dff9a';
  const r = current;
  if (!r) return fallback;
  const ix = rx(r);
  return ix.type.get(id)?.color ?? ix.status.get(id)?.color ?? fallback;
}

export function statusName(id: string): string {
  return (current && rx(current).status.get(id)?.name) ?? id;
}

/**
 * How a kind of damage (or 'heal') looks in this world's effects: the world's own look (its build's
 * fightLooks step), or, for a kind with no look, a plain one in its color.
 */
export function kindLook(id: string | undefined): FxLook {
  const r = current;
  const own = id ? r?.looks.kinds[id] : undefined;
  if (own) return own;
  const color = kindColor(id, '#ffffff');
  if (id === 'heal') return { shapes: ['mote', 'spark'], colors: [color, '#3fbf6a'], glow: true, motion: 'rise', trail: 'motes' };
  return { shapes: ['spark'], colors: [color], glow: true, motion: 'burst', trail: 'sparks' };
}

/**
 * How a kind of damage's skills move (its build's fightLooks step): its rush, its shot, and its blast. A kind with no
 * choice made rushes in dust, shoots arrows, and lands in a ring if it is the world's first kind (its physical one),
 * and blinks, shoots orbs, and lands in a ring otherwise.
 */
export function kindMoves(id: string | undefined): FxMoves {
  const r = current;
  const own = id ? r?.looks.moves?.[id] : undefined;
  if (own) return own;
  return id && r?.damageTypes[0]?.id === id ? { rush: 'dash', shot: 'arrow', blast: 'ring' } : { rush: 'blink', shot: 'orb', blast: 'ring' };
}

/** The look of the status a skill puts on someone, if it puts one (a buff or a weakening is drawn in its colors). */
export function skillStatusLook(skillId: string | undefined): FxLook | undefined {
  const sk = skillId && current ? rx(current).skill.get(skillId) : undefined;
  const st = sk?.effects.find((e) => e.kind === 'status');
  return st && st.kind === 'status' ? statusLook(st.statusId) : undefined;
}

/** How a status looks on whoever has it: the world's own look, or drips for a harmful one and motes for a helpful one. */
export function statusLook(id: string): FxLook {
  const r = current;
  const own = r?.looks.statuses[id];
  if (own) return own;
  const def = r ? rx(r).status.get(id) : undefined;
  const color = def?.color ?? '#ffffff';
  return def?.harmful === false ? { shapes: ['mote'], colors: [color], glow: true, motion: 'rise', trail: 'none' } : { shapes: ['droplet'], colors: [color], glow: false, motion: 'fall', trail: 'none' };
}
