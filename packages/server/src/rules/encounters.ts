/**
 * Encounter building shared by world assembly and the balance simulator: packs are sized by a threat budget
 * relative to the party's strength, built for a design party and fitted at play time to the heroes there are.
 */
import { MAX_HEROES, rx, type DifficultyId, type Fighter, type FighterKind, type Rng, type Ruleset } from '@daydream/shared';

export type EncounterKind = 'normal' | 'boss';

/** One creature of a pack: the family member it is (its kind of fighter and class), and its level. */
export interface PackMember extends Fighter {
  /** The family member's index. */
  member: number;
  level: number;
  boss?: boolean;
  /** Threat multiplier from pack fitting. */
  scale?: number;
}

/** Heroes the world's packs are built for; fewer or more heroes meet a fitted pack. */
export const DESIGN_PARTY = 4;
/** The most creatures a fitted pack grows to (a place has room for so many); past it, the members get stronger. */
export const MAX_PACK = 8;

/**
 * Build a pack worth the right amount of threat from a family's members: a front-liner (a member whose class fights up
 * close) first, a healer at most once, and swarms never leading.
 */
export function buildPack(r: Ruleset, rng: Rng, opts: { heroes: number; level: number; kind: EncounterKind; members: Fighter[]; depth?: number }): PackMember[] {
  const ix = rx(r);
  const all = opts.members.map((m, member) => ({ ...m, member }));
  // The party's strength in threat units: one a hero.
  const power = Math.max(1, opts.heroes);
  const depthBonus = 1 + (opts.depth ?? 0.5) * 0.25;
  const threat = (m: Fighter) => r.fighters[m.fighter]?.threat ?? 1;
  const melee = (m: Fighter) => ix.cls.get(m.classId)?.reach !== 'ranged';
  const healer = (m: Fighter) => ix.cls.get(m.classId)?.role === 'healer';
  const out: PackMember[] = [];
  let budget: number;
  if (opts.kind === 'boss') {
    const leaders = all.filter((m) => m.fighter !== 'swarm');
    const lead = rng.pick(leaders.length ? leaders : all);
    out.push({ ...lead, level: opts.level, boss: true });
    budget = power * 0.55;
  } else budget = power * depthBonus;
  let guard = 0;
  while (budget > 0.35 && guard++ < 12) {
    const options = all.filter((m) => (!healer(m) || !out.some(healer)) && threat(m) <= budget + 0.4);
    if (!options.length) break;
    const pick = !out.some(melee) ? (options.find(melee) ?? rng.pick(options)) : rng.pick(options);
    out.push({ ...pick, level: Math.max(1, opts.level - (pick.fighter === 'swarm' ? 1 : 0)) });
    budget -= threat(pick);
  }
  if (!out.length && all[0]) out.push({ ...all[0], level: opts.level });
  return out;
}

// ------------------------------------------------------------------------------------ fitting at runtime

interface FitMember {
  id: string;
  fighter: FighterKind;
  boss?: boolean;
  /** A named foe: fought as one of its kind, and always there (a quest may send the heroes to defeat it). */
  named?: boolean;
}

interface PackFit {
  /** Members left out for a smaller party. */
  absent: string[];
  /** Threat multiplier for the members that stay (a boss has its own). */
  scale: number;
  bossScale: number;
  /** Members copied once more each (a larger party, or the difficulty's extra foe); an id may repeat. */
  extras: string[];
}

/** The difficulty's encounter roll: maybe one more foe. */
function extraFoe(r: Ruleset, difficulty: DifficultyId, rand: () => number): boolean {
  return rand() < (r.difficulty[difficulty] ?? r.difficulty.normal).extraEnemyChance;
}

/**
 * Packs are built for the design party. A smaller party meets fewer members (the strongest stay) and the rest are
 * scaled to the remaining gap; a larger one meets more of the pack's kind, up to MAX_PACK creatures, and past that the
 * members are scaled up. A boss and a named foe keep their places (the named foe counts in the pack's strength); a
 * boss is scaled on its own curve (the ruleset's `party` powers, fitted by the balance loop). Then the difficulty's
 * extra-foe roll applies.
 */
export function fitPack(r: Ruleset, members: FitMember[], opts: { heroes: number; difficulty: DifficultyId; rand: () => number }): PackFit {
  const heroes = Math.max(1, Math.min(opts.heroes, MAX_HEROES)) / DESIGN_PARTY;
  const ratio = Math.pow(heroes, heroes < 1 ? r.party.packFewer : r.party.packMore);
  // (Only the pack's ordinary members and a named foe are weighed: a boss is scaled on its own.)
  const threat = (m: FitMember) => r.fighters[m.fighter]?.threat ?? 1;
  const others = members.filter((m) => !m.boss);
  const order = others.filter((m) => !m.named).sort((a, b) => threat(b) - threat(a));
  const target = others.reduce((s, m) => s + threat(m), 0) * ratio;
  const keep: FitMember[] = members.filter((m) => m.boss || m.named);
  const extras: string[] = [];
  let kept = keep.filter((m) => m.named).reduce((s, m) => s + threat(m), 0);
  for (const m of order) {
    if ((!keep.length && !kept) || kept + threat(m) / 2 <= target) {
      keep.push(m);
      kept += threat(m);
    }
  }
  // A larger party: more of the pack's ordinary members, in turn, while there is room.
  for (let i = 0; order.length && keep.length + extras.length < MAX_PACK && kept + threat(order[i % order.length]!) / 2 <= target; i++) {
    const m = order[i % order.length]!;
    extras.push(m.id);
    kept += threat(m);
  }
  const clamp = (v: number) => Math.max(0.1, Math.min(3, v));
  const fit: PackFit = { absent: members.filter((m) => !keep.includes(m)).map((m) => m.id), scale: kept ? clamp(target / kept) : 1, bossScale: clamp(Math.pow(heroes, heroes < 1 ? r.party.bossFewer : r.party.bossMore)), extras };
  if (extraFoe(r, opts.difficulty, opts.rand)) {
    const back = members.find((m) => fit.absent.includes(m.id) && !m.boss);
    const pool = keep.filter((m) => !m.boss);
    if (back) fit.absent = fit.absent.filter((id) => id !== back.id);
    else if (pool.length) fit.extras.push(pool[Math.floor(opts.rand() * pool.length)]!.id);
  }
  return fit;
}

/** The simulator's version: a design-size party meets the pack with the difficulty's rolls applied. */
export function withDifficulty(r: Ruleset, pack: PackMember[], difficulty: DifficultyId, rng: Rng): PackMember[] {
  const out = pack.map((m) => ({ ...m }));
  const pool = out.filter((m) => !m.boss);
  if (extraFoe(r, difficulty, () => rng.next()) && pool.length) out.push({ ...pool[Math.floor(rng.next() * pool.length)]! });
  return out;
}

/** A pack fitted to a party of `heroes`, as the game spawns it (for simulation). */
export function fittedPack(r: Ruleset, pack: PackMember[], opts: { heroes: number; difficulty: DifficultyId; rng: Rng }): PackMember[] {
  const fit = fitPack(r, pack.map((m, i) => ({ id: String(i), fighter: m.fighter, boss: m.boss })), { ...opts, rand: () => opts.rng.next() });
  const out: PackMember[] = pack.map((m, i) => ({ ...m, scale: m.boss ? fit.bossScale : fit.scale })).filter((_, i) => !fit.absent.includes(String(i)));
  for (const id of fit.extras) out.push({ ...pack[Number(id)]!, scale: fit.scale });
  return out;
}
