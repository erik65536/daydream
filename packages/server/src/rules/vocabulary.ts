/**
 * The fixed lists the rules steps choose from (pipeline facts `game.rules`) and the records accept, so a step's enums
 * and the game can never disagree.
 */
import { UI_MATERIALS, UI_MOODS, UI_ORNAMENTS, UI_TYPEFACES } from '@daydream/shared';

export const RULES_VOCABULARY = {
  /** How big the numbers feel: small (health about 30), medium (about 80), large (about 400). */
  numbers: ['small', 'medium', 'large'],
  /** How much each hit's damage varies. */
  variances: ['low', 'medium', 'high'],
  /** How a downed character gets up: through any healing, only through revive skills and items, or once the fight is won. */
  revives: ['heal', 'special', 'after_combat'],
  ui: { materials: UI_MATERIALS, ornaments: UI_ORNAMENTS, typefaces: UI_TYPEFACES, moods: UI_MOODS },
} as const;
