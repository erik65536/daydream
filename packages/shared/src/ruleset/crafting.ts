/** Costs shared by the server (which charges them) and the client (which shows them). */
import { affixCount, rx, slotKindOf } from './stats.ts';
import type { CraftId, ItemBaseDef, RecipeDef, Ruleset, SlotDef } from './types.ts';

/** How close (tiles) the party leader must stand to a workbench or a store to use it. */
const STATION_REACH = 3;

/**
 * Field recipes (remedies and simple tools) can be made anywhere out of combat; everything else — gear,
 * improving and enchanting — needs a workbench.
 */
export function fieldRecipe(r: Ruleset, rec: RecipeDef): boolean {
  if (!('itemId' in rec.output)) return false;
  const cat = rx(r).item.get(rec.output.itemId)?.category;
  return cat === 'potion' || cat === 'tool';
}

/** The groups recipes are listed in, in order. */
export const RECIPE_GROUPS = [
  { id: 'potions', name: 'Potions' },
  { id: 'bombs', name: 'Bombs' },
  { id: 'tools', name: 'Tools' },
  { id: 'weapon', name: 'Weapons' },
  { id: 'offhand', name: 'Shields' },
  { id: 'armor', name: 'Armor' },
  { id: 'accessory', name: 'Accessories' },
] as const;
export type RecipeGroup = (typeof RECIPE_GROUPS)[number]['id'];

/** Which group a recipe is listed under: what it makes (a thrown consumable is a bomb, gear goes by its slot). */
export function recipeGroup(r: Ruleset, rec: RecipeDef): RecipeGroup {
  if ('slotKind' in rec.output) return rec.output.slotKind;
  const base = rx(r).item.get(rec.output.itemId);
  if (base?.category === 'tool') return 'tools';
  return base?.use?.targeting === 'ground' ? 'bombs' : 'potions';
}

/** Whether a point stands within reach of one of these features of a kind (a workbench by default). */
export function nearStation(features: { kind: string; x: number; y: number }[], at: { x: number; y: number } | undefined, kind = 'craft_station'): boolean {
  return !!at && features.some((f) => f.kind === kind && Math.hypot(f.x - at.x, f.y - at.y) <= STATION_REACH + 0.5);
}

/** How close (meters) two players' heroes must stand for one to hand the other an item. */
export const HAND_REACH = 4;

/** Whether two players can hand each other things: some hero of one stands within reach of some hero of the other. */
export function withinHandReach(a: { x: number; y: number }[], b: { x: number; y: number }[]): boolean {
  return a.some((p) => b.some((q) => Math.hypot(p.x - q.x, p.y - q.y) <= HAND_REACH));
}

/** Which of a player's stores a town's storage opens: the town's own, or the one every town shares. */
export const storageKey = (r: Ruleset, townId: string) => (r.inventory.storage === 'shared' ? 'shared' : townId);

interface CraftCost {
  gold: number;
  material?: ItemBaseDef;
  qty: number;
}

/** Inventory slot capacity after `upgrades` bag upgrades. */
export function inventoryCapacity(r: Ruleset, p: { inventoryUpgrades?: number }): number {
  return r.inventory.slots + Math.min(r.inventory.upgrades, p.inventoryUpgrades ?? 0) * r.inventory.slotsPerUpgrade;
}

/** Slots used: quest items never take space. */
export function inventoryUsed(p: { inventory: { bound?: boolean }[] }): number {
  return p.inventory.filter((i) => !i.bound).length;
}

export function bagUpgradeCost(r: Ruleset, p: { inventoryUpgrades?: number }): number {
  return Math.round(r.inventory.upgradeCost * Math.pow(1 + (p.inventoryUpgrades ?? 0), 1.6));
}

function upgradeMaterial(r: Ruleset): ItemBaseDef | undefined {
  const up = r.crafting.upgrades;
  return up.materialId ? rx(r).item.get(up.materialId) : r.items.find((i) => i.category === 'material' && (i.tier ?? 1) === 2) ?? r.items.find((i) => i.category === 'material');
}

function enchantMaterial(r: Ruleset): ItemBaseDef | undefined {
  const en = r.crafting.enchanting;
  return en.materialId ? rx(r).item.get(en.materialId) : [...r.items].filter((i) => i.category === 'material').sort((a, b) => (b.tier ?? 1) - (a.tier ?? 1))[0];
}

// ------------------------------------------------------------------------------------ crafts (the utility tree)

/** Ranks in each craft. */
export const CRAFT_RANKS = 4;

/**
 * The craft points a player has: their highest hero's level brings them, from one at the start to about three fifths
 * of every rank of the world's crafts at the level cap, so a player chooses what they are good at.
 */
export function craftPoints(r: Ruleset, topLevel: number): number {
  const cap = Math.round(r.crafts.length * CRAFT_RANKS * 0.6);
  if (!cap) return 0;
  const max = Math.max(2, r.progression.maxLevel);
  return Math.max(1, Math.min(cap, Math.round(1 + ((topLevel - 1) / (max - 1)) * (cap - 1))));
}

export const craftRank = (p: { crafts?: Partial<Record<CraftId, number>> }, id: CraftId): number => p.crafts?.[id] ?? 0;

export function craftPointsLeft(r: Ruleset, p: { crafts?: Partial<Record<CraftId, number>>; party: { level: number }[] }): number {
  const spent = Object.values(p.crafts ?? {}).reduce((n, v) => n + (v ?? 0), 0);
  return craftPoints(r, playerLevel(p)) - spent;
}

/** The gear a recipe for a kind of slot can make: the player chooses which. */
export function craftBases(r: Ruleset, slotKind: SlotDef['kind']): ItemBaseDef[] {
  return r.items.filter((b) => b.category === 'equipment' && b.dropWeight > 0 && slotKindOf(r, b) === slotKind);
}

/** The rarity of gear made at a rank of crafting: common at the first, a step better with each rank after (never the best). */
export function craftedRarity(r: Ruleset, rank: number): string {
  return r.rarities[Math.max(0, Math.min(rank - 1, r.rarities.length - 2))]!.id;
}

/**
 * The level of gear made at a workshop. Crafting sets an item's quality and improving its level, so where the world
 * has improving, gear is made at the first level and improved from there; elsewhere it is made at the player's level.
 */
export const craftedLevel = (r: Ruleset, playerLevel: number) => (r.crafts.some((c) => c.id === 'upgrade') ? 1 : playerLevel);

/** How many a brew makes at a rank of brewing: one more each rank (consumables have no level, so a rank never makes a better one). */
export const brewBatch = (rank: number) => Math.max(1, rank);

/** A player's level for what follows it (craft points, the worth of consumables): their highest hero's. */
export const playerLevel = (p: { party: { level: number }[] }) => Math.max(1, ...p.party.map((c) => c.level));

/** How many levels one improvement raises an item at a rank of upgrading: one at the first rank, one more each rank after. */
export const upgradeStep = (rank: number) => Math.max(0, rank);

/**
 * Why an item cannot be improved now, or null when it can. Improving raises an item's level, so it becomes just as
 * strong as one found at that level, as often as the player likes but never past their own level (nor the world's cap).
 */
export function upgradeBlock(r: Ruleset, item: { baseId: string; level: number }, rank: number, playerLevel: number, craftName = 'upgrading'): string | null {
  if (!r.crafting.upgrades.enabled || rx(r).item.get(item.baseId)?.category !== 'equipment') return 'This cannot be improved.';
  if (rank <= 0) return `Learn ${craftName} first.`;
  if (item.level >= Math.min(playerLevel, r.progression.maxLevel)) return item.level >= r.progression.maxLevel ? 'Already at the highest level.' : 'Already at your level.';
  return null;
}

/** The level one improvement takes an item to: a rank's step higher, up to the player's own level. */
export const upgradedLevel = (r: Ruleset, item: { level: number }, rank: number, playerLevel: number) => Math.min(item.level + upgradeStep(rank), playerLevel, r.progression.maxLevel);

/** What one rank of a craft does, in a line. */
export function craftRankLine(r: Ruleset, id: CraftId, rank: number): string {
  switch (id) {
    case 'craft':
      return `Make gear of ${rx(r).rarity.get(craftedRarity(r, rank))?.name.toLowerCase() ?? 'better'} quality`;
    case 'brew':
      return rank > 1 ? `Brew ${brewBatch(rank)} at a time` : 'Brew consumables, one at a time';
    case 'upgrade':
      return `Raise an item's level by ${upgradeStep(rank)}${rank > 1 ? ' at once' : ''}, up to your own`;
    case 'enchant':
      return rank >= CRAFT_RANKS ? `${Math.round((rank - 1) * 15)}% cheaper, and two rolls keep the better` : rank > 1 ? `${Math.round((rank - 1) * 15)}% cheaper` : 'Give gear new random properties';
  }
}

/**
 * Cost of improving an item once at a rank of upgrading, or null when it cannot be improved now (upgradeBlock says
 * why): gold by the level it reaches and one material, however many levels the rank raises it at once.
 */
export function upgradeCost(r: Ruleset, item: { baseId: string; level: number }, rank: number, playerLevel: number): CraftCost | null {
  if (upgradeBlock(r, item, rank, playerLevel)) return null;
  return { gold: Math.round(r.crafting.upgrades.gold * (1 + upgradedLevel(r, item, rank, playerLevel) * 0.15)), material: upgradeMaterial(r), qty: 1 };
}

/** How many effects enchanting can fill on an item: one more than the most its rarity rolls. */
export const enchantSlots = (r: Ruleset, base: ItemBaseDef | undefined, rarityId: string) => affixCount(r, base, rarityId)[1] + 1;

/** Cost of rerolling one affix at a rank of enchanting, or null when the item cannot be enchanted (or no rank). */
export function enchantCost(r: Ruleset, item: { baseId: string; level: number; uniqueId?: string }, rank: number): CraftCost | null {
  const en = r.crafting.enchanting;
  const base = rx(r).item.get(item.baseId);
  if (rank <= 0 || !en.enabled || item.uniqueId || base?.category !== 'equipment' || !base.slotId) return null;
  return { gold: Math.round(en.gold * (1 + item.level * 0.2) * (1 - 0.15 * (rank - 1))), material: enchantMaterial(r), qty: 1 };
}

// ------------------------------------------------------------------------------------ stacks

/** Default maximum stack size per category (an item base can override it with `maxStack`). */
const MAX_STACK: Partial<Record<ItemBaseDef['category'], number>> = { potion: 20, tool: 10, material: 50, valuable: 25 };

/** How many fit in one inventory slot (1 for gear, story items and uniques). */
export function maxStack(r: Ruleset, item: { baseId: string; uniqueId?: string; bound?: boolean }): number {
  if (item.uniqueId || item.bound) return 1;
  const base = rx(r).item.get(item.baseId);
  if (!base?.stackable) return 1;
  return Math.max(1, base.maxStack ?? MAX_STACK[base.category] ?? 20);
}

/** Two items share a stack when they are the same stackable thing (stackables have no level). */
export function sameStack(r: Ruleset, a: { baseId: string; uniqueId?: string; bound?: boolean }, b: { baseId: string; uniqueId?: string; bound?: boolean }): boolean {
  return a.baseId === b.baseId && maxStack(r, a) > 1 && maxStack(r, b) > 1;
}
