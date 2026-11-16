/**
 * Executes skills, consumables, and statuses against actors from ruleset data.
 * Synchronous and deterministic given the host's RNG; shared by real-time play, combat, and the balance simulator.
 */
import {
  SPACING, blockedBy, chanceAt, cleanseCount, consumableStats, controlText, damageKind, dodges, statusPower, lifestealAt, reviveAt, flatDamage, healOf, isHarmful, itemSkill, outsideFights, potency, rollDamage, rx, skillAp, skillRange, statusDot, worstFirst,
  type ActiveStatus, type DamageEffect, type Effect, type FxEvent, type ItemInstance, type Rng, type Ruleset, type SkillDef, type StatBlock,
} from '@daydream/shared';
import type { Actor } from './actors.ts';
import { CharActor, NpcActor } from './actors.ts';
import type { ZoneMap } from './worldctx.ts';


export interface EffectHost {
  r: Ruleset;
  rng: Rng;
  now(): number;
  actorsInZone(zoneId: string): Actor[];
  zoneMap(zoneId: string): ZoneMap;
  /** Walkable ground nobody (else) stands on, in meters. */
  isFree(zoneId: string, x: number, y: number, ignoreId?: string): boolean;
  fx(zoneId: string, events: FxEvent[]): void;
  onDamaged(target: Actor, source: Actor | null, amount: number): void;
  onDowned(target: Actor, source: Actor | null): void;
  log(zoneId: string, text: string, color?: string): void;
  actorMoved(a: Actor): void;
  /** Takes no damage (a developer's god mode). */
  invulnerable?(a: Actor): boolean;
  /** Telemetry hook for the balance simulator. */
  onSkillUsed?(a: Actor, skill: SkillDef): void;
}

export function relation(a: Actor, b: Actor): 'ally' | 'enemy' | 'neutral' {
  if (a === b) return 'ally';
  const ta = a.team(), tb = b.team();
  if (a instanceof CharActor && b instanceof CharActor) return 'ally';
  // People never fight, and nobody fights them.
  if (a instanceof NpcActor || b instanceof NpcActor) return 'neutral';
  if (ta === 'enemies' && tb === 'enemies') return 'ally';
  if ((ta === 'players' && tb === 'enemies') || (ta === 'enemies' && tb === 'players')) return 'enemy';
  return 'neutral';
}

export function isHostileTo(a: Actor, b: Actor) {
  return relation(a, b) === 'enemy';
}

const dist = (a: { x: number; y: number }, b: { x: number; y: number }) => Math.hypot(a.x - b.x, a.y - b.y);

interface SkillUse {
  user: Actor;
  skill: SkillDef;
  target?: Actor;
  point?: { x: number; y: number };
}

const isRevive = (s: { effects: Effect[] }) => s.effects.some((e) => e.kind === 'revive');
const dashes = (s: SkillDef) => s.effects.some((e) => e.kind === 'dash');
export { isHarmful };

/** Returns an error message, or null if the skill may be used now. */
export function checkSkill(host: EffectHost, use: SkillUse, opts: { inCombat: boolean }): string | null {
  const { user, skill, target, point } = use;
  const r = host.r;
  if (!user.alive()) return 'You cannot act right now.';
  const stats = user.stats();
  const ap = skillAp(skill, stats);
  if (opts.inCombat && user.ap < ap) return `Not enough ${r.terminology.actionPoints}.`;
  if (!opts.inCombat && outsideFights(r, skill) === 'none') return 'That can only be used in combat.';
  const blocked = blockedBy(stats, skill);
  if (blocked) return blocked === 'root' ? 'You are rooted in place.' : `${controlText(r, blocked)}.`;
  const cd = user.cooldowns[skill.id] ?? 0;
  if (cd > 0) return `Ready in ${cd} turn${cd > 1 ? 's' : ''}.`;
  const range = skillRange(skill, stats);
  const map = host.zoneMap(user.zoneId);
  const los = (p: { x: number; y: number }) => map.nav.sees(user, p);
  switch (skill.targeting) {
    case 'self':
      return null;
    case 'enemy':
      if (!target || !target.alive()) return 'Choose a target.';
      // Only a foe: people never fight, and nobody fights them.
      if (relation(user, target) !== 'enemy') return relation(user, target) === 'ally' ? 'That is an ally.' : 'They are no foe of yours.';
      if (dist(user, target) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(target)) return 'No line of sight.';
      if (dashes(skill) && !landingBeside(host, user, target)) return 'No room to land there.';
      return null;
    case 'ally':
      if (!target) return 'Choose an ally.';
      if (relation(user, target) !== 'ally') return 'Choose an ally.';
      if (!target.alive() && !(target.downed() && canReviveWith(r, skill.effects))) return 'They are down.';
      if (isRevive(skill) && target.alive() && !skill.effects.some((e) => e.kind === 'heal')) return 'They are not down.';
      if (dist(user, target) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(target)) return 'No line of sight.';
      return null;
    case 'ground': {
      const p = point ?? target;
      if (!p) return 'Choose a location.';
      if (dist(user, p) > range + 0.01) return 'Out of range.';
      if (range > 2 && !los(p)) return 'No line of sight.';
      return null;
    }
  }
}

/** Whether these effects can bring a downed ally back under the ruleset's revive mode. */
export function canReviveWith(r: Ruleset, effects: Effect[]): boolean {
  if (r.revive === 'after_combat') return false;
  if (effects.some((e) => e.kind === 'revive')) return true;
  return r.revive === 'heal' && effects.some((e) => e.kind === 'heal');
}

/** A free spot right next to the target (the nearest to the user), where a dash lands; already beside it, the user stays. */
function landingBeside(host: EffectHost, user: Actor, target: Actor): { x: number; y: number } | null {
  if (dist(user, target) <= SPACING + 0.1) return { x: user.x, y: user.y };
  let best: { x: number; y: number } | null = null;
  let bd = Infinity;
  for (let i = 0; i < 12; i++) {
    const a = (i / 12) * Math.PI * 2;
    const x = target.x + Math.cos(a) * (SPACING + 0.05), y = target.y + Math.sin(a) * (SPACING + 0.05);
    if (!host.isFree(user.zoneId, x, y, user.id)) continue;
    const d = Math.hypot(x - user.x, y - user.y);
    if (d < bd) {
      bd = d;
      best = { x, y };
    }
  }
  return best;
}

// ------------------------------------------------------------------------------------ primitives

export function addStatus(host: EffectHost, target: Actor, statusId: string, turns: number, power: number, sourceId?: string, strength = 1): boolean {
  const def = rx(host.r).status.get(statusId);
  if (!def || !target.alive()) return false;
  if (def.control && (target.controlImmune > 0 || !host.r.control.enabled)) return false;
  const existing = target.statuses.find((s) => s.id === statusId);
  // Put on again, it is a new one of the longer length and the greater strength (so it lasts its turns in full: `wearStatuses`).
  const next: ActiveStatus = existing
    ? { ...existing, turns: Math.max(existing.turns, turns), power: Math.max(existing.power, power), strength: Math.max(existing.strength ?? 1, strength) }
    : { id: statusId, turns, power, strength, sourceId };
  target.statuses = existing ? target.statuses.map((s) => (s === existing ? next : s)) : [...target.statuses, next];
  target.dirty = true;
  return true;
}

/** Deal damage; returns damage dealt to health. */
function dealDamage(host: EffectHost, source: Actor | null, target: Actor, amount: number, kind: { typeId: string }, opts: { crit?: boolean; noThorns?: boolean } = {}): number {
  if (!target.alive()) return 0;
  if (host.invulnerable?.(target)) amount = 0;
  const toHp = Math.min(target.hp, amount);
  target.hp -= toHp;
  host.fx(target.zoneId, [{ kind: 'damage', sourceId: source?.id, targetId: target.id, damage: {
    targetId: target.id,
    amount: toHp,
    type: kind.typeId,
    crit: opts.crit,
    share: Math.round((toHp / Math.max(1, target.stats().maxHp)) * 100) / 100,
    fatal: target.hp <= 0 || undefined,
    minor: (!source || opts.noThorns) || undefined,
  } }]);
  target.dirty = true;
  if (source && !opts.noThorns) {
    const thorns = target.stats().thorns;
    if (thorns > 0 && dist(source, target) < 2.2) dealDamage(host, null, source, Math.max(1, Math.round(thorns)), { typeId: host.r.damageTypes[0]!.id }, { noThorns: true });
  }
  host.onDamaged(target, source, toHp);
  if (target.hp <= 0) {
    target.hp = 0;
    host.onDowned(target, source);
  }
  return toHp;
}

function healActor(host: EffectHost, target: Actor, amount: number, allowRevive = false) {
  if (!target.alive()) {
    if (allowRevive && target instanceof CharActor && target.ch.downed) {
      target.ch.downed = false;
      target.ch.hp = 0;
      host.fx(target.zoneId, [{ kind: 'text', targetId: target.id, text: 'Revived', color: '#ffe680' }]);
    } else return;
  }
  const max = target.stats().maxHp;
  const before = target.hp;
  target.hp = Math.max(1, Math.min(max, target.hp + amount));
  const healed = Math.round(target.hp - before);
  if (healed > 0) host.fx(target.zoneId, [{ kind: 'damage', targetId: target.id, damage: { targetId: target.id, amount: healed, type: 'heal', share: Math.round((healed / max) * 100) / 100 } }]);
  target.dirty = true;
}

// ------------------------------------------------------------------------------------ the effect engine

interface EffectRun {
  user: Actor;
  /** Stats used for magnitudes (a consumable's are the same for everyone: `consumableStats`). */
  stats: StatBlock;
  skill: SkillDef;
  rank: number;
  effects: Effect[];
  targets: Actor[];
  zone: string;
}

function runEffects(host: EffectHost, run: EffectRun) {
  const { user, stats, skill, rank, effects, targets, zone } = run;
  const r = host.r;
  const rand = () => host.rng.next();
  const pot = potency(skill, rank);
  let dealtTotal = 0;
  const blow = effects.some((e) => e.kind === 'damage');
  const putOn = (who: Actor, e: Extract<Effect, { kind: 'status' }>) => {
    if (!who.alive() || !host.rng.chance(chanceAt(e, skill, rank))) return;
    const def = rx(r).status.get(e.statusId);
    if (def && addStatus(host, who, e.statusId, e.turns, statusPower(r, stats, e.statusId, pot), user.id, pot)) host.fx(zone, [{ kind: 'text', targetId: who.id, text: def.name, color: def.color, statusId: e.statusId }]);
  };
  for (const t of targets) {
    // Downed by what an earlier target gave back (thorns), the user strikes no more.
    if (!user.alive()) break;
    // A dodge avoids the whole blow on its target: its damage and the statuses it would put on them.
    const dodged = blow && t !== user && t.alive() && dodges(t.stats(), rand);
    if (dodged) {
      host.fx(zone, [{ kind: 'text', sourceId: user.id, targetId: t.id, text: 'Dodged', color: '#cccccc', dodged: true }]);
      host.onDamaged(t, user, 0);
    }
    for (const e of effects) {
      if (dodged && (e.kind === 'damage' || e.kind === 'status')) continue;
      switch (e.kind) {
        case 'damage': {
          if (!t.alive()) break;
          const roll = rollDamage(r, stats, t.stats(), skill, rank, e, rand);
          const dealt = dealDamage(host, user, t, roll.amount, roll, { crit: roll.crit });
          dealtTotal += dealt;
          if (stats.lifesteal > 0) healActor(host, user, Math.round(dealt * stats.lifesteal));
          break;
        }
        case 'heal':
          healActor(host, t, healOf(stats, e, t.stats().maxHp, pot), canReviveWith(r, effects));
          break;
        case 'status':
          if (!e.self) putOn(t, e);
          break;
        case 'cleanse': {
          const gone = new Set(worstFirst(r, t.statuses).slice(0, cleanseCount(skill, rank)));
          t.statuses = t.statuses.filter((s) => !gone.has(s));
          host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Cleansed', color: '#a0ffd0' }]);
          break;
        }
        case 'revive':
          if (t instanceof CharActor && t.ch.downed && r.revive !== 'after_combat') {
            t.ch.downed = false;
            t.ch.hp = Math.max(1, Math.round(t.stats().maxHp * reviveAt(e, pot)));
            host.fx(zone, [{ kind: 'text', targetId: t.id, text: 'Revived', color: '#ffe680' }]);
            t.dirty = true;
          }
          break;
        default:
          break;
      }
    }
  }
  // What the user gains is theirs once, whoever the skill caught (an area that catches nobody too).
  for (const e of effects) {
    if (e.kind === 'status' && e.self) putOn(user, e);
    if (e.kind === 'lifesteal' && dealtTotal > 0) healActor(host, user, Math.round(dealtTotal * lifestealAt(e, pot)));
  }
}

/** Resolve the actors an area or single-target use affects. */
function resolveTargets(host: EffectHost, user: Actor, effects: Effect[], targeting: SkillDef['targeting'], radius: number | undefined, center: { x: number; y: number }, target?: Actor): Actor[] {
  const harmful = isHarmful(host.r, effects);
  const revive = canReviveWith(host.r, effects);
  const actors = host.actorsInZone(user.zoneId).filter((a) => a.alive() || (revive && a.downed()));
  if (radius) return actors.filter((a) => dist(a, center) <= radius + 0.01 && (harmful ? isHostileTo(user, a) : relation(user, a) === 'ally'));
  if (target) return [target];
  if (targeting === 'self') return [user];
  return [];
}

/** The kind of damage a skill is drawn and heard as ('heal' for healing). */
function skillElement(r: Ruleset, skill: SkillDef, stats: StatBlock): string | undefined {
  const d = skill.effects.find((e) => e.kind === 'damage') as DamageEffect | undefined;
  if (!d) return skill.tags.includes('heal') ? 'heal' : undefined;
  return damageKind(r, skill, d, stats).typeId;
}

/** Execute a validated skill. Spends costs and sets cooldowns. */
export function executeSkill(host: EffectHost, use: SkillUse, inCombat: boolean): void {
  const { user, skill } = use;
  const stats = user.stats();
  const rank = user.skillRank(skill.id);
  if (inCombat) user.ap -= skillAp(skill, stats);
  if (skill.cooldown > 0) user.cooldowns[skill.id] = skill.cooldown + 1;
  host.onSkillUsed?.(user, skill);
  if (use.target) user.facing = Math.atan2(use.target.y - user.y, use.target.x - user.x);
  else if (use.point) user.facing = Math.atan2(use.point.y - user.y, use.point.x - user.x);
  const center = skill.targeting === 'self' ? { x: user.x, y: user.y } : use.point ?? (use.target ? { x: use.target.x, y: use.target.y } : { x: user.x, y: user.y });
  const ranged = skillRange(skill, stats) > 2;
  // A dash lands beside its target before the blow (the effect says where, so the rush can be drawn).
  const land = dashes(skill) && use.target ? landingBeside(host, user, use.target) : null;
  const moved = !!land && (land.x !== user.x || land.y !== user.y);
  host.fx(user.zoneId, [{ kind: ranged && skill.targeting !== 'self' && !land ? 'projectile' : 'skill', sourceId: user.id, targetId: use.target?.id, x: user.x, y: user.y, tx: center.x, ty: center.y, skillId: skill.id, fx: skill.fx, radius: skill.radius, element: skillElement(host.r, skill, stats), land: moved ? land : undefined }]);
  if (land && moved) {
    user.motion = null;
    user.x = land.x;
    user.y = land.y;
    host.actorMoved(user);
  }
  const targets = resolveTargets(host, user, skill.effects, skill.targeting, skill.radius, center, use.target);
  runEffects(host, { user, stats, skill, rank, effects: skill.effects, targets, zone: user.zoneId });
  user.dirty = true;
}

// ------------------------------------------------------------------------------------ statuses

/** What the start of a fighter's turn brings: damage and healing over time, regeneration, and cooldowns a turn shorter. */
export function startTurn(host: EffectHost, a: Actor): void {
  const r = host.r;
  const ix = rx(r);
  for (const s of a.statuses) {
    const def = ix.status.get(s.id);
    if (def?.dot && a.alive()) dealDamage(host, null, a, flatDamage(a.stats(), statusDot(r, s.id, s.power), def.dot.typeId), def.dot, { noThorns: true });
    if (def?.hot && a.alive()) healActor(host, a, Math.max(1, Math.round(def.hot.coef * s.power)));
  }
  const regen = a.stats().hpRegen;
  if (regen > 0 && a.alive()) healActor(host, a, Math.max(1, Math.round(regen)));
  for (const k of Object.keys(a.cooldowns)) {
    a.cooldowns[k] = Math.max(0, a.cooldowns[k]! - 1);
    if (!a.cooldowns[k]) delete a.cooldowns[k];
  }
  a.dirty = true;
}

/**
 * The end of a fighter's turn: every status that was on when the turn began (`had`) has one turn less, so a status for
 * N turns lasts through N of its bearer's own turns, whoever put it on and when (one the bearer gains during their own
 * turn starts counting with their next). A control that ends leaves its bearer immune to control for the turns the
 * rules give, counted the same way.
 */
export function wearStatuses(host: EffectHost, a: Actor, had: readonly ActiveStatus[]): void {
  const ix = rx(host.r);
  let controlEnded = false;
  a.statuses = a.statuses.flatMap((s) => {
    const def = ix.status.get(s.id);
    if (!def) return [];
    if (!had.includes(s)) return [s];
    if (s.turns > 1) return [{ ...s, turns: s.turns - 1 }];
    if (def.control) controlEnded = true;
    return [];
  });
  if (a.controlImmune > 0) a.controlImmune--;
  if (controlEnded) a.controlImmune = host.r.control.immunityTurns;
  a.dirty = true;
}

// ------------------------------------------------------------------------------------ items

/** Why a consumable cannot be used now, or null when it can: thrown at the ground in reach and in sight, or used on its user. */
export function checkItemUse(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }): string | null {
  const base = rx(host.r).item.get(item.baseId);
  const u = base?.use;
  if (!base || !u || u.tool) return 'That cannot be used here.';
  if (!user.alive()) return 'You cannot act right now.';
  if (inCombat && user.ap < u.ap) return `Not enough ${host.r.terminology.actionPoints}.`;
  if (!inCombat && !u.outOfCombat && !(u.targeting === 'ground' && (point || target))) return 'Only in combat.';
  if (u.targeting === 'ground') {
    const p = point ?? target;
    if (!p) return 'Choose where to throw it.';
    if (dist(user, p) > itemSkill(base).range + 0.01) return 'Out of range.';
    if (!host.zoneMap(user.zoneId).nav.sees(user, p)) return 'No line of sight.';
    return null;
  }
  // Said rather than used on the user instead of whoever was meant.
  if (target && target !== user) return `${base.name} works only on the one who uses it.`;
  return null;
}

/** Apply a consumable. The caller removes the item from the inventory. */
export function useConsumable(host: EffectHost, user: Actor, item: ItemInstance, inCombat: boolean, target?: Actor, point?: { x: number; y: number }) {
  const base = rx(host.r).item.get(item.baseId)!;
  const u = base.use!;
  if (inCombat) user.ap -= u.ap;
  const skill = itemSkill(base);
  const stats = consumableStats(host.r, user.level);
  const thrown = u.targeting === 'ground';
  const at = thrown ? point ?? target ?? user : user;
  const center = { x: at.x, y: at.y };
  host.fx(user.zoneId, [{ kind: thrown ? 'projectile' : 'skill', sourceId: user.id, x: user.x, y: user.y, tx: center.x, ty: center.y, fx: skill.fx, radius: u.radius, element: skillElement(host.r, skill, stats) }]);
  const targets = thrown ? resolveTargets(host, user, u.effects, 'ground', u.radius, center) : [user];
  runEffects(host, { user, stats, skill, rank: 1, effects: u.effects, targets, zone: user.zoneId });
  user.dirty = true;
}
