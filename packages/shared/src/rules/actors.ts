/** Engine-level actor vocabularies: kinds of fighter (their numbers live in the ruleset), NPC roles, merchants. */

/**
 * The kind of fighter a creature or boss is: its body (size, toughness, numbers, experience) and
 * its habit in a fight. It fights as one of the world's classes, which gives its skills, reach, and damage; any kind
 * fights as any class.
 */
export const FIGHTER_KINDS = ['soldier', 'brute', 'swarm', 'stalker', 'guardian'] as const;
export type FighterKind = (typeof FIGHTER_KINDS)[number];

/** A kind of fighter fighting as a class (a class id of the ruleset). */
export interface Fighter {
  fighter: FighterKind;
  classId: string;
}

/** How each kind of fighter reads in the UI, its size on the map, and its share of experience. */
export const FIGHTER_LOOK: Record<FighterKind, { name: string; scale: number; xp: number }> = {
  soldier: { name: 'Soldier', scale: 1, xp: 1 },
  brute: { name: 'Brute', scale: 1.25, xp: 1.2 },
  swarm: { name: 'Swarmling', scale: 0.7, xp: 0.45 },
  stalker: { name: 'Stalker', scale: 0.95, xp: 1.2 },
  guardian: { name: 'Guardian', scale: 1.3, xp: 1.3 },
};

/**
 * What a townsperson is for the players who visit: one of the story's people (the main quests), a merchant (what they
 * sell is their `merchantKind`), or a resident (side jobs, directions, news, gifts, and secrets, as anyone may give).
 * Everything else about them (their trade, standing, manner) is in their title and their life, not in a role.
 */
const NPC_ROLES = ['story', 'merchant', 'resident'] as const;
export type NpcRole = (typeof NPC_ROLES)[number];

const MERCHANT_KINDS = ['general', 'weapons', 'armor', 'alchemy', 'magic', 'materials'] as const;
export type MerchantKind = (typeof MERCHANT_KINDS)[number];
