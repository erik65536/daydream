/**
 * Making a world (worldgen/review.ts, creation.ts): its concept and rule systems are written for review without any
 * world being saved, describing it again writes again only what the change reaches, and the world created from the
 * review keeps its runs, with the rules set by hand amended in and nothing asked of a model again.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import type { ReviewView, WorldInput } from '@daydream/shared';
import * as store from '../src/storage.ts';
import { mountWorldCreation } from '../src/creation.ts';
import { latestJob, requestCancel } from '../src/jobs/queue.ts';
import { placeholderWorld, worldExample, worldPipeline } from '../src/worldgen/build.ts';
import { worldMetrics } from '../src/worldgen/metrics.ts';
import { activeUser, mockModels, type MockModels } from './helpers.ts';

const input: WorldInput = { theme: 'A lighthouse island of smugglers and drowned caves.', size: 'tiny', length: 'brief', communication: 2 };

describe('making a world', () => {
  let models: MockModels;
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    models = await mockModels();
    const app = express();
    app.use(express.json());
    mountWorldCreation(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => {
    server.close();
    models.stop();
  });
  const call = async (u: store.User, path: string, body: unknown) => {
    const res = await fetch(base + path, { method: 'POST', headers: { cookie: `daydream_session=${store.createSession(u.id)}`, 'content-type': 'application/json' }, body: JSON.stringify(body) });
    return { status: res.status, json: (await res.json()) as Record<string, unknown> };
  };
  // The worlds of one owner: other test files build worlds in the same data at the same time.
  const worlds = (u: store.User) => store.listWorlds().filter((w) => w.ownerId === u.id).length;

  it('writes the review without saving a world, and creates the world reviewed, keeping its runs and the rules set by hand', async () => {
    const owner = activeUser(), other = activeUser();
    const before = worlds(owner);
    const first = (await call(owner, '/api/worlds/review', { input })).json as unknown as ReviewView;
    expect(first.concept?.title).toBeTruthy();
    expect(typeof first.systems?.crafting).toBe('boolean');
    expect(first.failed).toBeUndefined();
    expect(worlds(owner)).toBe(before);
    // Someone else cannot use it.
    expect((await call(other, '/api/worlds/review', { input, review: first.id })).status).toBe(404);
    expect((await call(other, '/api/worlds', { input, review: first.id })).status).toBe(404);

    // Described again with only the size changed: nothing the steps read changed, so the same answers come back.
    const again = (await call(owner, '/api/worlds/review', { input: { ...input, size: 'small', length: 'short' }, review: first.id })).json as unknown as ReviewView;
    expect(again.concept).toEqual(first.concept);
    expect(again.usd).toBe(first.usd);
    // A new theme writes the concept again.
    const theme = 'A lighthouse island of smugglers, drowned caves and singing seals.';
    const third = (await call(owner, '/api/worlds/review', { input: { ...input, theme }, review: first.id })).json as unknown as ReviewView;
    expect(third.usd).toBeGreaterThanOrEqual(again.usd);
    // Written again with a rule set by hand and nothing else changed: the answer holds it, no model asked again.
    const fourth = (await call(owner, '/api/worlds/review', { input: { ...input, theme, rules: { lifeSteal: !third.systems!.lifeSteal } }, review: first.id })).json as unknown as ReviewView;
    expect(fourth.usd).toBe(third.usd);
    expect(fourth.systems?.lifeSteal).toBe(!third.systems!.lifeSteal);

    // Created with more rules set by hand: the reviewed runs are the world's, the answer holds every choice, all fresh.
    const rules = { lifeSteal: !third.systems!.lifeSteal, crafting: !third.systems!.crafting, potions: { bombs: true } };
    const made = await call(owner, '/api/worlds', { input: { ...input, theme, rules }, review: first.id });
    expect(made.status).toBe(200);
    const w = store.loadWorld(String(made.json.worldId))!;
    expect(w.status).toBe('generating');
    expect(w.concept.title).toBe(third.concept!.title);
    const pipe = worldPipeline(w.id);
    expect(pipe.store.latest(w.id, 'rulesSystems')).toMatchObject({ edited: true, output: { lifeSteal: rules.lifeSteal, crafting: rules.crafting, potions: { bombs: true } } });
    const status = pipe.status(worldExample(w), ['ownerStyle', 'concept', 'rulesSystems']);
    expect(Object.values(status).map((s) => s.state)).toEqual(['fresh', 'fresh', 'fresh']);
    // The review's cost is the first of the world's records; the review itself is gone.
    expect(worldMetrics(w.id)[0]).toMatchObject({ kind: 'review', status: 'done' });
    expect(worldMetrics(w.id)[0]!.steps['pipeline concept']?.calls).toBeGreaterThan(0);
    expect((await call(owner, '/api/worlds', { input, review: first.id })).status).toBe(404);
    store.globalDb().prepare(`UPDATE jobs SET status = 'cancelled' WHERE id = ?`).run(latestJob(w.id)!.id);
  });

  it('resuming a stopped build counts toward the owner’s builds like a new one, and is for the owner or an administrator', async () => {
    const owner = activeUser(), other = activeUser(), admin = activeUser(true);
    const who = { id: owner.id, name: owner.displayName };
    const stopped = () => {
      const w = placeholderWorld(`w_res_${Math.random().toString(36).slice(2, 10)}`, input, who, 'failed');
      store.saveWorld(w);
      return w.id;
    };
    const first = stopped(), second = stopped(), third = stopped();
    const resume = (u: store.User, id: string) => call(u, `/api/worlds/${id}/resume`, {});
    expect((await resume(other, first)).status).toBe(403);
    expect((await resume(owner, first)).status).toBe(200);
    expect(store.loadWorld(first)?.status).toBe('generating');
    // Already being made.
    expect((await resume(owner, first)).status).toBe(409);
    expect((await resume(owner, second)).status).toBe(200);
    // Two are queued: a third waits its turn, and nothing of it changed.
    const refused = await resume(owner, third);
    expect(refused.status).toBe(409);
    expect(refused.json.error).toMatch(/already have 2 jobs/);
    expect(store.loadWorld(third)?.status).toBe('failed');
    expect(latestJob(third)).toBeUndefined();
    // An administrator is not held to the limit.
    expect((await resume(admin, third)).status).toBe(200);
    for (const id of [first, second, third]) requestCancel(latestJob(id)!.id);
  });
});
