/**
 * The places that are live: their creatures (packs coming back and sized to the heroes there), their people and
 * gatherings, and what creatures and people do when left to themselves.
 */
import {
  SPACING, type NpcRuntime, type MonsterRuntime, type SpawnDef, type Vec2, type ZoneRuntime, type FighterKind,
} from '@daydream/shared';
import { CharActor, MonsterActor, NpcActor } from './actors.ts';
import { fitPack } from '../rules/encounters.ts';
import { type ZoneMap } from './worldctx.ts';
import { merchantPurse } from './items.ts';
import type { Adventure, LiveZone } from './adventure.ts';

/** How often one person may call out to a party walking past, and how often a party hears anyone call out. */
const REMARK_EACH_MS = 10 * 60_000;
const REMARK_ANY_MS = 20_000;

/** What this part of an adventure uses of the rest of it. */
type PlacesHost = Pick<
  Adventure,
  'broadcastZone' | 'ctx' | 'day' | 'inGame' | 'items' | 'markDirty' | 'nearestFree' | 'passable'
  | 'questDef' | 'r' | 'refreshFeatures' | 'rng' | 'sayAloud' | 'state' | 'world' | 'zones'
>;

export class Places {
  private h: PlacesHost;
  constructor(h: PlacesHost) {
    this.h = h;
  }

  initNpc(npcId: string): NpcRuntime {
    const def = this.h.ctx.npcs.get(npcId)!;
    return { npcId, zoneId: def.zoneId, x: def.x, y: def.y, regard: {}, memories: [], stock: [], stockDay: -1, gold: def.role === 'merchant' ? merchantPurse(def.level) : 20 + def.level * 10 };
  }

  zoneRuntime(zoneId: string): ZoneRuntime {
    let rt = this.h.state.zones[zoneId];
    if (!rt) {
      // Creatures are added as they come out (populate).
      rt = { zoneId, monsters: {}, features: {}, loot: [] };
      this.h.state.zones[zoneId] = rt;
    }
    return rt;
  }

  live(zoneId: string): LiveZone {
    let z = this.h.zones.get(zoneId);
    if (z) return z;
    const map = this.h.ctx.map(zoneId);
    const rt = this.zoneRuntime(zoneId);
    z = { id: zoneId, map, rt, actors: new Map(), lootDirty: false, featuresDirty: new Set() };
    this.h.zones.set(zoneId, z);
    this.populate(z);
    this.endGatherings();
    this.h.items.expireLoot();
    const onGround = (q: { x: number; y: number }) => !!map.nav.nearestWalkable(q, 1);
    for (const rtn of Object.values(this.h.state.npcs)) {
      if (rtn.zoneId !== zoneId) continue;
      const def = this.h.ctx.npcs.get(rtn.npcId);
      if (!def) continue;
      if (!onGround(rtn) && def.zoneId === zoneId) Object.assign(rtn, { x: def.x, y: def.y });
      const a = new NpcActor(def, rtn, zoneId, this.h.r);
      z.actors.set(a.id, a);
    }
    this.applyGatherings(z);
    return z;
  }

  /**
   * A place's creatures: the packs due back return, packs never fought are sized to the heroes in the place, and the
   * living get actors. `only`: just these groups (a quest foe come out while the party is there), leaving the rest as
   * they are. `arrival`: a party came into a place already live, so packs are sized again but none comes back.
   */
  populate(z: LiveZone, only?: Set<string>, arrival = false) {
    const { map, rt } = z;
    const zoneId = z.id;
    // Monsters. A slain pack comes back (for farming) once every member's respawn time has passed; bosses stay dead.
    const due = (m: MonsterRuntime) => {
      return m.respawnAt !== undefined && m.respawnAt <= this.h.state.clock;
    };
    const groups = new Map<string, SpawnDef[]>();
    for (const s of map.def.spawns) groups.set(s.groupId, [...(groups.get(s.groupId) ?? []), s]);
    // A quest foe and its followers wait unseen until a quest sent to defeat it has begun.
    const waiting = new Set([...groups].filter(([, members]) => members.some((s) => s.bossId && !this.foeAbroad(s.bossId))).map(([id]) => id));
    const extrasOf = (members: SpawnDef[]) => Object.values(rt.monsters).filter((m) => m.extraOf && members.some((s) => s.id === m.extraOf));
    const heroes = this.heroesIn(zoneId);
    const removed: string[] = [];
    for (const [groupId, members] of groups) {
      if (waiting.has(groupId) || (only && !only.has(groupId))) continue;
      const rts = members.map((s) => (rt.monsters[s.id] ??= { spawnId: s.id, hp: -1, dead: false, x: s.x, y: s.y }));
      const gone = (m: MonsterRuntime) => m.absent || (m.dead && due(m));
      if (!arrival && rts.some((m) => !m.absent) && rts.every(gone) && extrasOf(members).every((m) => m.dead)) {
        members.forEach((s, i) => Object.assign(rts[i]!, { dead: false, hp: -1, x: s.x, y: s.y, respawnAt: undefined, absent: undefined, scale: undefined, fitFor: undefined, fought: undefined }));
        for (const e of extrasOf(members)) delete rt.monsters[e.spawnId];
      }
      // A pack never fought is sized to the heroes in the place, again whenever their number has changed since it was
      // sized; one that has fought keeps the size it has until it comes back, so no fight changes under way.
      const pack = [...rts, ...extrasOf(members)];
      if (pack.some((m) => m.dead || m.fought)) {
        for (const m of rts) m.scale ??= 1;
        continue;
      }
      if (rts[0]!.fitFor === heroes) continue;
      for (const m of pack) {
        if (z.actors.delete(m.spawnId)) removed.push(m.spawnId);
        if (m.extraOf) delete rt.monsters[m.spawnId];
      }
      members.forEach((s, i) => Object.assign(rts[i]!, { hp: -1, x: s.x, y: s.y, absent: undefined, scale: undefined, fitFor: heroes }));
      this.fitGroup(map, members, rts, heroes);
    }
    if (removed.length) this.h.broadcastZone(zoneId, { t: 'entities', upsert: [], remove: removed });
    const spawnFor = (m: MonsterRuntime): SpawnDef | undefined => {
      if (m.def) return m.def;
      if (!m.extraOf) return map.def.spawns.find((s) => s.id === m.spawnId);
      const base = map.def.spawns.find((s) => s.id === m.extraOf);
      return base && { ...base, id: m.spawnId, x: m.x, y: m.y, bossId: undefined };
    };
    // Positions saved before the place was laid out again (a re-read painting) may be off its ground now: back to
    // where the place's own data puts them.
    const onGround = (q: { x: number; y: number }) => !!map.nav.nearestWalkable(q, 1);
    for (const m of Object.values(rt.monsters)) {
      if (m.dead || m.absent || z.actors.has(m.spawnId)) continue;
      const s = spawnFor(m);
      if (!s || waiting.has(s.groupId) || (only && !only.has(s.groupId))) continue;
      if (!onGround(m)) Object.assign(m, { x: s.x, y: s.y });
      const fam = this.h.ctx.family(s.familyId) ?? this.h.world.families[0]!;
      const actor = new MonsterActor(s, m, fam, s.bossId ? this.h.ctx.bosses.get(s.bossId) : undefined, zoneId, this.h.r, () => this.h.state.difficulty);
      z.actors.set(actor.id, actor);
    }
  }

  /** Whether a boss or named foe is out in the world: always, unless quests send the heroes to defeat it and none has begun. */
  private foeAbroad(bossId: string): boolean {
    const quests = this.h.ctx.foeQuests.get(bossId);
    return !quests || quests.some((id) => this.h.state.quests[id]);
  }

  /** A quest has begun: what it sends the heroes to find is there now, and so is the foe it sends them to defeat. */
  questBegun(questId: string) {
    this.h.refreshFeatures();
    const foes = new Set(this.h.questDef(questId)?.objectives.flatMap((o) => (o.type === 'kill_unique' && o.targetId ? [o.targetId] : [])));
    for (const z of this.h.zones.values()) {
      const groups = new Set(z.map.def.spawns.filter((s) => s.bossId && foes.has(s.bossId)).map((s) => s.groupId));
      if (groups.size) this.populate(z, groups);
    }
  }

  /** Heroes in a place now: those of every player in the game whose party is there or on its way in (one at least). */
  private heroesIn(zoneId: string): number {
    return Math.max(1, this.h.inGame().reduce((n, p) => n + (p.zoneId === zoneId ? p.party.length : 0), 0));
  }

  /** The boss a spawn is, if it is one (not a named foe, who is one of its kind). */
  private spawnBoss(s: SpawnDef) {
    const boss = s.bossId ? this.h.ctx.bosses.get(s.bossId) : undefined;
    return boss && !boss.member ? boss : undefined;
  }

  /** A spawn's kind of fighter: its boss's, or its family member's. */
  private spawnFighter(s: SpawnDef): FighterKind {
    return this.spawnBoss(s)?.fighter ?? this.h.ctx.member(s.familyId, s.member)?.fighter ?? 'soldier';
  }

  /** Fit a fresh pack to `heroes` heroes and roll the difficulty's extra foe. */
  private fitGroup(map: ZoneMap, members: SpawnDef[], rts: MonsterRuntime[], heroes: number) {
    const fit = fitPack(this.h.r, members.map((s) => ({ id: s.id, fighter: this.spawnFighter(s), boss: !!this.spawnBoss(s), named: !!s.bossId && !this.spawnBoss(s) })), { heroes, difficulty: this.h.state.difficulty, rand: () => this.h.rng.next() });
    members.forEach((s, i) => {
      const m = rts[i]!;
      m.scale = this.spawnBoss(s) ? fit.bossScale : fit.scale;
      m.absent = fit.absent.includes(s.id) || undefined;
    });
    // More of the pack: each stands near the one it copies, clear of the rest.
    const taken: Vec2[] = members.filter((s) => !fit.absent.includes(s.id)).map((s) => ({ x: s.x, y: s.y }));
    fit.extras.forEach((baseId, n) => {
      const base = members.find((s) => s.id === baseId)!;
      const ring = Array.from({ length: 12 }, (_, i) => ({ r: SPACING * (i < 8 ? 1.2 : 2.2), a: (i * Math.PI) / (i < 8 ? 4 : 2) + (i < 8 ? 0 : Math.PI / 4) })).map(({ r, a }) => ({ x: base.x + Math.cos(a) * r, y: base.y + Math.sin(a) * r }));
      const spot = ring.find((p) => map.nav.walkable(p.x, p.y) && taken.every((s) => Math.hypot(s.x - p.x, s.y - p.y) >= SPACING));
      if (!spot) return;
      taken.push(spot);
      const id = `${base.id}_x${n}`;
      this.zoneRuntime(map.def.id).monsters[id] = { spawnId: id, hp: -1, dead: false, x: spot.x, y: spot.y, extraOf: base.id, scale: fit.scale };
    });
  }

  maybeUnloadZone(zoneId: string) {
    const z = this.h.zones.get(zoneId);
    if (!z) return;
    const hasChars = [...z.actors.values()].some((a) => a instanceof CharActor);
    const hasCombat = [...z.actors.values()].some((a) => a.combatId);
    if (hasChars || hasCombat) return;
    // Creatures are back where they keep, healed; people stay where they stand.
    for (const a of z.actors.values()) {
      if (a instanceof MonsterActor) {
        a.rt.x = a.homeX;
        a.rt.y = a.homeY;
        if (a.alive()) a.rt.hp = a.stats().maxHp;
      }
      if (a instanceof NpcActor) {
        // (Someone on their way is where they were going.)
        const at = a.motion?.path[a.motion.path.length - 1] ?? a;
        a.rt.x = at.x;
        a.rt.y = at.y;
      }
    }
    this.h.zones.delete(zoneId);
  }

  /**
   * Today's gatherings in a place: its people (a gathering is of a town's own) stand in a ring around the spot, and
   * keep there for the day.
   */
  applyGatherings(z: LiveZone) {
    const today = this.h.day();
    for (const ev of this.h.state.events) {
      if (ev.day !== today || ev.zoneId !== z.id) continue;
      ev.npcIds.forEach((id, i) => {
        const a = z.actors.get(id);
        if (!(a instanceof NpcActor)) return;
        const angle = (i / Math.max(1, ev.npcIds.length)) * Math.PI * 2;
        const spot = this.h.nearestFree(z.id, { x: ev.x + Math.cos(angle) * 3, y: ev.y + Math.sin(angle) * 3 }, id);
        [a.x, a.y, a.homeX, a.homeY] = [spot.x, spot.y, spot.x, spot.y];
        [a.rt.x, a.rt.y] = [spot.x, spot.y];
        a.motion = null;
        a.dirty = true;
      });
    }
  }

  /**
   * Gatherings whose day has passed are over: they are dropped, and their people go back to where they keep (walking
   * there when players may be watching).
   */
  endGatherings() {
    const today = this.h.day();
    const past = this.h.state.events.filter((e) => e.day < today);
    if (!past.length) return;
    this.h.state.events = this.h.state.events.filter((e) => e.day >= today);
    for (const id of new Set(past.flatMap((e) => e.npcIds))) {
      const def = this.h.ctx.npcs.get(id);
      const rt = this.h.state.npcs[id];
      if (!def || !rt) continue;
      const z = this.h.zones.get(rt.zoneId);
      const a = z?.actors.get(id);
      if (!z || !(a instanceof NpcActor)) {
        [rt.x, rt.y] = [def.x, def.y];
        continue;
      }
      [a.homeX, a.homeY] = [def.x, def.y];
      const path = z.map.nav.path(a, def, { maxNodes: 4000 });
      if (path?.length) a.motion = { path, from: { x: a.x, y: a.y }, speed: 1.3, t0: Date.now() };
      else [a.x, a.y] = [def.x, def.y];
      a.dirty = true;
    }
    this.h.markDirty();
  }

  monsterIdle(z: LiveZone, a: MonsterActor, now: number) {
    if (a.motion || now < a.nextWanderAt) return;
    a.nextWanderAt = now + 3000 + this.h.rng.next() * 7000;
    if (a.isBoss || this.h.rng.chance(0.4)) return;
    const to = { x: a.homeX + (this.h.rng.next() - 0.5) * 6, y: a.homeY + (this.h.rng.next() - 0.5) * 6 };
    if (!this.h.passable(z.id, to.x, to.y)) return;
    const path = z.map.nav.path(a, to, { maxNodes: 1500 });
    if (path?.length) {
      a.motion = { path, from: { x: a.x, y: a.y }, speed: 1.6, t0: now };
      a.dirty = true;
    }
  }

  /**
   * Remarks people made to each player's party walking past (`<person id>|<user id>`): the day, when, and which lines;
   * and when each player last heard one. Kept here rather than on the person's figure, which goes when the place is
   * left empty, so coming back after a while does not set the whole town calling out at once.
   */
  private remarks = new Map<string, { day: number; at: number; lines: string[] }>();

  private lastRemark = new Map<string, number>();

  npcIdle(z: LiveZone, a: NpcActor, now: number) {
    // A remark to a party walking past: now and then, more often from someone who knows them, never the same line twice
    // in a day, at most once in ten minutes from each person, and one person at a time.
    if (now > a.nextBarkAt && !a.talkingTo) {
      a.nextBarkAt = now + 3000;
      const near = [...z.actors.values()].find((x) => x instanceof CharActor && Math.hypot(x.x - a.x, x.y - a.y) < 5.5) as CharActor | undefined;
      const p = near && this.h.state.players[near.userId];
      const key = `${a.def.id}|${near?.userId}`;
      const heard = this.remarks.get(key);
      const day = this.h.day();
      if (p && now - (this.lastRemark.get(p.userId) ?? -Infinity) > REMARK_ANY_MS && (!heard || heard.day !== day || now - heard.at > REMARK_EACH_MS)) {
        const said = heard?.day === day ? heard.lines : [];
        const due = a.rt.memories.find((m) => p.party.some((c) => c.id === m.about) && m.dueDay !== undefined && m.dueDay <= day && !m.fulfilled);
        const knows = (this.h.state.conversations[a.def.id] ?? []).some((t) => t.speaker === 'player' && p.party.some((c) => c.name === t.hero));
        const fresh = a.def.barks.filter((b) => !said.includes(b));
        const call = due ? `${p.party.find((c) => c.id === due.about)!.name}! Come here, I remembered!` : '';
        const text = call && !said.includes(call) ? call : this.h.rng.chance(knows ? 0.5 : 0.15) && fresh.length ? this.h.rng.pick(fresh) : '';
        this.remarks.set(key, { day, at: now, lines: text ? [...said, text] : said });
        if (text) {
          this.lastRemark.set(p.userId, now);
          a.bark = { text, until: now + 4500 };
          a.dirty = true;
          this.h.sayAloud(a, a.def.id, text);
        }
      }
    }
    if (!a.def.wanders || a.motion || a.talkingTo || now < a.nextWanderAt) return;
    a.nextWanderAt = now + 5000 + this.h.rng.next() * 9000;
    if (this.h.rng.chance(0.45)) return;
    const to = { x: a.homeX + (this.h.rng.next() - 0.5) * 8, y: a.homeY + (this.h.rng.next() - 0.5) * 8 };
    if (!this.h.passable(z.id, to.x, to.y)) return;
    const path = z.map.nav.path(a, to, { maxNodes: 2000 });
    if (path?.length) {
      a.motion = { path, from: { x: a.x, y: a.y }, speed: 1.3, t0: now };
      a.dirty = true;
    }
  }
}
