/**
 * Classes: their shape for a level cap. A hero is not bound to one class: points come from levels and go into any
 * class's tree (multiclassing), and where they go decides what the hero becomes, so two heroes of the same level and
 * armor differ by what they chose.
 */

/** The ranks of a skill in a tier: three, two from the fourth tier (where skills are stronger and points dearer). */
export const skillRanks = (tier: number) => (tier >= 3 ? 2 : 3);

/** The picks passives offer in each tier (each bought once). */
const TIER_PASSIVES = 3;

/**
 * A class's shape for a level cap. A hero has 2 points at the start and 2 more each level, to spend in any class;
 * the points spent in a class open its tiers, the last at about half of all the points, so a hero devoted to one
 * class reaches it with points to spare for another. Longer worlds have more tiers (3 to 5). Each tier has two
 * actives (the last one) and three passives, each bought once, of one effect in the first tier and up to two deeper.
 *
 * A gate never asks for more than a tier's picks less its passives, so a hero opening the next tier always has a
 * choice of what to buy (and a hero of the class, whose first skill comes free, still has one left over).
 */
export function classShape(maxLevel: number) {
  const points = 2 * maxLevel;
  const count = Math.min(5, 2 + Math.ceil(maxLevel / 10));
  const step = Math.min(Math.round(points / 2 / (count - 1)), 2 * skillRanks(0));
  const tiers = Array.from({ length: count }, (_, i) => ({ id: `tier_${i + 1}`, n: i + 1, opensAt: i * step, actives: i === count - 1 ? 1 : 2, passives: TIER_PASSIVES, passiveEffects: i === 0 ? 1 : 2 }));
  return { points, tiers };
}
