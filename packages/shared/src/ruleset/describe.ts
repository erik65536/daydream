/** Human-readable text for ruleset data: stat labels, skill summaries, item names and tooltips, the codex. */
import type { Effect, ItemBaseDef, Modifier, Ruleset, SkillDef, StatId, StatusDef, TreeNode } from './types.ts';
import { curve, defenseCoef, itemMods, modifierAmount, rx, statUnit, weaponHit, type ItemLike, type StatBlock } from './stats.ts';
import { chanceAt, cleanseCount, consumableStats, damageBonus, damageKind, healAmount, isBasic, itemSkill, lifestealAt, potency, rawDamage, reviveAt, statusPower } from './math.ts';

function statName(r: Ruleset, stat: StatId): string {
  const ix = rx(r);
  const [head, arg] = stat.includes(':') ? [stat.slice(0, stat.indexOf(':')), stat.slice(stat.indexOf(':') + 1)] : [stat, ''];
  switch (head) {
    case 'hp': return r.health.name;
    case 'hpPct': return `${r.health.name}`;
    case 'hpRegen': return `${r.health.name} per turn`;
    case 'move': return 'Movement';
    case 'crit': return 'Critical chance';
    case 'critDmg': return 'Critical damage';
    case 'dodge': return 'Dodge';
    case 'power': return 'Damage';
    case 'dmg': return `${ix.type.get(arg)?.name ?? arg} damage`;
    case 'healing': return 'Healing';
    case 'mit': return ix.type.get(arg)?.mitigationName ?? arg;
    case 'lifesteal': return 'Life steal';
    case 'thorns': return 'Reflect damage';
    case 'taken': return 'Damage taken';
    default: return stat;
  }
}

const pctStat = (stat: string) => statUnit(stat) === 'pct';

/** A number of the points spent in the classes' trees, in the world's word ("1 Skill Seed", "3 Skill Seeds"). */
export const talentPoints = (r: Ruleset, n: number) => `${n} ${n === 1 ? r.terminology.talentPoint : r.terminology.talentPoints}`;

/** "+12% Fire damage", "+34 Health" at a level. */
export function modifierLabel(r: Ruleset, m: Modifier, level: number): string {
  const v = modifierAmount(r, m, level);
  const name = statName(r, m.stat);
  if (m.stat === 'hpPct') return `${v >= 0 ? '+' : ''}${Math.round(v)}% ${name}`;
  // Whole percentages from 3 up ("+7% Dodge"), a decimal below, so a small amount never reads as 0.
  if (pctStat(m.stat)) return `${v >= 0 ? '+' : ''}${Math.abs(v) >= 3 || v === 0 ? Math.round(v) : Math.abs(v) >= 0.1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100}% ${name}`;
  if (m.stat === 'move') return `${v >= 0 ? '+' : ''}${Math.round(v * 10) / 10} ${name}`;
  return `${v >= 0 ? '+' : ''}${fine(v)} ${name}`;
}

/** Whole numbers, but small amounts keep enough digits not to read as 0. */
const fine = (v: number) => (Math.abs(v) >= 1 || v === 0 ? Math.round(v) : Math.abs(v) >= 0.1 ? Math.round(v * 10) / 10 : Math.round(v * 100) / 100);

/** "1 turn", "3 turns". */
const turnsText = (n: number) => `${n} turn${n === 1 ? '' : 's'}`;

/**
 * What a control stops, in plain words (`blockedBy`): a silence the skills of the classes that deal the world's second
 * kind of damage, a disarm the basic attack and the skills of those that deal its first.
 */
export function controlText(r: Ruleset, control: NonNullable<StatusDef['control']>): string {
  const magic = r.damageTypes[1]?.name ?? 'magic';
  const physical = r.damageTypes[0]?.name ?? 'weapon';
  switch (control) {
    case 'root': return "Can't move";
    case 'silence': return `Can't use ${magic} skills`;
    case 'disarm': return `Can't attack or use ${physical} skills`;
    case 'stun': return 'Loses their next turn';
  }
}

/**
 * What a status does, line by line: its stat changes at a strength (the potency of the skill that applies it), the
 * damage or healing it deals each turn for an applier of `power` (skill power times potency) when known, and what
 * it stops.
 */
export function statusLines(r: Ruleset, s: StatusDef, opts: { strength?: number; level?: number; power?: number } = {}): string[] {
  const lines: string[] = [];
  if (s.dot) lines.push(`${opts.power !== undefined ? `${fine(s.dot.coef * opts.power)} ` : ''}${rx(r).type.get(s.dot.typeId)?.name ?? ''} damage each turn`.trim());
  if (s.hot) lines.push(`Heals ${opts.power !== undefined ? `${fine(s.hot.coef * opts.power)} ` : ''}${r.health.name} each turn`);
  for (const m of s.modifiers ?? []) lines.push(modifierLabel(r, { stat: m.stat, value: m.value * (opts.strength ?? 1) }, opts.level ?? 1));
  if (s.control) lines.push(controlText(r, s.control));
  return lines;
}

/** One thing a skill does; one that applies a status carries what the status does. */
interface SkillLine {
  text: string;
  status?: { id: string; name: string; color: string; harmful: boolean; lines: string[] };
}

const capital = (t: string) => t.charAt(0).toUpperCase() + t.slice(1);

function effectLine(r: Ruleset, e: Effect, skill: SkillDef, rank: number, stats?: StatBlock): SkillLine | null {
  const ix = rx(r);
  const p = potency(skill, rank);
  const area = !!skill.radius;
  switch (e.kind) {
    case 'damage': {
      // With the user's bonuses to that kind of damage, as a heal is shown with theirs.
      const bonus = stats ? damageBonus(stats, damageKind(r, skill, e, stats).typeId) : 1;
      if (isBasic(skill)) {
        if (!stats) return { text: 'Weapon damage' };
        const w = stats.weapon, wkind = ix.type.get(w.typeId)?.name;
        return { text: `${Math.round(w.min * p * bonus)}–${Math.round(w.max * p * bonus)} ${wkind ? `${wkind} ` : ''}damage` };
      }
      const kind = e.typeId ? ix.type.get(e.typeId)?.name : undefined;
      const amt = stats ? `${Math.round(rawDamage(skill, rank, e, stats) * bonus)} ` : '';
      return { text: capital(`${amt}${kind ? `${kind} ` : ''}damage${area ? ' to each foe in the area' : ''}`) };
    }
    case 'heal':
      if (e.share !== undefined) return { text: `Heals ${Math.round(e.share * 100)}% of ${r.health.name}` };
      return { text: `Heals ${stats ? `${healAmount(stats, e.coef, p)} ` : ''}${r.health.name}${area ? ' to each ally in the area' : ''}` };
    case 'status': {
      const s = ix.status.get(e.statusId);
      if (!s) return null;
      const self = e.self || skill.targeting === 'self';
      const who = area ? (s.harmful ? 'each foe in the area' : 'each ally in the area') : skill.targeting === 'enemy' ? 'the target' : 'an ally';
      const chance = chanceAt(e, skill, rank);
      const text = self
        ? `You gain ${s.name} for ${turnsText(e.turns)}`
        : chance < 1
          ? `${Math.round(chance * 100)}% chance to put ${s.name} on ${who} for ${turnsText(e.turns)}`
          : `Puts ${s.name} on ${who} for ${turnsText(e.turns)}`;
      return { text, status: { id: s.id, name: s.name, color: s.color, harmful: s.harmful, lines: statusLines(r, s, { strength: p, level: stats?.level, power: stats ? statusPower(r, stats, s.id, p) : undefined }) } };
    }
    case 'cleanse': {
      const n = cleanseCount(skill, rank);
      const what = n === Infinity ? 'every harmful effect' : n === 1 ? 'the worst harmful effect' : `the ${n} worst harmful effects`;
      return { text: `Removes ${what}${area ? ' from each ally in the area' : skill.targeting === 'self' ? ' from you' : ''}` };
    }
    case 'revive':
      return { text: `Revives a downed ally with ${Math.round(reviveAt(e, p) * 100)}% ${r.health.name}` };
    case 'dash':
      return { text: 'Rushes to the target first' };
    case 'lifesteal':
      return { text: `Heals you for ${Math.round(lifestealAt(e, p) * 100)}% of the damage dealt` };
  }
}

/** What a skill does at a rank, one line an effect (with numbers if stats are given). */
export function skillDetails(r: Ruleset, skill: SkillDef, rank: number, stats?: StatBlock): SkillLine[] {
  const lines: SkillLine[] = [];
  for (const e of skill.effects) {
    const l = effectLine(r, e, skill, Math.max(1, rank), stats);
    if (l) lines.push(l);
  }
  if (skill.radius) lines.push({ text: `Area: ${Math.round(skill.radius * 20) / 10} tiles across` });
  return lines;
}

/** What a skill does at a rank, as plain lines (a status's effects follow its line, indented). */
export function skillLines(r: Ruleset, skill: SkillDef, rank: number, stats?: StatBlock): string[] {
  return skillDetails(r, skill, rank, stats).flatMap((l) => [l.text, ...(l.status?.lines ?? []).map((x) => `  ${x}`)]);
}

/**
 * What the next rank changes, as "before → after" lines: every line whose numbers grow, a status's effects included.
 * Empty when the skill is unknown or has no further rank.
 */
export function nextRankLines(r: Ruleset, skill: SkillDef, rank: number, stats?: StatBlock): string[] {
  if (rank < 1 || rank >= skill.maxRank) return [];
  const now = skillLines(r, skill, rank, stats);
  const next = skillLines(r, skill, rank + 1, stats);
  const nums = /-?\d+(?:\.\d+)?/g;
  const out: string[] = [];
  next.forEach((line, i) => {
    const was = now[i];
    if (!was || was === line) return;
    // A line that changes its words, not only its numbers ("the worst harmful effect" to "the 2 worst"), as it will read.
    if (was.replace(nums, '#') !== line.replace(nums, '#')) return out.push(line.trim());
    const a = was.match(nums) ?? [];
    let k = 0;
    out.push(line.trim().replace(nums, (n) => {
      const before = a[k++];
      return before !== undefined && before !== n ? `${before} → ${n}` : n;
    }));
  });
  return out;
}

export function skillCostLine(r: Ruleset, skill: SkillDef, stats?: StatBlock): string {
  const parts: string[] = [];
  parts.push(`${isBasic(skill) && stats ? stats.weapon.apCost : skill.ap} ${r.terminology.actionPoints}`);
  if (skill.cooldown) parts.push(`cooldown ${skill.cooldown}`);
  const range = isBasic(skill) ? stats?.weapon.range : skill.range;
  if (skill.targeting !== 'self' && range !== undefined) parts.push(range <= 2 ? 'melee' : `range ${Math.round(range)}`);
  return parts.join(' · ');
}

/** A passive's effects (a skill's node is described by its skill). */
export function nodeLines(r: Ruleset, node: TreeNode, level: number): string[] {
  return (node.modifiers ?? []).map((m) => modifierLabel(r, { stat: m.stat, value: m.value * (node.tune ?? 1) }, level));
}

// ------------------------------------------------------------------------------------ items

interface ItemNaming {
  uniqueItems: Record<string, { name: string; description: string }>;
}

export function itemDisplayName(r: Ruleset, item: ItemLike & { uniqueId?: string; qty?: number }, naming?: ItemNaming): string {
  if (item.uniqueId && naming?.uniqueItems[item.uniqueId]) return naming.uniqueItems[item.uniqueId]!.name;
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  let name = base?.name ?? item.baseId;
  const order = ix.rarityOrder.get(item.rarityId) ?? 0;
  const a1 = item.affixes[0] ? ix.affix.get(item.affixes[0].affixId) : undefined;
  const a2 = item.affixes[1] ? ix.affix.get(item.affixes[1].affixId) : undefined;
  // Skip a prefix or suffix that repeats a word of the name ("Grounding Grounding Clamp").
  const echoes = (word: string) => {
    const stem = (x: string) => x.toLowerCase().replace(/[^a-z]/g, '').slice(0, 5);
    const have = new Set(name.split(/\s+/).map(stem));
    return word.split(/\s+/).some((w) => w.length > 3 && have.has(stem(w)));
  };
  if (a1 && !echoes(a1.prefix)) name = `${a1.prefix} ${name}`;
  if (a2 && order >= 2 && !echoes(a2.suffix)) name = `${name} ${a2.suffix}`;
  return name.trim();
}

/**
 * What a merchant pays for one of an item, at the trade's sell multiplier. Consumables fetch a quarter as much: they
 * are for using, and a brewer's batch must not buy back more materials than it took.
 */
export function sellPrice(r: Ruleset, item: ItemLike, playerLevel: number, sellMult: number): number {
  const consumable = rx(r).item.get(item.baseId)?.category === 'potion';
  return Math.max(1, Math.round(itemPrice(r, { ...item, qty: 1 }, playerLevel) * sellMult * (consumable ? 0.25 : 1)));
}

/** The gold a recipe takes at a player's level (it makes gear at that level, and grows as a fight's gold does). */
export function recipeGold(r: Ruleset, rec: { gold: number }, playerLevel: number): number {
  return rec.gold > 0 ? Math.max(1, Math.round(rec.gold * fightGold(r, playerLevel))) : 0;
}

/** An item's lines. A consumable's strength is shown for the hero at `userLevel` (it has no level of its own). */
export function itemLines(r: Ruleset, item: ItemLike, base: ItemBaseDef | undefined = rx(r).item.get(item.baseId), userLevel = 1): string[] {
  if (!base) return [];
  const ix = rx(r);
  const lines: string[] = [];
  if (base.weapon) {
    const [mn, mx] = weaponHit(r, item, base);
    const kind = ix.type.get(base.weapon.typeId)?.name ?? '';
    lines.push(`${Math.round(mn)}–${Math.round(mx)} ${kind} damage · ${base.weapon.apCost} ${r.terminology.actionPoints}`);
    lines.push(base.weapon.range > 2 ? `Range ${base.weapon.range}` : 'Melee');
    if (base.weapon.twoHanded) lines.push('Two-handed');
  }
  if (base.defense) {
    for (const [typeId, c] of Object.entries(base.defense)) if (c > 0) lines.push(modifierLabel(r, { stat: `mit:${typeId}`, value: defenseCoef(r, item, c) }, item.level));
  }
  // One line per stat: a base bonus and an affix on the same stat read as their total.
  const mods: Modifier[] = [];
  const add = (m: Modifier) => {
    const same = mods.find((x) => x.stat === m.stat);
    if (same) same.value += m.value;
    else mods.push({ ...m });
  };
  for (const m of itemMods(r, item, base)) add(m);
  for (const m of mods) lines.push(modifierLabel(r, m, item.level));
  if (base.use) {
    lines.push(...skillLines(r, itemSkill(base), 1, consumableStats(r, userLevel)));
    if (base.use.tool === 'recall') lines.push(`Returns you to the last ${r.terminology.town} visited`);
    if (base.use.ap && !base.use.tool) lines.push(`${base.use.ap} ${r.terminology.actionPoints} in combat`);
  }
  return lines;
}

/**
 * How much more gold a fight pays at a player's level than at the first: what things bought per fight (consumables,
 * the materials that drop per kill, a recipe's gold) grow by, so one costs the same number of fights all game. Gold per
 * level is no measure: the time spent at a level follows how much content the world puts there.
 */
function fightGold(r: Ruleset, playerLevel: number): number {
  return curve(r.economy.goldPerKill, Math.max(1, playerLevel)) / Math.max(1e-9, r.economy.goldPerKill.base);
}

/**
 * What one of an item is worth. Gear is priced by its own level. Things that stack (consumables, materials,
 * valuables) have no level: they are priced at the level of the player buying or selling them, growing as a fight's
 * gold does, as a consumable's strength follows the level of the hero using it.
 */
export function itemPrice(r: Ruleset, item: ItemLike & { qty?: number }, playerLevel: number): number {
  const ix = rx(r);
  const base = ix.item.get(item.baseId);
  if (!base || base.price <= 0) return 0;
  const rar = ix.rarity.get(item.rarityId);
  const lvl = base.category === 'equipment' ? 1 + (item.level - 1) * 0.3 : fightGold(r, playerLevel);
  let p = base.price * lvl * (rar?.priceMult ?? 1) * r.economy.priceMult;
  p *= 1 + item.affixes.length * 0.25;
  return Math.max(1, Math.round(p));
}
