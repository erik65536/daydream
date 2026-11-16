/**
 * Following a friend: a player's party walking after a friend's leader, into other places too, and the heroes of a
 * player who steers none walking after the nearest one who does.
 */
import { WALK_SPEED, type PlayerState, type Vec2 } from '@daydream/shared';
import { CharActor } from './actors.ts';
import { nearestFree } from './space.ts';
import type { Adventure } from './adventure.ts';

/** How far (meters) heroes the AI plays look for a hero a player steers to walk after. */
const FOLLOW_RANGE = 18;

/** What this part of an adventure uses of the rest of it. */
export type FollowingHost = Pick<
  Adventure,
  'actorsInZone' | 'charActors' | 'conns' | 'ctx' | 'inFight' | 'inGame' | 'leader' | 'markPlayer'
  | 'sendError' | 'state' | 'transfer' | 'walking' | 'zones'
>;

export class Following {
  private h: FollowingHost;
  constructor(h: FollowingHost) {
    this.h = h;
  }

  /**
   * Players walking after a friend's party (who follows -> whom). It lasts until the player sends their own party
   * somewhere or uses something (`stopFollowing`). A fight only pauses it, and when the friend goes to another place
   * the follower goes after them, so a player away from the keyboard keeps up with their friend.
   */
  following = new Map<string, string>();

  cmdFollow(p: PlayerState, userId: string | null) {
    if (!userId || userId === p.userId || !this.h.state.players[userId]) return this.stopFollowing(p);
    if (this.following.get(userId) === p.userId) return this.h.sendError(p.userId, `${this.h.state.players[userId]!.name} is following you.`);
    this.following.set(p.userId, userId);
    this.h.markPlayer(p.userId);
  }

  /** The player gave their own party an order outside a fight: they no longer follow anyone. */
  stopFollowing(p: PlayerState) {
    if (this.following.delete(p.userId)) this.h.markPlayer(p.userId);
  }

  /** Where to stand just behind a friend's leader, in their place (open ground). */
  private behind(f: PlayerState, lead: CharActor): Vec2 {
    const at = { x: lead.x - Math.cos(lead.facing) * 1.5, y: lead.y - Math.sin(lead.facing) * 1.5 };
    return nearestFree(this.h.ctx.map(f.zoneId).nav, this.h.actorsInZone(f.zoneId), at) ?? { x: lead.x, y: lead.y };
  }

  /** Go to a friend in another place: neither may be in a fight, and the friend must be in the game. */
  cmdJoinFriend(p: PlayerState, userId: string) {
    const f = this.h.state.players[userId];
    const lead = f && this.h.leader(f);
    if (!f || !lead || !this.h.conns.has(userId)) return this.h.sendError(p.userId, 'They are not in the game.');
    if (this.h.inFight(p)) return this.h.sendError(p.userId, 'Not during a fight.');
    if (this.h.inFight(f)) return this.h.sendError(p.userId, `${f.name} is in a fight: go there and join it.`);
    this.stopFollowing(p);
    const at = this.behind(f, lead);
    if (f.zoneId === p.zoneId) {
      const mine = this.h.leader(p);
      if (mine) this.h.walking.walkParty(p, mine, at, 1.2);
      return;
    }
    this.h.transfer(p, f.zoneId, undefined, at);
  }

  /**
   * Heroes the AI plays walk after the nearest hero a player steers: those of a player who steers none (all handed
   * to the AI, or dropped out), and a player following a friend (into another place, too). With nobody close enough
   * they wait where they are.
   */
  followFriends(now: number) {
    for (const p of this.h.inGame()) {
      const mine = this.h.charActors(p).filter((a) => a.alive() && !a.combatId);
      if (!mine.length) continue;
      const lead = this.h.leader(p);
      const friendId = this.following.get(p.userId);
      // A player in the game leads their own party (whoever fights on their own); one away trails a friend.
      const steered = lead && !lead.playerAway;
      if (steered && !friendId) continue;
      const z = this.h.zones.get(p.zoneId);
      if (!z) continue;
      const friend = friendId ? this.h.state.players[friendId] : undefined;
      // The friend went to another place (a way out, a waypoint): their follower goes after them once neither is in a
      // fight.
      if (friend && friend.zoneId !== p.zoneId) {
        const theirs = this.h.leader(friend);
        if (theirs && this.h.conns.has(friend.userId) && !this.h.inFight(p) && !this.h.inFight(friend)) this.h.transfer(p, friend.zoneId, undefined, this.behind(friend, theirs));
        continue;
      }
      const candidates = friend ? this.h.charActors(friend).filter((a) => a === this.h.leader(friend)) : [...z.actors.values()].filter((a): a is CharActor => a instanceof CharActor && a.userId !== p.userId && !a.playerAway && a.alive() && a === this.h.leader(this.h.state.players[a.userId]!));
      const walkers = steered ? [lead!] : mine;
      const from = walkers[0]!;
      const target = candidates.filter((c) => c.zoneId === p.zoneId).sort((a, b) => Math.hypot(a.x - from.x, a.y - from.y) - Math.hypot(b.x - from.x, b.y - from.y))[0];
      if (!target || Math.hypot(target.x - from.x, target.y - from.y) > (friend ? Infinity : FOLLOW_RANGE)) continue;
      walkers.forEach((w, i) => {
        const back = 1.6 + 0.8 * i, side = (i % 2 ? 1 : -1) * 0.6;
        const dir = { x: Math.cos(target.facing), y: Math.sin(target.facing) };
        const slot = { x: target.x - dir.x * back - dir.y * side, y: target.y - dir.y * back + dir.x * side };
        const goal = w.motion?.path[w.motion.path.length - 1];
        if (Math.hypot(w.x - slot.x, w.y - slot.y) < 1.2 || (goal && Math.hypot(goal.x - slot.x, goal.y - slot.y) < 1)) return;
        const path = z.map.nav.path(w, slot, { stopWithin: 0.6, allowBlockedGoal: true, maxNodes: 4000 });
        if (!path?.length) return;
        w.motion = { path, from: { x: w.x, y: w.y }, speed: WALK_SPEED * (Math.hypot(w.x - slot.x, w.y - slot.y) > 4 ? 1.3 : 1.05), t0: now };
        w.dirty = true;
      });
      // A party led by a player follows its leader as usual.
      if (steered) this.h.walking.followLeader(p, lead!, { x: Math.cos(lead!.facing), y: Math.sin(lead!.facing) }, now);
    }
  }
}
