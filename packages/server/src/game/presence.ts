/**
 * Who is in the game besides those connected: the minute a dropped player's heroes stay with the AI before they
 * leave, players removed, and the roster everyone sees.
 */
import { characterStats, type PlayerState, type RosterEntry } from '@daydream/shared';
import type { Adventure } from './adventure.ts';

/** Each player's color, in the order they joined the adventure. */
const PLAYER_COLORS = ['#7fd1ff', '#ffb86b', '#9be37a', '#e58cff', '#ff8a8a', '#f5e26b', '#7ff0d8', '#c6a8ff'];

/** What this part of an adventure uses of the rest of it. */
export type PresenceHost = Pick<
  Adventure,
  'charActors' | 'conns' | 'despawnParty' | 'fightOf' | 'leader' | 'onEmpty' | 'playersInCombat' | 'r'
  | 'save' | 'sendTo' | 'state'
>;

export class Presence {
  private h: PresenceHost;
  constructor(h: PresenceHost) {
    this.h = h;
  }

  /** A player is no longer allowed in: their connections end (their heroes stay saved with the adventure). */
  kick(userId: string, message: string) {
    // Their heroes leave at once, as when a player leaves on purpose.
    if (this.h.conns.has(userId)) this.leaving.add(userId);
    for (const c of [...(this.h.conns.get(userId) ?? [])]) {
      c.send({ t: 'error', message, code: 'removed' });
      c.close?.();
    }
  }

  /** Players who dropped out a moment ago: their heroes stay, played by the AI, until the timer (or the fight) ends. */
  away = new Map<string, { timer: ReturnType<typeof setTimeout>; afterFight?: boolean }>();

  /** Players who said they are leaving: their heroes go at once rather than after the minute. */
  leaving = new Set<string>();

  /** A dropped player's minute is up: their heroes leave the game, or, in a fight with another player, once it ends. */
  goAway(userId: string) {
    const kept = this.away.get(userId);
    const p = this.h.state.players[userId];
    if (!kept || !p || this.h.conns.has(userId)) return;
    if (this.fightingWithOthers(p)) {
      kept.afterFight = true;
      return;
    }
    this.away.delete(userId);
    this.h.despawnParty(p);
    this.h.save();
    this.sendRoster();
    if (!this.h.conns.size && !this.away.size) this.h.onEmpty?.();
  }

  private fightingWithOthers(p: PlayerState): boolean {
    const fight = this.h.fightOf(p);
    return !!fight && !fight.ended && this.h.playersInCombat(fight).some((u) => u !== p.userId && this.h.conns.has(u));
  }

  /**
   * A player away from the game changes their heroes on the adventure's page: the ones the AI keeps for them leave
   * now, so the new choice is what comes back. Not while they are in a fight with another player (an error).
   */
  settleAway(userId: string): string | null {
    const p = this.h.state.players[userId];
    if (!p || !this.away.has(userId)) return null;
    if (this.fightingWithOthers(p)) return 'Your heroes are still in a fight with friends: wait for it to end.';
    clearTimeout(this.away.get(userId)!.timer);
    this.goAway(userId);
    return null;
  }

  /** Everyone in the game hears who plays, where, in what color, and how their heroes fare (`onlyIfChanged`: unless all is as last sent). */
  sendRoster(onlyIfChanged = false) {
    const players: RosterEntry[] = Object.values(this.h.state.players).map((p, i) => {
      const actors = this.h.charActors(p);
      return {
        userId: p.userId,
        name: p.name,
        color: PLAYER_COLORS[i % PLAYER_COLORS.length]!,
        online: this.h.conns.has(p.userId),
        away: this.away.has(p.userId) || undefined,
        zoneId: p.zoneId,
        leaderId: this.h.leader(p)?.id ?? p.leaderId,
        heroes: p.party.map((ch) => {
          const a = actors.find((x) => x.id === ch.id);
          return {
            id: ch.id,
            name: ch.name,
            sprite: ch.sprite,
            level: ch.level,
            hp: Math.ceil(ch.hp),
            maxHp: Math.round((a?.stats() ?? characterStats(this.h.r, ch)).maxHp),
            statuses: ch.statuses.map(({ id, turns, power }) => ({ id, turns, power })),
            ...(ch.downed ? { downed: true } : {}),
            ...(a?.aiDriven() ?? ch.ai ? { ai: true } : {}),
          };
        }),
        fighting: actors.some((a) => a.combatId),
      };
    });
    const key = JSON.stringify(players);
    if (onlyIfChanged && key === this.rosterKey) return;
    this.rosterKey = key;
    for (const u of this.h.conns.keys()) this.h.sendTo(u, { t: 'roster', players });
  }

  /** The roster last sent, so the once-a-second check sends it only when something in it changed. */
  private rosterKey = '';
}
