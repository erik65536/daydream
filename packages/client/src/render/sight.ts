/**
 * Who a screen sees by. The heroes of every player in a place uncover one shared map, and on every screen each of them
 * does what the player's own do: the fog lifts around them, the ground near them reads as seen rather than remembered,
 * they carry a light through the night, and the mist along the place's edge clears around them.
 */
import { SIGHT_RADIUS, type EntityView } from '@daydream/shared';

/** The heroes in the place, the player's own first (where only so many can be counted, theirs are). */
export function heroesOf(entities: Iterable<EntityView>, userId: string | undefined): EntityView[] {
  const heroes = [...entities].filter((e) => e.kind === 'character');
  return [...heroes.filter((e) => e.ownerUserId === userId), ...heroes.filter((e) => e.ownerUserId !== userId)];
}

/**
 * Everyone the ground is seen from: the heroes and, while the player is in a fight, everyone standing in one (a
 * fight is never in the dark).
 */
export function eyesOf(entities: Iterable<EntityView>, fighting: boolean): EntityView[] {
  return [...entities].filter((e) => e.kind === 'character' || (fighting && !!e.inCombat && !e.dead));
}

/** How far past sight range remembered ground goes on dimming (m), and how dim it gets. */
const DIM_OVER = 5, DIMMEST = 0.45;

/** How dim remembered ground is `d` meters from the nearest of those who see: clear in sight, dimming smoothly past it. */
export function dimAt(d: number): number {
  return d > SIGHT_RADIUS + DIM_OVER ? DIMMEST : d > SIGHT_RADIUS ? ((d - SIGHT_RADIUS) / DIM_OVER) ** 1.5 * DIMMEST : 0;
}
