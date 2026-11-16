import { afterEach, describe, expect, it, vi } from 'vitest';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { CharActor, NpcActor } from '../src/game/actors.ts';

const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('barks', () => {
  afterEach(() => vi.useRealTimers());

  it('take turns, come once in ten minutes from each person, and are remembered when the town is loaded again', async () => {
    const w = await genWorld('A sunburnt frontier of mesas and copper mines');
    const adv = adventures.create(w, 'ub', 'Tester', 'barks', [hero(w, 'Ana', 'melee')]);
    adv.join({ userId: 'ub', send: () => {} });
    const p = adv.state.players.ub!;
    const town = p.zoneId;
    const people = [...adv._live(town).actors.values()].filter((a): a is NpcActor => a instanceof NpcActor && a.def.barks.length > 0).slice(0, 2);
    expect(people).toHaveLength(2);
    const [ana] = adv._charActors('ub') as CharActor[];
    // Everyone stands together, and every roll says to speak.
    const place = () => {
      const live = [...adv._live(town).actors.values()];
      for (const [k, x] of people.entries()) {
        const a = live.find((y) => y.id === x.id)!;
        a.x = ana!.x + 1 + k;
        a.y = ana!.y;
      }
    };
    place();
    (adv as unknown as { rng: { chance: () => boolean } }).rng.chance = () => true;
    const said: string[] = [];
    (adv as unknown as { sayAloud: (a: unknown, id: string) => void }).sayAloud = (_a, id) => said.push(id);

    vi.useFakeTimers({ toFake: ['Date'] });
    const t0 = Date.now();
    await until(() => expect(said).toHaveLength(1));
    // A few seconds on, the other person would speak but waits their turn.
    vi.setSystemTime(t0 + 5_000);
    await wait(400);
    expect(said).toHaveLength(1);
    vi.setSystemTime(t0 + 25_000);
    await until(() => expect(new Set(said).size).toBe(2));

    // Away and back: the town is left empty and made again, and nobody calls out again so soon.
    const wild = w.zones.find((z) => z.kind === 'wilderness')!;
    adv.transfer(p, wild.id);
    adv.transfer(p, town);
    place();
    vi.setSystemTime(t0 + 60_000);
    await wait(400);
    expect(said).toHaveLength(2);
    adv.leave({ userId: 'ub', send: () => {} } as never);
  }, 120_000);
});
