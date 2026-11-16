import { describe, expect, it } from 'vitest';
import http from 'node:http';
import express from 'express';
import { activity, activityOf, addressesOf, clearErrors, recentErrors, reportClientError, reportError, routeError, seenFrom, sharedAddresses } from '../src/log.ts';
import { ownSiteOnly } from '../src/auth.ts';
import { clientStack } from '../src/sourcemap.ts';

describe('error reports', () => {
  it('counts the same error once, keeps where it happened, and hides secrets', () => {
    clearErrors();
    const boom = (id: number) => {
      try {
        throw new Error(`zone z_${id} has no map`, { cause: new Error('file missing') });
      } catch (e) {
        return e;
      }
    };
    // The same error from the same place, for different zones: one entry, counted twice.
    reportError(boom(1), { zone: 'z_1', apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' });
    reportError(boom(2), { zone: 'z_2', note: 'Bearer abcdefghijkl1234' });
    const [e, ...rest] = recentErrors();
    expect(rest).toHaveLength(0);
    expect(e!.count).toBe(2);
    expect(e!.context.zone).toBe('z_2');
    expect(e!.context.note).toBe('[hidden]');
    expect(e!.context.version).toBeTruthy();
    expect(e!.stack).toContain('Caused by: Error: file missing');
    reportError(boom(1), { apiKey: 'sk-abcdefghijklmnopqrstuvwxyz' });
    expect(JSON.stringify(recentErrors())).not.toContain('sk-abc');
    // A different error is its own entry.
    reportError(new Error('something else'));
    expect(recentErrors()).toHaveLength(2);
    clearErrors();
    expect(recentErrors()).toHaveLength(0);
  });

  it("keeps the version of the page that reported an error beside the server's own", () => {
    clearErrors();
    // (What the page says of itself cannot stand in for who reported it, or for its version.)
    reportClientError(new Error('the map did not draw'), { where: 'game', context: { screen: 'game', user: 'someone-else', version: 'forged' }, trail: ['opened the map'], version: 'abc1234' }, { user: 'u_tab', ip: '10.0.0.9' });
    const [e] = recentErrors();
    expect(e).toMatchObject({ source: 'client', message: 'the map did not draw' });
    expect(e!.context).toMatchObject({ where: 'game', screen: 'game', version: 'abc1234', user: 'u_tab', trail: ['opened the map'] });
    expect(typeof e!.context.serverVersion).toBe('string');
    // A page that says nothing of its version (an older build) is kept without one.
    reportClientError(new Error('an older page broke'), {}, { user: 'u_tab' });
    expect(recentErrors().find((x) => x.message === 'an older page broke')!.context.version).toBeUndefined();
    clearErrors();
  });

  it("leaves a stack it has no source map for as it was", () => {
    const stack = 'Error: x\n    at Ab (https://example.test/assets/index-nothere.js:1:500)\n    at http://localhost:5173/src/App.tsx:12:3';
    expect(clientStack(stack)).toBe(stack);
  });
});

describe('requests', () => {
  /** A small server with the real first and last handlers around two routes; `fn` gets its address. */
  async function served<T>(fn: (base: string) => Promise<T>): Promise<T> {
    const app = express();
    app.use(express.json({ limit: '1kb' }));
    app.use('/api', ownSiteOnly('http://localhost:5173'));
    app.post('/api/echo', (req, res) => void res.json(req.body));
    app.get('/api/broken', () => {
      throw new Error('the route itself broke');
    });
    app.use(routeError);
    const server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
    try {
      return await fn(`http://127.0.0.1:${(server.address() as { port: number }).port}`);
    } finally {
      server.close();
    }
  }
  const post = (base: string, body: string, headers: Record<string, string> = {}) => fetch(`${base}/api/echo`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers }, body });

  it('a request that was itself wrong is answered as such and is not kept as an error; a route that breaks is', async () => {
    clearErrors();
    await served(async (base) => {
      const bad = await post(base, '{"not json');
      expect(bad.status).toBe(400);
      expect(await bad.json()).toEqual({ error: 'The request could not be read.' });
      expect((await post(base, JSON.stringify({ big: 'x'.repeat(4000) }))).status).toBe(413);
      expect(recentErrors()).toEqual([]);
      const broken = await fetch(`${base}/api/broken`);
      expect(broken.status).toBe(500);
      expect(await broken.json()).toEqual({ error: 'Something went wrong.' });
      expect(recentErrors().map((e) => e.message)).toEqual(['the route itself broke']);
    });
    clearErrors();
  });

  it('only this site’s own pages change anything: another site’s page is refused, a read and a tool are not', async () => {
    await served(async (base) => {
      const host = base.replace('http://', '');
      // No Origin: not a browser (console tools, tests).
      expect((await post(base, '{}')).status).toBe(200);
      // The site's own page, and in development the Vite client's.
      expect((await post(base, '{}', { origin: base })).status).toBe(200);
      expect((await post(base, '{}', { origin: 'http://localhost:5173' })).status).toBe(200);
      // Behind Caddy, the host the player asked for.
      expect((await post(base, '{}', { origin: 'https://play.example', 'x-forwarded-host': 'play.example' })).status).toBe(200);
      // Another site, a sibling of this one, and a page with no origin of its own.
      for (const origin of ['https://elsewhere.example', `http://blog.${host}`, 'null']) {
        const res = await post(base, '{}', { origin });
        expect(res.status, origin).toBe(403);
      }
      // Reading is not changing.
      expect((await fetch(`${base}/api/broken`, { headers: { origin: 'https://elsewhere.example' } })).status).toBe(500);
    });
    clearErrors();
  });
});

describe('addresses', () => {
  // Fresh accounts and addresses each run: the test database keeps what earlier runs wrote.
  const n = Date.now() % 250;
  const A = `log_a_${Date.now()}`, B = `log_b_${Date.now()}`, HOME = `10.77.${n}.1`, AWAY = `10.77.${n}.2`;
  it("keeps each account's addresses, and finds those more than one account used", () => {
    seenFrom(A, HOME);
    seenFrom(A, `::ffff:${HOME}`); // the same address, as Node may give it
    seenFrom(A, AWAY);
    seenFrom(B, HOME);
    const a = addressesOf(A);
    expect(a.map((r) => r.ip).sort()).toEqual([HOME, AWAY].sort());
    expect(a.find((r) => r.ip === HOME)!.count).toBe(2);
    const shared = sharedAddresses().filter((r) => r.ip === HOME && (r.userId === A || r.userId === B));
    expect(shared).toHaveLength(2);
  });
});

describe('activity', () => {
  it("keeps what an account did, newest first, without secrets", () => {
    const U = `log_u_${Date.now()}`;
    activity('world started', U, { world: 'w_1' });
    activity('played', U, { world: 'w_1', adventure: 'a_1' }, { minutes: 12.5, token: 'abc' });
    const [last, first] = activityOf(U);
    expect(first!.event).toBe('world started');
    expect(last).toMatchObject({ event: 'played', worldId: 'w_1', adventureId: 'a_1', detail: { minutes: 12.5, token: '[hidden]' } });
  });
});
