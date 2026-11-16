import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';
import http from 'node:http';
import express from 'express';
import {
  activateUser, addPasskey, claimInvite, clearPassword, createSession, createUser, deleteSession, findUser, getUser, listUsers, removePasskey, resetUser,
  sessionUser, setAdmin, setEnabled, setPassword, unlockUser, userByInvite, verifyUser, BLOCK_AFTER, INVITE_DAYS, LOCK_AFTER,
  globalDb,
} from '../src/storage.ts';
import { cookie } from '../src/auth.ts';
import { mountAccounts } from '../src/accounts.ts';
import { mountAdmin } from '../src/admin.ts';
import { activeUser } from './helpers.ts';

/** Skip an account's wait between wrong passwords (as time passing would), keeping its count. */
const unlockOnlyTheWait = (userId: string) => globalDb().prepare('UPDATE users SET locked_until = NULL WHERE id = ?').run(userId);
const name = () => `t_${Math.random().toString(36).slice(2, 10)}`;

describe('accounts', () => {
  it('an invite becomes an account when its player picks a user name and a way to sign in', () => {
    const u = createUser({ displayName: 'Robin', monthlyBudgetUsd: 4 });
    expect(u).toMatchObject({ status: 'invited', username: null, displayName: 'Robin', monthlyBudgetUsd: 4, isAdmin: false });
    expect(u.inviteCode).toMatch(/^[A-Z2-9]{4}-[A-Z2-9]{4}-[A-Z2-9]{4}$/);
    expect(u.inviteExpires! - Date.now()).toBeGreaterThan((INVITE_DAYS - 0.01) * 86400_000);
    expect(userByInvite(u.inviteCode!.toLowerCase())?.id).toBe(u.id);
    // Not signed in until it is set up.
    expect(sessionUser(createSession(u.id))).toBeNull();

    const taken = activeUser().username!;
    expect(() => claimInvite(u.id, { username: taken.toUpperCase() })).toThrow(/taken/);
    expect(() => claimInvite(u.id, { username: 'a b' })).toThrow(/User names/);
    expect(() => claimInvite(u.id, {})).toThrow(/Choose a user name/);
    const mine = name();
    claimInvite(u.id, { username: mine, displayName: 'Robin Hood' });
    expect(() => setPassword(u.id, 'short')).toThrow(/at least/);
    setPassword(u.id, 'a-chosen-password');
    activateUser(u.id);
    expect(getUser(u.id)).toMatchObject({ status: 'active', username: mine, displayName: 'Robin Hood', inviteCode: null });
    expect(userByInvite(u.inviteCode!)).toBeUndefined();
    expect(verifyUser(mine.toUpperCase(), 'a-chosen-password').user?.id).toBe(u.id);
  });

  it('a reset sends the account back to an invite: same user name, no way to sign in, signed out', () => {
    const u = activeUser();
    addPasskey({ id: `pk_${name()}`, userId: u.id, name: 'Phone', publicKey: new Uint8Array([1]), counter: 0, transports: [] });
    const s = createSession(u.id);
    const r = resetUser(u.id);
    expect(r).toMatchObject({ status: 'invited', username: u.username, passwordHash: null });
    expect(sessionUser(s)).toBeNull();
    expect(verifyUser(u.username!, 'a-chosen-password').user).toBeUndefined();
    // The user name stays as it was.
    claimInvite(u.id, { username: name() });
    expect(getUser(u.id)!.username).toBe(u.username);
  });

  it('wrong passwords make an account wait, then lock it until an unlock; a right one clears them', () => {
    const u = activeUser();
    let now = Date.now();
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now);
    try {
      for (let i = 1; i < LOCK_AFTER; i++) expect(verifyUser(u.username!, 'not-the-password')).toEqual({ why: 'wrong' });
      expect(verifyUser(u.username!, 'not-the-password')).toEqual({ why: 'wrong' });
      // It waits now, and while it does even the right password is not checked.
      expect(verifyUser(u.username!, 'a-chosen-password')).toMatchObject({ why: 'locked', until: now + 30_000 });
      now += 31_000;
      expect(verifyUser(u.username!, 'a-chosen-password').user?.failedPasswords).toBe(0);
      // Guessing on, each wait longer (at most 15 minutes), until it is blocked.
      let last = verifyUser(u.username!, 'not-the-password');
      for (let i = 1; i < BLOCK_AFTER; i++) {
        now += 16 * 60_000;
        last = verifyUser(u.username!, 'not-the-password');
      }
      expect(last).toEqual({ why: 'blocked' });
      now += 24 * 3600_000;
      expect(verifyUser(u.username!, 'a-chosen-password')).toEqual({ why: 'blocked' });
      unlockUser(u.id);
      expect(verifyUser(u.username!, 'a-chosen-password').user?.id).toBe(u.id);
    } finally {
      clock.mockRestore();
    }
  });

  it('a disabled account cannot sign in and is signed out', () => {
    const u = activeUser();
    const s = createSession(u.id);
    setEnabled(u.id, false);
    expect(sessionUser(s)).toBeNull();
    expect(verifyUser(u.username!, 'a-chosen-password').user).toBeUndefined();
    setEnabled(u.id, true);
    expect(verifyUser(u.username!, 'a-chosen-password').user?.id).toBe(u.id);
    expect(() => setEnabled(createUser({ displayName: 'Not yet' }).id, true)).toThrow(/not been set up/);
  });

  it('keeps a way to sign in: no clearing the only password, no removing the only passkey', () => {
    const u = activeUser();
    expect(() => clearPassword(u.id)).toThrow(/passkey/);
    const pk = `pk_${name()}`;
    addPasskey({ id: pk, userId: u.id, name: 'Laptop', publicKey: new Uint8Array([1]), counter: 0, transports: [] });
    clearPassword(u.id);
    expect(() => removePasskey(u.id, pk, true)).toThrow(/only way/);
    // An administrator may (the account then needs a reset).
    removePasskey(u.id, pk, false);
  });

  it('an invite is never an administrator; a reset makes one a player again', () => {
    const u = createUser({ displayName: 'Not yet' });
    expect(() => setAdmin(u.id, true)).toThrow(/invite cannot/);
    activeUser(true);
    const v = activeUser();
    setAdmin(v.id, true);
    expect(resetUser(v.id).isAdmin).toBe(false);
  });

  it('keeps at least one active administrator', () => {
    const a = activeUser(true);
    const b = activeUser();
    setAdmin(b.id, true);
    expect(findUser(b.username!)!.isAdmin).toBe(true);
    setAdmin(b.id, false);
    for (const u of listUsers()) if (u.isAdmin && u.id !== a.id) setAdmin(u.id, false);
    expect(() => setAdmin(a.id, false)).toThrow(/at least one/);
    expect(() => setEnabled(a.id, false)).toThrow(/at least one/);
    expect(() => resetUser(a.id)).toThrow(/at least one/);
  });

  it('keeps a session by its hash: what the database holds signs nobody in', () => {
    const u = activeUser();
    const token = createSession(u.id), other = createSession(u.id);
    const kept = (globalDb().prepare('SELECT token FROM sessions WHERE user_id = ?').all(u.id) as { token: string }[]).map((r) => r.token);
    expect(kept).toHaveLength(2);
    expect(kept).not.toContain(token);
    for (const k of kept) expect(k).toMatch(/^[0-9a-f]{64}$/);
    expect(sessionUser(token)?.id).toBe(u.id);
    // The stored value is no session, and neither is a token stored as it is (one from before tokens were hashed).
    for (const k of kept) expect(sessionUser(k)).toBeNull();
    globalDb().prepare('INSERT INTO sessions (token, user_id, expires) VALUES (?, ?, ?)').run('a-token-in-plain-text', u.id, Date.now() + 60_000);
    expect(sessionUser('a-token-in-plain-text')).toBeNull();
    // A new password keeps the session it was set from and ends the others; signing out ends that one.
    setPassword(u.id, 'another-chosen-password', token);
    expect(sessionUser(token)?.id).toBe(u.id);
    expect(sessionUser(other)).toBeNull();
    deleteSession(token);
    expect(sessionUser(token)).toBeNull();
  });

  it('reads the session cookie, and takes a malformed one for none', () => {
    const req = (c: string) => ({ headers: { cookie: c } }) as never;
    expect(cookie(req('a=1; daydream_session=abc%20def'), 'daydream_session')).toBe('abc def');
    expect(cookie(req('daydream_session=%E0%A4%A'), 'daydream_session')).toBeUndefined();
    expect(cookie(req('other=1'), 'daydream_session')).toBeUndefined();
  });
});

describe('accounts on the web', () => {
  let server: http.Server;
  let base = '';
  /** The accounts whose games the routes asked to end. */
  const ended: string[] = [];
  beforeAll(async () => {
    const app = express();
    app.use(express.json());
    mountAdmin(app);
    mountAccounts(app, { sameOrigin: () => true, endGames: (id) => void ended.push(id) });
    server = http.createServer(app);
    await new Promise<void>((r) => server.listen(0, () => r()));
    base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  });
  afterAll(() => server.close());
  const post = async (p: string, body: unknown, c?: string) => {
    const res = await fetch(base + p, { method: 'POST', headers: { 'content-type': 'application/json', ...(c ? { cookie: c } : {}) }, body: JSON.stringify(body) });
    return { status: res.status, body: (await res.json()) as any, cookie: res.headers.get('set-cookie')?.split(';')[0] };
  };

  it('joins by invite link with a password, then signs in; a used or wrong code does nothing', async () => {
    const u = createUser({ displayName: 'Sam' });
    const code = u.inviteCode!;
    expect(await (await fetch(`${base}/api/join/${code}`)).json()).toEqual({ username: null, displayName: 'Sam' });
    const mine = name();
    const joined = await post(`/api/join/${code}/password`, { username: mine, displayName: 'Samwise', password: 'a-chosen-password' });
    expect(joined.status).toBe(200);
    expect(joined.body).toMatchObject({ username: mine, displayName: 'Samwise', hasPassword: true, passkeys: [] });
    expect(joined.cookie).toMatch(/^daydream_session=/);
    expect((await post(`/api/join/${code}/password`, { username: name(), password: 'another-password' })).status).toBe(400);
    expect((await fetch(`${base}/api/join/AAAA-BBBB-CCCC`)).status).toBe(400);
    const signed = await post('/api/auth/login', { username: mine, password: 'a-chosen-password' });
    expect(signed.status).toBe(200);
    // Changing the password needs the current one.
    expect((await post('/api/account/password', { next: 'a-new-password' }, signed.cookie)).status).toBe(400);
    expect((await post('/api/account/password', { proof: { password: 'wrong' }, next: 'a-new-password' }, signed.cookie)).status).toBe(400);
    expect((await post('/api/account/password', { proof: { password: 'a-chosen-password' }, next: 'a-new-password' }, signed.cookie)).status).toBe(200);
  });

  it('says while a user name is typed why it cannot be chosen, with the same words a join would refuse it with', async () => {
    const code = createUser({ displayName: 'Pip' }).inviteCode!;
    const ask = async (n: string) => (await (await fetch(`${base}/api/join/${code}/username?name=${encodeURIComponent(n)}`)).json() as { problem: string | null }).problem;
    expect(await ask('  free_name_9 ')).toBeNull();
    expect(await ask(activeUser().username!.toUpperCase())).toMatch(/taken/);
    const spaced = await ask('pip squeak');
    expect(spaced).toMatch(/spaces/);
    expect((await post(`/api/join/${code}/password`, { username: 'pip squeak', displayName: 'Pip', password: 'a-chosen-password' })).body.error).toBe(spaced);
    expect((await post(`/api/join/${code}/password`, { username: 'pip', displayName: 'Pip', password: 'short' })).body.error).toMatch(/at least 12/);
    expect((await fetch(`${base}/api/join/AAAA-BBBB-CCCC/username?name=pip`)).status).toBe(400);
  });

  it('a way to sign in that is refused leaves the invite as it was: the user name can still be chosen', async () => {
    const u = createUser({ displayName: 'Wren' });
    const first = name();
    expect((await post(`/api/join/${u.inviteCode}/password`, { username: first, displayName: 'Wren', password: 'short' })).status).toBe(400);
    expect(getUser(u.id)).toMatchObject({ username: null, status: 'invited', displayName: 'Wren' });
    // A passkey that does not check out (here: a ceremony never started) fixes nothing either.
    expect((await post(`/api/join/${u.inviteCode}/passkey/finish`, { username: first, flow: 'none', response: {}, name: 'Key' })).status).toBe(400);
    expect(getUser(u.id)!.username).toBeNull();
    const other = name();
    expect((await post(`/api/join/${u.inviteCode}/password`, { username: other, password: 'a-chosen-password' })).body).toMatchObject({ username: other });
  });

  it('disabling or resetting an account ends the games it has open', async () => {
    const admin = activeUser(true), a = activeUser(), b = activeUser();
    const as = `daydream_session=${createSession(admin.id)}`;
    const patch = await fetch(`${base}/api/admin/users/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: as }, body: JSON.stringify({ enabled: false }) });
    expect(patch.status).toBe(200);
    expect((await post(`/api/admin/users/${b.id}/reset`, {}, as)).status).toBe(200);
    expect(ended).toEqual([a.id, b.id]);
    // Enabling an account again ends nothing.
    await fetch(`${base}/api/admin/users/${a.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json', cookie: as }, body: JSON.stringify({ enabled: true }) });
    expect(ended).toHaveLength(2);
  });

  it('a blocked account says why and how to get back in', async () => {
    const u = activeUser();
    for (let i = 0; i < BLOCK_AFTER; i++) {
      verifyUser(u.username!, 'not-the-password');
      unlockOnlyTheWait(u.id);
    }
    const r = await post('/api/auth/login', { username: u.username, password: 'a-chosen-password' });
    expect(r.status).toBe(429);
    expect(r.body.error).toMatch(/passkey.*administrator/);
  });
});
