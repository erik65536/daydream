/**
 * The world viewer shows administrators everything a world holds, spoilers and secrets included, so the server
 * refuses it to everyone else: signed out, other players, and the world's own owner.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import express from 'express';
import type { WorldDefinition } from '@daydream/shared';
import * as store from '../src/storage.ts';
import { mountAdmin } from '../src/admin.ts';
import { mountWorldViewer } from '../src/worldview.ts';
import { placeholderWorld } from '../src/worldgen/build.ts';
import { activeUser, genWorld } from './helpers.ts';

describe('the world viewer', () => {
  let server: http.Server;
  let base = '';
  let w: WorldDefinition;
  const owner = activeUser();
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountAdmin(app);
    mountWorldViewer(app);
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    w = { ...(await genWorld('A quiet valley of mills and old shrines')), id: `w_view_${Math.random().toString(36).slice(2, 8)}`, ownerId: owner.id, ownerName: 'Owner' };
    store.saveWorld(w);
    const voices = path.join(store.worldAssetDir(w.id), 'voices');
    fs.mkdirSync(voices, { recursive: true });
    fs.writeFileSync(path.join(voices, 'narrator.wav'), 'RIFF');
  });
  afterAll(() => server.close());
  const get = (p: string, u: store.User | null) => fetch(base + p, { headers: { cookie: u ? `daydream_session=${store.createSession(u.id)}` : '' } });

  it('is refused to anyone but administrators, the world’s owner included', async () => {
    for (const p of [`/api/admin/worlds/${w.id}/view`, `/api/admin/worlds/${w.id}/voices/narrator.wav`]) {
      expect((await get(p, null)).status).toBe(401);
      expect((await get(p, owner)).status).toBe(403);
      expect((await get(p, activeUser())).status).toBe(403);
    }
  });

  it('shows an administrator the whole world, secrets included, with its build records and voices', async () => {
    const res = await get(`/api/admin/worlds/${w.id}/view`, activeUser(true));
    expect(res.status).toBe(200);
    const view = await res.json() as { world: WorldDefinition; records: unknown; voiceClips: string[]; adventures: unknown };
    expect(view.world.id).toBe(w.id);
    expect(view.world.npcs.flatMap((n: WorldDefinition['npcs'][number]) => n.secrets)).toEqual(w.npcs.flatMap((n) => n.secrets));
    expect(view.world.quests).toHaveLength(w.quests.length);
    expect(Array.isArray(view.records)).toBe(true);
    expect(view.voiceClips).toEqual(['narrator']);
    expect(view.adventures).toEqual({ count: 0, players: 0 });
    expect((await get(`/api/admin/worlds/${w.id}/voices/narrator.wav`, activeUser(true))).status).toBe(200);
    expect((await get(`/api/admin/worlds/${w.id}/voices/..%2Fworld.json`, activeUser(true))).status).toBe(400);
    expect((await get('/api/admin/worlds/w_missing/view', activeUser(true))).status).toBe(404);
  });

  it('shows a world still being built, before it has rules, places or people', async () => {
    const id = `w_viewnew_${Math.random().toString(36).slice(2, 8)}`;
    store.saveWorld(placeholderWorld(id, w.input, { id: owner.id, name: 'Owner' }));
    const res = await get(`/api/admin/worlds/${id}/view`, activeUser(true));
    expect(res.status).toBe(200);
    expect((await res.json() as { world: WorldDefinition }).world.status).toBe('generating');
  });
});
