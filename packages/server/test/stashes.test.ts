import { describe, expect, it } from 'vitest';
import type { ServerMessage } from '@daydream/shared';
import { genWorld, hero } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';

describe('secrets that tell of a stash', () => {
  it('are kept by the build only when someone knows of them, and show the stash to those who were told', async () => {
    const w = await genWorld('A river delta of stilt villages and drowned temples');
    // Every stash the build keeps is one a person knows of, named by them.
    const stashes = w.zones.flatMap((z) => z.features.filter((f) => f.hidden).map((f) => ({ z, f })));
    expect(stashes.length).toBeGreaterThan(0);
    const keeper = (fid: string) => w.npcs.find((n) => n.secrets.some((s) => s.leadsTo === fid));
    for (const { f } of stashes) expect(keeper(f.id), f.id).toBeTruthy();

    const { z: wild, f: stash } = stashes[0]!;
    const n = keeper(stash.id)!;
    const adv = adventures.create(w, 'u1', 'Tester', 'stash', [hero(w, 'Mara', 'melee')]);
    const msgs: ServerMessage[] = [];
    adv.join({ userId: 'u1', send: (m) => msgs.push(m) });
    const p = adv.state.players.u1!;
    // What the player was last told of the stash: there, or unseen.
    const seen = () => {
      const last = msgs.filter((m): m is Extract<ServerMessage, { t: 'zone' | 'features' }> => m.t === 'zone' || m.t === 'features').at(-1)!;
      const state = last.features.find((f) => f.id === stash.id);
      return !!state && !state.unseen;
    };
    const go = (zoneId: string) => adv.handle('u1', { t: 'dev', reqId: 1, action: 'goto', zoneId });

    // Untold, the stash is not there.
    go(wild.id);
    expect(p.zoneId).toBe(wild.id);
    expect(seen()).toBe(false);
    // Told (the person confided it to this hero), it is, on coming back.
    (adv.state.npcs[n.id]!.secretsTold ??= {})[p.party[0]!.id] = [n.secrets.findIndex((s) => s.leadsTo === stash.id)];
    go(n.zoneId);
    go(wild.id);
    expect(seen()).toBe(true);
  }, 60000);
});
