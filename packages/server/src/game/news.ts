/**
 * What people have heard about heroes. Deeds and news are kept once, in the adventure (`AdventureState.news`); nobody
 * holds a copy. Who knows an item is worked out when it matters, from who saw it, how far it can travel, and how long it
 * has had to get there, scaled by the world's communication level (0: nobody tells anyone, 1: friends and family,
 * 2: the whole town, 3: everywhere):
 * - the witnesses know at once;
 * - their friends hear it the next day (from 1 up);
 * - everyone in the town where it happened hears it the next day, if it is town news or bigger (from 2 up);
 * - other towns hear world news after three days (2), or the next day (3).
 * Each person knows who they heard it from, so they can say so, and the day it reached them: news is new to someone
 * from that day, however long ago it happened.
 */
import type { NewsItem, NpcDef, NpcRuntime } from '@daydream/shared';
import type { WorldCtx } from './worldctx.ts';

export interface Heard {
  item: NewsItem;
  /** "you were there", "Clover told you", "people in town are talking about it"... */
  source: string;
  /** The day it reached them (the day it happened, for those who were there). */
  day: number;
  /** They were there: they need no telling, and made up their mind about it then. */
  witness: boolean;
}

/** Everything a person has heard about these heroes (newest last). */
export function heardAbout(ctx: WorldCtx, news: NewsItem[], npc: NpcDef, rt: NpcRuntime, heroIds: string[], today: number, communication: number): Heard[] {
  const out: Heard[] = [];
  const home = ctx.townOf(rt.zoneId) ?? rt.zoneId;
  for (const item of news) {
    if (!item.heroIds.some((h) => heroIds.includes(h))) continue;
    const how = heardHow(ctx, item, npc, home, communication);
    if (how && how.day <= today) out.push({ item, ...how });
  }
  return out;
}

/** How an item reaches a person and on which day, or null if it never does. */
function heardHow(ctx: WorldCtx, item: NewsItem, npc: NpcDef, home: string, comm: number): Omit<Heard, 'item'> | null {
  if (item.witnesses.includes(npc.id)) return { source: 'you were there', day: item.day, witness: true };
  if (comm < 1) return null;
  const friend = item.witnesses.find((w) => npc.relations?.includes(w) || ctx.npcs.get(w)?.relations?.includes(npc.id));
  if (friend) return { source: `${ctx.npcs.get(friend)?.name ?? 'a friend'} told you`, day: item.day + 1, witness: false };
  if (comm < 2 || item.reach === 'friends') return null;
  const where = ctx.townOf(item.zoneId) ?? item.zoneId;
  if (where === home) return { source: 'people in town are talking about it', day: item.day + 1, witness: false };
  if (item.reach === 'world') return { source: `word came from ${ctx.zones.get(where)?.name ?? 'elsewhere'}`, day: item.day + (comm >= 3 ? 1 : 3), witness: false };
  return null;
}
