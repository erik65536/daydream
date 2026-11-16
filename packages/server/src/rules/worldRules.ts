/**
 * The world's ruleset from the rules steps' records (pipeline/steps/rules*.yaml) with every number, so the game can
 * play it (docs/rulesets.md). Deterministic. Every number comes from one power budget, so content is roughly balanced by
 * construction, and the balance loop (balance.ts) tunes the rest by simulated fights.
 *
 * Classes are trees: any character puts points into any of the world's classes, tiers open by the points spent in
 * that class, and a hybrid mixes them. A character's own class is where they start: its first skill and its weapon.
 * There are no attributes and no resources: skills cost action points and cooldowns, and base stats grow with level
 * and gear. A class's skills work at its own reach and deal its own damage whatever weapon is in hand, so any
 * character can use any class's skills; the weapon gives the basic attack.
 *
 * Creatures, bosses, and named foes fight as a kind of fighter (their body: health, damage, defenses, speed, threat)
 * and a class (their skills, reach, and damage), so nothing is designed for them alone.
 */
import {
  CRAFTS, FIGHTER_KINDS, classShape, kinPresentations, skillRanks,
  type AffixDef, type ClassDef, type ClassRole, type DamageTypeDef, type DifficultyId, type Effect, type FighterDef, type FighterKind, type FxKind, type ItemBaseDef,
  type KinDef, type Knots, type Modifier, type RarityDef, type RecipeDef, type Ruleset, type SkillDef, type SlotDef, type SlotKind, type StatId, type StatusDef, type TreeNode,
} from '@daydream/shared';
import type { Records } from '../pipeline/world.ts';
import { CLASS_KEYS } from '../pipeline/records.ts';

/** The tiers of every class, in order (facts `input.tiers`), as the rules steps wrote them; when each opens is the engine's (`classShape`). */
export interface TierShape { id: string }

interface WorldRulesOptions { maxLevel: number; tiers: TierShape[]; seed: string; id: string }

type ClassKey = (typeof CLASS_KEYS)[number];

// ------------------------------------------------------------------------------------ the power budget

/** A critical hit's damage, as a multiple of the hit's. */
const CRIT_MULT = 1.5;

/**
 * What one unit of each stat is worth in a fight, in power % (a percent more damage on everything), to a hero it
 * serves: Healing to one who heals, a kind of damage to one who deals it. Passives, gear bonuses, and statuses are priced
 * in it, so a pick of any stat is worth about the same. Every stat acts in a fight and only there (one that helped
 * outside them, as with prices or loot, could not be weighed against one that wins fights). A kind of defense is worth
 * its kind's share of the damage creatures deal: the first kind (physical) about three fifths in a world with two.
 *
 * Measured with `combatlab/affixes.ts` on 15 November 2026: in the balance loop's fights on three worlds, at a middle
 * level and the last, each stat on every hero saved the party about as much Health as the same worth of Damage did
 * (20% Damage against stats worth 20%: 20 to 25 on average over the six, each reading within about 5). Critical chance
 * is the arithmetic: each point adds a point's share of a crit's extra damage. A defense's worth follows how much of
 * the creatures' damage is of its kind, which differs from world to world (a world's physical defense measured 11 to
 * 38 where 20 was intended), so its price is right only on average.
 */
export function statPrice(stat: StatId, typeIds: string[], critMult = CRIT_MULT): number {
  const [head, arg] = stat.includes(':') ? [stat.slice(0, stat.indexOf(':')), stat.slice(stat.indexOf(':') + 1)] : [stat, ''];
  switch (head) {
    case 'hpPct': return 1;
    case 'hpRegen': return 800;
    case 'dmg': return 1;
    case 'power': return 1;
    case 'healing': return 0.2;
    case 'crit': return critMult - 1;
    case 'critDmg': return 0.2;
    case 'dodge': return 2;
    case 'move': return 12;
    case 'mit': return 85 * (typeIds.length > 1 ? (arg === typeIds[0] ? 0.6 : 0.4) : 1);
    case 'lifesteal': return 3.5;
    case 'thorns': return 20;
    default: return 1;
  }
}

/** Power % of one passive in the first tier, and deeper. */
const B_PASSIVE = 5;
const B_DEEP_PASSIVE = 7;
/** Power % of one affix at rarity budget 1. */
const B_AFFIX = 5;
/** Power % a status gives or takes while it lasts. */
const B_STATUS = 16;

const round = (v: number, p = 4) => Math.round(v * 10 ** p) / 10 ** p;
const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
const HEX = /^#[0-9a-f]{6}$/i;
const color = (c: string | undefined, fallback: string) => (c && HEX.test(c) ? c : fallback);
const slug = (s: string) => s.toLowerCase().normalize('NFKD').replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '').slice(0, 28) || 'x';

class Ids {
  private used = new Set<string>();
  make(prefix: string, name: string): string {
    const base = `${prefix}${slug(name)}`;
    let id = base;
    for (let i = 2; this.used.has(id); i++) id = `${base}_${i}`;
    this.used.add(id);
    return id;
  }
}

// ------------------------------------------------------------------------------------ the world's classes

/** A class of the world as rulesCore names it, with where it fights, the damage it deals, and how it plays. */
interface WorldClass { key: ClassKey; name: string; description: string; damage: 'physical' | 'magic'; reach: 'melee' | 'ranged'; role: ClassRole }

function classesOf(rec: Records): WorldClass[] {
  const c = rec.rulesCore.classes;
  const supportDamage = c.magical ? 'magic' : 'physical';
  const out: WorldClass[] = [];
  const add = (key: ClassKey, cls: { name: string; description: string } | null | undefined, damage: WorldClass['damage'], reach: WorldClass['reach'], role: ClassRole) => {
    if (cls) out.push({ key, name: cls.name, description: cls.description, damage, reach, role });
  };
  add('physical_melee', c.physical.melee, 'physical', 'melee', 'melee');
  add('physical_ranged', c.physical.ranged, 'physical', 'ranged', 'ranged');
  add('magic_melee', c.magical?.melee, 'magic', 'melee', 'hybrid');
  add('magic_ranged', c.magical?.ranged, 'magic', 'ranged', 'caster');
  add('healer', c.healer, supportDamage, c.healer?.reach ?? 'ranged', 'healer');
  add('buff_and_debuff', c.buff_and_debuff, supportDamage, c.buff_and_debuff?.reach ?? 'ranged', 'support');
  return out;
}

/** Each class's health and damage against the average, before the balance loop corrects them. */
const TUNE: Record<ClassRole, { hp: number; dmg: number }> = { melee: { hp: 1.1, dmg: 1 }, ranged: { hp: 0.95, dmg: 1 }, hybrid: { hp: 1, dmg: 1 }, caster: { hp: 0.88, dmg: 1.06 }, healer: { hp: 1, dmg: 0.85 }, support: { hp: 1, dmg: 0.85 } };

// ------------------------------------------------------------------------------------ skills

/**
 * Range in meters of a skill reaching from a distance, and up close a step. Movement is 2 m an AP, so a melee fighter
 * closes the distance to an archer in a turn; a dash reaches a few steps further (about two AP of walking).
 */
const RANGE = { melee: 1.6, ranged: 6, dash: 5.5 } as const;
/** What the walk a dash saves is worth, in basic attacks: the share of the skill's budget it takes. */
const DASH_PRICE = 0.6;
const AREA = { single: 0, small: 1.6, large: 2.4 } as const;
/** About how many targets an area catches (its power is shared among them). */
const AREA_TARGETS = { single: 1, small: 1.7, large: 2.4 } as const;
/**
 * A skill is budgeted per AP against the basic attack (100% weapon damage for 2 AP: a weapon's damage per AP is about
 * the character's skill power), so a skill used every turn is no better than attacking; a cooldown earns its edge,
 * and deeper tiers hit a little harder.
 */
const ATTACK_PER_AP = 1;
/**
 * Healing is priced as damage of the same size. A skill that heals always waits a turn or more, so no party outheals a
 * fight and no healer plays as one button; the balance loop evens the healer class out as a whole. At 0.35 a healer gave
 * back 2 to 11% of the Health its party lost and a potion out-healed its heal six to one; at this price, rebalanced, it
 * gives back 14 to 25% in ordinary fights, near a hero's part of four (combatlab healing, 15 November 2026).
 */
const HEAL_PER_DAMAGE = 1;
/** What a healing potion mends: a share of the drinker's most Health, below a healer's heal at any level. */
const POTION_HEAL = 0.15;
const COOLDOWN_MULT: Record<number, number> = { 0: 1, 2: 1.4, 4: 1.9 };
const CONTROL_PRICE: Record<string, number> = { root: 0.6, silence: 0.8, disarm: 0.8, stun: 1.2 };
/** What each rank after the first adds to everything a skill does (`potency`). */
const RANK_BONUS = 0.15;
/** What a defeat costs, where the owner chose to lose money or experience: a quarter of it. */
const DEFEAT_LOSS = 0.25;
/** Slots in a player's store (each town's, or the one every town shares). */
const STORAGE_SLOTS = 100;

type SkillRecord = Records['rulesSkills'][string][string][number];

/**
 * A skill from its record: its tier and place set its cost (the first skill of a class is its everyday move, at no
 * cooldown unless it heals; deeper and wider ones cost more and wait longer), its class its reach and damage.
 */
function skillOf(r: Ruleset, ids: Ids, s: SkillRecord, c: WorldClass & { classId: string; typeId: string; typeOf: (d: 'physical' | 'magic') => DamageTypeDef }, tier: number, first: boolean, statusNamed: (n: string) => StatusDef | undefined): SkillDef {
  const ap = s.area === 'large' || tier >= 3 ? 3 : 2;
  const heals = s.effects.includes('heal');
  // A dash only makes sense up close, at one enemy; it always waits a turn or more.
  const dash = s.effects.includes('dash') && c.reach === 'melee' && s.target === 'enemy';
  const cooldown = first && !heals && !dash ? 0 : tier <= 1 && s.area === 'single' ? 2 : 4;
  const budget = ap * ATTACK_PER_AP * (COOLDOWN_MULT[cooldown] ?? 1) * (1 + 0.08 * Math.min(3, tier)) * (c.reach === 'melee' ? 1.1 : 1);
  const perTarget = (dash ? budget - DASH_PRICE : budget) / AREA_TARGETS[s.area];
  const weightOf = (e: SkillRecord['effects'][number]) => (typeof e === 'object' ? 1 : e === 'dash' ? 0 : e === 'removes_statuses' || e === 'life_steal' ? 1 : 2);
  const total = s.effects.reduce((n, e) => n + weightOf(e), 0) || 1;
  // What a skill may be made of follows the world's rules, and one that breaks them is not compiled into something
  // else: a revive only where special skills revive, and a status on those the skill reaches (its foes if it deals
  // damage, its allies if it heals) or on its user.
  const breaks = (why: string) => new Error(`${c.name}'s skill "${s.name}" ${why}`);
  const damages = s.effects.some((e) => e === 'damage' || e === 'physical_damage' || e === 'magic_damage');
  if (s.effects.includes('revive') && r.revive !== 'special') throw breaks(`revives, and in this world the fallen get up ${r.revive === 'heal' ? 'through any healing' : 'once the fight is won'}`);
  for (const e of s.effects) {
    if (typeof e !== 'object') continue;
    if (e.on === 'allies' && damages) throw breaks(`deals damage and puts "${e.status}" on allies`);
    if (e.on === 'enemies' && heals) throw breaks(`heals and puts "${e.status}" on enemies`);
  }
  const effects: Effect[] = [];
  // A control lands at its first rank no more often than a rank's worth short of certain for each rank after it, so
  // every rank makes it likelier (and the last certain: `chanceAt`).
  const surest = 1 / (1 + RANK_BONUS * (skillRanks(tier) - 1));
  for (const e of s.effects) {
    const share = (weightOf(e) / total) * perTarget;
    if (typeof e === 'object') {
      const st = statusNamed(e.status);
      if (!st) continue;
      const self = e.on === 'self';
      if (st.dot) effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round((share * 1.2) / st.dot.coef), 1, 4), self: self || undefined });
      else if (st.control) {
        const price = CONTROL_PRICE[st.control] ?? 0.8;
        const turns = share >= price * 2 ? 2 : 1;
        const chance = round(clamp(share / (price * turns), 0.3, surest), 2);
        effects.push({ kind: 'status', statusId: st.id, chance, turns, self: self || undefined });
      } else if (st.hot) effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round((share * HEAL_PER_DAMAGE) / st.hot.coef), 1, 4), self: self || undefined });
      else effects.push({ kind: 'status', statusId: st.id, chance: 1, turns: clamp(Math.round(share / 0.8), 1, 3), self: self || undefined });
    } else if (e === 'damage') effects.push({ kind: 'damage', coef: round(share, 3), typeId: c.typeId });
    else if (e === 'physical_damage' || e === 'magic_damage') effects.push({ kind: 'damage', coef: round(share, 3), typeId: c.typeOf(e === 'magic_damage' ? 'magic' : 'physical').id });
    else if (e === 'heal') effects.push({ kind: 'heal', coef: round(share * HEAL_PER_DAMAGE, 3) });
    else if (e === 'removes_statuses') effects.push({ kind: 'cleanse' });
    else if (e === 'revive') effects.push({ kind: 'revive', fraction: round(clamp(0.2 + share * 0.1, 0.25, 0.6), 2) });
    else if (e === 'life_steal') effects.push({ kind: 'lifesteal', fraction: round(clamp(share * 0.25, 0.1, 0.6), 2) });
    else if (e === 'dash' && dash) effects.push({ kind: 'dash' });
  }
  if (!effects.some((e) => e.kind !== 'dash')) effects.push({ kind: 'damage', coef: round(perTarget, 3), typeId: c.typeId });
  // A skill that hurts goes on enemies; one that only helps goes on allies or its user, as its record says. An area is
  // aimed at the ground, where the player puts it, to catch several: one that helps always (among the allies it is
  // for), one that hurts from a distance; a melee area that hurts strikes about the foe it is used on.
  const hurts = effects.some((e) => e.kind === 'damage') || s.effects.some((e) => typeof e === 'object' && e.on === 'enemies');
  const area = !!AREA[s.area] && s.target !== 'self';
  const aimed = area && (hurts ? c.reach === 'ranged' && !dash : true);
  const targeting = s.target === 'self' ? 'self' : aimed ? 'ground' : s.target === 'ally' && !hurts ? 'ally' : hurts ? 'enemy' : s.target;
  const helpful = effects.some((e) => e.kind === 'heal' || e.kind === 'revive' || e.kind === 'cleanse');
  const onlyHelps = effects.every((e) => e.kind === 'heal' || e.kind === 'cleanse' || e.kind === 'revive' || (e.kind === 'status' && !r.statuses.find((x) => x.id === e.statusId)?.harmful));
  const fx: FxKind = helpful ? 'heal' : effects.every((e) => e.kind === 'status') ? (hurts ? 'debuff' : 'buff') : s.area === 'large' ? 'nova' : c.reach === 'melee' ? (c.damage === 'magic' ? 'shadow' : 'slash') : c.damage === 'magic' ? 'bolt' : 'arrow';
  return {
    id: ids.make(`${c.key.slice(0, 6)}_`, s.name),
    name: s.name.slice(0, 40),
    description: s.description.slice(0, 200),
    owner: c.classId,
    targeting,
    range: targeting === 'self' ? 0 : dash ? RANGE.dash : RANGE[c.reach],
    radius: AREA[s.area] || undefined,
    ap,
    cooldown,
    effects,
    rankBonus: RANK_BONUS,
    maxRank: skillRanks(tier),
    tags: [c.damage === 'magic' ? 'spell' : 'weapon', ...(effects.some((e) => e.kind === 'heal') ? ['heal'] : [])],
    fx,
    outOfCombat: onlyHelps && targeting !== 'enemy' ? true : undefined,
    tune: 1,
  };
}

// ------------------------------------------------------------------------------------ the ruleset

export function compileWorldRules(rec: Records, opts: WorldRulesOptions): Ruleset {
  const sys = rec.rulesSystems;
  const core = rec.rulesCore;
  const w = core.words;
  const ids = new Ids();
  const max = opts.maxLevel;
  const scale = core.numbers === 'small' ? 3 : core.numbers === 'large' ? 30 : 8;

  // ---------------------------------------------------------------- kinds of damage
  const phys = core.classes.physical.damage;
  const mag = core.classes.magical?.damage;
  const types: DamageTypeDef[] = [{ id: ids.make('t_', phys.name), name: phys.name, color: color(phys.color, '#d8d0c0'), mitigationName: phys.defence }];
  if (mag) types.push({ id: ids.make('t_', mag.name), name: mag.name, color: color(mag.color, '#9fb8ff'), mitigationName: mag.defence });
  const typeOf = (d: 'physical' | 'magic'): DamageTypeDef => (d === 'magic' && types[1]) || types[0]!;
  const price = (stat: StatId) => statPrice(stat, types.map((t) => t.id));
  /** Modifiers worth `budget` power %, split evenly over stats. */
  const priced = (stats: StatId[], budget: number): Modifier[] => stats.map((stat) => ({ stat, value: round(budget / stats.length / price(stat)) }));

  // ---------------------------------------------------------------- statuses
  const statOf = (s: string): StatId | null => {
    switch (s) {
      case 'physical_damage': return `dmg:${types[0]!.id}`;
      case 'magic_damage': return types[1] ? `dmg:${types[1].id}` : null;
      case 'physical_defence': return `mit:${types[0]!.id}`;
      case 'magic_defence': return types[1] ? `mit:${types[1].id}` : null;
      case 'movement': return 'move';
      case 'dodge': return sys.dodge ? 'dodge' : null;
      case 'crit_chance': return sys.crit ? 'crit' : null;
      default: return null;
    }
  };
  const statuses: StatusDef[] = rec.rulesStatuses.statuses.map((s) => {
    const def: StatusDef = { id: ids.make('st_', s.name), name: s.name, color: color(s.color, '#c0c0c0'), description: s.description, harmful: s.kind === 'debuff' };
    const mods: Modifier[] = [];
    for (const e of s.effects) {
      if (typeof e === 'object') {
        const up = 'increases' in e;
        const stat = statOf(up ? e.increases : e.decreases);
        if (!stat) continue;
        mods.push({ stat, value: round(((up ? 1 : -1) * B_STATUS) / price(stat)) });
      } else if (e === 'physical_damage_over_time' || e === 'magic_damage_over_time') def.dot = { coef: 0.32, typeId: typeOf(e === 'magic_damage_over_time' ? 'magic' : 'physical').id };
      else if (e === 'heal_over_time') def.hot = { coef: 0.4 };
      // A silence stops the skills of the magic classes, so only a world with magic has one.
      else if (e === 'silence' && !types[1]) throw new Error(`the status "${s.name}" silences, and this world has no magic`);
      else if (sys.control && (e === 'stun' || e === 'root' || e === 'silence' || e === 'disarm')) def.control = e;
      else if (e === 'thorns' || e === 'life_steal') {
        const stat = e === 'thorns' ? 'thorns' : 'lifesteal';
        mods.push({ stat, value: round(B_STATUS / price(stat)) });
      }
    }
    if (mods.length) def.modifiers = mods;
    if (!def.modifiers && !def.dot && !def.hot && !def.control) def.modifiers = [{ stat: 'power', value: def.harmful ? -B_STATUS : B_STATUS }];
    return def;
  });
  const statusNamed = (name: string) => statuses.find((s) => s.name === name);

  // ---------------------------------------------------------------- slots and qualities
  const slots: SlotDef[] = [{ id: ids.make('sl_', core.slots.weapon), name: core.slots.weapon, kind: 'weapon' }];
  if (sys.shields && core.slots.offhand) slots.push({ id: ids.make('sl_', core.slots.offhand), name: core.slots.offhand, kind: 'offhand' });
  for (const a of core.slots.armor) slots.push({ id: ids.make('sl_', a), name: a, kind: 'armor' });
  for (const a of core.slots.accessories) slots.push({ id: ids.make('sl_', a), name: a, kind: 'accessory' });
  const q = core.qualities;
  const RARITY = [{ c: '#d8d8d8', b: 1, w: 60, p: 1 }, { c: '#5fd35f', b: 1.12, w: 28, p: 1.8 }, { c: '#4fa3ff', b: 1.25, w: 9, p: 3.2 }, { c: '#c46bff', b: 1.42, w: 2.5, p: 6 }, { c: '#ffa630', b: 1.62, w: 0.4, p: 12 }];
  const rarities: RarityDef[] = [q.common, q.uncommon, q.rare, q.epic, q.legendary].map((name, i) => ({ id: `r${i}`, name, color: RARITY[i]!.c, affixes: [i, i], budget: RARITY[i]!.b, weight: RARITY[i]!.w, priceMult: RARITY[i]!.p }));

  // ---------------------------------------------------------------- items
  const classes = classesOf(rec);
  const items: ItemBaseDef[] = [];
  const weaponSlot = slots[0]!;
  const weaponOf: Partial<Record<ClassKey, string>> = {};
  for (const c of classes) {
    const set = rec.rulesGear.weapons[c.key];
    for (const [wpn, two] of [[set?.weapon, false], [set?.one_handed, false], [set?.two_handed, true]] as const) {
      if (!wpn) continue;
      const kind = wpn.damage === 'magic_damage' ? 'magic' : wpn.damage === 'physical_damage' ? 'physical' : c.damage;
      const ranged = c.reach === 'ranged';
      const id = ids.make('w_', wpn.name);
      items.push({
        id, name: wpn.name, description: wpn.description, category: 'equipment', slotId: weaponSlot.id, classId: `cl_${c.key}`,
        weapon: ranged ? { coef: two ? 1.0 : 0.9, apCost: 2, range: kind === 'magic' ? 6 : 7, typeId: typeOf(kind).id, projectile: true, twoHanded: two || undefined } : { coef: two ? 1.3 : 1.0, apCost: 2, range: 1.6, typeId: typeOf(kind).id, twoHanded: two || undefined },
        stackable: false, price: 40, dropWeight: 10, icon: ranged ? (kind === 'magic' ? 'staff' : 'bow') : two ? 'axe' : 'sword', tags: [ranged ? 'ranged' : 'melee'],
      });
      weaponOf[c.key] ??= id;
    }
  }
  // Armor: each kind for every armor slot. Both defenses in similar measure; sturdy and nimble lean.
  const armorSlots = slots.filter((s) => s.kind === 'armor');
  const share = (name: string) => (/body|chest|torso|coat|robe|suit|vest|rig|shirt|jacket/i.test(name) ? 0.4 : /head|helm|hat|hood|cap|visor/i.test(name) ? 0.22 : 0.17) * (3 / Math.max(3, armorSlots.length));
  const armour = rec.rulesGear.armor;
  for (const [kind, a, weight] of [['balanced', armour.balanced, 0.9], ['sturdy', armour.sturdy, 1.25], ['nimble', armour.nimble, 0.6]] as const) {
    if (!a) continue;
    const lean: Modifier[] = kind === 'sturdy' ? [{ stat: 'hpPct', value: 4 }, { stat: 'power', value: -3 }] : kind === 'nimble' ? [{ stat: 'power', value: 3 }, { stat: 'hpPct', value: -3 }, ...(sys.dodge ? [{ stat: 'dodge', value: 2 }] : [])] : [];
    for (const slot of armorSlots) {
      // A kind of armor names a piece for every armor slot (its record is keyed by them).
      const name = a.pieces[slot.name]!;
      items.push({
        id: ids.make('a_', name), name, description: a.description, category: 'equipment', slotId: slot.id,
        defense: Object.fromEntries(types.map((t, i) => [t.id, round(weight * share(slot.name) * (i === 0 ? 0.62 : 0.5), 3)])), implicit: lean.length ? lean : undefined,
        stackable: false, price: 30, dropWeight: 4, icon: /head|helm|hat|hood|cap/i.test(slot.name) ? (kind === 'nimble' ? 'hood' : 'helm') : /hand|glove|gaunt|mitt/i.test(slot.name) ? 'gloves' : /feet|boot|shoe|greave|sandal|slipper/i.test(slot.name) ? 'boots' : kind === 'nimble' ? 'robe' : 'chest', tags: [kind],
      });
    }
  }
  const offSlot = slots.find((s) => s.kind === 'offhand');
  if (offSlot) for (const s of rec.rulesGear.shields ?? []) items.push({ id: ids.make('o_', s.name), name: s.name, description: s.description, category: 'equipment', slotId: offSlot.id, defense: Object.fromEntries(types.map((t, i) => [t.id, i === 0 ? 0.3 : 0.18])), stackable: false, price: 35, dropWeight: 5, icon: 'shield', tags: ['shield'] });
  for (const slot of slots.filter((s) => s.kind === 'accessory'))
    for (const a of rec.rulesGear.accessories?.[slot.name] ?? [{ name: slot.name, description: '' }]) items.push({ id: ids.make('j_', a.name), name: a.name, description: a.description, category: 'equipment', slotId: slot.id, stackable: false, price: 50, dropWeight: 3, icon: /amulet|neck|pendant|locket|chip|badge/i.test(slot.name) ? 'amulet' : 'ring', tags: ['accessory'] });
  // Consumables
  const it = rec.rulesItems;
  const consumable = (p: { name: string; description: string }, use: NonNullable<ItemBaseDef['use']>, tag: string, icon: string, price = 20, drop = 6) => items.push({ id: ids.make('c_', p.name), name: p.name, description: p.description, category: 'potion', use, stackable: true, price, dropWeight: drop, icon, tags: [tag] });
  if (it.healing) consumable(it.healing, { effects: [{ kind: 'heal', share: POTION_HEAL }], ap: 1, targeting: 'self', outOfCombat: true }, 'heal', 'potion_red', 15, 14);
  if (it.cleansing) consumable(it.cleansing, { effects: [{ kind: 'cleanse' }], ap: 1, targeting: 'self', outOfCombat: true }, 'cleanse', 'potion_blue');
  for (const b of it.buffs ?? []) {
    const st = statusNamed(b.status);
    if (st) consumable(b, { effects: [{ kind: 'status', statusId: st.id, chance: 1, turns: 3, self: true }], ap: 1, targeting: 'self', outOfCombat: false }, 'buff', 'potion_orange');
  }
  for (const b of it.debuffs ?? []) {
    const st = statusNamed(b.status);
    if (st) consumable(b, { effects: [{ kind: 'status', statusId: st.id, chance: 1, turns: 2 }], ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false }, 'debuff', 'bomb');
  }
  if (it.bombs) {
    consumable(it.bombs.physical, { effects: [{ kind: 'damage', coef: 2.4, typeId: types[0]!.id }], ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false }, 'damage', 'bomb');
    if (it.bombs.magic && types[1]) consumable(it.bombs.magic, { effects: [{ kind: 'damage', coef: 2.4, typeId: types[1].id }], ap: 1, targeting: 'ground', radius: 1.6, outOfCombat: false }, 'damage', 'bomb');
  }
  // Materials: hard and soft are common, the reagent less so, the essence rare.
  const m = it.materials;
  for (const [mat, tier, icon] of [[m.hard, 1, 'ore'], [m.soft, 1, 'herb'], [m.reagent, 2, 'herb'], [m.essence, 3, 'essence']] as const)
    if (mat) items.push({ id: ids.make('m_', mat.name), name: mat.name, description: mat.description, category: 'material', stackable: true, price: 4 + tier * 5, dropWeight: 9 - tier * 2, icon, tier, tags: ['material'] });
  for (const v of it.valuables) items.push({ id: ids.make('v_', v.name), name: v.name, description: v.description, category: 'valuable', stackable: true, price: 30, dropWeight: 4, icon: 'gem', tags: ['valuable'] });
  if (sys.fastTravel) items.push({ id: 'tool_recall', name: `Return to ${w.town}`, description: '', category: 'tool', use: { effects: [], ap: 0, targeting: 'self', outOfCombat: true, tool: 'recall' }, stackable: true, price: 25, dropWeight: 3, icon: 'scroll', tags: ['tool'] });
  items.push({ id: 'quest_item', name: 'Quest Item', description: '', category: 'quest', stackable: false, price: 0, dropWeight: 0, icon: 'quest', tags: [] });
  items.push({ id: 'key', name: 'Key', description: '', category: 'key', stackable: false, price: 0, dropWeight: 0, icon: 'key', tags: [] });

  // ---------------------------------------------------------------- affixes: Diablo-style random effects on gear
  const W: SlotKind[] = ['weapon'], A: SlotKind[] = ['armor', 'offhand'], J: SlotKind[] = ['accessory'];
  // Each is a stat the world's fights use: Healing only where heroes heal, the signature effects where the world has them.
  const affixList: [StatId, SlotKind[], number, string, string][] = [
    ['hpPct', [...A, ...J], 10, 'Hale', 'of Vigor'],
    ['power', [...W, ...J], 6, 'Brutal', 'of Force'],
    ['move', ['armor'], 3, 'Fleet', 'of Haste'],
    ...types.map((t, i): [StatId, SlotKind[], number, string, string] => [`mit:${t.id}`, A, 8, ['Reinforced', 'Warded'][i]!, `of ${t.mitigationName}`]),
    ...types.map((t): [StatId, SlotKind[], number, string, string] => [`dmg:${t.id}`, [...W, ...J], 5, t.name, `of ${t.name}`]),
  ];
  if (sys.healing) affixList.push(['healing', [...J, 'weapon', 'offhand'], 4, 'Blessed', 'of Mercy']);
  if (sys.regeneration) affixList.push(['hpRegen', ['armor', ...J], 3, 'Renewing', 'of Renewal']);
  if (sys.lifeSteal) affixList.push(['lifesteal', [...W, ...J], 2, 'Vampiric', 'of the Leech']);
  if (sys.thorns) affixList.push(['thorns', ['armor', 'offhand'], 3, 'Thorned', 'of Thorns']);
  if (sys.crit) affixList.push(['crit', [...W, ...J, 'armor'], 6, 'Keen', 'of Precision'], ['critDmg', [...W, ...J], 4, 'Savage', 'of Carnage']);
  if (sys.dodge) affixList.push(['dodge', ['armor', ...J], 4, 'Evasive', 'of Shadows']);
  const affixes: AffixDef[] = affixList.map(([stat, slotKinds, weight, prefix, suffix]) => {
    const value = round(B_AFFIX / price(stat));
    return { id: `af_${slug(stat)}`, prefix, suffix, stat, slotKinds, weight, value };
  });

  // ---------------------------------------------------------------- recipes
  // Brewing follows the potions: a world with consumables has a recipe for each, whether or not gear is made there.
  // Gear recipes (at a workshop) are the world's crafting system.
  const mats = items.filter((i) => i.category === 'material');
  const mat = (tier: number) => mats.find((x) => x.tier === tier) ?? mats[0];
  const recipes: RecipeDef[] = [];
  if (mats.length) for (const [i, p] of items.filter((x) => x.category === 'potion').entries()) recipes.push({ id: `rc_${p.id}`, name: `Make ${p.name}`, inputs: [{ itemId: (mat(2) ?? mat(1))!.id, qty: 1 + (i % 2) }], output: { itemId: p.id, qty: 1 }, gold: 0 });
  if (sys.crafting && mats.length) {
    const hard = m.hard ? mats.find((x) => x.name === m.hard!.name) : mat(1);
    const soft = m.soft ? mats.find((x) => x.name === m.soft!.name) : mat(1);
    if (hard) recipes.push({ id: 'rc_weapon', name: `Make a ${w.class.toLowerCase()} weapon`, inputs: [{ itemId: hard.id, qty: 4 }], output: { slotKind: 'weapon' }, gold: 20 });
    if (soft) recipes.push({ id: 'rc_armor', name: 'Make armor', inputs: [{ itemId: soft.id, qty: 3 }], output: { slotKind: 'armor' }, gold: 15 });
    if (soft && accessoriesExist(slots)) recipes.push({ id: 'rc_trinket', name: 'Make an accessory', inputs: [{ itemId: soft.id, qty: 2 }, ...(mat(3) ? [{ itemId: mat(3)!.id, qty: 1 }] : [])], output: { slotKind: 'accessory' }, gold: 40 });
  }

  // ---------------------------------------------------------------- the ruleset without its classes
  const flat = (value: number): Knots => [{ level: 1, value }];
  const r: Ruleset = {
    id: opts.id,
    name: core.name.slice(0, 60),
    turn: { model: 'ap', apPerTurn: 4, apMax: 6, apStart: 4, tilesPerAp: 2 },
    death: { recover: sys.defeat.recoverBody, goldLoss: sys.defeat.loseMoney ? DEFEAT_LOSS : 0, xpLoss: sys.defeat.loseExperience ? DEFEAT_LOSS : 0 },
    revive: sys.revive,
    resolution: { variance: { low: 0.08, medium: 0.15, high: 0.25 }[sys.swing], crit: sys.crit, baseCrit: 5, critMult: CRIT_MULT, critCap: 0.6, dodge: sys.dodge, baseDodge: 0, dodgeCap: 0.45 },
    control: { enabled: sys.control, immunityTurns: 2 },
    recovery: { secondsToFull: 25 },
    health: { name: w.health, color: color(core.healthColor, '#c8322a') },
    damageTypes: types,
    statuses,
    slots,
    rarities,
    skills: [{ id: 'attack', name: 'Attack', description: 'Strike with your weapon.', owner: 'general', targeting: 'enemy', range: 1.6, ap: 2, cooldown: 0, effects: [{ kind: 'damage', coef: 1 }], rankBonus: 0, maxRank: 1, tags: ['basic', 'weapon'], fx: 'slash', tune: 1 }],
    basicAttackId: 'attack',
    kins: [],
    classes: [],
    items,
    affixes,
    recipes,
    // The crafts players learn: those the world has and named; brewing wherever there are recipes to brew (a world with
    // consumables), with gear crafting or without.
    crafts: CRAFTS.flatMap((id) => {
      const c = it.crafts[id];
      const on = { craft: sys.crafting, brew: recipes.some((x) => 'itemId' in x.output), upgrade: sys.upgrades, enchant: sys.enchanting }[id];
      return c && on ? [{ id, name: c.name.slice(0, 40), description: c.description.slice(0, 200) }] : [];
    }),
    fighters: fighters(types),
    // (Starting points near what the balance loop usually settles on.)
    party: { packFewer: 0.8, packMore: 1.4, bossFewer: 2, bossMore: 1.6 },
    boss: { hp: flat(6.5), dmg: flat(2.2) },
    curves: { hp: { base: scale * 10, lin: 0.2, quad: 0.012 }, dmg: { base: scale, lin: 0.2, quad: 0.012 }, mit: { base: scale * 3, lin: 0.2, quad: 0.012 }, monsterHp: [{ level: 1, value: 1 }, { level: max, value: 1 }], monsterDmg: [{ level: 1, value: 0.6 }, { level: max, value: 0.6 }] },
    progression: { maxLevel: max, xp: provisionalXp(max), treePointsStart: 2, treePointsPerLevel: 2, tierRequirements: classShape(max).tiers.map((t) => t.opensAt), killXp: { base: 20, lin: 0.45, quad: 0 } },
    economy: { currency: w.money, sellRatio: 0.3, priceMult: 1, goldPerKill: { base: 3, lin: 0.5, quad: 0 } },
    inventory: { slots: 30 + (sys.crafting ? 10 : 0) + (sys.upgrades ? 5 : 0) + (sys.enchanting ? 5 : 0), upgrades: 4, slotsPerUpgrade: 8, upgradeCost: 150, storage: sys.storage, storageSlots: STORAGE_SLOTS },
    crafting: {
      enabled: sys.crafting,
      upgrades: { enabled: sys.upgrades, materialId: mats.find((x) => x.name === m.hard?.name)?.id, gold: 30 },
      enchanting: { enabled: sys.enchanting, materialId: mats.find((x) => x.name === m.essence?.name)?.id, gold: 50 },
    },
    systems: { statuses: statuses.length > 0, fastTravel: sys.fastTravel },
    difficulty: difficulty(max),
    terminology: { xp: w.experience, level: w.level, actionPoints: 'AP', party: w.party, town: w.town, dungeon: w.dungeon, wilderness: w.wilds, quest: w.quest, currency: w.money, calling: w.class, kin: w.race, talentPoint: w.talent_point, talentPoints: w.talent_points },
    ui: ui(rec.art.interface),
    looks: { kinds: {}, statuses: {}, moves: {} },
  };

  // ---------------------------------------------------------------- classes: one tree each
  for (const c of classes) {
    const classId = `cl_${c.key}`;
    const ctx = { ...c, classId, typeId: typeOf(c.damage).id, typeOf };
    const nodes: TreeNode[] = [];
    const starting: string[] = [];
    // A class's first skill is its everyday move: its first skill of the first tier that deals damage, if one does.
    const firstTier = rec.rulesSkills[c.key]?.[opts.tiers[0]!.id] ?? [];
    const firstAt = Math.max(0, firstTier.findIndex((s) => s.effects.some((e) => e === 'damage' || e === 'physical_damage' || e === 'magic_damage')));
    opts.tiers.forEach((tier, ti) => {
      (rec.rulesSkills[c.key]?.[tier.id] ?? []).forEach((s, si) => {
        const first = ti === 0 && si === firstAt;
        const def = skillOf(r, ids, s, ctx, ti, first, statusNamed);
        r.skills.push(def);
        // A class's first skill is known from the start by its own characters, and a pick for anyone else.
        if (first) starting.push(def.id);
        // One node a skill: its first point learns it, every further point is a rank.
        nodes.push({ id: `n_${def.id}`, name: def.name, description: def.description, kind: 'skill', classId, tier: ti, maxRank: def.maxRank, skillId: def.id });
      });
      for (const p of rec.rulesPassives[c.key]?.[tier.id] ?? []) {
        const stats = p.effects.map((e): StatId => {
          switch (e) {
            case 'health': return 'hpPct';
            case 'physical_defence': return `mit:${types[0]!.id}`;
            case 'magic_defence': return `mit:${typeOf('magic').id}`;
            case 'skill_damage': return `dmg:${ctx.typeId}`;
            case 'skill_power': return c.role === 'healer' ? 'healing' : `dmg:${ctx.typeId}`;
            case 'dodge': return sys.dodge ? 'dodge' : 'hpPct';
            case 'crit_chance': return sys.crit ? 'crit' : `dmg:${ctx.typeId}`;
          }
        });
        nodes.push({ id: ids.make('n_', `${c.key} ${p.name}`), name: p.name, description: '', kind: 'passive', classId, tier: ti, maxRank: 1, modifiers: priced([...new Set(stats)], ti >= 2 ? B_DEEP_PASSIVE : B_PASSIVE) });
      }
    });
    const startingGear: Record<string, string> = {};
    const weapon = weaponOf[c.key] ?? items.find((i) => i.weapon)?.id;
    if (weapon) startingGear[weaponSlot.id] = weapon;
    for (const slot of armorSlots.filter((s) => /body|chest|torso|coat|robe|suit|vest|rig|shirt|jacket|head|helm|hat|hood|cap/i.test(s.name)).slice(0, 2)) {
      const piece = items.find((i) => i.slotId === slot.id && i.tags.includes('balanced'));
      if (piece) startingGear[slot.id] = piece.id;
    }
    r.classes.push({ id: classId, name: c.name, description: c.description, role: c.role, reach: c.reach, damageTypeId: ctx.typeId, startingSkills: starting, startingGear, nodes, tune: TUNE[c.role] } satisfies ClassDef);
  }

  // ---------------------------------------------------------------- statuses something applies
  // A status no skill or item puts on anyone is not part of the world (the rules steps may design one nothing picked).
  const applied = new Set([...r.skills, ...r.items.map((i) => i.use)].flatMap((x) => x?.effects ?? []).flatMap((e) => (e.kind === 'status' ? [e.statusId] : [])));
  r.statuses = statuses.filter((st) => applied.has(st.id));
  r.systems.statuses = r.statuses.length > 0;

  // ---------------------------------------------------------------- races and looks
  const genders = kinPresentations(core.races.length, opts.seed);
  r.kins = core.races.map((k, i): KinDef => ({ id: ids.make('k_', k.name), name: k.name, description: k.description, appearance: k.look, presentation: genders[i]!, names: k.names }));
  const looks = rec.fightLooks;
  const tinted = (l: (typeof looks)['healing'], c: string) => ({ ...l, colors: l.colors.map((x) => color(x, c)) });
  r.looks = {
    kinds: {
      ...Object.fromEntries(types.filter((t) => looks.damageTypes[t.name]).map((t) => [t.id, tinted(looks.damageTypes[t.name]!, t.color)])),
      heal: tinted(looks.healing, '#7dff9a'),
    },
    statuses: Object.fromEntries(r.statuses.filter((s) => looks.statuses[s.name]).map((s) => [s.id, tinted(looks.statuses[s.name]!, s.color)])),
    moves: Object.fromEntries(types.filter((t) => looks.moves[t.name]).map((t) => [t.id, looks.moves[t.name]!])),
  };
  return r;
}

const accessoriesExist = (slots: SlotDef[]) => slots.some((s) => s.kind === 'accessory');

/** The bodies of the kinds of fighter, against an ordinary one (1): health, damage, defenses, speed, and threat. */
function fighters(types: DamageTypeDef[]): Record<FighterKind, FighterDef> {
  const def = (hp: number, dmg: number, phys: number, mag: number, move: number, initiative: number, threat: number): FighterDef => ({
    hp, dmg, move, initiative, threat, defense: Object.fromEntries(types.map((t, i) => [t.id, i === 0 ? phys : mag])),
  });
  const out: Record<FighterKind, FighterDef> = {
    soldier: def(1, 1, 0.25, 0.2, 1.1, 2, 1),
    brute: def(1.4, 1.15, 0.4, 0.1, 1, 0, 1.2),
    swarm: def(0.45, 0.55, 0.1, 0.1, 1.3, 3, 0.45),
    stalker: def(0.8, 1.3, 0.15, 0.15, 1.3, 5, 1.2),
    guardian: def(1.7, 0.8, 0.6, 0.3, 0.8, -2, 1.3),
  };
  for (const k of FIGHTER_KINDS) if (!out[k]) throw new Error(`no body for the kind of fighter ${k}`);
  return out;
}

/** Provisional experience curve; the world's content solves the real one (bind.ts). */
function provisionalXp(maxLevel: number): number[] {
  const xp = [0, 0];
  for (let l = 2; l <= maxLevel; l++) xp.push(Math.round(120 * Math.pow(l - 1, 1.8) + 80 * (l - 1)));
  return xp;
}

function difficulty(maxLevel: number): Ruleset['difficulty'] {
  // Low levels get gentler multipliers: fights there are only a few hits long.
  const k = (lo: number, hi: number): Knots => [{ level: 1, value: lo }, { level: Math.min(4, maxLevel), value: hi }, { level: maxLevel, value: hi }];
  const d: Record<DifficultyId, Ruleset['difficulty'][DifficultyId]> = {
    story: { name: 'Story', enemyHp: k(0.7, 0.55), enemyDmg: k(0.65, 0.5), extraEnemyChance: 0, lootMult: 1 },
    easy: { name: 'Easy', enemyHp: k(0.88, 0.78), enemyDmg: k(0.85, 0.75), extraEnemyChance: 0, lootMult: 1 },
    normal: { name: 'Normal', enemyHp: k(1, 1), enemyDmg: k(1, 1), extraEnemyChance: 0, lootMult: 1 },
    hard: { name: 'Hard', enemyHp: k(1.08, 1.25), enemyDmg: k(1.08, 1.25), extraEnemyChance: 0.25, lootMult: 1.15 },
    brutal: { name: 'Brutal', enemyHp: k(1.15, 1.5), enemyDmg: k(1.15, 1.45), extraEnemyChance: 0.5, lootMult: 1.3 },
  };
  return d;
}

/** The interface's look and the game view's grading. */
function ui(i: Records['art']['interface']): Ruleset['ui'] {
  const g = { warm: [1.05, 1.03, 0.35, 0.03], cold: [0.9, 1.05, 0.35, 0.02], bleak: [0.7, 1.1, 0.55, 0.08], vivid: [1.2, 1.04, 0.25, 0.0], muted: [0.8, 1.0, 0.4, 0.04], neon: [1.3, 1.1, 0.4, 0.03] }[i.mood];
  return { material: i.material, ornament: i.ornament, typeface: i.typeface, grading: { tint: color(i.tint, '#ffffff'), saturation: g[0]!, contrast: g[1]!, vignette: g[2]!, grain: g[3]! } };
}
