/** What in a place can be used, by one rule for the mouse, a finger and a controller. */
import type { FeatureDef, FeatureState } from '@daydream/shared';

/** The kinds of things one uses: a click, a tap or a controller's A acts on them. */
const USABLE = new Set<string>(['chest', 'exit', 'sign', 'lore', 'craft_station', 'storage', 'waypoint']);

/**
 * Whether a thing can be used now, given what this player has done with it: anything of a usable kind, except a
 * chest that has been emptied (one opened with things left in it can be opened again).
 */
export function featureUsable(f: FeatureDef, fs: FeatureState | undefined): boolean {
  return USABLE.has(f.kind) && !(f.kind === 'chest' && fs?.opened && fs.empty);
}
