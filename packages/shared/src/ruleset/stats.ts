/**
 * Ruleset interpretation shared by server, client and simulator: lookups, level curves, stat aggregation
 * for characters and monsters. Pure functions of (ruleset, state).
 */
import type { FighterKind } from '../rules/actors.ts';
import type { AffixDef, ClassDef, Curve, DamageTypeDef, DifficultyId, ItemBaseDef, KinDef, Knots, Modifier, RarityDef, Ruleset, SkillDef, SlotDef, StatId, StatusDef, TreeNode } from './types.ts';

// ------------------------------------------------------------------------------------ lookups

interface RulesetIndex {
  skill: Map<string, SkillDef>;
  status: Map<string, StatusDef>;
  item: Map<string, ItemBaseDef>;
  affix: Map<string, AffixDef>;
  cls: Map<string, ClassDef>;
  kin: Map<string, KinDef>;
  slot: Map<string, SlotDef>;
  type: Map<string, DamageTypeDef>;
  rarity: Map<string, RarityDef>;
  /** Every class's tree nodes, by id (any character may take any of them). */
  node: Map<string, TreeNode>;
  /** Each skill's node in its class's tree. */
  skillNode: Map<string, TreeNode>;
  rarityOrder: Map<string, number>;
}

const cache = new WeakMap<Ruleset, RulesetIndex>();
const byId = <T extends { id: string }>(a: T[]) => new Map(a.map((x) => [x.id, x]));

export function rx(r: Ruleset): RulesetIndex {
  let ix = cache.get(r);
  if (ix) return ix;
  ix = {
    skill: byId(r.skills),
    status: byId(r.statuses),
    item: byId(r.items),
    affix: byId(r.affixes),
    cls: byId(r.classes),
    kin: byId(r.kins),
    slot: byId(r.slots),
    type: byId(r.damageTypes),
    rarity: byId(r.rarities),
    node: byId(r.classes.flatMap((c) => c.nodes)),
    skillNode: new Map(r.classes.flatMap((c) => c.nodes.flatMap((n) => (n.skillId ? [[n.skillId, n] as const] : [])))),
    rarityOrder: new Map(r.rarities.map((x, i) => [x.id, i])),
  };
  cache.set(r, ix);
  return ix;
}

/** Call after mutating a ruleset in place (the balance loop does). */
export function invalidateRuleset(r: Ruleset) {
  cache.delete(r);
}

// ------------------------------------------------------------------------------------ curves

export function curve(c: Curve, level: number): number {
  const n = Math.max(0, level - 1);
  return c.base * (1 + c.lin * n + c.quad * n * n);
}

export function knot(k: Knots, level: number): number {
  if (!k.length) return 1;
  if (level <= k[0]!.level) return k[0]!.value;
  for (let i = 1; i < k.length; i++) {
    const a = k[i - 1]!, b = k[i]!;
    if (level <= b.level) return a.value + ((b.value - a.value) * (level - a.level)) / Math.max(1e-9, b.level - a.level);
  }
  return k[k.length - 1]!.value;
}

const refHp = (r: Ruleset, level: number) => curve(r.curves.hp, level);
export const refDpa = (r: Ruleset, level: number) => curve(r.curves.dmg, level);
const refMit = (r: Ruleset, level: number) => curve(r.curves.mit, level);

// ------------------------------------------------------------------------------------ stat units

type StatUnit = 'hp' | 'dmg' | 'mit' | 'pct' | 'flat';

/** How a stat's modifier values are interpreted. 'hp'/'dmg'/'mit' are coefficients of the level curves. */
export function statUnit(stat: StatId): StatUnit {
  if (stat === 'hp' || stat === 'hpRegen') return 'hp';
  if (stat === 'thorns') return 'dmg';
  if (stat.startsWith('mit:')) return 'mit';
  if (stat === 'move') return 'flat';
  return 'pct';
}

/** Absolute value of a modifier granted at `level` (an item's level, or the character's for the tree). */
export function modifierAmount(r: Ruleset, m: Modifier, level: number): number {
  switch (statUnit(m.stat)) {
    case 'hp':
      return m.value * refHp(r, level);
    case 'dmg':
      return m.value * refDpa(r, level);
    case 'mit':
      return m.value * refMit(r, level);
    default:
      return m.value;
  }
}

// ------------------------------------------------------------------------------------ derived stats

interface WeaponStats {
  /** Damage per hit at the weapon's AP cost. */
  min: number;
  max: number;
  apCost: number;
  range: number;
  typeId: string;
  projectile: boolean;
  melee: boolean;
}

export interface StatBlock {
  level: number;
  maxHp: number;
  hpRegen: number;
  apPerTurn: number;
  apMax: number;
  apStart: number;
  move: number;
  initiative: number;
  crit: number;
  critMult: number;
  dodge: number;
  /** Damage per AP of non-weapon skills. */
  dpa: number;
  weapon: WeaponStats;
  /** Additive % bonuses keyed by stat (power, dmg:<x>, healing). */
  pct: Record<string, number>;
  mitigation: Record<string, number>;
  /** Damage taken modifier as a multiplier (exposed > 1, fortified < 1). */
  taken: number;
  lifesteal: number;
  thorns: number;
  rooted: boolean;
  silenced: boolean;
  disarmed: boolean;
  /** Loses its next turn in a fight (combat.ts). */
  stunned: boolean;
}

interface ActiveStatusLike {
  id: string;
  turns: number;
  power: number;
  strength?: number;
}

interface CharacterLike {
  classId: string;
  kinId: string;
  level: number;
  tree: Record<string, number>;
  equipment: Record<string, ItemLike | undefined>;
  statuses: ActiveStatusLike[];
}

export interface ItemLike {
  baseId: string;
  level: number;
  rarityId: string;
  affixes: { affixId: string; value: number }[];
  uniqueMods?: Modifier[];
}

class Acc {
  flat = new Map<string, number>();
  add(stat: string, v: number) {
    this.flat.set(stat, (this.flat.get(stat) ?? 0) + v);
  }
  get(stat: string) {
    return this.flat.get(stat) ?? 0;
  }
}

const MIT_CAP = 0.85;
const LIFESTEAL_CAP = 25;

function rarityBudget(r: Ruleset, rarityId: string): number {
  return rx(r).rarity.get(rarityId)?.budget ?? 1;
}

/**
 * How much more every bonus on gear is worth at a world's last level than at its first, beside what the level curves
 * already grow (a bonus to Health or to a defense is a share of the level's Health or defense, a percentage the same
 * share at every level). Everything on an item follows its level, so an improved item is as strong as one found at its
 * new level, and gear found deeper in a world is better than gear found near its start, by as much in a world of five
 * levels as in one of thirty (as its experience and gold are spread over its own levels).
 */
export const ITEM_GROWTH = 0.25;

/** A bonus on gear as it stands at the item's level. */
export function itemMod(r: Ruleset, m: Modifier, level: number): Modifier {
  const span = Math.max(1, r.progression.maxLevel - 1);
  return { stat: m.stat, value: m.value * (1 + (ITEM_GROWTH * Math.min(span, level - 1)) / span) };
}

export function weaponHit(r: Ruleset, item: ItemLike, base: ItemBaseDef): [number, number] {
  const w = base.weapon!;
  const per = w.coef * refDpa(r, item.level) * w.apCost * (1 + (rarityBudget(r, item.rarityId) - 1) * 0.35);
  const v = r.resolution.variance;
  return [per * (1 - v), per * (1 + v)];
}

/** An item's modifiers at its level: its base's, its affixes', and a unique's own, as they stand before the curves. */
export function itemMods(r: Ruleset, item: ItemLike, base: ItemBaseDef | undefined = rx(r).item.get(item.baseId)): Modifier[] {
  const ix = rx(r);
  const out: Modifier[] = [];
  for (const m of base?.implicit ?? []) out.push(m);
  for (const a of item.affixes) {
    const def = ix.affix.get(a.affixId);
    if (def) out.push({ stat: def.stat, value: a.value });
  }
  for (const m of item.uniqueMods ?? []) out.push(m);
  return out.map((m) => itemMod(r, m, item.level));
}

/** An armor piece's defense against a kind of damage, as a coefficient of the level's mitigation scale. */
export const defenseCoef = (r: Ruleset, item: ItemLike, c: number) => c * rarityBudget(r, item.rarityId) ** 0.5;

function addItemMods(r: Ruleset, item: ItemLike, acc: Acc) {
  const base = rx(r).item.get(item.baseId);
  if (!base) return;
  if (base.defense) for (const [typeId, c] of Object.entries(base.defense)) acc.add(`mit:${typeId}`, defenseCoef(r, item, c) * refMit(r, item.level));
  for (const m of itemMods(r, item, base)) acc.add(m.stat, modifierAmount(r, m, item.level));
}

// ------------------------------------------------------------------------------------ affixes

/** The slot kind of an item base (weapon, offhand, armor, or accessory), if it is gear. */
export function slotKindOf(r: Ruleset, base: ItemBaseDef | undefined): SlotDef['kind'] | undefined {
  return base?.slotId ? rx(r).slot.get(base.slotId)?.kind : undefined;
}

/**
 * The affixes gear of a base can roll: those of its slot, never a stat the base already gives (it would read as a
 * second line of the same thing), nor one in `taken`. A weapon's damage bonus is for its own kind of damage only,
 * so a staff never rolls a bonus to blows and a sword never one to spells.
 */
export function affixPool(r: Ruleset, base: ItemBaseDef, taken: Iterable<string> = []): AffixDef[] {
  const kind = slotKindOf(r, base);
  if (!kind) return [];
  const have = new Set<string>(taken);
  for (const m of base.implicit ?? []) have.add(m.stat);
  for (const t of Object.keys(base.defense ?? {})) have.add(`mit:${t}`);
  return r.affixes.filter((a) => a.slotKinds.includes(kind) && !have.has(a.stat) && !(base.weapon && a.stat.startsWith('dmg:') && a.stat !== `dmg:${base.weapon.typeId}`));
}

/**
 * How many affixes gear of a base rolls at a rarity. Gear whose base gives nothing of its own (an accessory: no
 * damage, defense, or built-in bonus) rolls one more, so every piece of gear does something.
 */
export function affixCount(r: Ruleset, base: ItemBaseDef | undefined, rarityId: string): [number, number] {
  const [lo, hi] = rx(r).rarity.get(rarityId)?.affixes ?? [0, 0];
  const bare = !!base && !base.weapon && !base.defense && !base.implicit?.length;
  return bare ? [lo + 1, hi + 1] : [lo, hi];
}

type Flags = { rooted: boolean; silenced: boolean; disarmed: boolean; stunned: boolean };

function addStatusMods(r: Ruleset, statuses: ActiveStatusLike[], level: number, acc: Acc, flags: Flags) {
  const ix = rx(r);
  for (const s of statuses) {
    const def = ix.status.get(s.id);
    if (!def) continue;
    for (const m of def.modifiers ?? []) acc.add(m.stat, modifierAmount(r, m, level) * (s.strength ?? 1));
    if (def.control === 'root') flags.rooted = true;
    if (def.control === 'silence') flags.silenced = true;
    if (def.control === 'disarm') flags.disarmed = true;
    if (def.control === 'stun') flags.stunned = true;
  }
}

function finish(r: Ruleset, level: number, acc: Acc, base: { hp: number; dpa: number; weapon: WeaponStats }, flags: Flags, opts: { apBonus?: number } = {}): StatBlock {
  const K = refMit(r, level);
  const pct: Record<string, number> = {};
  for (const [k, v] of acc.flat) if (k === 'power' || k.startsWith('dmg:') || k === 'healing') pct[k] = v;
  const mitigation: Record<string, number> = {};
  for (const t of r.damageTypes) {
    const R = Math.max(0, acc.get(`mit:${t.id}`));
    mitigation[t.id] = Math.min(MIT_CAP, R / (R + K));
  }
  const t = r.turn;
  return {
    level,
    maxHp: Math.max(1, Math.round(base.hp * (1 + acc.get('hpPct') / 100) + acc.get('hp'))),
    hpRegen: acc.get('hpRegen'),
    apPerTurn: Math.max(1, t.apPerTurn + (opts.apBonus ?? 0)),
    apMax: t.apMax + (opts.apBonus ?? 0),
    apStart: t.apStart + (opts.apBonus ?? 0),
    move: flags.rooted ? 0 : Math.max(0.5, t.tilesPerAp + acc.get('move')),
    initiative: 10,
    crit: r.resolution.crit ? Math.min(r.resolution.critCap, (r.resolution.baseCrit + acc.get('crit')) / 100) : 0,
    critMult: r.resolution.critMult + acc.get('critDmg') / 100,
    dodge: r.resolution.dodge ? Math.min(r.resolution.dodgeCap, Math.max(0, (r.resolution.baseDodge + acc.get('dodge')) / 100)) : 0,
    dpa: base.dpa,
    weapon: base.weapon,
    pct,
    mitigation,
    taken: Math.max(0.3, 1 + acc.get('taken') / 100),
    lifesteal: Math.min(LIFESTEAL_CAP, acc.get('lifesteal')) / 100,
    thorns: acc.get('thorns'),
    rooted: flags.rooted,
    silenced: flags.silenced,
    disarmed: flags.disarmed,
    stunned: flags.stunned,
  };
}

export function characterStats(r: Ruleset, ch: CharacterLike): StatBlock {
  const ix = rx(r);
  const acc = new Acc();
  const cls = ix.cls.get(ch.classId);
  const items = Object.values(ch.equipment).filter((x): x is ItemLike => !!x);
  for (const it of items) addItemMods(r, it, acc);
  for (const [nodeId, rank] of Object.entries(ch.tree)) {
    const n = ix.node.get(nodeId);
    if (!n || rank <= 0 || !n.modifiers) continue;
    for (const m of n.modifiers) acc.add(m.stat, modifierAmount(r, m, ch.level) * rank * (n.tune ?? 1));
  }
  const flags: Flags = { rooted: false, silenced: false, disarmed: false, stunned: false };
  addStatusMods(r, ch.statuses, ch.level, acc, flags);
  const tune = cls?.tune ?? { hp: 1, dmg: 1 };
  // Weapon
  const wSlot = r.slots.find((s) => s.kind === 'weapon');
  const wItem = wSlot ? ch.equipment[wSlot.id] : undefined;
  const wBase = wItem ? ix.item.get(wItem.baseId) : undefined;
  let weapon: WeaponStats;
  if (wItem && wBase?.weapon) {
    const [mn, mx] = weaponHit(r, wItem, wBase);
    const m = tune.dmg;
    weapon = { min: mn * m, max: mx * m, apCost: wBase.weapon.apCost, range: wBase.weapon.range, typeId: wBase.weapon.typeId, projectile: !!wBase.weapon.projectile, melee: wBase.weapon.range <= 2 };
  } else {
    const per = refDpa(r, ch.level) * 0.6 * 2 * tune.dmg;
    weapon = { min: per * (1 - r.resolution.variance), max: per * (1 + r.resolution.variance), apCost: 2, range: 1.6, typeId: cls?.damageTypeId ?? r.damageTypes[0]!.id, projectile: false, melee: true };
  }
  return finish(r, ch.level, acc, { hp: refHp(r, ch.level) * tune.hp, dpa: refDpa(r, ch.level) * tune.dmg, weapon }, flags);
}

interface FighterStatInput {
  level: number;
  fighter: FighterKind;
  /** The classes it fights as: the first gives its reach and kind of damage. */
  classIds: string[];
  boss?: boolean;
  statuses: ActiveStatusLike[];
  difficulty?: DifficultyId;
  /** Threat multiplier (pack fitted to a smaller party); split evenly between health and damage. */
  scale?: number;
}

/** A creature's or boss's stats: its kind of fighter's body, its class's reach and damage. */
export function fighterStats(r: Ruleset, m: FighterStatInput): StatBlock {
  const def = r.fighters[m.fighter];
  const cls = rx(r).cls.get(m.classIds[0] ?? '');
  const acc = new Acc();
  const diff = r.difficulty[m.difficulty ?? 'normal'] ?? r.difficulty.normal;
  const fitted = Math.sqrt(Math.max(0.1, Math.min(3, m.scale ?? 1)));
  const hpMult = def.hp * knot(r.curves.monsterHp, m.level) * (m.boss ? knot(r.boss.hp, m.level) : 1) * knot(diff.enemyHp, m.level) * fitted;
  const dmgMult = def.dmg * knot(r.curves.monsterDmg, m.level) * (m.boss ? knot(r.boss.dmg, m.level) : 1) * knot(diff.enemyDmg, m.level) * fitted;
  for (const [typeId, c] of Object.entries(def.defense)) acc.add(`mit:${typeId}`, c * refMit(r, m.level) * (m.boss ? 1.3 : 1));
  const flags: Flags = { rooted: false, silenced: false, disarmed: false, stunned: false };
  addStatusMods(r, m.statuses, m.level, acc, flags);
  const dpa = refDpa(r, m.level) * dmgMult;
  const ranged = cls?.reach === 'ranged';
  const v = r.resolution.variance;
  const weapon: WeaponStats = { min: dpa * 2 * (1 - v), max: dpa * 2 * (1 + v), apCost: 2, range: ranged ? 8 : 1.6, typeId: cls?.damageTypeId ?? r.damageTypes[0]!.id, projectile: ranged, melee: !ranged };
  const block = finish(r, m.level, acc, { hp: refHp(r, m.level) * hpMult, dpa, weapon }, flags, { apBonus: m.boss ? 1 : 0 });
  // Its body's own pace, with what statuses add or take, as a hero's.
  block.move = flags.rooted ? 0 : Math.max(0.5, r.turn.tilesPerAp * def.move + acc.get('move'));
  // A hero's 10, with its kind's own quickness: a creature's level gives it no edge in the order.
  block.initiative = 10 + def.initiative;
  return block;
}

/**
 * The skills a fighter of these classes knows at a level: every skill of the tiers in which a character all-in on the
 * class could have taken one. A tier opens once its points are spent in the class, and its skills cost a point more,
 * so a creature never knows a tier's skills before a hero could.
 */
export function fighterSkills(r: Ruleset, classIds: string[], level: number): string[] {
  const points = treePointsAt(r, level);
  const open = r.progression.tierRequirements.filter((need) => points > need).length;
  const ix = rx(r);
  const own = classIds.flatMap((id) => {
    const c = ix.cls.get(id);
    return c ? [...c.startingSkills, ...c.nodes.filter((n) => n.kind === 'skill' && n.tier < open).map((n) => n.skillId!)] : [];
  });
  return [r.basicAttackId, ...own].filter((x, i, a) => a.indexOf(x) === i && ix.skill.has(x));
}

// ------------------------------------------------------------------------------------ skills & trees

/**
 * A character's rank in a skill (0 when unknown): the basic attack is always known at rank 1, its class's first skill
 * comes free at rank 1, and every point in the skill's node adds a rank.
 */
export function skillRank(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>, skillId: string): number {
  if (skillId === r.basicAttackId) return 1;
  const ix = rx(r);
  const free = ix.cls.get(ch.classId)?.startingSkills.includes(skillId) ? 1 : 0;
  const node = ix.skillNode.get(skillId);
  const max = ix.skill.get(skillId)?.maxRank ?? 1;
  return Math.min(max, free + (node ? ch.tree[node.id] ?? 0 : 0));
}

/** The ranks a node can still take for this character (a known first skill already has its first). */
export function nodeRank(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>, node: TreeNode): { rank: number; max: number } {
  if (node.skillId) return { rank: skillRank(r, ch, node.skillId), max: rx(r).skill.get(node.skillId)?.maxRank ?? node.maxRank };
  return { rank: ch.tree[node.id] ?? 0, max: node.maxRank };
}

/** Skills a character can use (basic attack first). */
export function knownSkills(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>): string[] {
  const ix = rx(r);
  const out = new Set<string>([r.basicAttackId, ...(ix.cls.get(ch.classId)?.startingSkills ?? [])]);
  for (const [nodeId, n] of Object.entries(ch.tree)) {
    const node = ix.node.get(nodeId);
    if (node?.kind === 'skill' && node.skillId && n > 0) out.add(node.skillId);
  }
  return [...out].filter((id) => ix.skill.has(id));
}

/** Points a character has spent in a class's tree. */
export function classSpent(r: Ruleset, ch: Pick<CharacterLike, 'tree'>, classId: string): number {
  const ix = rx(r);
  let s = 0;
  for (const [nodeId, n] of Object.entries(ch.tree)) if (ix.node.get(nodeId)?.classId === classId) s += n;
  return s;
}

/**
 * Why a hero cannot wield a weapon, or null when they can. A weapon is made for a class, and classes are open to
 * everyone: a hero wields their own class's weapons and those of any class they have spent a point in.
 */
export function wieldBlock(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'>, base: ItemBaseDef | undefined): string | null {
  const cls = base?.classId;
  if (!cls || cls === ch.classId || classSpent(r, ch, cls) > 0) return null;
  return `Spend a ${r.terminology.talentPoint} in ${rx(r).cls.get(cls)?.name ?? 'its class'} to wield it.`;
}

/** Why a node can't take another point, or null if it can. */
export function canAllocate(r: Ruleset, ch: Pick<CharacterLike, 'classId' | 'tree'> & { treePoints: number }, nodeId: string): string | null {
  const node = rx(r).node.get(nodeId);
  if (!node) return 'Unknown node.';
  if (ch.treePoints <= 0) return `No ${r.terminology.talentPoints} to spend.`;
  const { rank, max } = nodeRank(r, ch, node);
  if (rank >= max) return max > 1 ? 'Already at its highest rank.' : node.skillId ? 'Already learned.' : 'Already taken.';
  const req = r.progression.tierRequirements[node.tier] ?? 0;
  const spent = classSpent(r, ch, node.classId);
  if (spent < req) return `Spend ${req - spent} more ${req - spent === 1 ? r.terminology.talentPoint : r.terminology.talentPoints} in ${rx(r).cls.get(node.classId)?.name ?? 'this class'} to open it.`;
  return null;
}

export function xpForLevel(r: Ruleset, level: number): number {
  return r.progression.xp[Math.min(level, r.progression.xp.length - 1)] ?? Infinity;
}

export function levelForXp(r: Ruleset, xp: number): number {
  let l = 1;
  while (l < r.progression.maxLevel && xp >= xpForLevel(r, l + 1)) l++;
  return l;
}

export function treePointsAt(r: Ruleset, level: number): number {
  return r.progression.treePointsStart + r.progression.treePointsPerLevel * (level - 1);
}
