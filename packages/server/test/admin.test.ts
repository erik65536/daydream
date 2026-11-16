/**
 * The administrators' pages are refused to everyone else by the server, not only hidden by the interface: every
 * route under /api/admin, wherever it is mounted, answers 401 signed out and 403 to a player.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import * as store from '../src/storage.ts';
import { mountAdmin } from '../src/admin.ts';
import { mountAccounts } from '../src/accounts.ts';
import { mountGpuAdmin } from '../src/gpu/admin.ts';
import { mountWorldDeletion } from '../src/worlddelete.ts';
import { mountWorldViewer } from '../src/worldview.ts';
import { activeUser } from './helpers.ts';

/** Every route an app has under a prefix, as method and path (parameters filled in). */
function routes(app: express.Express, prefix: string): { method: string; path: string }[] {
  const stack = (app as unknown as { router: { stack: { route?: { path: string; methods: Record<string, boolean> } }[] } }).router.stack;
  return stack.flatMap((l) => (l.route && l.route.path.startsWith(prefix) ? Object.keys(l.route.methods).map((m) => ({ method: m.toUpperCase(), path: l.route!.path.replace(/:\w+/g, 'x') })) : []));
}

describe('the administrators’ pages', () => {
  const app = express();
  app.use(express.json());
  mountAdmin(app);
  mountAccounts(app, { sameOrigin: () => true });
  mountGpuAdmin(app);
  mountWorldDeletion(app);
  mountWorldViewer(app);
  let server: http.Server;
  let base = '';
  beforeAll(async () => {
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const as = (u: store.User | null) => ({ cookie: u ? `daydream_session=${store.createSession(u.id)}` : '', 'content-type': 'application/json' });

  it('are refused to players and to anyone signed out, every route of them', async () => {
    // The GPU page's routes are on a router of their own: one of its paths stands for them.
    const all = [...routes(app, '/api/admin'), { method: 'GET', path: '/api/admin/gpu' }, { method: 'POST', path: '/api/admin/gpu/pause' }];
    expect(all.length).toBeGreaterThan(15);
    const player = activeUser();
    for (const r of all) {
      const send = (u: store.User | null) => fetch(base + r.path, { method: r.method, headers: as(u), body: r.method === 'GET' ? undefined : '{}' });
      expect([r.path, (await send(null)).status]).toEqual([r.path, 401]);
      expect([r.path, (await send(player)).status]).toEqual([r.path, 403]);
    }
  });

  it('answer administrators', async () => {
    const res = await fetch(`${base}/api/admin/errors`, { headers: as(activeUser(true)) });
    expect(res.status).toBe(200);
  });
});
