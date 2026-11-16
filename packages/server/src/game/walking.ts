/**
 * Walking outside fights: a party sent somewhere or steered with a stick, its followers behind the leader, and the
 * errands done on arrival.
 */
import {
  STEER_TRUST_M, WALK_SPEED, hashFloat, nearestOnWay, type PlayerState, type Vec2,
} from '@daydream/shared';
import { CharActor } from './actors.ts';
import { callContext, withCallContext } from '../genai/context.ts';
import { followSlot } from './space.ts';
import type { Adventure, Errand } from './adventure.ts';

/** What this part of an adventure uses of the rest of it. */
type WalkingHost = Pick<
  Adventure,
  'charActors' | 'charFor' | 'cmdSkill' | 'dialogue' | 'endDialog' | 'fightOf' | 'follow' | 'inFight'
  | 'leader' | 'markDirty' | 'onStep' | 'passable' | 'performInteraction' | 'sendError' | 'state' | 'zones'
>;

export class Walking {
  private h: WalkingHost;
  constructor(h: WalkingHost) {
    this.h = h;
  }

  errands = new Map<string, Errand>();

  cmdMove(p: PlayerState, x: number, y: number, charId?: string) {
    const z = this.h.zones.get(p.zoneId);
    if (!z) return;
    if (!Number.isFinite(x) || !Number.isFinite(y)) return;
    // Combat movement: a hero of this player's whose turn it is.
    const c = this.h.fightOf(p);
    if (c) {
      const active = c.actingFor(p.userId, charId);
      if (!active) return this.h.sendError(p.userId, 'Not your turn.');
      const res = c.move(active, { x, y });
      if (res.error) this.h.sendError(p.userId, res.error);
      return;
    }
    this.errands.delete(p.userId);
    const leader = this.h.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    this.walkParty(p, leader, { x, y }, 0);
    this.closeDialogOnMove(p);
  }

  /** Controller walking: direction per player, refreshed by the client while the stick is held. */
  steering = new Map<string, { dx: number; dy: number; at: number; follow: number; legDir?: { x: number; y: number } }>();

  cmdSteer(p: PlayerState, dx: number, dy: number, x?: number, y?: number) {
    const len = Math.hypot(dx, dy);
    if (!Number.isFinite(len) || this.h.inFight(p)) return;
    // The walker's own screen decides where the leader is (within reason: a standable spot close by).
    this.takeClientPosition(p, x, y);
    if (len < 0.2) {
      this.steering.delete(p.userId);
      return this.stopSteering(p);
    }
    const prev = this.steering.get(p.userId);
    this.h.follow.stopFollowing(p);
    this.steering.set(p.userId, { dx: dx / len, dy: dy / len, at: Date.now(), follow: prev?.follow ?? 0, legDir: prev?.legDir });
    this.errands.delete(p.userId);
    this.closeDialogOnMove(p);
  }

  /** Put the leader where the walker's client has them, entering tiles on the way (exploring them). */
  private takeClientPosition(p: PlayerState, x?: number, y?: number) {
    const lead = this.h.leader(p);
    const z = this.h.zones.get(p.zoneId);
    if (!lead || !z || x === undefined || y === undefined || !Number.isFinite(x) || !Number.isFinite(y)) return;
    // Trust the walker's screen: only the spot itself must be standable (a straight-line check from the server's
    // own copy, which lags and slides differently around corners, refused good updates, and caused snap-backs).
    if (Math.hypot(x - lead.x, y - lead.y) > STEER_TRUST_M || !this.h.passable(z.id, x, y)) return;
    const before = { x: lead.x, y: lead.y };
    lead.x = x;
    lead.y = y;
    if (lead.motion) lead.motion = { ...lead.motion, from: { x, y }, t0: Date.now() };
    lead.dirty = true;
    this.h.onStep(z, lead, before);
  }

  /**
   * Keep the leader walking the steered way: a short straight leg ahead, renewed before it runs out or when the
   * direction changes, so motion never restarts from a standstill. Walls are slid along. Followers follow a
   * trail behind the leader instead of being re-planned on every update.
   */
  steerStep(p: PlayerState, s: { dx: number; dy: number; at: number; follow: number; legDir?: { x: number; y: number } }, now: number) {
    const lead = this.h.leader(p);
    const z = this.h.zones.get(p.zoneId);
    if (!lead || !z || lead.combatId) return;
    const m = lead.motion;
    const end = m?.path[m.path.length - 1];
    const left = end ? Math.hypot(end.x - lead.x, end.y - lead.y) : 0;
    // A new leg only when the stick's direction changed (not when a wall slide bent the last one) or the leg is
    // running out: every new leg is a small correction the client has to smooth over.
    const turned = !s.legDir || s.legDir.x * s.dx + s.legDir.y * s.dy < 0.985;
    if (!m || left < 1.6 || turned) {
      s.legDir = { x: s.dx, y: s.dy };
      const from = { x: lead.x, y: lead.y };
      const base = Math.atan2(s.dy, s.dx);
      let target: Vec2 | null = null;
      for (const turn of [0, 0.35, -0.35, 0.75, -0.75, 1.2, -1.2]) {
        const a = base + turn;
        for (const len of [4, 2.5, 1.2, 0.5]) {
          const t = { x: from.x + Math.cos(a) * len, y: from.y + Math.sin(a) * len };
          if (z.map.nav.clear(from, t)) {
            target = t;
            break;
          }
        }
        if (target) break;
      }
      if (target) {
        lead.motion = { path: [target], from, speed: WALK_SPEED, t0: now };
        lead.dirty = true;
      } else if (m) {
        lead.motion = null;
        lead.dirty = true;
      }
    }
    if (now - s.follow > 300) {
      s.follow = now;
      this.followLeader(p, lead, { x: s.dx, y: s.dy }, now);
    }
  }

  stopSteering(p: PlayerState) {
    const lead = this.h.leader(p);
    if (!lead || lead.combatId) return;
    if (lead.motion) {
      lead.motion = null;
      lead.dirty = true;
      p.x = lead.x;
      p.y = lead.y;
    }
    this.followLeader(p, lead, { x: Math.cos(lead.facing), y: Math.sin(lead.facing) }, Date.now());
  }

  /** Followers walk to their places in a short column behind the leader (only when they have drifted). */
  followLeader(p: PlayerState, lead: CharActor, dir: Vec2, now: number) {
    const z = this.h.zones.get(p.zoneId);
    if (!z) return;
    const followers = this.h.charActors(p).filter((a) => a !== lead && a.alive() && !a.combatId);
    const nav = z.map.nav;
    followers.forEach((f, i) => {
      let slot = followSlot(lead, dir, i);
      if (!nav.walkable(slot.x, slot.y)) slot = followSlot(lead, dir, i, true);
      if (!nav.walkable(slot.x, slot.y)) slot = { x: lead.x, y: lead.y };
      const d = Math.hypot(f.x - slot.x, f.y - slot.y);
      const goal = f.motion?.path[f.motion.path.length - 1];
      if (d < 0.7 || (goal && Math.hypot(goal.x - slot.x, goal.y - slot.y) < 0.6)) return;
      const from = { x: f.x, y: f.y };
      const path = nav.path(from, slot, { stopWithin: 0.3, allowBlockedGoal: true, maxNodes: 4000 });
      if (!path?.length) return;
      // Catch up a little faster when far behind, so the party keeps together while walking.
      f.motion = { path, from, speed: WALK_SPEED * (d > 3 ? 1.35 : 1.1), t0: now };
      f.dirty = true;
    });
  }

  /** Walking away ends a conversation. */
  private closeDialogOnMove(p: PlayerState) {
    if (this.h.dialogue.session(p.userId)) this.h.endDialog(p.userId);
  }

  /** Walk the leader to a target (or to within `stopWithin` meters of it); followers gather around the end. */
  walkParty(p: PlayerState, leader: CharActor, target: Vec2, stopWithin: number): boolean {
    // Every walk the player orders (a move, going to something, an attack from afar, going to a friend) is their own.
    this.h.follow.stopFollowing(p);
    const z = this.h.zones.get(p.zoneId)!;
    const nav = z.map.nav;
    const opts = {
      stopWithin: stopWithin > 0 ? stopWithin : undefined,
      allowBlockedGoal: stopWithin > 0,
      maxNodes: 60000,
    };
    const from = { x: leader.x, y: leader.y };
    // A walk to a spot no one can stand on or reach (a wall, a bush, across water) goes as near as it can.
    const path = nav.path(from, target, { ...opts, closest: stopWithin <= 0 });
    if (!path) return false;
    const now = Date.now();
    leader.motion = path.length ? { path, from, speed: WALK_SPEED, t0: now } : null;
    leader.dirty = true;
    if (!path.length) {
      this.arrived(leader);
      return true;
    }
    // Followers stop around the end, behind the leader as it arrives (with a little jitter so they don't line up).
    const dest = path[path.length - 1]!;
    const prev = path.length > 1 ? path[path.length - 2]! : from;
    const len = Math.hypot(prev.x - dest.x, prev.y - dest.y) || 1;
    const dir = { x: (prev.x - dest.x) / len, y: (prev.y - dest.y) / len };
    const followers = this.h.charActors(p).filter((a) => a !== leader && a.alive());
    followers.forEach((f, i) => {
      const off = [
        { x: dir.x - dir.y, y: dir.y + dir.x },
        { x: dir.x + dir.y, y: dir.y - dir.x },
        { x: dir.x * 2, y: dir.y * 2 },
      ][i % 3]!;
      const j = (hashFloat(`${f.id}:${now}`) - 0.5) * 0.4;
      const want = { x: dest.x + off.x * 0.9 + j, y: dest.y + off.y * 0.9 - j };
      const goal = nav.walkable(want.x, want.y) && nav.clear(dest, want) ? want : prev;
      const ff = { x: f.x, y: f.y };
      const fp = nav.path(ff, goal, { ...opts, stopWithin: undefined, allowBlockedGoal: false }) ?? nav.path(ff, dest, { ...opts, stopWithin: 1.5, allowBlockedGoal: true });
      if (fp?.length) {
        f.motion = { path: fp, from: ff, speed: WALK_SPEED * 1.05, t0: now + 120 * (i + 1) };
        f.dirty = true;
      }
    });
    return true;
  }

  arrived(a: CharActor) {
    const p = this.h.state.players[a.userId];
    if (!p) return;
    p.x = a.x;
    p.y = a.y;
    this.h.markDirty();
    const e = this.errands.get(p.userId);
    if (!e || e.charId !== a.id) return;
    this.errands.delete(p.userId);
    // The walk ended on the game's own clock: what the errand sets off is still paid by whoever ordered it.
    withCallContext({ priority: 'interactive', userId: e.payer ?? p.userId }, () => {
      if (e.kind === 'skill') this.h.cmdSkill(p, a.id, e.skillId, e.targetId, e.point?.x, e.point?.y, true);
      else this.h.performInteraction(p, a, e.targetId, e.inspect);
    });
  }

  /** Where `targetId` is to be reached from `from`: a way out at the map's edge anywhere along its road. */
  private targetPos(p: PlayerState, targetId: string, from: Vec2): { x: number; y: number; kind: 'actor' | 'feature' | 'loot' } | null {
    const z = this.h.zones.get(p.zoneId);
    if (!z) return null;
    const actor = z.actors.get(targetId);
    if (actor) return { x: actor.x, y: actor.y, kind: 'actor' };
    const f = z.map.features.get(targetId);
    if (f) {
      const at = f.kind === 'exit' ? nearestOnWay(z.map.nav.wayOut(f), from) : f;
      return { x: at.x, y: at.y, kind: 'feature' };
    }
    const l = z.rt.loot.find((x) => x.id === targetId);
    if (l) return { x: l.x, y: l.y, kind: 'loot' };
    return null;
  }

  cmdInteract(p: PlayerState, targetId: string, charId?: string, inspect?: boolean) {
    const leader = this.h.charFor(p, charId);
    if (!leader || !leader.alive()) return;
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    // Using something is the player's own errand: they stop following (or the friend's party would pull them away).
    this.h.follow.stopFollowing(p);
    const t = this.targetPos(p, targetId, leader);
    if (!t) return;
    const d = Math.hypot(t.x - leader.x, t.y - leader.y);
    // A pile on the ground is picked up from where it lies, and a way out is taken from its road: the hero steps onto
    // the spot (as near as the ground allows). People, chests, and other things are used from beside them.
    const onto = t.kind === 'loot' || this.h.zones.get(p.zoneId)?.map.features.get(targetId)?.kind === 'exit';
    const reach = onto ? 0.35 : 1.6;
    if (d <= reach + 0.01) return this.h.performInteraction(p, leader, targetId, inspect);
    this.goDo(p, leader, t, onto ? 0 : 1.5, { kind: 'use', charId: leader.id, targetId, inspect });
  }

  /** Walk over to do an errand, done on arrival (at once when already there). */
  goDo(p: PlayerState, a: CharActor, to: Vec2, stopWithin: number, errand: Errand) {
    // Set first: a hero already there arrives within the walk.
    this.errands.set(p.userId, { ...errand, payer: callContext()?.userId ?? p.userId });
    if (this.walkParty(p, a, to, stopWithin)) return;
    this.errands.delete(p.userId);
    this.h.sendError(p.userId, 'You can’t reach that.');
  }
}
