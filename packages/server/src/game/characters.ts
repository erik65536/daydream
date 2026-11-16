/** Character creation and progression on the world's ruleset: class, kin, the class trees, levels. */
import {
  canAllocate, classSpent, characterStats, knownSkills, levelForXp, rx, skillRank, treePointsAt, uid, xpForLevel,
  type CharacterSpec, type CharacterState, type ItemInstance, type Rng, type Ruleset, type TreeNode,
} from '@daydream/shared';
import { makeItem } from './loot.ts';

export type { CharacterSpec };

/** The sprite of a hero of this class and kin (each class is painted once per kin). */
export const heroSprite = (classId: string, kinId: string) => `spr_hero_${classId}_${kinId}`;

export function createCharacter(r: Ruleset, spec: CharacterSpec, rng: Rng): { ch: CharacterState; inventory: ItemInstance[] } {
  const ix = rx(r);
  const cls = ix.cls.get(spec.classId) ?? r.classes[0]!;
  const kin = ix.kin.get(spec.kinId) ?? r.kins[0]!;
  const equipment: CharacterState['equipment'] = {};
  for (const [slotId, baseId] of Object.entries(cls.startingGear)) if (ix.item.get(baseId)) equipment[slotId] = makeItem(r, rng, baseId, 1, r.rarities[0]!.id);
  const ch: CharacterState = {
    id: uid('ch'),
    name: spec.name.trim().slice(0, 24) || 'Wanderer',
    classId: cls.id,
    kinId: kin.id,
    presentation: kin.presentation,
    sprite: heroSprite(cls.id, kin.id),
    level: 1,
    xp: 0,
    tree: {},
    treePoints: r.progression.treePointsStart,
    hotbar: [],
    hp: 1,
    statuses: [],
    equipment,
    cooldowns: {},
    downed: false,
  };
  ch.hotbar = defaultHotbar(r, ch);
  restoreFully(r, ch);
  const inventory: ItemInstance[] = [];
  const heal = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'));
  if (heal) inventory.push(makeItem(r, rng, heal.id, 1, r.rarities[0]!.id, 3));
  return { ch, inventory };
}

/**
 * A hero made to join others further along starts at their level: common gear of that level in its starting
 * slots, and the talent points of every level to spend in the game, as if it had leveled.
 */
export function startAtLevel(r: Ruleset, ch: CharacterState, level: number, rng: Rng) {
  level = Math.max(1, Math.min(r.progression.maxLevel, Math.round(level)));
  if (level <= 1) return;
  ch.level = level;
  ch.xp = xpForLevel(r, level);
  ch.treePoints = treePointsAt(r, level);
  for (const [slot, it] of Object.entries(ch.equipment)) if (it) ch.equipment[slot] = makeItem(r, rng, it.baseId, level, r.rarities[0]!.id);
  restoreFully(r, ch);
}

function defaultHotbar(r: Ruleset, ch: CharacterState): (string | null)[] {
  return knownSkills(r, ch).slice(0, 10);
}

export function restoreFully(r: Ruleset, ch: CharacterState) {
  const s = characterStats(r, ch);
  ch.hp = s.maxHp;
  ch.downed = false;
  ch.statuses = [];
}

/** Keep health within its maximum after equipment or stat changes. */
export function clampHealth(r: Ruleset, ch: CharacterState) {
  ch.hp = Math.min(ch.hp, characterStats(r, ch).maxHp);
}

/** Out-of-combat regeneration over `seconds`. Returns true if anything changed. */
export function regenerate(r: Ruleset, ch: CharacterState, seconds: number): boolean {
  if (ch.downed) return false;
  const s = characterStats(r, ch);
  const frac = seconds / Math.max(1, r.recovery.secondsToFull);
  if (ch.hp >= s.maxHp) return false;
  ch.hp = Math.min(s.maxHp, ch.hp + s.maxHp * frac);
  return true;
}

/** Spend a tree point on a node. Returns an error or null. */
export function allocateNode(r: Ruleset, ch: CharacterState, nodeId: string): string | null {
  const err = canAllocate(r, ch, nodeId);
  if (err) return err;
  ch.tree[nodeId] = (ch.tree[nodeId] ?? 0) + 1;
  ch.treePoints--;
  const node = rx(r).node.get(nodeId);
  if (node?.kind === 'skill' && node.skillId && !ch.hotbar.includes(node.skillId)) {
    const i = ch.hotbar.indexOf(null);
    if (i >= 0) ch.hotbar[i] = node.skillId;
    else if (ch.hotbar.length < 10) ch.hotbar.push(node.skillId);
  }
  return null;
}

/**
 * Grant experience; returns the number of levels gained. A level gives the level and its points, nothing else: no
 * Health back, no statuses lifted, nobody raised, in a fight or out of one.
 */
export function grantXp(r: Ruleset, ch: CharacterState, amount: number): number {
  if (ch.level >= r.progression.maxLevel) return 0;
  ch.xp += Math.max(0, Math.round(amount));
  const newLevel = levelForXp(r, ch.xp);
  const gained = newLevel - ch.level;
  if (gained > 0) {
    ch.level = newLevel;
    // Points wait for the player, AI-played heroes' too (their party cards show them).
    ch.treePoints += gained * r.progression.treePointsPerLevel;
  }
  return gained;
}

/**
 * Automatic build policy (the simulator's builds): a typical build puts every point into the character's own class,
 * learning skills as they open, then ranks and passives; a random one picks anything it can, hybrids included.
 */
function autoSpend(r: Ruleset, ch: CharacterState, rng?: Rng, style: 'typical' | 'random' = 'typical') {
  const nodes = r.classes.flatMap((c) => c.nodes);
  let guard = 0;
  while (ch.treePoints > 0 && guard++ < 200) {
    const options = nodes.filter((n) => !canAllocate(r, ch, n.id));
    if (!options.length) break;
    const pick = style === 'random' && rng ? rng.pick(options) : typicalPick(r, ch, options);
    allocateNode(r, ch, pick.id);
  }
  ch.hotbar = defaultHotbar(r, ch);
}

function typicalPick(r: Ruleset, ch: CharacterState, options: TreeNode[]): TreeNode {
  const own = options.filter((n) => n.classId === ch.classId);
  const pool = own.length ? own : options;
  const spent = classSpent(r, ch, ch.classId);
  const nextTier = r.progression.tierRequirements.find((x) => x > spent);
  const score = (n: TreeNode) => {
    // A new skill first, then a skill's next rank, then a passive.
    const rank = n.skillId ? skillRank(r, ch, n.skillId) : ch.tree[n.id] ?? 0;
    const base = n.skillId ? (rank === 0 ? 10 + n.tier : 8 - rank) : 6 - rank * 1.5;
    return base + (nextTier !== undefined ? n.tier * 0.1 : 0);
  };
  return [...pool].sort((a, b) => score(b) - score(a))[0]!;
}

/** Bring a fresh character to a level with an automatic build (the simulator). */
export function levelUpTo(r: Ruleset, ch: CharacterState, level: number, rng?: Rng, style: 'typical' | 'random' = 'typical') {
  ch.level = Math.max(1, Math.min(r.progression.maxLevel, level));
  ch.xp = xpForLevel(r, ch.level);
  ch.treePoints = treePointsAt(r, ch.level) - Object.values(ch.tree).reduce((s, v) => s + v, 0);
  autoSpend(r, ch, rng, style);
  restoreFully(r, ch);
}
