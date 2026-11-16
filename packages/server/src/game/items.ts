/**
 * What players own and take: gear put on and off, things dropped, given and stored, crafts, trade with merchants,
 * and loot (piles, chests, what a kill or a chest leaves, legendary finds).
 */
import {
  GAME_MINUTES_PER_DAY, Rng, CRAFT_RANKS, brewBatch, storageKey, craftPointsLeft, playerLevel, craftRank,
  craftRankLine, craftBases, craftedLevel, craftedRarity, upgradedLevel, bagUpgradeCost, fieldRecipe, nearStation,
  withinHandReach, enchantCost, enchantSlots, affixPool, upgradeBlock, upgradeCost, itemPrice, recipeGold, sellPrice,
  rx, uid, wieldBlock, type CraftId, type FeatureDef, type ItemInstance, type LootPile, type PlayerState,
  type TradeState, type Vec2,
} from '@daydream/shared';
import { forgeLegend, isTopRarity } from './legends.ts';
import { withCallContext } from '../genai/context.ts';
import { addToInventory, affixValue, fitsIn, fitsInInventory, inventoryCapacity, isPouchItem, makeItem, merchantStock, mergeStacks, removeFromInventory, rollLoot, rollRarity } from './loot.ts';
import { clampHealth } from './characters.ts';
import type { Adventure } from './adventure.ts';

/** How far (meters) a party's leader may stand from a pile or chest to take from it by hand. */
export const LOOT_REACH = 3;
/**
 * How many of a stack a message asks for: a whole number from 1 to `have`. Anything else (nothing given, a fraction of
 * one, a negative amount, not a number) is `otherwise`: the whole stack, unless the command says differently.
 */
const qtyOf = (asked: unknown, have: number, otherwise = have): number => {
  const n = Math.floor(Number(asked));
  return n >= 1 ? Math.min(have, n) : otherwise;
};
/** How long (game minutes) an ordinary pile lies before it is gone: a hero's remains and a quest's thing stay. */
const LOOT_KEPT_GAME_MINUTES = 3 * GAME_MINUTES_PER_DAY;
/** What a merchant has to buy with at the start of each day. */
export const merchantPurse = (level: number) => 300 + level * 60;
/** Whose a chest's contents are: each player's own, a quest's find the adventure's. */
export const opener = (f: FeatureDef, userId: string) => (f.questId ? 'adventure' : userId);

/** What this part of an adventure uses of the rest of it. */
type ItemsHost = Pick<
  Adventure,
  'broadcastCombat' | 'charActors' | 'combatOf' | 'conns' | 'ctx' | 'day' | 'inFight' | 'journal'
  | 'leader' | 'markAll' | 'markDirty' | 'markPlayer' | 'places' | 'quests' | 'r' | 'rng'
  | 'sees' | 'sendError' | 'sendTo' | 'state' | 'toastAll' | 'world' | 'zones'
>;

export class Items {
  private h: ItemsHost;
  constructor(h: ItemsHost) {
    this.h = h;
  }

  private trades = new Map<string, string>();

  lootOpen = new Map<string, string>();

  /** Give a player items; quest and key items go to the shared pouch (see `found`). */
  give(p: PlayerState | null, items: ItemInstance[]) {
    const pouch = items.filter((it) => isPouchItem(this.h.r, it));
    if (pouch.length) addToInventory(this.h.r, this.h.state.pouch, pouch);
    const rest = items.filter((it) => !pouch.includes(it));
    if (p && rest.length) addToInventory(this.h.r, p.inventory, rest);
    if (pouch.length) this.h.markAll();
    else if (p) this.h.markPlayer(p.userId);
  }

  /**
   * Things the world put somewhere (in a chest, on a boss) are found: story items go straight into the pouch everyone
   * shares, so a quest never waits on the one player who found them coming back to pick them up. Returns the rest,
   * for the finder's own share.
   */
  found(items: ItemInstance[], finder: string): ItemInstance[] {
    const story = items.filter((it) => isPouchItem(this.h.r, it));
    if (!story.length) return items;
    this.give(null, story);
    for (const it of story) {
      this.h.toastAll(`${finder} found ${this.h.ctx.itemName(it)}.`, 'loot');
      if (it.uniqueId) this.h.journal('loot', `${finder} found ${this.h.ctx.itemName(it)}.`);
    }
    this.h.quests.refresh();
    return items.filter((it) => !story.includes(it));
  }

  /** The loot piles a player sees and may take: their own, and those that are nobody's. */
  /**
   * Ordinary piles left lying for days are gone (in every place, on a new day and when a place goes live). A hero's
   * remains stay until fetched, and so does anything holding a quest's thing.
   */
  expireLoot() {
    const old = (l: LootPile) => !l.corpse && this.h.state.clock - l.createdAt > LOOT_KEPT_GAME_MINUTES && !l.items.some((it) => isPouchItem(this.h.r, it));
    for (const rt of Object.values(this.h.state.zones)) {
      if (!rt.loot.some(old)) continue;
      rt.loot = rt.loot.filter((l) => !old(l));
      const z = this.h.zones.get(rt.zoneId);
      if (z) z.lootDirty = true;
      this.h.markDirty();
    }
  }

  visibleLoot(userId: string, zoneId: string): LootPile[] {
    return this.h.places.zoneRuntime(zoneId).loot.filter((l) => !l.ownerUserId || l.ownerUserId === userId);
  }

  pileFor(userId: string, zoneId: string, id: string): LootPile | undefined {
    return this.visibleLoot(userId, zoneId).find((l) => l.id === id);
  }

  /** A player's loot from something: one roll for each of `heroes` of theirs, in one pile. */
  rollLootFor(p: PlayerState, heroes: number, rng: Rng, level: number, opts: { boss?: boolean; chest?: boolean; share: number }): { items: ItemInstance[]; gold: number } {
    const mult = this.h.r.difficulty[this.h.state.difficulty]?.lootMult ?? 1;
    const rolls = Array.from({ length: heroes }, () => rollLoot(this.h.r, rng, level, { ...opts, mult }));
    return { items: mergeStacks(this.h.r, rolls.flatMap((l) => l.items)), gold: rolls.reduce((g, l) => g + l.gold, 0) };
  }

  /**
   * One click takes everything from a pile or chest, plus any other piles lying close by. `found` is whether opening the
   * chest just now found something (a story item goes straight to the pouch, told to everyone), so the click was not
   * for nothing.
   */
  lootAll(p: PlayerState, sourceId: string, found = false) {
    const src = this.lootSource(p, sourceId)?.at;
    if (!src) return;
    const ids = [sourceId, ...this.visibleLoot(p.userId, p.zoneId).filter((l) => l.id !== sourceId && Math.hypot(l.x - src.x, l.y - src.y) <= 2.5).map((l) => l.id)];
    const got: string[] = [];
    let gold = 0;
    for (const id of ids) {
      const r = this.cmdTakeLoot(p, id, undefined, true, true);
      if (r) {
        got.push(...r.names);
        gold += r.gold;
      }
    }
    if (ids.includes(this.lootOpen.get(p.userId) ?? '')) this.closeLoot(p.userId);
    const parts = [...(gold ? [`${gold} ${this.h.r.terminology.currency}`] : []), ...got];
    if (!parts.length) return found ? undefined : this.h.sendTo(p.userId, { t: 'toast', text: 'Nothing left to take.', kind: 'info' });
    this.h.sendTo(p.userId, { t: 'toast', text: parts.length > 4 ? `${parts.slice(0, 4).join(', ')}, and ${parts.length - 4} more` : parts.join(', '), kind: 'pickup', sound: gold && !got.length ? 'gold' : undefined });
  }

  /** Put on a piece of gear from the pack; what it replaces goes back into the pack. In a fight: on the hero's turn, for 1 AP. */
  cmdEquip(p: PlayerState, charId: string, itemId: string) {
    const ch = p.party.find((c) => c.id === charId);
    const item = p.inventory.find((i) => i.id === itemId);
    if (!ch || !item) return;
    const base = rx(this.h.r).item.get(item.baseId);
    if (!base?.slotId) return this.h.sendError(p.userId, 'That cannot be equipped.');
    const unwieldy = wieldBlock(this.h.r, ch, base);
    if (unwieldy) return this.h.sendError(p.userId, `${ch.name}: ${unwieldy}`);
    // Same-kind slots (two rings): fill an empty one first.
    const kind = rx(this.h.r).slot.get(base.slotId)?.kind;
    const sameKind = this.h.r.slots.filter((s) => s.kind === kind && (s.id === base.slotId || kind === 'accessory'));
    const slot = sameKind.find((s) => !ch.equipment[s.id])?.id ?? base.slotId;
    // What comes off: the piece in that slot, and the other hand's when a two-handed weapon is involved.
    const weaponSlot = this.h.r.slots.find((s) => s.kind === 'weapon')?.id;
    const offSlot = this.h.r.slots.find((s) => s.kind === 'offhand')?.id;
    const off = [slot];
    if (slot === weaponSlot && base.weapon?.twoHanded && offSlot) off.push(offSlot);
    if (slot === offSlot && weaponSlot && rx(this.h.r).item.get(ch.equipment[weaponSlot]?.baseId ?? '')?.weapon?.twoHanded) off.push(weaponSlot);
    const back = off.flatMap((s) => ch.equipment[s] ?? []);
    if (!fitsIn(this.h.r, p.inventory.filter((i) => i !== item), back, inventoryCapacity(this.h.r, p))) return this.h.sendError(p.userId, 'Your pack is full.');
    const actor = this.h.zones.get(p.zoneId)?.actors.get(ch.id);
    if (actor?.combatId) {
      const c = this.h.combatOf(actor)!;
      if (!c.isActing(actor)) return this.h.sendError(p.userId, 'Not your turn.');
      if (actor.ap < 1) return this.h.sendError(p.userId, `Not enough ${this.h.r.terminology.actionPoints}.`);
      actor.ap -= 1;
      this.h.broadcastCombat(c);
    }
    removeFromInventory(p.inventory, item.id, item.qty);
    for (const s of off) delete ch.equipment[s];
    addToInventory(this.h.r, p.inventory, back);
    ch.equipment[slot] = item;
    clampHealth(this.h.r, ch);
    if (actor) actor.dirty = true;
    this.h.markPlayer(p.userId);
  }

  cmdUnequip(p: PlayerState, charId: string, slot: string) {
    const ch = p.party.find((c) => c.id === charId);
    if (!ch || !ch.equipment[slot]) return;
    const actor = this.h.zones.get(p.zoneId)?.actors.get(ch.id);
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    if (!fitsInInventory(this.h.r, p, [ch.equipment[slot]!])) return this.h.sendError(p.userId, 'Your pack is full.');
    addToInventory(this.h.r, p.inventory, [ch.equipment[slot]!]);
    delete ch.equipment[slot];
    clampHealth(this.h.r, ch);
    if (actor) actor.dirty = true;
    this.h.markPlayer(p.userId);
  }

  cmdDrop(p: PlayerState, itemId: string, qty?: number) {
    const item = p.inventory.find((i) => i.id === itemId);
    if (!item) return;
    if (item.bound) return this.h.sendError(p.userId, 'You should hold on to that.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    const z = this.h.zones.get(p.zoneId);
    const leader = this.h.leader(p);
    if (!z || !leader) return;
    const it = removeFromInventory(p.inventory, itemId, qtyOf(qty, item.qty));
    if (!it) return;
    z.rt.loot.push({ id: uid('lp'), x: leader.x, y: leader.y, items: [it], gold: 0, label: 'Dropped', ownerUserId: p.userId, createdAt: this.h.state.clock, dropped: true });
    z.lootDirty = true;
    this.h.markPlayer(p.userId);
  }

  /**
   * Hand an item from the pack to another player in the game whose heroes stand near, out of a fight. Story items are
   * already everyone's (the pouch), and gear must come off before it is given.
   */
  cmdGive(p: PlayerState, itemId: string, toUserId: string, qty?: number) {
    const item = p.inventory.find((i) => i.id === itemId);
    const to = this.h.state.players[toUserId];
    if (!item || !to || to === p) return;
    if (isPouchItem(this.h.r, item)) return this.h.sendError(p.userId, 'Story items are already shared by everyone.');
    if (!this.h.conns.has(toUserId) || to.zoneId !== p.zoneId) return this.h.sendError(p.userId, `${to.name} is not here.`);
    if (this.h.inFight(p) || this.h.inFight(to)) return this.h.sendError(p.userId, 'Not during a fight.');
    if (!withinHandReach(this.h.charActors(p), this.h.charActors(to))) return this.h.sendError(p.userId, `Stand closer to ${to.name} to hand it over.`);
    const n = qtyOf(qty, item.qty);
    if (!fitsInInventory(this.h.r, to, [{ ...item, qty: n }])) return this.h.sendError(p.userId, `${to.name}’s pack is full.`);
    const it = removeFromInventory(p.inventory, itemId, n);
    if (!it) return;
    addToInventory(this.h.r, to.inventory, [it]);
    const what = `${this.h.ctx.itemName(it)}${n > 1 ? ` ×${n}` : ''}`;
    this.h.sendTo(toUserId, { t: 'toast', text: `${p.name} gave you ${what}.`, kind: 'loot' });
    this.h.sendTo(p.userId, { t: 'toast', text: `Gave ${what} to ${to.name}.` });
    this.h.markPlayer(p.userId);
    this.h.markPlayer(toUserId);
  }

  /** The party leader stands at a workbench (crafting gear, improving, and enchanting happen there), or at another kind of station. */
  private atStation(p: PlayerState, kind?: string): boolean {
    const a = this.h.leader(p);
    const z = this.h.zones.get(p.zoneId);
    return !!a && !!z && nearStation(this.h.ctx.zones.get(z.id)?.features ?? [], { x: a.x, y: a.y }, kind);
  }

  /** Storage: move an item between the pack and the player's store at the town's storage (`to`: where it goes). */
  cmdStore(p: PlayerState, itemId: string, to: 'storage' | 'bag', qty?: number) {
    if (this.h.r.inventory.storage === 'none') return this.h.sendError(p.userId, 'There is no storage in this world.');
    if (!this.atStation(p, 'storage')) return this.h.sendError(p.userId, 'That needs the storage in town.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    const box = ((p.storage ??= {})[storageKey(this.h.r, p.zoneId)] ??= []);
    const [from, into] = to === 'storage' ? [p.inventory, box] : [box, p.inventory];
    const item = from.find((i) => i.id === itemId);
    if (!item) return;
    if (item.bound) return this.h.sendError(p.userId, 'You should hold on to that.');
    const moving = { ...item, qty: qtyOf(qty, item.qty) };
    const fits = to === 'storage' ? fitsIn(this.h.r, box, [moving], this.h.r.inventory.storageSlots) : fitsInInventory(this.h.r, p, [moving]);
    if (!fits) return this.h.sendError(p.userId, to === 'storage' ? 'The storage is full.' : 'Your pack is full.');
    const it = removeFromInventory(from, itemId, moving.qty);
    if (it) addToInventory(this.h.r, into, [it]);
    this.h.markPlayer(p.userId);
  }

  /** Crafting: improve an item, raising its level by the rank's step (it becomes as strong as one found at that level). */
  cmdUpgrade(p: PlayerState, itemId: string, charId?: string) {
    if (!this.h.r.crafting.upgrades.enabled) return this.h.sendError(p.userId, 'Items cannot be improved in this world.');
    if (!this.atStation(p)) return this.h.sendError(p.userId, 'Improving gear needs a workbench.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    const { item } = this.findOwnedItem(p, itemId, charId);
    if (!item) return;
    const rank = craftRank(p, 'upgrade');
    const why = upgradeBlock(this.h.r, item, rank, playerLevel(p), this.craftName('upgrade'));
    const cost = upgradeCost(this.h.r, item, rank, playerLevel(p));
    if (why || !cost) return this.h.sendError(p.userId, why ?? 'This cannot be improved.');
    const { gold, material: mat, qty } = cost;
    if (p.gold < gold) return this.h.sendError(p.userId, `Needs ${gold} ${this.h.r.terminology.currency}.`);
    if (mat && !this.consumeMaterials(p, [{ itemId: mat.id, qty }])) return this.h.sendError(p.userId, `Needs ${qty} ${mat.name}.`);
    p.gold -= gold;
    item.level = upgradedLevel(this.h.r, item, rank, playerLevel(p));
    this.refreshCharStats(p);
    this.h.sendTo(p.userId, { t: 'toast', text: `${this.h.ctx.itemName(item)} improved.`, kind: 'good', sound: 'improve' });
    this.h.markPlayer(p.userId);
  }

  /** Crafting: replace one affix with a new random one. */
  cmdEnchant(p: PlayerState, itemId: string, affixIndex: number, charId?: string) {
    const en = this.h.r.crafting.enchanting;
    if (!en.enabled) return this.h.sendError(p.userId, 'Enchanting is not possible in this world.');
    if (!this.atStation(p)) return this.h.sendError(p.userId, 'Enchanting needs a workbench.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    const { item } = this.findOwnedItem(p, itemId, charId);
    if (!item) return;
    const base = rx(this.h.r).item.get(item.baseId);
    const rank = craftRank(p, 'enchant');
    if (rank <= 0) return this.h.sendError(p.userId, `Learn ${this.craftName('enchant')} first.`);
    const cost = enchantCost(this.h.r, item, rank);
    if (!base || !cost) return this.h.sendError(p.userId, 'That cannot be enchanted.');
    // A new effect goes in an empty slot while there is one, else in place of the one chosen (or the last).
    const at = affixIndex >= 0 && affixIndex < item.affixes.length ? affixIndex : item.affixes.length < enchantSlots(this.h.r, base, item.rarityId) ? item.affixes.length : item.affixes.length - 1;
    // It is never an effect the item keeps (the one replaced may come back, rolled anew).
    const pool = affixPool(this.h.r, base, item.affixes.filter((_, i) => i !== at).map((a) => rx(this.h.r).affix.get(a.affixId)?.stat ?? ''));
    if (!pool.length || at < 0) return this.h.sendError(p.userId, 'That cannot be enchanted.');
    const { gold, material: mat } = cost;
    if (p.gold < gold) return this.h.sendError(p.userId, `Needs ${gold} ${this.h.r.terminology.currency}.`);
    if (mat && !this.consumeMaterials(p, [{ itemId: mat.id, qty: 1 }])) return this.h.sendError(p.userId, `Needs a ${mat.name}.`);
    p.gold -= gold;
    const pick = this.h.rng.pickWeighted(pool, (a) => a.weight);
    // The top rank rolls twice and keeps the better.
    const roll = rank >= CRAFT_RANKS ? Math.max(this.h.rng.next(), this.h.rng.next()) : this.h.rng.next();
    item.affixes[at] = { affixId: pick.id, value: affixValue(this.h.r, pick.id, item.rarityId, roll) };
    this.refreshCharStats(p);
    this.h.sendTo(p.userId, { t: 'toast', text: `${this.h.ctx.itemName(item)} glows with new power.`, kind: 'good', sound: 'enchant' });
    this.h.markPlayer(p.userId);
  }

  private findOwnedItem(p: PlayerState, itemId: string, charId?: string): { item?: ItemInstance } {
    const inv = p.inventory.find((i) => i.id === itemId);
    if (inv) return { item: inv };
    for (const c of p.party) if (!charId || c.id === charId) for (const it of Object.values(c.equipment)) if (it?.id === itemId) return { item: it };
    return {};
  }

  private consumeMaterials(p: PlayerState, inputs: { itemId: string; qty: number }[]): boolean {
    for (const inp of inputs) {
      const have = p.inventory.filter((i) => i.baseId === inp.itemId).reduce((s, i) => s + i.qty, 0);
      if (have < inp.qty) return false;
    }
    for (const inp of inputs) {
      let need = inp.qty;
      for (const it of [...p.inventory].filter((i) => i.baseId === inp.itemId)) {
        const take = Math.min(need, it.qty);
        removeFromInventory(p.inventory, it.id, take);
        need -= take;
        if (!need) break;
      }
    }
    return true;
  }

  private refreshCharStats(p: PlayerState) {
    for (const a of this.h.charActors(p)) a.dirty = true;
    for (const c of p.party) clampHealth(this.h.r, c);
  }

  /** Merchants sell a limited number of pack upgrades. */
  cmdBuyBagSpace(p: PlayerState, npcId: string) {
    if (this.trades.get(p.userId) !== npcId) return this.h.sendError(p.userId, 'That needs a merchant.');
    if (p.inventoryUpgrades >= this.h.r.inventory.upgrades) return this.h.sendError(p.userId, 'Your pack cannot get any bigger.');
    const cost = bagUpgradeCost(this.h.r, p);
    if (p.gold < cost) return this.h.sendError(p.userId, `Needs ${cost} ${this.h.r.terminology.currency}.`);
    p.gold -= cost;
    p.inventoryUpgrades++;
    this.h.sendTo(p.userId, { t: 'toast', text: `Pack enlarged to ${inventoryCapacity(this.h.r, p)} slots.`, kind: 'good' });
    this.sendTrade(p.userId);
    this.h.markPlayer(p.userId);
  }

  /**
   * What a player may take from: a pile they see, or their share of a chest they have opened (a chest is opened by
   * using it, never by asking for what is in it). `box` holds the items and gold, taken out of in place.
   */
  lootSource(p: PlayerState, sourceId: string): { box: { items: ItemInstance[]; gold: number }; at: Vec2; label: string; pile?: LootPile } | undefined {
    const z = this.h.zones.get(p.zoneId);
    if (!z) return undefined;
    const f = z.map.features.get(sourceId);
    if (f) {
      const box = f.kind === 'chest' && this.h.sees(f, p.userId) ? z.rt.features[f.id]?.lootBy?.[opener(f, p.userId)] : undefined;
      return box && { box, at: f, label: f.name ?? 'Chest' };
    }
    const pile = this.pileFor(p.userId, z.id, sourceId);
    return pile && { box: pile, at: pile, label: pile.label, pile };
  }

  openLoot(p: PlayerState, sourceId: string) {
    const src = this.lootSource(p, sourceId);
    if (!src) return;
    this.lootOpen.set(p.userId, sourceId);
    this.h.sendTo(p.userId, { t: 'loot', loot: { id: sourceId, label: src.label, items: src.box.items, gold: src.box.gold, sourceKind: src.pile ? 'pile' : 'chest' } });
  }

  /** The pile or chest a player was looking into is closed (`always`: told so even when the game had none open). */
  closeLoot(userId: string, always = false) {
    if (this.lootOpen.delete(userId) || always) this.h.sendTo(userId, { t: 'loot', loot: null });
  }

  /** Take items from a pile or chest. `quiet` skips per-item toasts and the window refresh (lootAll reports instead). */
  cmdTakeLoot(p: PlayerState, sourceId: string, itemId?: string, all?: boolean, quiet = false): { names: string[]; gold: number } | undefined {
    const z = this.h.zones.get(p.zoneId);
    const src = this.lootSource(p, sourceId);
    if (!z || !src) return;
    if (this.h.inFight(p)) return void this.h.sendError(p.userId, 'Not during a fight.');
    const { box } = src;
    const leader = this.h.leader(p);
    if (!leader || Math.hypot(src.at.x - leader.x, src.at.y - leader.y) > (quiet ? 5 : LOOT_REACH)) {
      if (!quiet) this.h.sendError(p.userId, 'Too far away.');
      return;
    }
    let take = all ? box.items : box.items.filter((i) => i.id === itemId);
    // The pack has limited slots: take what fits (quest items go to the pouch).
    const fitting: ItemInstance[] = [];
    for (const it of take) if (isPouchItem(this.h.r, it) || fitsInInventory(this.h.r, { inventory: [...p.inventory, ...fitting], inventoryUpgrades: p.inventoryUpgrades }, [it])) fitting.push(it);
    if (fitting.length < take.length) this.h.sendError(p.userId, 'Your pack is full.');
    take = fitting;
    const names: string[] = [];
    let tookGold = 0;
    if ((all || itemId === 'gold') && box.gold) {
      tookGold = box.gold;
      box.gold = 0;
      p.gold += tookGold;
      p.stats.goldEarned += tookGold;
      if (!quiet) this.h.sendTo(p.userId, { t: 'toast', text: `${tookGold} ${this.h.r.terminology.currency}`, kind: 'pickup', sound: 'gold' });
    }
    if (take.length) {
      this.give(p, take);
      box.items = box.items.filter((i) => !take.includes(i));
      for (const it of take) {
        const name = `${this.h.ctx.itemName(it)}${it.qty > 1 ? ` ×${it.qty}` : ''}`;
        names.push(name);
        if (!quiet) this.h.sendTo(p.userId, { t: 'toast', text: name, kind: 'pickup' });
        // A find is told once: not what a player put down themselves, or left where they fell.
        if (it.uniqueId && !src.pile?.dropped && !src.pile?.corpse) this.h.journal('loot', `${leader.name} found ${this.h.ctx.itemName(it)}.`);
      }
      this.h.quests.refresh();
    }
    if (!src.pile) z.featuresDirty.add(sourceId);
    // An emptied pile is gone.
    if (src.pile && !box.items.length && !box.gold) {
      z.rt.loot = z.rt.loot.filter((x) => x !== src.pile);
      if (this.lootOpen.get(p.userId) === sourceId) this.closeLoot(p.userId);
    } else if (!quiet) this.openLoot(p, sourceId);
    z.lootDirty = true;
    this.h.markPlayer(p.userId);
    return { names, gold: tookGold };
  }

  private priceMults(p: PlayerState, npcId: string) {
    const rt = this.h.state.npcs[npcId];
    // What the shopkeeper thinks of the leader: prices come out of how the party has dealt with them.
    const regard = rt?.regard[p.leaderId]?.value ?? 0;
    const sell = this.h.r.economy.sellRatio;
    return { buy: Math.max(0.6, 1.25 - regard * 0.002), sell: Math.min(sell * 2, sell + Math.max(0, regard) * 0.001) };
  }

  openTrade(userId: string, npcId: string) {
    const p = this.h.state.players[userId];
    const def = this.h.ctx.npcs.get(npcId);
    const rt = this.h.state.npcs[npcId];
    if (!p || !def || !rt) return;
    if (rt.stockDay !== this.h.day()) {
      const kind = def.merchantKind ?? 'general';
      const level = Math.max(1, this.h.ctx.zones.get(rt.zoneId)?.levelRange[0] ?? def.level);
      rt.stock = merchantStock(this.h.r, new Rng(`${this.h.state.id}:${npcId}:${this.h.day()}`), kind, Math.max(level, ...p.party.map((c) => c.level - 1)));
      rt.stockDay = this.h.day();
      rt.gold = Math.max(rt.gold, merchantPurse(def.level));
    }
    this.trades.set(userId, npcId);
    this.sendTrade(userId);
  }

  private sendTrade(userId: string) {
    const npcId = this.trades.get(userId);
    const p = this.h.state.players[userId];
    if (!npcId || !p) return;
    const rt = this.h.state.npcs[npcId]!;
    const def = this.h.ctx.npcs.get(npcId)!;
    const m = this.priceMults(p, npcId);
    const view: TradeState = { npcId, npcName: def.name, stock: rt.stock.map((it) => ({ ...it, price: Math.max(1, Math.round(itemPrice(this.h.r, it, playerLevel(p)) * m.buy)) })), sellMult: m.sell, npcGold: rt.gold, bagUpgrade: p.inventoryUpgrades < this.h.r.inventory.upgrades ? { cost: bagUpgradeCost(this.h.r, p), slots: this.h.r.inventory.slotsPerUpgrade } : undefined };
    this.h.sendTo(userId, { t: 'trade', trade: view });
  }

  /** A merchant's stock or purse changed: everyone trading with them sees it. */
  private tradeChanged(npcId: string) {
    for (const [u, id] of this.trades) if (id === npcId) this.sendTrade(u);
  }

  closeTrade(userId: string) {
    if (this.trades.delete(userId)) this.h.sendTo(userId, { t: 'trade', trade: null });
  }

  cmdBuy(p: PlayerState, npcId: string, itemId: string, qty?: number) {
    if (this.trades.get(p.userId) !== npcId) return;
    const rt = this.h.state.npcs[npcId]!;
    const it = rt.stock.find((i) => i.id === itemId);
    // (Someone else trading here bought it first.)
    if (!it) return this.h.sendError(p.userId, 'That is no longer for sale.');
    const n = qtyOf(qty, it.qty, 1);
    const unit = Math.max(1, Math.round(itemPrice(this.h.r, { ...it, qty: 1 }, playerLevel(p)) * this.priceMults(p, npcId).buy));
    const cost = unit * n;
    if (p.gold < cost) return this.h.sendError(p.userId, `Not enough ${this.h.r.terminology.currency}.`);
    if (!fitsInInventory(this.h.r, p, [{ ...it, qty: n }])) return this.h.sendError(p.userId, 'Your pack is full.');
    p.gold -= cost;
    rt.gold += cost;
    const bought = removeFromInventory(rt.stock, it.id, n)!;
    addToInventory(this.h.r, p.inventory, [bought]);
    this.h.quests.refresh();
    this.tradeChanged(npcId);
    this.h.markPlayer(p.userId);
  }

  cmdSell(p: PlayerState, npcId: string, itemId: string, qty?: number) {
    if (this.trades.get(p.userId) !== npcId) return;
    const rt = this.h.state.npcs[npcId]!;
    const it = p.inventory.find((i) => i.id === itemId);
    if (!it) return;
    const cat = rx(this.h.r).item.get(it.baseId)?.category;
    if (it.bound || cat === 'quest' || cat === 'key') return this.h.sendError(p.userId, 'They will not buy that.');
    const n = qtyOf(qty, it.qty, 1);
    const unit = sellPrice(this.h.r, it, playerLevel(p), this.priceMults(p, npcId).sell);
    const value = unit * n;
    if (rt.gold < value) return this.h.sendError(p.userId, 'They cannot afford it.');
    p.gold += value;
    rt.gold -= value;
    const sold = removeFromInventory(p.inventory, it.id, n)!;
    addToInventory(this.h.r, rt.stock, [sold]);
    this.tradeChanged(npcId);
    this.h.markPlayer(p.userId);
  }

  /** Make a recipe: a consumable, or the piece of gear the player chose (only its quality and bonuses rolled), at the level crafting makes it (craftedLevel). */
  cmdCraft(p: PlayerState, recipeId: string, baseId?: string) {
    const rec = this.h.r.recipes.find((x) => x.id === recipeId);
    if (!rec) return this.h.sendError(p.userId, 'There is no such recipe.');
    // (A world may have brewing without the making of gear: only gear needs crafting to be part of it.)
    if (!('itemId' in rec.output) && !this.h.r.crafting.enabled) return this.h.sendError(p.userId, 'No gear can be made in this world.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    if (!fieldRecipe(this.h.r, rec) && !this.atStation(p)) return this.h.sendError(p.userId, 'That needs a workbench.');
    // Brewing makes consumables and crafting makes gear, each by the rank learned.
    const craft: CraftId = 'itemId' in rec.output ? 'brew' : 'craft';
    const rank = craftRank(p, craft);
    if (rank <= 0) return this.h.sendError(p.userId, `Learn ${this.craftName(craft)} first.`);
    const gold = recipeGold(this.h.r, rec, playerLevel(p));
    if (p.gold < gold) return this.h.sendError(p.userId, `Needs ${gold} ${this.h.r.terminology.currency}.`);
    const output = rec.output;
    let out: ItemInstance;
    if ('itemId' in output) out = makeItem(this.h.r, this.h.rng, output.itemId, 1, this.h.r.rarities[0]!.id, output.qty * brewBatch(rank));
    else {
      const base = craftBases(this.h.r, output.slotKind).find((b) => b.id === baseId);
      if (!base) return this.h.sendError(p.userId, 'Choose what to make.');
      out = makeItem(this.h.r, this.h.rng, base.id, craftedLevel(this.h.r, playerLevel(p)), rollRarity(this.h.r, this.h.rng, this.h.r.rarities.findIndex((x) => x.id === craftedRarity(this.h.r, rank))));
    }
    if (!fitsInInventory(this.h.r, p, [out])) return this.h.sendError(p.userId, 'Your pack is full.');
    if (!this.consumeMaterials(p, rec.inputs)) return this.h.sendError(p.userId, 'Missing ingredients.');
    p.gold -= gold;
    addToInventory(this.h.r, p.inventory, [out]);
    p.stats.itemsCrafted++;
    this.h.sendTo(p.userId, { t: 'toast', text: `Crafted ${this.h.ctx.itemName(out)}${out.qty > 1 ? ` ×${out.qty}` : ''}.`, kind: 'loot', sound: 'craft' });
    this.h.markPlayer(p.userId);
  }

  /** A rank of a craft (the utility tree): the player's own, for all their heroes. */
  cmdLearnCraft(p: PlayerState, id: CraftId) {
    const craft = this.h.r.crafts.find((c) => c.id === id);
    if (!craft) return;
    const rank = craftRank(p, id);
    if (rank >= CRAFT_RANKS) return this.h.sendError(p.userId, `${craft.name} is learned in full.`);
    if (craftPointsLeft(this.h.r, p) <= 0) return this.h.sendError(p.userId, 'No craft points to spend: they come with levels.');
    p.crafts = { ...p.crafts, [id]: rank + 1 };
    this.h.sendTo(p.userId, { t: 'toast', text: `${craft.name}: rank ${rank + 1}. ${craftRankLine(this.h.r, id, rank + 1)}.`, kind: 'good', sound: 'learn' });
    this.h.markPlayer(p.userId);
  }

  private craftName(id: CraftId): string {
    return this.h.r.crafts.find((c) => c.id === id)?.name ?? id;
  }

  /**
   * Give each top-rarity piece of gear among these items a name, legend, and signature powers (in the background:
   * the item drops at once and becomes named a moment later, wherever it is by then). `finderId`: whose AI budget pays for
   * the naming, and who is told of it when the loot is their `own`; everyone in the place when it is a quest's find.
   */
  forgeLegendaries(items: ItemInstance[], zoneId: string, source: string, finderId: string, own: boolean) {
    const zone = this.h.ctx.zones.get(zoneId);
    for (const item of items.filter((i) => isTopRarity(this.h.r, i))) {
      void withCallContext({ priority: 'interactive', userId: finderId }, () => forgeLegend(this.h.r, item, { world: { title: this.h.world.concept.title, pitch: this.h.world.concept.pitch, tone: this.h.world.concept.tone }, place: zone?.name ?? 'the wilds', source })).then((made) => {
        if (!made || item.uniqueId) return;
        this.h.state.dynamicItems ??= {};
        this.h.state.dynamicItems[made.def.id] = made.def;
        this.mergeDynamicItems();
        item.uniqueId = made.def.id;
        item.uniqueMods = made.mods;
        for (const p of Object.values(this.h.state.players)) {
          if (own ? p.userId === finderId : p.zoneId === zoneId) this.h.sendTo(p.userId, { t: 'toast', text: `Legendary: ${made.def.name}`, kind: 'loot', sound: 'legendary' });
          this.refreshCharStats(p);
          this.h.markPlayer(p.userId);
        }
        for (const z of this.h.zones.values()) {
          z.lootDirty = true;
          for (const f of Object.keys(z.rt.features)) if (Object.values(z.rt.features[f]?.lootBy ?? {}).some((l) => l.items.includes(item))) z.featuresDirty.add(f);
        }
        this.h.markDirty();
      });
    }
  }

  mergeDynamicItems() {
    this.h.ctx.uniqueItems = { ...this.h.world.uniqueItems, ...(this.h.state.dynamicItems ?? {}) };
  }
}
