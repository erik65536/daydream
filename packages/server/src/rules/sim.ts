/**
 * Headless combat simulator: the real Combat / AI / effects code on a small arena with a virtual clock.
 * Used by the balance loop and by tests. Synchronous and deterministic for a given seed.
 */
import {
  Nav, Rng, makeNav, rx,
  type BossDef, type CharacterState, type DifficultyId, type FxEvent, type ItemInstance, type MonsterFamily, 
  type MonsterRuntime, type Ruleset, type SkillDef, type SpawnDef, type ZoneDef,
} from '@daydream/shared';
import { Actor, CharActor, MonsterActor } from '../game/actors.ts';
import { Combat, type CombatHost, type CombatOutcome } from '../game/combat.ts';
import type { Policy } from '../game/ai.ts';
import { createCharacter, levelUpTo, restoreFully } from '../game/characters.ts';
import { makeItem } from '../game/loot.ts';
import type { ZoneMap } from '../game/worldctx.ts';
import { fightPositions, isFree, nearestFree } from '../game/space.ts';
import type { PackMember } from './encounters.ts';

/** Rounds after which a simulated fight is called off. */
const MAX_ROUNDS = 40;
const ARENA_W = 22;
const ARENA_H = 18;

/** A walled arena (meters) with four square pillars to fight around. */
function arena(seed: string): ZoneMap {
  const rng = new Rng(`arena:${seed}`);
  const pillars = Array.from({ length: 4 }, () => ({ x: rng.int(8, 13) + 0.5, y: rng.int(3, ARENA_H - 4) + 0.5 }));
  // Walls and pillars are a meter thick; a person's center keeps a body's width from them.
  const near = (x: number, y: number, by: number) => pillars.some((p) => Math.max(Math.abs(p.x - x), Math.abs(p.y - y)) < 0.5 + by);
  const inside = (x: number, y: number, by: number) => x > 1 + by && y > 1 + by && x < ARENA_W - 1 - by && y < ARENA_H - 1 - by;
  const nav = makeNav(ARENA_W, ARENA_H, (x, y) => inside(x, y, 0.35) && !near(x, y, 0.35), (x, y) => inside(x, y, 0) && !near(x, y, 0));
  const def = { id: 'arena', name: 'Arena', kind: 'dungeon', width: ARENA_W, height: ARENA_H, features: [], spawns: [], nav } as unknown as ZoneDef;
  return { def, nav: new Nav(nav), features: new Map() };
}

export interface FightTelemetry {
  /** Who used it (a hero's class id, or `m:` and a creature's kind of fighter) -> skillId -> uses. */
  uses: Map<string, Map<string, number>>;
}

/** Hooks for the combat lab: every skill used and every blow landed, in order. */
interface FightWatch {
  start?(actors: Actor[], combat: Combat): void;
  skill?(a: Actor, skill: SkillDef): void;
  damaged?(target: Actor, source: Actor | null, amount: number): void;
  /** What the fight shows (hits, heals, skills), as the game would draw it. */
  fx?(events: FxEvent[]): void;
}

class SimHost implements CombatHost {
  rng: Rng;
  private clock = 0;
  private seq = 0;
  private queue: { t: number; seq: number; fn: () => void }[] = [];
  actors: Actor[] = [];
  readonly map: ZoneMap;
  ended: { victory: boolean } | null = null;
  potions: ItemInstance[] = [];
  potionsUsed = 0;
  r: Ruleset;
  telemetry?: FightTelemetry;
  watch?: FightWatch;
  constructor(r: Ruleset, seed: string, telemetry?: FightTelemetry, watch?: FightWatch) {
    this.r = r;
    this.telemetry = telemetry;
    this.watch = watch;
    this.rng = new Rng(seed);
    this.map = arena(seed);
  }
  now() { return this.clock; }
  after(ms: number, fn: () => void) { this.queue.push({ t: this.clock + Math.max(0, ms), seq: this.seq++, fn }); }
  /** Run queued work in time order until the fight ends, `stop` says so, or the step budget runs out. */
  run(maxSteps: number, stop: () => boolean = () => false) {
    for (let i = 0; i < maxSteps && this.queue.length && !this.ended && !stop(); i++) {
      let bi = 0;
      for (let j = 1; j < this.queue.length; j++) {
        const a = this.queue[j]!, b = this.queue[bi]!;
        if (a.t < b.t || (a.t === b.t && a.seq < b.seq)) bi = j;
      }
      const job = this.queue.splice(bi, 1)[0]!;
      this.clock = Math.max(this.clock, job.t);
      job.fn();
    }
  }
  actorsInZone() { return this.actors; }
  zoneMap() { return this.map; }
  isFree(_z: string, x: number, y: number, ignoreId?: string) {
    return isFree(this.map.nav, this.actors, { x, y }, ignoreId);
  }
  fx(_z: string, e: FxEvent[]) {
    this.watch?.fx?.(e);
  }
  onDamaged(target: Actor, source: Actor | null, amount: number) {
    this.watch?.damaged?.(target, source, amount);
  }
  onDowned(target: Actor) {
    if (target instanceof MonsterActor) target.rt.dead = true;
    else if (target instanceof CharActor) target.ch.downed = true;
  }
  log() {}
  actorMoved() {}
  broadcastCombat() {}
  combatEnded(_c: Combat, outcome: CombatOutcome) { this.ended = { victory: outcome === 'victory' }; }
  isMultiplayer() { return false; }
  onSkillUsed(a: Actor, skill: SkillDef) {
    this.watch?.skill?.(a, skill);
    if (!this.telemetry) return;
    const key = a instanceof CharActor ? a.ch.classId : a instanceof MonsterActor ? `m:${a.fighter}` : 'other';
    let m = this.telemetry.uses.get(key);
    if (!m) this.telemetry.uses.set(key, (m = new Map()));
    m.set(skill.id, (m.get(skill.id) ?? 0) + 1);
  }
  aiPotions(a: Actor) {
    if (!(a instanceof CharActor)) return [];
    return this.potions.slice(0, 1).map((item) => ({ item, consume: () => { this.potions.shift(); this.potionsUsed++; } }));
  }
}

// ------------------------------------------------------------------------------------ parties

/** The armor a typical hero of a class wears: sturdy up close, nimble for magic from a distance, else balanced (as far as the world has them). */
function armorWeight(r: Ruleset, classId: string): string {
  const cls = rx(r).cls.get(classId);
  const want = cls?.reach === 'melee' && cls.role !== 'healer' && cls.role !== 'support' ? 'sturdy' : cls?.role === 'caster' ? 'nimble' : 'balanced';
  return r.items.some((i) => i.tags.includes(want)) ? want : 'balanced';
}

/** Equip level-typical gear: the class's weapon kind at `level`, armor of its weight in every armor slot, accessories. */
function equipTypical(r: Ruleset, ch: CharacterState, level: number, rng: Rng, rarityIndex: number) {
  const ix = rx(r);
  const cls = ix.cls.get(ch.classId)!;
  const rarity = r.rarities[Math.min(4, Math.max(0, rarityIndex))]!.id;
  const weight = armorWeight(r, ch.classId);
  for (const slot of r.slots) {
    let baseId = cls.startingGear[slot.id];
    if (!baseId) {
      const cands = r.items.filter((i) => i.slotId === slot.id && (slot.kind !== 'armor' || i.tags.includes(weight)));
      const weaponId = cls.startingGear[r.slots.find((s) => s.kind === 'weapon')?.id ?? ''];
      if (slot.kind === 'offhand' && weaponId && ix.item.get(weaponId)?.weapon?.twoHanded) continue;
      if (!cands.length) continue;
      baseId = rng.pick(cands).id;
    }
    // Gear of the hero's level: improving only ever brings gear up to its owner's level.
    ch.equipment[slot.id] = makeItem(r, rng, baseId, level, rarity);
  }
}

interface PartyOptions {
  classes: string[];
  level: number;
  rng: Rng;
  style?: 'typical' | 'random';
  rarityIndex?: number;
  /** Override tree allocation (build search). */
  tree?: Record<string, number>;
}

export function makeParty(r: Ruleset, o: PartyOptions): CharacterState[] {
  return o.classes.map((classId, i) => {
    const { ch } = createCharacter(r, { name: `Sim${i}`, classId, kinId: r.kins[i % r.kins.length]!.id }, o.rng);
    ch.ai = true;
    if (o.tree) {
      ch.level = o.level;
      ch.tree = { ...o.tree };
      ch.treePoints = 0;
    } else levelUpTo(r, ch, o.level, o.rng, o.style ?? 'typical');
    equipTypical(r, ch, o.level, o.rng, o.rarityIndex ?? (o.level >= 4 ? 1 : 0));
    restoreFully(r, ch);
    return ch;
  });
}

// ------------------------------------------------------------------------------------ fights

interface FightSpec {
  party: CharacterState[];
  pack: PackMember[];
  potions: number;
  difficulty: DifficultyId;
  seed: string;
  telemetry?: FightTelemetry;
  /** Another way for the fighters to choose than the game's AI (experiments). */
  policy?: Policy;
  watch?: FightWatch;
}

interface FightResult {
  win: boolean;
  rounds: number;
  /** Fraction of the party's total health lost (downed counts as all of it). */
  hpLost: number;
  downed: number;
  potionsUsed: number;
  /** Fraction of the creatures' total Health still standing at the end. */
  foesLeft: number;
}

/** About how far from a leader creatures notice them and a fight begins (the game's notice distance is 6.5 m). */
const NOTICE = 6.2;

/** Where a pack's members stand around its center, as the build places them: at least 0.9 m apart, within 2.6 m (3.2 m for more than three). */
function packSpots(rng: Rng, n: number): { x: number; y: number }[] {
  const radius = n > 3 ? 3.2 : 2.6;
  const out: { x: number; y: number }[] = [];
  for (let tries = 0; out.length < n && tries < 400; tries++) {
    const a = rng.next() * Math.PI * 2, d = Math.sqrt(rng.next()) * radius;
    const p = { x: Math.cos(a) * d, y: Math.sin(a) * d };
    if (out.every((o) => Math.hypot(o.x - p.x, o.y - p.y) >= 0.9)) out.push(p);
  }
  while (out.length < n) out.push({ x: out.length, y: 0 });
  return out;
}

/** The pack's members as a family of their own. */
const simFamily = (pack: PackMember[]): MonsterFamily => ({ id: 'simfam', name: 'Sim', description: '', members: pack.map((m, i) => ({ fighter: m.fighter, classId: m.classId, name: `m${i}`, description: '', appearance: '' })) });

/** A fight set up and ready to start: its host, the heroes and creatures standing where it begins, and the combat they are in. */
export function setUpFight(r: Ruleset, spec: FightSpec): { host: SimHost; chars: CharActor[]; monsters: MonsterActor[]; combat: Combat } {
  const host = new SimHost(r, spec.seed, spec.telemetry, spec.watch);
  // The same ids every time, so a fight is told the same way whichever heroes it was made from.
  const party = spec.party.map((ch, i) => ({ ...(JSON.parse(JSON.stringify(ch)) as CharacterState), id: `c${i}` }));
  const heal = r.items.find((i) => i.category === 'potion' && i.use?.effects.some((e) => e.kind === 'heal'));
  if (heal) for (let i = 0; i < spec.potions; i++) host.potions.push(makeItem(r, host.rng, heal.id, party[0]?.level ?? 1, r.rarities[0]!.id));
  // The fight begins as it does in the game: the pack standing as it was placed, its nearest member just inside the
  // distance at which creatures notice a party's leader, and the party stepping into its fighting positions.
  const lead = { x: 5.5, y: ARENA_H / 2 };
  const chars = party.map((ch) => new CharActor(ch, 'sim', 'arena', lead.x, lead.y, r));
  const family = simFamily(spec.pack);
  const spots = packSpots(host.rng, spec.pack.length);
  // Far enough along that none stands nearer the leader than that distance.
  const shift = Math.max(...spots.map((p) => lead.x - p.x + Math.sqrt(Math.max(0, NOTICE ** 2 - p.y ** 2))));
  const monsters = spec.pack.map((m, i) => {
    const spawn: SpawnDef = { id: `m${i}`, kind: 'monster', familyId: family.id, member: i, level: m.level, x: 0, y: 0, groupId: 'g' };
    const rt: MonsterRuntime = { spawnId: spawn.id, hp: -1, dead: false, x: spots[i]!.x + shift, y: spots[i]!.y + lead.y, scale: m.scale };
    const boss: BossDef | undefined = m.boss ? { id: 'b', name: 'Boss', description: '', familyId: family.id, fighter: m.fighter, classIds: [m.classId], level: m.level, zoneId: 'arena', appearance: '', drops: [], voice: '' } : undefined;
    return new MonsterActor(spawn, rt, family, boss, 'arena', r, () => spec.difficulty);
  });
  host.actors = [...chars, ...monsters];
  const toward = { x: monsters.reduce((s, m) => s + m.x, 0) / monsters.length, y: lead.y };
  for (const [a, at] of fightPositions(host.map.nav, monsters, chars, toward)) [a.x, a.y] = [at.x, at.y];
  // Everyone starts on open ground, a body's width apart.
  for (const a of host.actors) {
    const p = nearestFree(host.map.nav, host.actors, a, a);
    if (p) [a.x, a.y] = [p.x, p.y];
  }
  const combat = new Combat(`sim_${spec.seed}`, 'arena', host);
  combat.policy = spec.policy;
  for (const a of host.actors) combat.add(a);
  return { host, chars, monsters, combat };
}

export function runFight(r: Ruleset, spec: FightSpec): FightResult {
  const { host, chars, monsters, combat } = setUpFight(r, spec);
  const maxHp = chars.reduce((s, c) => s + c.stats().maxHp, 0);
  spec.watch?.start?.(host.actors, combat);
  combat.start();
  // A fight that drags on past any target (sides that cannot reach each other) is not a win.
  host.run(20000, () => combat.round > MAX_ROUNDS);
  const rounds = combat.round;
  const win = !!host.ended?.victory && monsters.every((m) => !m.alive());
  const hpLeft = chars.reduce((s, c) => s + (c.alive() ? c.hp : 0), 0);
  const foesMax = monsters.reduce((s, m) => s + m.stats().maxHp, 0);
  const foesLeft = monsters.reduce((s, m) => s + (m.alive() ? m.hp : 0), 0) / Math.max(1, foesMax);
  return { win, rounds, hpLost: Math.max(0, Math.min(1, 1 - hpLeft / Math.max(1, maxHp))), downed: chars.filter((c) => !c.alive()).length, potionsUsed: host.potionsUsed, foesLeft };
}
