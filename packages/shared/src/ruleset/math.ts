/** Combat math shared by the server, the simulator (identical code paths) and client previews. */
import type { ControlKind, Effect, ItemBaseDef, Ruleset, SkillDef, StatusDef } from './types.ts';
import { refDpa, rx, type StatBlock } from './stats.ts';

export type DamageEffect = Extract<Effect, { kind: 'damage' }>;

/**
 * How strongly a skill works at a rank, with the balance loop's correction: everything it does grows with it, its
 * damage and healing, the effects of the statuses it applies, a revive, and life steal. (A cleanse and a status's
 * chance grow by rank instead: `cleanseCount`, `chanceAt`.)
 */
export function potency(skill: SkillDef, rank: number): number {
  return skill.tune * (1 + skill.rankBonus * Math.max(0, rank - 1));
}

/**
 * A status effect's chance at a rank: a control that may fail lands more often each rank, in even steps from its
 * first-rank chance to certain at the skill's last rank (a skill of one rank keeps its chance).
 */
export function chanceAt(e: Extract<Effect, { kind: 'status' }>, skill: SkillDef, rank: number): number {
  if (e.chance >= 1 || skill.maxRank <= 1) return Math.min(1, e.chance);
  return Math.min(1, e.chance + ((1 - e.chance) * Math.max(0, rank - 1)) / (skill.maxRank - 1));
}
/** The share of Health a revive brings back, and of damage dealt life steal returns, at a potency. */
export const reviveAt = (e: Extract<Effect, { kind: 'revive' }>, pot: number) => Math.min(1, e.fraction * pot);
export const lifestealAt = (e: Extract<Effect, { kind: 'lifesteal' }>, pot: number) => Math.min(1, e.fraction * pot);

/**
 * How many harmful statuses a cleanse removes at a rank: one more each rank, every one at the last (a potion's
 * cleanse, of one rank, removes them all).
 */
export const cleanseCount = (skill: SkillDef, rank: number) => (rank >= skill.maxRank ? Infinity : Math.max(1, rank));

/**
 * The harmful statuses on a fighter, worst first, as a cleanse removes them: what stops it acting (a stun, then the
 * other controls), then damage over time, then weakenings; the longer first among equals.
 */
export function worstFirst<T extends { id: string; turns: number }>(r: Ruleset, statuses: T[]): T[] {
  const weight = (s: StatusDef) => (s.control === 'stun' ? 0 : s.control ? 1 : s.dot ? 2 : 3);
  const harmful = statuses.flatMap((s) => {
    const def = rx(r).status.get(s.id);
    return def?.harmful ? [{ s, w: weight(def) }] : [];
  });
  return harmful.sort((a, b) => a.w - b.w || b.s.turns - a.s.turns).map((x) => x.s);
}

export function isBasic(skill: SkillDef): boolean {
  return skill.tags.includes('basic');
}

/** Whether effects hurt whoever they land on (damage, or a harmful status on someone else). */
export const isHarmful = (r: Ruleset, effects: Effect[]) => effects.some((e) => e.kind === 'damage' || (e.kind === 'status' && !e.self && rx(r).status.get(e.statusId)?.harmful));

/**
 * What a skill can do outside a fight: help (heal, cleanse, raise, a helpful status), open a fight against a
 * foe (the first move of the attacker's first turn), or nothing until a fight begins.
 */
export function outsideFights(r: Ruleset, skill: SkillDef): 'help' | 'opener' | 'none' {
  if (skill.outOfCombat) return 'help';
  if (isBasic(skill) || skill.targeting === 'enemy' || (skill.targeting === 'ground' && isHarmful(r, skill.effects))) return 'opener';
  return 'none';
}

/** AP a skill costs for this user (the basic attack costs the weapon's AP). */
export function skillAp(skill: SkillDef, stats: StatBlock): number {
  return isBasic(skill) ? stats.weapon.apCost : skill.ap;
}

/** How far a skill reaches for this user (the basic attack as far as the weapon). */
export function skillRange(skill: SkillDef, stats: StatBlock): number {
  return isBasic(skill) ? stats.weapon.range : skill.range;
}

/** A skill of a class that fights with weapons, or the basic attack: what a disarm stops, and all a silence leaves. */
const usesWeapon = (skill: SkillDef) => isBasic(skill) || skill.tags.includes('weapon');

/** The control that keeps a fighter from using a skill, if one does: a silence or a disarm, or a root for a dash. */
export function blockedBy(stats: StatBlock, skill: SkillDef): ControlKind | null {
  if (stats.silenced && !usesWeapon(skill)) return 'silence';
  if (stats.disarmed && usesWeapon(skill)) return 'disarm';
  if (stats.rooted && skill.effects.some((e) => e.kind === 'dash')) return 'root';
  return null;
}

/** The kind of damage an effect deals: the weapon's for the basic attack, else the effect's own. */
export function damageKind(r: Ruleset, skill: SkillDef, e: DamageEffect, stats: StatBlock): { typeId: string } {
  return { typeId: e.typeId ?? (isBasic(skill) ? stats.weapon.typeId : r.damageTypes[0]!.id) };
}

/** Sum of applicable additive damage bonuses (as a multiplier). */
export function damageBonus(stats: StatBlock, typeId: string): number {
  const p = stats.pct;
  return 1 + ((p.power ?? 0) + (p[`dmg:${typeId}`] ?? 0)) / 100;
}

/** Raw (pre-roll, pre-mitigation) damage of an effect. */
export function rawDamage(skill: SkillDef, rank: number, e: DamageEffect, stats: StatBlock): number {
  if (isBasic(skill)) return ((stats.weapon.min + stats.weapon.max) / 2) * potency(skill, rank);
  return e.coef * stats.dpa * potency(skill, rank);
}

/** Multiplier from the target's defense against the kind of damage. */
function defenseMult(target: StatBlock, typeId: string): number {
  return (1 - (target.mitigation[typeId] ?? 0)) * target.taken;
}

interface DamageRoll {
  amount: number;
  typeId: string;
  crit: boolean;
}

/** Whether a fighter dodges a blow: any hit of an attack or a skill, with what it carries (`rand` returns [0,1)). */
export const dodges = (target: StatBlock, rand: () => number) => target.dodge > 0 && rand() < target.dodge;

/** Roll one damage effect (a dodge is rolled before, for the whole blow: `dodges`). `rand` returns [0,1). */
export function rollDamage(r: Ruleset, attacker: StatBlock, target: StatBlock, skill: SkillDef, rank: number, e: DamageEffect, rand: () => number, mult = 1): DamageRoll {
  const kind = damageKind(r, skill, e, attacker);
  let raw = rawDamage(skill, rank, e, attacker) * mult;
  raw *= 1 + (rand() * 2 - 1) * r.resolution.variance;
  raw *= damageBonus(attacker, kind.typeId);
  const crit = attacker.crit > 0 && rand() < attacker.crit;
  if (crit) raw *= attacker.critMult;
  raw *= defenseMult(target, kind.typeId);
  return { amount: Math.max(1, Math.round(raw)), ...kind, crit };
}

/** Average damage (used by the AI and UI previews). */
export function expectedDamage(r: Ruleset, attacker: StatBlock, target: StatBlock, skill: SkillDef, rank: number, e: DamageEffect, mult = 1): number {
  const kind = damageKind(r, skill, e, attacker);
  let v = rawDamage(skill, rank, e, attacker) * mult;
  v *= damageBonus(attacker, kind.typeId);
  v *= 1 + attacker.crit * (attacker.critMult - 1);
  v *= 1 - target.dodge;
  return v * defenseMult(target, kind.typeId);
}

/** Damage after defense for a flat amount (damage over time). */
export function flatDamage(target: StatBlock, amount: number, typeId: string): number {
  return Math.max(1, Math.round(amount * defenseMult(target, typeId)));
}

/**
 * The power a status is put on with: the applier's damage per AP at the skill's potency, with their bonuses to the
 * damage or healing it deals each turn, as their own blows and heals have them.
 */
export function statusPower(r: Ruleset, stats: StatBlock, statusId: string, pot: number): number {
  const def = rx(r).status.get(statusId);
  const bonus = def?.dot ? damageBonus(stats, def.dot.typeId) : def?.hot ? 1 + (stats.pct.healing ?? 0) / 100 : 1;
  return stats.dpa * pot * bonus;
}

export function healAmount(stats: StatBlock, coef: number, skillPotency = 1): number {
  return Math.round(coef * stats.dpa * skillPotency * (1 + (stats.pct.healing ?? 0) / 100));
}

/** What a heal mends on a target with `maxHp` most Health: by the healer's power, or a share of the target's Health. */
export function healOf(stats: StatBlock, e: Extract<Effect, { kind: 'heal' }>, maxHp: number, skillPotency = 1): number {
  return e.share !== undefined ? Math.round(e.share * maxHp) : healAmount(stats, e.coef, skillPotency);
}

/** Damage-over-time per turn for a status applied with `power` (the applier's damage per AP). */
export function statusDot(r: Ruleset, statusId: string, power: number): number {
  const def = rx(r).status.get(statusId);
  return def?.dot ? def.dot.coef * power : 0;
}

/** A consumable's use as a skill of one rank: thrown up to 8 m at the ground, or used on the one who holds it. */
export function itemSkill(base: ItemBaseDef): SkillDef {
  const u = base.use!;
  const fx = u.effects.some((e) => e.kind === 'damage') ? 'bolt' : u.effects.some((e) => e.kind === 'heal') ? 'heal' : 'buff';
  return { id: `item:${base.id}`, name: base.name, description: base.description, owner: 'item', targeting: u.targeting, range: u.targeting === 'ground' ? 8 : 0, radius: u.radius, ap: u.ap, cooldown: 0, effects: u.effects, rankBonus: 0, maxRank: 1, tags: ['item'], fx, outOfCombat: u.outOfCombat, tune: 1 };
}

/**
 * The stats a consumable works with: the same for everyone. It has no level, so its strength follows the level of the
 * hero using it (a bomb deals the same share of Health all game), and nothing else of theirs counts: no bonuses to
 * damage or healing, no critical hits, no life steal.
 */
export function consumableStats(r: Ruleset, level: number): StatBlock {
  const none = r.damageTypes[0]!.id;
  return {
    level, dpa: refDpa(r, level), pct: {}, crit: 0, critMult: 1, lifesteal: 0,
    maxHp: 1, hpRegen: 0, apPerTurn: 0, apMax: 0, apStart: 0, move: 0, initiative: 0, dodge: 0, mitigation: {}, taken: 1, thorns: 0,
    weapon: { min: 0, max: 0, apCost: 1, range: 0, typeId: none, projectile: false, melee: true },
    rooted: false, silenced: false, disarmed: false, stunned: false,
  };
}
