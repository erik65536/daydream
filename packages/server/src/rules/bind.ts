/**
 * Binds a world's content to its ruleset: the classes heroes are drawn as, unique item powers, quest rewards, and the
 * level curve (solved from the world's own content). Used at assembly and when a world's rules are rebalanced.
 */
import { FIGHTER_LOOK, Rng, affixPool, curve, rx, type FighterKind, type Modifier, type QuestDef, type Ruleset, type SlotKind, type UniqueItemDef, type WorldDefinition } from '@daydream/shared';
import { affixValue } from '../game/loot.ts';
import { DESIGN_PARTY } from './encounters.ts';

/** Legendary-strength modifiers for a unique item, drawn from the affixes its slot allows. */
export function uniqueMods(r: Ruleset, baseId: string, seed: string): Modifier[] {
  const ix = rx(r);
  const base = ix.item.get(baseId);
  if (!base?.slotId) return [];
  const rng = new Rng(`unique:${seed}`);
  const out: Modifier[] = [];
  const taken = new Set<string>();
  for (let i = 0; i < 3; i++) {
    const choices = affixPool(r, base, taken);
    if (!choices.length) break;
    const a = rng.pickWeighted(choices, (x) => x.weight);
    taken.add(a.stat);
    out.push({ stat: a.stat, value: affixValue(r, a.id, r.rarities[4]!.id, 0.75 + rng.next() * 0.25) });
  }
  return out;
}

/** Pick a ruleset base for a unique item of a broad kind (a quest's things are relics). */
export function uniqueBase(r: Ruleset, kind: 'weapon' | 'armor' | 'trinket' | 'relic', rng: Rng): string {
  const slotKind: Partial<Record<typeof kind, SlotKind>> = { weapon: 'weapon', armor: 'armor', trinket: 'accessory' };
  const want = slotKind[kind];
  const list = want ? r.items.filter((i) => i.category === 'equipment' && i.slotId && rx(r).slot.get(i.slotId)?.kind === want) : [];
  return list.length ? rng.pick(list).id : 'quest_item';
}

function bindUnique(r: Ruleset, u: UniqueItemDef) {
  const ix = rx(r);
  if (!ix.item.has(u.baseId)) u.baseId = 'quest_item';
  u.rarityId = ix.rarity.has(u.rarityId) ? u.rarityId : u.questItem && u.baseId === 'quest_item' ? r.rarities[2]!.id : r.rarities[4]!.id;
  u.mods = u.baseId === 'quest_item' ? [] : uniqueMods(r, u.baseId, u.id);
}

/** Experience per kill (shared out among the heroes who fought). */
export function killXpFor(r: Ruleset, level: number, fighter: FighterKind, boss: boolean): number {
  return Math.round(curve(r.progression.killXp, level) * (boss ? 5 : 1) * FIGHTER_LOOK[fighter].xp);
}

/**
 * Solve the experience curve from the world's content so that a hero who clears content at each level reaches the
 * next level about when that content runs out (progression follows the world, not a fixed table). A fight's
 * experience is split among the heroes in it, and packs are built for DESIGN_PARTY heroes, so a hero's share of the
 * content's kills is a DESIGN_PARTY-th of it, whatever the size of the party. Quest experience is not split. Also sets
 * quest XP and gold rewards.
 */
function solveProgression(r: Ruleset, w: WorldDefinition) {
  const max = r.progression.maxLevel;
  const byLevel = new Array(max + 2).fill(0) as number[];
  const lv = (l: number) => Math.max(1, Math.min(max, Math.round(l)));
  const families = new Map(w.families.map((f) => [f.id, f]));
  const bosses = new Map(w.bosses.map((b) => [b.id, b]));
  for (const z of w.zones)
    for (const s of z.spawns) {
      const found = s.bossId ? bosses.get(s.bossId) : undefined;
      const boss = found && !found.member ? found : undefined;
      const fighter = boss?.fighter ?? families.get(s.familyId)?.members[s.member]?.fighter ?? 'soldier';
      byLevel[lv(s.level)]! += killXpFor(r, lv(s.level), fighter, !!boss) / DESIGN_PARTY;
    }
  for (const q of w.quests) {
    questRewards(r, q);
    byLevel[lv(q.level)]! += q.rewards.xp;
  }
  const xp = [0, 0];
  for (let L = 1; L < max; L++) {
    const kill = curve(r.progression.killXp, L);
    const span = Math.max(kill * 6, byLevel[L]! * 0.8);
    xp.push(Math.round(xp[L]! + span));
  }
  r.progression.xp = xp;
}

/** A quest's experience and gold, from its level. */
export function questRewards(r: Ruleset, q: QuestDef) {
  const L = Math.max(1, Math.min(r.progression.maxLevel, Math.round(q.level)));
  q.rewards.xp = Math.round(curve(r.progression.killXp, L) * (q.main ? 9 : 5));
  q.rewards.gold = Math.round(curve(r.economy.goldPerKill, L) * (q.main ? 14 : 8));
}

/** Bind the world's content to `r` (mutates the world). */
export function bindWorld(w: WorldDefinition, r: Ruleset) {
  w.ruleset = r;
  w.maxLevel = r.progression.maxLevel;
  // Heroes are drawn in their class's look, once per race; drawings made before stay with their class.
  w.origins = r.classes.map((c) => {
    const prev = w.origins.find((o) => o.id === c.id);
    return { id: c.id, name: c.name, description: c.description, appearance: prev?.appearance ?? `${c.name}: ${c.description}`, assets: prev?.assets };
  });
  // Uniques' powers (they grow with the level each is found at, as every item's do).
  for (const u of Object.values(w.uniqueItems)) bindUnique(r, u);
  solveProgression(r, w);
  solveEconomy(r, w);
}

/**
 * What things cost, from what the world pays (as the experience curve is solved from what it holds): the gold a
 * player gathers clearing it (every creature placed, as the loot rolls pay it, every chest, and every quest), spread
 * over its levels, sets the shop's prices and the costs of crafting and of a bigger bag. At the middle level a
 * common weapon costs about two fifths of a level's gold, an upgrade or an enchantment about an eighth, and the first
 * bag upgrade most of a level's gold, so a player who sells little still buys something now and then and has choices
 * to make. Costs grow with item level as before.
 */
export function solveEconomy(r: Ruleset, w: WorldDefinition) {
  const max = r.progression.maxLevel;
  const lv = (l: number) => Math.max(1, Math.min(max, Math.round(l)));
  const gold = (l: number) => curve(r.economy.goldPerKill, lv(l));
  const boss = (s: { bossId?: string }) => !!s.bossId && !w.bosses.find((b) => b.id === s.bossId)?.member;
  let total = 0;
  for (const z of w.zones) {
    for (const s of z.spawns) total += gold(s.level) * 0.55 * (boss(s) ? 6 : 1);
    for (const f of z.features) if (f.kind === 'chest') total += gold(f.lootTier ?? z.levelRange[1]) * 0.9 * 2.5;
  }
  for (const q of w.quests) total += q.rewards.gold;
  const perLevel = Math.max(1, total / max);
  const mid = Math.ceil(max / 2);
  const weapon = r.items.find((i) => i.weapon)?.price ?? 40;
  const nice = (v: number) => (v < 20 ? Math.max(1, Math.round(v)) : Math.round(v / 5) * 5);
  r.economy.priceMult = Math.round(((0.4 * perLevel) / (weapon * (1 + (mid - 1) * 0.3))) * 100) / 100;
  r.crafting.upgrades.gold = nice((0.12 * perLevel) / (1 + mid * 0.15));
  r.crafting.enchanting.gold = nice((0.12 * perLevel) / (1 + mid * 0.2));
  r.inventory.upgradeCost = nice(0.8 * perLevel);
}
