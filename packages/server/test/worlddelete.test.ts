import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type { ServerMessage, WorldDefinition } from '@daydream/shared';
import * as store from '../src/storage.ts';
import { DATA_DIR } from '../src/paths.ts';
import { enqueue, enqueueAnimation, getJobRecord } from '../src/jobs/queue.ts';
import { adventures } from '../src/game/manager.ts';
import { mountAdmin } from '../src/admin.ts';
import { mountWorldDeletion, removeWorld, StillStopping } from '../src/worlddelete.ts';
import { activeUser, genWorld, hero } from './helpers.ts';

const owner = () => activeUser();
const setJob = (id: string, status: string, leaseUntil: number) => store.globalDb().prepare('UPDATE jobs SET status = ?, lease_until = ? WHERE id = ?').run(status, leaseUntil, id);

/** A fresh copy of a test world, owned by `ownerId`. */
async function world(ownerId: string): Promise<WorldDefinition> {
  const w = { ...(await genWorld('A quiet valley of mills and old shrines')), id: `w_del_${Math.random().toString(36).slice(2, 8)}`, ownerId, ownerName: 'Owner' };
  store.saveWorld(w);
  return w;
}

describe('deleting a world', () => {
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountAdmin(app);
    mountWorldDeletion(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const as = (u: store.User | null) => ({ cookie: u ? `daydream_session=${store.createSession(u.id)}` : '' });
  const del = (id: string, u: store.User | null) => fetch(`${base}/api/worlds/${id}`, { method: 'DELETE', headers: as(u) });
  const preview = (id: string, u: store.User | null) => fetch(`${base}/api/admin/worlds/${id}/deletion`, { headers: as(u) });

  it('is for administrators only: the world’s owner and other players are refused', async () => {
    const mine = owner();
    const w = await world(mine.id);
    for (const u of [mine, activeUser()]) {
      expect((await del(w.id, u)).status).toBe(403);
      expect((await preview(w.id, u)).status).toBe(403);
    }
    expect((await del(w.id, null)).status).toBe(401);
    expect(store.loadWorld(w.id)).not.toBeNull();
    expect(fs.existsSync(store.worldDir(w.id))).toBe(true);
  });

  it('stops the world’s jobs, ends the adventures being played and moves the world and its adventures to the trash', async () => {
    const mine = owner();
    const admin = activeUser(true);
    const w = await world(mine.id);
    const adv = adventures.create(w, mine.id, 'Owner', 'doomed', [hero(w, 'Ada', 'melee')]);
    const sent: ServerMessage[] = [];
    let closed = 0;
    const conn = { userId: mine.id, send: (m: ServerMessage) => sent.push(m), close: () => void closed++ };
    expect(adv.join(conn)).toBe(true);
    // A queued animation, and a build whose worker died (its lease ran out).
    enqueueAnimation(w.id, { id: mine.id, name: 'Owner' });
    const orphan = enqueue('art', w.id, { id: mine.id, name: 'Owner' }, {});
    setJob(orphan.id, 'running', 1);

    const p = await (await preview(w.id, admin)).json() as { jobs: unknown[] };
    expect(p).toMatchObject({ title: w.concept.title, adventures: 1, players: 1, online: 1 });
    expect(p.jobs).toHaveLength(2);

    expect((await del(w.id, admin)).status).toBe(200);
    expect(sent.at(-1)).toMatchObject({ t: 'error', code: 'gone' });
    expect(closed).toBe(1);
    // The connection closing afterwards saves nothing back outside the trash.
    adv.leave(conn);
    expect(store.loadAdventure(adv.state.id)).toBeNull();
    expect(fs.existsSync(path.join(DATA_DIR, 'adventures', `${adv.state.id}.sqlite`))).toBe(false);
    expect(store.loadWorld(w.id)).toBeNull();
    expect(fs.existsSync(store.worldDir(w.id))).toBe(false);
    expect(getJobRecord(orphan.id)).toBeUndefined();
    expect(store.listTrash().find((e) => e.id === w.id)).toMatchObject({ deletedBy: admin.displayName, adventures: 1 });
    expect((await del(w.id, admin)).status).toBe(404);
  });

  it('waits for a running job to stop, and deletes nothing while it still runs', async () => {
    const admin = activeUser(true);
    const w = await world(owner().id);
    const job = enqueue('art', w.id, { id: w.ownerId, name: 'Owner' }, {});
    setJob(job.id, 'running', Date.now() + 60_000); // a live worker holds it
    await expect(removeWorld(w.id, admin, { waitMs: 300 })).rejects.toBeInstanceOf(StillStopping);
    expect(getJobRecord(job.id)?.cancelRequested).toBe(true);
    expect(store.loadWorld(w.id)).not.toBeNull();
    // The worker sees the cancel and stops; then the delete goes through.
    setTimeout(() => setJob(job.id, 'cancelled', 0), 300);
    await removeWorld(w.id, admin, { waitMs: 5000 });
    expect(store.loadWorld(w.id)).toBeNull();
  });
});
