/**
 * Live actors inside a zone. Characters, NPCs, and monsters share the Actor interface used by combat and effects.
 * Stats come from the world's ruleset; the same classes run in the game and in the balance simulator.
 */
import {
  FIGHTER_LOOK, characterStats, fighterSkills, fighterStats, knownSkills, rx, skillRank,
  type ActiveStatus, type BossDef, type CharacterState, type DifficultyId, type EntityKind, type EntityView, type FighterKind,
  type MonsterFamily, type MonsterMember, type MonsterRuntime, type Motion, type NpcDef, type NpcRuntime, type Ruleset, type SpawnDef, type StatBlock,
} from '@daydream/shared';

type Team = 'players' | 'enemies' | 'neutral';

/** The current hold on stats (0 when none): see `holdStats`. */
let held = 0, holds = 0;

/**
 * Run `fn` with everyone's stats taken as unchanged: each actor's are checked once, then kept until `fn` returns. For
 * work that only looks (the AI weighing a turn asks for the same stats thousands of times).
 */
export function holdStats<T>(fn: () => T): T {
  const outer = held;
  held = ++holds;
  try {
    return fn();
  } finally {
    held = outer;
  }
}

export abstract class Actor {
  abstract readonly kind: EntityKind;
  zoneId: string;
  x: number;
  y: number;
  motion: Motion | null = null;
  facing = 0;
  combatId: string | null = null;
  /** Combat turn resources. */
  ap = 0;
  movementLeft = 0;
  /** An attack made out of combat that started the fight: its cost comes out of this actor's first turn. */
  openerAp = 0;
  /** Turns of immunity to control effects (after one ends). */
  controlImmune = 0;
  /** Dirty flag for broadcasting. */
  dirty = true;
  bark?: { text: string; until: number };
  protected statCache: { key: string; stats: StatBlock; held: number } | null = null;
  readonly id: string;
  protected readonly r: Ruleset;
  constructor(id: string, zoneId: string, x: number, y: number, r: Ruleset) {
    this.id = id;
    this.r = r;
    this.zoneId = zoneId;
    this.x = x;
    this.y = y;
  }
  abstract get name(): string;
  abstract get level(): number;
  abstract get hp(): number;
  abstract set hp(v: number);
  abstract get statuses(): ActiveStatus[];
  abstract set statuses(v: ActiveStatus[]);
  abstract get cooldowns(): Record<string, number>;
  protected abstract computeStats(): StatBlock;
  /** Cache key for stats: anything that changes them. */
  protected abstract statKey(): string;
  stats(): StatBlock {
    const cache = this.statCache;
    if (held && cache?.held === held) return cache.stats;
    const key = this.statKey();
    if (cache?.key === key) {
      cache.held = held;
      return cache.stats;
    }
    const stats = this.computeStats();
    this.statCache = { key, stats, held };
    return stats;
  }
  /** Stats as they would be with other statuses (what a status would change), without touching the cache. */
  statsWith(statuses: ActiveStatus[]): StatBlock {
    const keep = this.statuses;
    this.statuses = statuses;
    try {
      return this.computeStats();
    } finally {
      this.statuses = keep;
    }
  }
  abstract team(): Team;
  abstract skillIds(): string[];
  skillRank(skillId: string): number {
    void skillId;
    return 1;
  }
  abstract alive(): boolean;
  /** Downed characters stay on the field and can be revived. */
  downed(): boolean {
    return false;
  }
  abstract view(): EntityView;
  baseView(): Pick<EntityView, 'id' | 'x' | 'y' | 'motion' | 'facing' | 'statuses' | 'inCombat' | 'bark' | 'hp'> {
    return { id: this.id, x: this.x, y: this.y, motion: this.motion ?? undefined, facing: this.facing, statuses: this.statuses, inCombat: this.combatId ?? undefined, bark: this.bark, hp: Math.round(this.hp) };
  }
  protected statusKey() {
    return this.statuses.map((s) => `${s.id}*${s.strength ?? 1}`).join(',');
  }
}

export class CharActor extends Actor {
  readonly kind = 'character' as const;
  /** Its player dropped out: the AI plays it until they are back or it leaves. */
  playerAway = false;
  ch: CharacterState;
  readonly userId: string;
  constructor(ch: CharacterState, userId: string, zoneId: string, x: number, y: number, r: Ruleset) {
    super(ch.id, zoneId, x, y, r);
    this.ch = ch;
    this.userId = userId;
  }
  get name() { return this.ch.name; }
  get level() { return this.ch.level; }
  get hp() { return this.ch.hp; }
  set hp(v) { this.ch.hp = v; }
  get statuses() { return this.ch.statuses; }
  set statuses(v) { this.ch.statuses = v; }
  get cooldowns() { return this.ch.cooldowns; }
  protected statKey() {
    // What gear's stats follow: improving raises an item's level, enchanting replaces an affix, and a piece forged
    // into a legendary gains powers of its own.
    const mods = (m: { stat: string; value: number }[]) => m.map((x) => `${x.stat}=${x.value}`).join('/');
    const eq = Object.values(this.ch.equipment).map((i) => (i ? `${i.id}:${i.level}:${i.rarityId}:${i.affixes.map((a) => `${a.affixId}=${a.value}`).join('/')}:${mods(i.uniqueMods ?? [])}` : '')).join(',');
    return `${this.ch.level}|${eq}|${Object.entries(this.ch.tree).map(([k, v]) => `${k}${v}`).join(',')}|${this.statusKey()}`;
  }
  protected computeStats() {
    return characterStats(this.r, this.ch);
  }
  team(): Team { return 'players'; }
  skillIds() { return knownSkills(this.r, this.ch); }
  override skillRank(skillId: string) { return Math.max(1, skillRank(this.r, this.ch, skillId)); }
  alive() { return !this.ch.downed && this.ch.hp > 0; }
  override downed() { return this.ch.downed; }
  /** Its turns in a fight are the AI's: it fights on its own (its player's choice), or its player dropped out. */
  aiDriven() { return !!this.ch.ai || this.playerAway; }
  view(): EntityView {
    const s = this.stats();
    return {
      ...this.baseView(),
      kind: 'character',
      name: this.ch.name,
      title: rx(this.r).cls.get(this.ch.classId)?.name,
      sprite: this.ch.sprite,
      scale: 1,
      level: this.ch.level,
      maxHp: s.maxHp,
      hostile: false,
      ownerUserId: this.userId,
      downed: this.ch.downed,
      ...(this.aiDriven() ? { ai: true } : {}),
    };
  }
}

export class MonsterActor extends Actor {
  readonly kind = 'monster' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  /** Wander anchor. */
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  spawn: SpawnDef;
  rt: MonsterRuntime;
  family: MonsterFamily;
  boss: BossDef | undefined;
  difficulty: () => DifficultyId;
  constructor(spawn: SpawnDef, rt: MonsterRuntime, family: MonsterFamily, boss: BossDef | undefined, zoneId: string, r: Ruleset, difficulty: () => DifficultyId = () => 'normal') {
    super(spawn.id, zoneId, rt.x, rt.y, r);
    this.spawn = spawn;
    this.rt = rt;
    this.family = family;
    this.boss = boss;
    this.difficulty = difficulty;
    this.homeX = spawn.x;
    this.homeY = spawn.y;
    if (rt.hp <= 0 && !rt.dead) rt.hp = this.stats().maxHp;
  }
  /** A boss, fought as one. (A named foe, `boss` with a family member, is one of its kind with a name of its own.) */
  get isBoss(): boolean { return !!this.boss && !this.boss.member; }
  /** The family member it is (a named foe: the one it is drawn as). */
  get member(): MonsterMember { return (this.boss?.member && this.family.members.find((m) => m.name === this.boss!.member)) || this.family.members[this.spawn.member] || this.family.members[0]!; }
  get fighter(): FighterKind { return this.boss && !this.boss.member ? this.boss.fighter : this.member.fighter; }
  /** The classes it fights as: a boss's one or two, else its member's. */
  get classIds(): string[] { return this.boss && !this.boss.member ? this.boss.classIds : [this.member.classId]; }
  get name() { return this.boss?.name ?? this.member.name; }
  get level() { return this.spawn.level; }
  get hp() { return this.rt.hp; }
  set hp(v) { this.rt.hp = v; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; }
  get cooldowns() { return this._cool; }
  protected statKey() { return `${this.statusKey()}|${this.difficulty()}`; }
  protected computeStats() {
    return fighterStats(this.r, { level: this.spawn.level, fighter: this.fighter, classIds: this.classIds, boss: this.isBoss, statuses: this._statuses, difficulty: this.difficulty(), scale: this.rt.scale });
  }
  team(): Team { return 'enemies'; }
  skillIds() { return fighterSkills(this.r, this.classIds, this.spawn.level); }
  alive() { return !this.rt.dead && this.rt.hp > 0; }
  restore() {
    this.rt.hp = this.stats().maxHp;
    this._statuses = [];
    this._cool = {};
  }
  view(): EntityView {
    const s = this.stats();
    const v = FIGHTER_LOOK[this.fighter];
    return {
      ...this.baseView(),
      kind: 'monster',
      name: this.name,
      // Its family, under its name: what a quest asking to fight them calls them.
      title: this.family.name,
      sprite: this.boss?.asset ?? this.member.asset,
      scale: v.scale * (this.isBoss ? 1.45 : this.boss ? 1.15 : 1),
      level: this.spawn.level,
      maxHp: s.maxHp,
      hostile: true,
      dead: this.rt.dead,
      bossId: this.boss?.id,
      named: this.boss?.member ? true : undefined,
      element: rx(this.r).cls.get(this.classIds[0] ?? '')?.damageTypeId,
      familyId: this.family.id,
    };
  }
}

export class NpcActor extends Actor {
  readonly kind = 'npc' as const;
  private _statuses: ActiveStatus[] = [];
  private _cool: Record<string, number> = {};
  homeX: number;
  homeY: number;
  nextWanderAt = 0;
  nextBarkAt = 0;
  /** Player currently in conversation with this NPC. */
  talkingTo: string | null = null;
  def: NpcDef;
  rt: NpcRuntime;
  constructor(def: NpcDef, rt: NpcRuntime, zoneId: string, r: Ruleset) {
    super(def.id, zoneId, rt.x, rt.y, r);
    this.def = def;
    this.rt = rt;
    this.homeX = def.x;
    this.homeY = def.y;
  }
  get name() { return this.def.name; }
  get level() { return this.def.level; }
  /** People are never hurt: they are always at full Health. */
  get hp() { return this.stats().maxHp; }
  set hp(v) { void v; }
  get statuses() { return this._statuses; }
  set statuses(v) { this._statuses = v; }
  get cooldowns() { return this._cool; }
  protected statKey() { return this.statusKey(); }
  /** People never fight: their stats are an ordinary soldier's of the world's first class, for what a skill used on them reads. */
  protected computeStats() {
    return fighterStats(this.r, { level: this.def.level, fighter: 'soldier', classIds: [this.r.classes[0]!.id], statuses: this._statuses });
  }
  team(): Team { return 'neutral'; }
  skillIds() { return [this.r.basicAttackId]; }
  alive() { return true; }
  view(): EntityView {
    const s = this.stats();
    return {
      ...this.baseView(),
      kind: 'npc',
      name: this.def.name,
      title: this.def.title,
      sprite: this.def.asset,
      scale: 1,
      level: this.def.level,
      maxHp: s.maxHp,
      hostile: false,
    };
  }
}
