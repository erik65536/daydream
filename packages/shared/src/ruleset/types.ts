import type { FighterKind } from '../rules/actors.ts';
import type { Presentation } from '../world/adventure.ts';
/**
 * A world's ruleset: pure data, generated with the world and interpreted by the engine.
 * See docs/rulesets.md. Ids are world-specific strings; nothing here is a fixed enum except the
 * engine vocabularies (turn models, effect primitives, control kinds, kinds of fighter).
 */


// ------------------------------------------------------------------------------------ engine vocabularies

type TurnModelId = 'ap';
type ReviveMode = 'heal' | 'special' | 'after_combat';
type StorageKind = 'none' | 'each_town' | 'shared';
/**
 * Root stops moving (and dashing). Disarm stops the basic attack and the skills of classes that fight with weapons
 * (those that deal the first kind of damage); silence stops every other skill. A stun loses the turn.
 */
export type ControlKind = 'root' | 'silence' | 'disarm' | 'stun';
export type SlotKind = 'weapon' | 'offhand' | 'armor' | 'accessory';
export type Targeting = 'self' | 'ally' | 'enemy' | 'ground';
/** How a class plays: fighting up close or from a distance, with weapons or magic, healing, or buffing and debuffing. */
export type ClassRole = 'melee' | 'ranged' | 'caster' | 'hybrid' | 'healer' | 'support';
export type FxKind = 'slash' | 'arrow' | 'bolt' | 'nova' | 'heal' | 'buff' | 'debuff' | 'shadow' | 'beam' | 'cloud' | 'none';

/** Small shapes the game draws effects with: each is drawn by code and tinted with a look's colors. */
export const FX_SHAPES = ['spark', 'ember', 'shard', 'chunk', 'droplet', 'bubble', 'mote', 'flake', 'petal', 'leaf', 'paper', 'pixel', 'glyph', 'star', 'smoke', 'dust', 'streak', 'note', 'bolt', 'feather', 'coin', 'crescent', 'halo'] as const;
export type FxShape = (typeof FX_SHAPES)[number];
/** How the shapes move: thrown out, thrown up and falling, circling, rising, falling from above, drifting. */
export const FX_MOTIONS = ['burst', 'splash', 'swirl', 'rise', 'fall', 'drift'] as const;
type FxMotion = (typeof FX_MOTIONS)[number];
/** What a projectile leaves behind it. */
export const FX_TRAILS = ['none', 'sparks', 'smoke', 'streak', 'bubbles', 'motes'] as const;
type FxTrail = (typeof FX_TRAILS)[number];
/**
 * How a fighter rushes to a foe (a skill that dashes): runs low in a cloud of dust, leaves fading copies of itself,
 * vanishes and reappears, flies as a bright streak, or leaps in an arc and lands hard.
 */
export const FX_RUSHES = ['dash', 'blur', 'blink', 'streak', 'leap'] as const;
export type FxRush = (typeof FX_RUSHES)[number];
/**
 * How what a ranged skill sends flies: a fast shaft, a glowing orb with a trail, an arcing throw, a jagged flash, a
 * steady ray, or a stream of many small shapes.
 */
export const FX_SHOTS = ['arrow', 'orb', 'lob', 'bolt', 'ray', 'swarm'] as const;
export type FxShot = (typeof FX_SHOTS)[number];
/**
 * How a skill over an area lands: a ring spreading out, a column bursting up from the ground, a shower falling from
 * above, a vortex drawn in before it bursts, or a quake of shock rings and thrown dust.
 */
export const FX_BLASTS = ['ring', 'pillar', 'rain', 'vortex', 'quake'] as const;
export type FxBlast = (typeof FX_BLASTS)[number];

/** What the interface's panels are made of, how they are decorated, its lettering, and the game view's grading. */
export const UI_MATERIALS = ['parchment', 'wood', 'stone', 'metal', 'glass', 'organic', 'paper', 'neon'] as const;
export const UI_ORNAMENTS = ['none', 'filigree', 'runes', 'rivets', 'circuit', 'vines'] as const;
export const UI_TYPEFACES = ['engraved', 'classic', 'modern', 'condensed', 'storybook', 'gothic', 'technical'] as const;
export const UI_MOODS = ['warm', 'cold', 'bleak', 'vivid', 'muted', 'neon'] as const;

/** How one kind of hit, healing, or status looks in this world (chosen with the world, so effects suit its theme). */
export interface FxLook {
  /** One or two shapes, the first the main one. */
  shapes: FxShape[];
  /** Two or three colors (hex), brightest first. */
  colors: string[];
  /** Gives off light (fire, magic, electricity) rather than being matter (paper, water, dust). */
  glow: boolean;
  motion: FxMotion;
  trail: FxTrail;
}
/** How a kind of damage's skills move: a rush, a ranged skill's shot, and an area skill's blast. */
export interface FxMoves {
  rush: FxRush;
  shot: FxShot;
  blast: FxBlast;
}
export type DifficultyId = 'story' | 'easy' | 'normal' | 'hard' | 'brutal';
export const DIFFICULTIES: DifficultyId[] = ['story', 'easy', 'normal', 'hard', 'brutal'];
/** How each difficulty plays, in a few words and in a sentence (the balance loop fits every world to it). */
export const DIFFICULTY_SHORT: Record<DifficultyId, string> = { story: 'For the tale', easy: 'Relaxed', normal: 'As intended', hard: 'Tactics matter', brutal: 'Merciless' };
export const DIFFICULTY_TEXT: Record<DifficultyId, string> = {
  story: 'For the tale: foes are gentle and mistakes are forgiven.',
  easy: 'A relaxed adventure with room to experiment.',
  normal: 'The intended balance: fights are winnable but cost something.',
  hard: 'Tougher, more numerous foes. Tactics and preparation matter.',
  brutal: 'Merciless. Every fight is a puzzle; expect to fall.',
};

/**
 * Stat ids. Engine-known forms:
 *   hp, hpPct, hpRegen, move, crit, critDmg, dodge, power, dmg:<typeId>, healing, mit:<typeId>, taken, lifesteal,
 *   thorns
 * Every one acts in a fight, so gear, passives, and statuses price them all in one unit (worldRules.ts).
 * Which unit a stat uses is decided by `statUnit()` in stats.ts.
 */
export type StatId = string;

export interface Modifier {
  stat: StatId;
  /** Scaled stats (hp, mit, thorns, hpRegen) store a coefficient of the level curve; others store the value. */
  value: number;
}

// ------------------------------------------------------------------------------------ building blocks

export interface Curve {
  /** value(L) = base * (1 + lin*(L-1) + quad*(L-1)^2) */
  base: number;
  lin: number;
  quad: number;
}

/** Piecewise-linear multiplier over levels (knots sorted by level). */
export type Knots = { level: number; value: number }[];

/** A kind of damage (physical, and magic where the world has it), each with the defense that reduces it. */
export interface DamageTypeDef {
  id: string;
  name: string;
  color: string;
  /** Name of the defense against it, as on a character sheet. */
  mitigationName: string;
}

export interface StatusDef {
  id: string;
  name: string;
  color: string;
  description: string;
  harmful: boolean;
  /** Damage per turn: coefficient of the applier's damage-per-AP. */
  dot?: { coef: number; typeId: string };
  /** Healing per turn: coefficient of the applier's damage-per-AP. */
  hot?: { coef: number };
  modifiers?: Modifier[];
  control?: ControlKind;
}

export interface SlotDef {
  id: string;
  name: string;
  kind: SlotKind;
}

export interface RarityDef {
  id: string;
  name: string;
  color: string;
  affixes: [number, number];
  /** Multiplier on an item's power budget. */
  budget: number;
  weight: number;
  priceMult: number;
}

// ------------------------------------------------------------------------------------ effects & skills

export type Effect =
  /** Damage: coef × damage-per-AP of the user (the basic attack deals the weapon's damage, of the weapon's kind). */
  | { kind: 'damage'; coef: number; typeId?: string }
  /**
   * Healing: coef × the healer's damage per AP (a skill's, so a healer heals as strongly as others hit), or a share of
   * the target's most Health (what anyone may drink, the same for everyone).
   */
  | { kind: 'heal'; coef: number; share?: undefined }
  | { kind: 'heal'; share: number; coef?: undefined }
  | { kind: 'status'; statusId: string; chance: number; turns: number; self?: boolean }
  | { kind: 'cleanse' }
  | { kind: 'revive'; fraction: number }
  | { kind: 'lifesteal'; fraction: number }
  /** The user rushes to the target first, landing beside it. */
  | { kind: 'dash' };

export interface SkillDef {
  id: string;
  name: string;
  description: string;
  /** Owning class id, or 'general'. */
  owner: string;
  targeting: Targeting;
  /** Range in meters (the basic attack reaches as far as the weapon). */
  range: number;
  radius?: number;
  ap: number;
  cooldown: number;
  effects: Effect[];
  /**
   * What each rank after the first adds to everything the skill does (damage, healing, the effects of the statuses
   * it applies, a chance short of certain, a revive, life steal). A skill with none of these (a cleanse, a certain
   * stun) has one rank: it is learned, never improved.
   */
  rankBonus: number;
  maxRank: number;
  tags: string[];
  fx: FxKind;
  outOfCombat?: boolean;
  /** Balance-loop correction applied to every magnitude, as a rank is (see `potency`). */
  tune: number;
}

// ------------------------------------------------------------------------------------ characters

/** A race: who a character is and how they look; races have no strengths, since builds come from classes. */
export interface KinDef {
  id: string;
  name: string;
  description: string;
  /** What a person of this kin looks like (used to draw its heroes). */
  appearance: string;
  /** Each kin is one gender, balanced over the world's kins. */
  presentation: Presentation;
  /** Example first names of its people. */
  names: string[];
}

type TreeNodeKind = 'skill' | 'passive';

/**
 * One pick in a class's tree: a skill (its first point learns it, each further point is a rank of it, up to the
 * skill's `maxRank`) or a passive. Any character may take any class's nodes.
 */
export interface TreeNode {
  id: string;
  name: string;
  description: string;
  kind: TreeNodeKind;
  /** The class whose tree it is in. */
  classId: string;
  tier: number;
  /** Points the node takes: a skill's ranks, or 1 for a passive. */
  maxRank: number;
  skillId?: string;
  /** Per rank. */
  modifiers?: Modifier[];
  tune?: number;
}

/**
 * A class is a skill tree: anyone puts points into any class, and a hybrid mixes them. A character's own class is
 * where they started: their first skill, their first gear, and how they are drawn.
 */
export interface ClassDef {
  id: string;
  name: string;
  description: string;
  role: ClassRole;
  /** Where the class's skills reach (up close, or from a distance), and the kind of damage they deal. */
  reach: 'melee' | 'ranged';
  damageTypeId: string;
  /** Known from the start by a character of this class. */
  startingSkills: string[];
  /** Base ids equipped at creation, per slot id. */
  startingGear: Record<string, string>;
  nodes: TreeNode[];
  /** Balance-loop correction on the class's health and damage. */
  tune: { hp: number; dmg: number };
}

// ------------------------------------------------------------------------------------ items

export type ItemCategory = 'equipment' | 'potion' | 'material' | 'valuable' | 'tool' | 'quest' | 'key';

interface WeaponDef {
  /** Damage per AP relative to the reference curve. */
  coef: number;
  apCost: number;
  range: number;
  typeId: string;
  twoHanded?: boolean;
  /** Ranged weapons draw projectiles. */
  projectile?: boolean;
}

export interface ItemBaseDef {
  id: string;
  name: string;
  description: string;
  category: ItemCategory;
  slotId?: string;
  weapon?: WeaponDef;
  /** A weapon's class: the one whose weapons the world's gear step made it as (any hero can wield it). */
  classId?: string;
  /** Mitigation coefficients per damage type (scaled by item level). */
  defense?: Record<string, number>;
  implicit?: Modifier[];
  /** Consumables, and the recall tool. */
  /** What using it does: on its user, or thrown at a point on the ground. */
  use?: { effects: Effect[]; ap: number; targeting: 'self' | 'ground'; radius?: number; outOfCombat: boolean; tool?: 'recall' };
  stackable: boolean;
  /** Per-slot stack limit (defaults by category). */
  maxStack?: number;
  price: number;
  dropWeight: number;
  icon: string;
  tier?: number;
  tags: string[];
}

export interface AffixDef {
  id: string;
  prefix: string;
  suffix: string;
  stat: StatId;
  slotKinds: SlotKind[];
  weight: number;
  /** Value at item level 1 with rarity budget 1; it grows with the item's level (itemMod in stats). */
  value: number;
}

/**
 * The crafts a player learns (the utility tree): making gear, brewing consumables, upgrading gear, and enchanting it,
 * each the world has. Points are the player's, shared by all their heroes; the engine sets what each rank does.
 */
export const CRAFTS = ['craft', 'brew', 'upgrade', 'enchant'] as const;
export type CraftId = (typeof CRAFTS)[number];
/** A craft as the world names it. */
export interface CraftDef {
  id: CraftId;
  name: string;
  description: string;
}

export interface RecipeDef {
  id: string;
  name: string;
  inputs: { itemId: string; qty: number }[];
  output: { itemId: string; qty: number } | { slotKind: SlotKind };
  gold: number;
}

// ------------------------------------------------------------------------------------ fighters & encounters

/** A kind of fighter's body: its share of health and damage, defenses, speed, and threat (its class gives the rest). */
export interface FighterDef {
  hp: number;
  dmg: number;
  /** Mitigation coefficient per damage type. */
  defense: Record<string, number>;
  move: number;
  initiative: number;
  /** Encounter threat units (a normal monster ≈ 1). */
  threat: number;
}

// ------------------------------------------------------------------------------------ the ruleset

export interface Ruleset {
  id: string;
  name: string;

  turn: { model: TurnModelId; apPerTurn: number; apMax: number; apStart: number; tilesPerAp: number };
  /**
   * What a party loses when every hero in a fight falls; they wake in the last town either way. `recover`: each
   * player's pack lies where they fell, to be fetched. `goldLoss`: the share of each player's gold that is lost.
   * `xpLoss`: the share each hero loses of the experience it has earned toward its next level (never a level).
   */
  death: { recover: boolean; goldLoss: number; xpLoss: number };
  revive: ReviveMode;
  resolution: { variance: number; crit: boolean; baseCrit: number; critMult: number; critCap: number; dodge: boolean; baseDodge: number; dodgeCap: number };
  control: { enabled: boolean; immunityTurns: number };
  recovery: { secondsToFull: number };

  health: { name: string; color: string };
  damageTypes: DamageTypeDef[];
  statuses: StatusDef[];
  slots: SlotDef[];
  rarities: RarityDef[];
  skills: SkillDef[];
  /** The always-available weapon attack. */
  basicAttackId: string;
  kins: KinDef[];
  classes: ClassDef[];
  items: ItemBaseDef[];
  affixes: AffixDef[];
  recipes: RecipeDef[];
  /** The crafts players learn, those the world has. */
  crafts: CraftDef[];
  fighters: Record<FighterKind, FighterDef>;
  /**
   * How a pack's strength follows the heroes fighting it, against the four it is built for: the heroes' ratio to four
   * to a power, one for fewer heroes and one for more, for packs and for bosses. A side's strength grows faster than
   * its numbers, and how much faster depends on the classes; the balance loop fits all four for the world.
   */
  party: { packFewer: number; packMore: number; bossFewer: number; bossMore: number };
  /** Bosses' multipliers on health and damage over level, fitted by the balance loop. */
  boss: { hp: Knots; dmg: Knots };

  curves: {
    hp: Curve;
    dmg: Curve;
    mit: Curve;
    /** Monster multipliers over level, fitted by the balance loop. */
    monsterHp: Knots;
    monsterDmg: Knots;
  };

  progression: {
    maxLevel: number;
    /** xp[L] = total experience needed to reach level L (index 0 and 1 are 0). */
    xp: number[];
    treePointsStart: number;
    treePointsPerLevel: number;
    /** Points spent in a class needed to open each of its tiers. */
    tierRequirements: number[];
    killXp: Curve;
  };

  economy: { currency: string; sellRatio: number; priceMult: number; goldPerKill: Curve };
  /**
   * The bag, and storage in towns: none, a store in each town holding only what was left there, or one store every
   * town reaches. Each player has their own, of `storageSlots` slots.
   */
  inventory: { slots: number; upgrades: number; slotsPerUpgrade: number; upgradeCost: number; storage: StorageKind; storageSlots: number };
  crafting: { enabled: boolean; upgrades: { enabled: boolean; materialId?: string; gold: number }; enchanting: { enabled: boolean; materialId?: string; gold: number } };

  systems: {
    statuses: boolean;
    /** Travel between visited cities from their waypoints, and items that take the party back (a rule the world's maker picks). */
    fastTravel: boolean;
  };

  /** Per-save difficulty: enemy multipliers over level and encounter adjustments. */
  difficulty: Record<DifficultyId, { name: string; enemyHp: Knots; enemyDmg: Knots; extraEnemyChance: number; lootMult: number }>;

  terminology: { xp: string; level: string; actionPoints: string; party: string; town: string; dungeon: string; wilderness: string; quest: string; currency: string; /** What a class is called. */ calling: string; /** What a race is called. */ kin: string;
    /** What one of the points spent in the classes' trees is called, and several of them. */ talentPoint: string; talentPoints: string };

  ui: { material: (typeof UI_MATERIALS)[number]; ornament: (typeof UI_ORNAMENTS)[number]; typeface: (typeof UI_TYPEFACES)[number]; grading: { tint: string; saturation: number; contrast: number; vignette: number; grain: number } };

  /**
   * How hits of each damage type ('heal' too) and each status look in a fight, and how each damage type's skills
   * move (`moves`, keyed by damage type).
   */
  looks: { kinds: Record<string, FxLook>; statuses: Record<string, FxLook>; moves: Record<string, FxMoves> };

  balance?: BalanceReport;
}

export interface BalanceScenarioResult {
  id: string;
  label: string;
  level: number;
  difficulty: DifficultyId;
  runs: number;
  winRate: number;
  hpLost: number;
  rounds: number;
  target: { winRate: [number, number]; hpLost: [number, number]; rounds: [number, number] };
  ok: boolean;
  /** Heroes in the party when not the four packs are built for (the pack is fitted to them as in the game). */
  heroes?: number;
  /** Off target with a setting at its limit: the rules, not the fitting, keep it from the target. */
  limit?: string;
}

/** What the balance loop could not fix with numbers, for the world's owner. */
type BalanceFindingKind = 'unused_skill' | 'dominant_skill' | 'basic_attack' | 'class_strength' | 'outlier' | 'out_of_reach' | 'dead_passive';

export interface BalanceFinding {
  kind: BalanceFindingKind;
  /** The class it concerns, if any. */
  classId?: string;
  text: string;
}

export interface BalanceReport {
  at: number;
  iterations: number;
  durationMs: number;
  fights: number;
  scenarios: BalanceScenarioResult[];
  /** Each class's strength in a party, against the classes' average (1), after correction. */
  classes: { classId: string; strength: number; tune: { hp: number; dmg: number } }[];
  skillUsage: { skillId: string; share: number; tune: number }[];
  outliers: string[];
  findings: BalanceFinding[];
  notes: string[];
}
