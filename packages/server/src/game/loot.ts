/** Item rolling on the world's ruleset: loot drops, chests, merchant stock, crafting outputs, uniques, inventory. */
import {
  affixCount, affixPool, curve, inventoryCapacity, maxStack, rx, sameStack, slotKindOf, uid,
  type ItemBaseDef, type ItemInstance, type MerchantKind, type PlayerState, type Rng, type Ruleset, type SlotKind, type UniqueItemDef,
} from '@daydream/shared';

export { inventoryCapacity };

/** The best rarity a world has (legendary). */
export const topRarity = (r: Ruleset) => r.rarities[r.rarities.length - 1]!;

/** A rarity rolled by the world's weights, kept within `minIndex` and `maxIndex` (indexes into its rarities). */
export function rollRarity(r: Ruleset, rng: Rng, minIndex = 0, maxIndex = r.rarities.length - 1): string {
  const idx = rng.pickWeighted(r.rarities.map((_, i) => i), (i) => r.rarities[i]!.weight);
  return r.rarities[Math.min(maxIndex, Math.max(minIndex, idx))]!.id;
}

/**
 * An affix's value at a rarity and a roll (0 to 1, from 80% to 120% of its worth). It is the value at the first item
 * level: the item's level grows it when read (itemMod), so raising an item's level raises every affix on it.
 */
export function affixValue(r: Ruleset, affixId: string, rarityId: string, roll: number): number {
  const a = rx(r).affix.get(affixId)!;
  const budget = rx(r).rarity.get(rarityId)?.budget ?? 1;
  return Math.round(a.value * budget * (0.8 + roll * 0.4) * 1000) / 1000;
}

export function makeItem(r: Ruleset, rng: Rng, baseId: string, level: number, rarityId: string, qty = 1): ItemInstance {
  const ix = rx(r);
  const base = ix.item.get(baseId)!;
  const equip = base.category === 'equipment';
  const rid = equip ? rarityId : r.rarities[0]!.id;
  // Only gear has a level: a consumable's strength follows its user, and things that stack are all alike.
  const item: ItemInstance = { id: uid('it'), baseId, level: base.stackable ? 1 : Math.max(1, Math.min(r.progression.maxLevel, level)), rarityId: rid, affixes: [], qty };
  if (equip) {
    const [lo, hi] = affixCount(r, base, rid);
    const n = rng.int(lo, hi);
    const taken = new Set<string>();
    for (let i = 0; i < n; i++) {
      const choices = affixPool(r, base, taken);
      if (!choices.length) break;
      const a = rng.pickWeighted(choices, (p) => p.weight);
      taken.add(a.stat);
      item.affixes.push({ affixId: a.id, value: affixValue(r, a.id, rid, rng.next()) });
    }
  }
  return item;
}

/** An instance of a world-defined unique item. */
export function makeUnique(r: Ruleset, def: UniqueItemDef, level: number): ItemInstance {
  return { id: uid('it'), baseId: rx(r).item.has(def.baseId) ? def.baseId : 'quest_item', level: Math.max(1, level), rarityId: def.rarityId ?? topRarity(r).id, affixes: [], qty: 1, uniqueId: def.id, uniqueMods: def.mods ?? [], bound: !!def.questItem };
}

/** Quest and key items, which go to the adventure's shared pouch instead of a player's bag. */
export function isPouchItem(r: Ruleset, it: ItemInstance): boolean {
  const cat = rx(r).item.get(it.baseId)?.category;
  return !!it.bound || cat === 'quest' || cat === 'key';
}

const dropPool = (r: Ruleset) => r.items.filter((b) => b.dropWeight > 0 && b.category !== 'quest' && b.category !== 'key');

export function rollRandomItem(r: Ruleset, rng: Rng, level: number, opts: { minRarity?: number; maxRarity?: number; slotKind?: SlotKind } = {}): ItemInstance {
  let pool = dropPool(r);
  if (opts.slotKind) pool = pool.filter((b) => b.category === 'equipment' && slotKindOf(r, b) === opts.slotKind);
  if (!pool.length) pool = dropPool(r);
  const base = rng.pickWeighted(pool, (b) => b.dropWeight);
  const rarity = base.category === 'equipment' ? rollRarity(r, rng, opts.minRarity ?? 0, opts.maxRarity) : r.rarities[0]!.id;
  const qty = base.stackable ? (base.category === 'material' ? rng.int(1, 3) : 1) : 1;
  return makeItem(r, rng, base.id, level + rng.int(-1, 0), rarity, qty);
}

/**
 * One roll of loot. `share` is the part of a kill this roll stands for: loot is rolled for each hero who fought, so a
 * hero's roll of an ordinary creature carries a share of its loot (a boss's and a chest's are whole for every hero).
 */
export function rollLoot(r: Ruleset, rng: Rng, level: number, opts: { boss?: boolean; chest?: boolean; mult?: number; share?: number }): { items: ItemInstance[]; gold: number } {
  const m = opts.mult ?? 1;
  const share = opts.share ?? 1;
  const items: ItemInstance[] = [];
  const goldBase = curve(r.economy.goldPerKill, level);
  const gold = Math.round((rng.chance(opts.chest ? 0.9 : 0.55) ? goldBase * (0.6 + rng.next() * 0.8) * (opts.chest ? 2.5 : 1) : 0) * (opts.boss ? 6 : 1) * m * share);
  const n = opts.boss ? rng.int(2, 3) : opts.chest ? rng.int(1, 3) : rng.chance(0.3 * m * share) ? 1 : 0;
  for (let i = 0; i < n; i++) items.push(rollRandomItem(r, rng, level, { minRarity: opts.boss && i === 0 ? 2 : 0 }));
  const mats = r.items.filter((b) => b.category === 'material');
  if (mats.length && rng.chance((opts.chest ? 0.5 : 0.22) * share)) items.push(makeItem(r, rng, rng.pickWeighted(mats, (b) => b.dropWeight).id, level, r.rarities[0]!.id, rng.int(1, 2)));
  return { items: mergeStacks(r, items), gold };
}

/** Merchant stock by shop kind, drawn from the ruleset's items. */
export function merchantStock(r: Ruleset, rng: Rng, kind: MerchantKind, level: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  // Every base of a kind is stocked once before any is stocked twice, each class's first: a weapons seller has a
  // weapon for every class, not three of one and none of another (as picking each at random did, a third of the time).
  const equip = (k: SlotKind | 'any', n: number) => {
    const bases = r.items.filter((b) => b.category === 'equipment' && (k === 'any' || slotKindOf(r, b) === k));
    const nth = new Map<string, number>();
    const order = rng.shuffle([...bases]).map((b) => {
      const i = nth.get(b.classId ?? '') ?? 0;
      nth.set(b.classId ?? '', i + 1);
      return { b, i };
    }).sort((x, y) => x.i - y.i).map((x) => x.b);
    for (let i = 0; i < n && order.length; i++) out.push(makeItem(r, rng, order[i % order.length]!.id, level + rng.int(-1, 1), r.rarities[rng.pick([0, 0, 1, 1, 2])]!.id));
  };
  const stack = (cat: ItemBaseDef['category'], filter: (b: ItemBaseDef) => boolean = () => true) => {
    for (const b of r.items.filter((x) => x.category === cat && filter(x))) out.push(makeItem(r, rng, b.id, level, r.rarities[0]!.id, b.stackable ? rng.int(3, 8) : 1));
  };
  switch (kind) {
    case 'weapons': equip('weapon', 5); equip('offhand', 2); break;
    case 'armor': equip('armor', 7); equip('offhand', 2); break;
    case 'alchemy': stack('potion'); stack('material', (b) => (b.tier ?? 1) <= 2); break;
    case 'magic': equip('accessory', 4); equip('weapon', 2); stack('potion', (b) => b.tags.includes('buff') || b.tags.includes('cleanse')); break;
    case 'materials': stack('material'); break;
    default:
      // Supplies: every consumable the world has (healing, cleansing, buffs, bombs), since a town may have no alchemist.
      stack('potion');
      stack('tool');
      equip('any', 3);
  }
  return out;
}

export function mergeStacks(r: Ruleset, items: ItemInstance[]): ItemInstance[] {
  const out: ItemInstance[] = [];
  addToInventory(r, out, items);
  return out;
}

/** Stacks `items` would add to `inv` once poured into partly filled stacks first. */
function newStacksNeeded(r: Ruleset, inv: ItemInstance[], items: ItemInstance[]): number {
  const room = new Map<string, number>();
  for (const o of inv) if (maxStack(r, o) > 1) room.set(o.baseId, (room.get(o.baseId) ?? 0) + Math.max(0, maxStack(r, o) - o.qty));
  let stacks = 0;
  for (const it of items) {
    if (it.bound) continue;
    const max = maxStack(r, it);
    if (max <= 1) {
      stacks++;
      continue;
    }
    let left = it.qty;
    const free = room.get(it.baseId) ?? 0;
    const used = Math.min(free, left);
    left -= used;
    room.set(it.baseId, free - used);
    while (left > 0) {
      stacks++;
      const put = Math.min(max, left);
      left -= put;
      room.set(it.baseId, (room.get(it.baseId) ?? 0) + (max - put));
    }
  }
  return stacks;
}

/** Whether `items` fit in a bag (filling existing stacks is free; story items always fit). */
export function fitsInInventory(r: Ruleset, p: Pick<PlayerState, 'inventory' | 'inventoryUpgrades'>, items: ItemInstance[]): boolean {
  return fitsIn(r, p.inventory, items, inventoryCapacity(r, p));
}

/** Whether `items` fit in a list of `slots` slots, such as a store. */
export function fitsIn(r: Ruleset, inv: ItemInstance[], items: ItemInstance[], slots: number): boolean {
  return inv.filter((i) => !i.bound).length + newStacksNeeded(r, inv, items) <= slots;
}

/** Add items, topping up existing stacks to their limit and opening new stacks for the rest. */
export function addToInventory(r: Ruleset, inv: ItemInstance[], items: ItemInstance[]) {
  for (const it of items) {
    const max = maxStack(r, it);
    if (max <= 1) {
      inv.push(it);
      continue;
    }
    let left = it.qty;
    for (const o of inv) {
      if (left <= 0) break;
      if (!sameStack(r, o, it) || o.qty >= max) continue;
      const put = Math.min(max - o.qty, left);
      o.qty += put;
      left -= put;
    }
    let first = true;
    while (left > 0) {
      const put = Math.min(max, left);
      inv.push({ ...it, id: first ? it.id : uid('it'), qty: put });
      first = false;
      left -= put;
    }
  }
}

export function removeFromInventory(inv: ItemInstance[], itemId: string, qty = 1): ItemInstance | null {
  const i = inv.findIndex((x) => x.id === itemId);
  if (i < 0) return null;
  const it = inv[i]!;
  if (it.qty > qty) {
    it.qty -= qty;
    return { ...it, id: uid('it'), qty };
  }
  inv.splice(i, 1);
  return it;
}

/** Quest reward specs: unique id or "base:<baseId>:<rarityIndex>" or "slot:<slotKind>:<rarityIndex>". */
export function rewardItems(r: Ruleset, uniques: Record<string, UniqueItemDef>, rng: Rng, specs: string[], level: number): ItemInstance[] {
  const out: ItemInstance[] = [];
  const rarity = (rar?: string) => Math.min(r.rarities.length - 1, Number(rar) || 1);
  for (const s of specs) {
    if (s.startsWith('base:')) {
      const [, baseId, rar] = s.split(':');
      const base = baseId ? rx(r).item.get(baseId) : undefined;
      if (base) out.push(makeItem(r, rng, base.id, level, r.rarities[rarity(rar)]!.id, base.stackable ? 2 : 1));
    } else if (s.startsWith('slot:')) {
      const [, kind, rar] = s.split(':');
      out.push(rollRandomItem(r, rng, level, { slotKind: kind as SlotKind, minRarity: rarity(rar) }));
    } else if (uniques[s]) out.push(makeUnique(r, uniques[s]!, level));
  }
  return out;
}
