/**
 * Accounts on the web: signing in (password or passkey), joining by invite link, your own account, and user
 * administration. See storage.ts for an account's life (invited, active, disabled).
 *
 * Passkeys use WebAuthn (SimpleWebAuthn). A passkey belongs to the site's host name, taken from the page's own origin
 * (checked against the request), so one made on localhost works only there. A ceremony (registering or using a
 * passkey) is a challenge kept here for five minutes under a random flow id the browser sends back.
 *
 * Changing how you sign in (setting, replacing, or removing a password; adding or removing a passkey) needs a proof
 * that it is you: your current password, or a passkey used just before. An open session alone is not enough.
 */
import crypto from 'node:crypto';
import type http from 'node:http';
import type { Express, Request, Response } from 'express';
import { z } from 'zod';
import {
  generateAuthenticationOptions, generateRegistrationOptions, verifyAuthenticationResponse, verifyRegistrationResponse,
  type AuthenticationResponseJSON, type RegistrationResponseJSON,
} from '@simplewebauthn/server';
import { PASSWORD_MAX } from '@daydream/shared';
import * as store from './storage.ts';
import { auth, cookie, SESSION_COOKIE, type AuthedRequest } from './auth.ts';
import { genai } from './genai/service.ts';
import { monthlyBudgetFor } from './spending.ts';
import { activity, count, log, seenFrom, warn } from './log.ts';

const SITE = 'Daydream';
const round = (usd: number) => Math.round(usd * 10000) / 10000;

// ------------------------------------------------------------------------------------ views

const passkeyView = (p: store.Passkey) => ({ id: p.id, name: p.name, createdAt: p.createdAt, lastUsedAt: p.lastUsedAt });

function meOf(u: store.User) {
  const budget = monthlyBudgetFor(u.id);
  return {
    id: u.id, username: u.username, displayName: u.displayName, isAdmin: u.isAdmin, hasPassword: !!u.passwordHash,
    passkeys: store.listPasskeys(u.id).map(passkeyView),
    ai: { spentMonth: round(store.spentThisMonth(u.id).usd), budget: Number.isFinite(budget) ? budget : null },
    settings: u.settings,
  };
}

/** An account as the Users page lists it (its own preferences are nobody else's business). */
const userRow = (u: store.User) => ({
  ...meOf(u), settings: undefined, status: u.status, createdAt: u.createdAt, monthlyBudgetUsd: u.monthlyBudgetUsd,
  inviteCode: u.status === 'invited' ? u.inviteCode : null, inviteExpires: u.status === 'invited' ? u.inviteExpires : null,
  failedPasswords: u.failedPasswords, lockedUntil: u.lockedUntil && u.lockedUntil > Date.now() ? u.lockedUntil : null, blocked: u.blocked,
});

// ------------------------------------------------------------------------------------ sessions and attempts

const setSession = (req: Request, res: Response, token: string) =>
  res.setHeader('Set-Cookie', `${SESSION_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Lax; Max-Age=${30 * 24 * 3600}${req.secure ? '; Secure' : ''}`);

/**
 * Failed attempts per address (sign-ins, and invite codes guessed): a growing lockout after five. An account's own
 * wrong passwords are counted on the account instead (store.tryPassword), so a restart does not forget them.
 */
const failures = new Map<string, { n: number; until: number }>();
const locked = (k: string) => (failures.get(k)?.until ?? 0) > Date.now();
const fail = (k: string) => {
  // Forget old entries now and then, so the map stays small.
  if (failures.size > 5000) for (const [key, f] of failures) if (f.until < Date.now()) failures.delete(key);
  const f = failures.get(k) ?? { n: 0, until: 0 };
  f.n++;
  if (f.n >= 5) f.until = Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (f.n - 5));
  failures.set(k, f);
};
const tooMany = (res: Response) => void res.status(429).json({ error: 'Too many failed attempts. Try again in a few minutes.' });

/** What a password refused for the account's own sake says (a merely wrong one says nothing more). */
function refusal(r: { why: 'wrong' | 'locked' | 'blocked'; until?: number }): string | null {
  if (r.why === 'blocked') return 'This account is locked after too many wrong passwords. Sign in with a passkey, or ask an administrator to unlock it.';
  if (r.why === 'locked') {
    const minutes = Math.max(1, Math.ceil(((r.until ?? 0) - Date.now()) / 60_000));
    return `Too many wrong passwords. Try again in ${minutes === 1 ? 'a minute' : `${minutes} minutes`}.`;
  }
  return null;
}

// ------------------------------------------------------------------------------------ passkey ceremonies

interface Flow {
  challenge: string;
  rpID: string;
  origin: string;
  /** What the ceremony is for, and for whom. */
  purpose: 'sign-in' | 'proof' | 'register';
  userId?: string;
  expires: number;
}
const flows = new Map<string, Flow>();

/** More ceremonies than this at once is not people signing in: the oldest make way (starting one needs no account). */
const MAX_FLOWS = 2000;

function newFlow(f: Omit<Flow, 'expires'>): string {
  const now = Date.now();
  // They are kept in the order they were started, which is the order they run out in.
  for (const [k, v] of flows) {
    if (v.expires >= now && flows.size < MAX_FLOWS) break;
    flows.delete(k);
  }
  const id = crypto.randomBytes(18).toString('base64url');
  flows.set(id, { ...f, expires: now + 5 * 60_000 });
  return id;
}

/** Take a flow (once): it must be for this purpose (and user) and not expired. */
function takeFlow(id: unknown, purpose: Flow['purpose'], userId?: string): Flow {
  const f = typeof id === 'string' ? flows.get(id) : undefined;
  if (typeof id === 'string') flows.delete(id);
  if (!f || f.expires < Date.now() || f.purpose !== purpose || (userId !== undefined && f.userId !== userId)) throw new Error('That took too long, or was not for this. Try again.');
  return f;
}

/** Use a passkey: the user whose passkey answered the flow's challenge (and its counter is moved on). */
async function usePasskey(flow: Flow, response: AuthenticationResponseJSON): Promise<store.User> {
  const pk = store.getPasskey(String(response?.id ?? ''));
  if (!pk || (flow.userId && pk.userId !== flow.userId)) throw new Error('That passkey is not known here.');
  const r = await verifyAuthenticationResponse({
    response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: false,
    credential: { id: pk.id, publicKey: pk.publicKey as Uint8Array<ArrayBuffer>, counter: pk.counter, transports: pk.transports as never },
  });
  if (!r.verified) throw new Error('That passkey did not check out.');
  store.passkeyUsed(pk.id, r.authenticationInfo.newCounter);
  // The owner, beyond doubt: wrong passwords someone else tried no longer hold the account.
  store.unlockUser(pk.userId);
  return store.getUser(pk.userId)!;
}

/** Check a finished registration; returns the passkey it made, to store for the user (`store.addPasskey`). */
async function verifiedPasskey(flow: Flow, response: RegistrationResponseJSON, userId: string, name: string): Promise<Parameters<typeof store.addPasskey>[0]> {
  const r = await verifyRegistrationResponse({ response, expectedChallenge: flow.challenge, expectedOrigin: flow.origin, expectedRPID: flow.rpID, requireUserVerification: false });
  if (!r.verified) throw new Error('That passkey could not be added.');
  const c = r.registrationInfo.credential;
  return { id: c.id, userId, name, publicKey: c.publicKey, counter: c.counter, transports: c.transports ?? [] };
}

async function registrationOptions(u: store.User, rpID: string) {
  return generateRegistrationOptions({
    rpName: SITE, rpID, userName: u.username ?? u.displayName, userDisplayName: u.displayName, userID: new TextEncoder().encode(u.id), attestationType: 'none',
    excludeCredentials: store.listPasskeys(u.id).map((p) => ({ id: p.id, transports: p.transports })),
    authenticatorSelection: { residentKey: 'required', userVerification: 'preferred' },
  });
}

// ------------------------------------------------------------------------------------ routes

/** Names and passwords as typed: the account rules (storage.ts, from @daydream/shared) judge them and say what is wrong. */
const Typed = z.string().max(1000);
const Proof = z.object({ password: z.string().max(PASSWORD_MAX).optional(), passkey: z.object({ flow: z.string(), response: z.unknown() }).optional() }).optional();

/**
 * `devClient`: under `npm run dev`, the Vite client's address. Only then a browser opened on
 * /api/dev/sign-in?token=<session> is given that session's cookie: tools hand a browser the session `npm run setup`
 * wrote to data/dev.json. It grants nothing the token does not: the token is a signed-in session already.
 *
 * `endGames`: ends an account's game connections, when an administrator disables or resets it (its sessions end in
 * storage; a game already open would otherwise go on until it closed).
 */
export function mountAccounts(app: Express, o: { sameOrigin: (req: http.IncomingMessage) => boolean; devClient?: string; endGames?: (userId: string, message: string) => void }) {
  /** The page's origin and the site name passkeys belong to; refused for a request from another site. */
  const rpOf = (req: Request): { origin: string; rpID: string } => {
    const origin = req.headers.origin;
    if (!origin || !o.sameOrigin(req)) throw new Error('Passkeys work only on this site.');
    return { origin, rpID: new URL(origin).hostname };
  };

  /** Run a handler, answering its thrown error as a 400. */
  const handle = (fn: (req: Request, res: Response) => Promise<unknown> | unknown) => async (req: Request, res: Response) => {
    try {
      await fn(req, res);
    } catch (e) {
      if (!res.headersSent) res.status(400).json({ error: (e as Error).message });
    }
  };

  /** That the signed-in user is who they say: their current password, or a passkey they just used. */
  const prove = async (u: store.User, proof: z.infer<typeof Proof>) => {
    if (proof?.password !== undefined) {
      const r = store.tryPassword(store.getUser(u.id)!, proof.password);
      if (!r.ok) throw new Error(refusal(r) ?? 'Your current password is wrong.');
      return;
    }
    if (proof?.passkey) {
      await usePasskey(takeFlow(proof.passkey.flow, 'proof', u.id), proof.passkey.response as AuthenticationResponseJSON);
      return;
    }
    throw new Error('Confirm it is you first: your current password, or one of your passkeys.');
  };

  // ---------------------------------------------------------------- signing in

  const signedIn = (u: store.User, method: string, req: Request) => {
    count('signIns');
    seenFrom(u.id, req.ip);
    activity('signed in', u.id, {}, { method, ip: req.ip });
  };

  app.post('/api/auth/login', (req, res) => {
    const body = z.object({ username: z.string().min(1).max(40), password: z.string().min(1).max(PASSWORD_MAX) }).safeParse(req.body);
    if (!body.success) return void res.status(400).json({ error: 'User name and password are required.' });
    const ip = `ip:${req.ip}`;
    if (locked(ip)) {
      warn('sign-in refused: too many failures from this address', { username: body.data.username, ip: req.ip });
      return tooMany(res);
    }
    const r = store.verifyUser(body.data.username, body.data.password);
    const u = r.user;
    if (!u) {
      if (r.why === 'wrong') fail(ip);
      warn('sign-in failed', { username: body.data.username, ip: req.ip, ...(r.why !== 'wrong' ? { account: r.why } : {}) });
      return void res.status(r.why === 'wrong' ? 401 : 429).json({ error: refusal(r) ?? 'Wrong user name or password.' });
    }
    failures.delete(ip);
    signedIn(u, 'password', req);
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(u));
  });

  app.post('/api/auth/passkey/start', handle(async (req, res) => {
    const rp = rpOf(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred' });
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'sign-in' }), options });
  }));

  app.post('/api/auth/passkey/finish', handle(async (req, res) => {
    if (locked(`ip:${req.ip}`)) return tooMany(res);
    let u: store.User;
    try {
      u = await usePasskey(takeFlow(req.body?.flow, 'sign-in'), req.body?.response as AuthenticationResponseJSON);
    } catch (e) {
      fail(`ip:${req.ip}`);
      warn('sign-in failed', { method: 'passkey', ip: req.ip });
      throw e;
    }
    if (u.status !== 'active') throw new Error(u.status === 'disabled' ? 'This account is disabled.' : 'This account is not set up yet.');
    signedIn(u, 'passkey', req);
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(u));
  }));

  app.post('/api/auth/logout', (req, res) => {
    const t = cookie(req, SESSION_COOKIE);
    if (t) store.deleteSession(t);
    res.setHeader('Set-Cookie', `${SESSION_COOKIE}=; Path=/; HttpOnly; SameSite=Lax; Max-Age=0${req.secure ? '; Secure' : ''}`);
    res.json({ ok: true });
  });

  if (o.devClient)
    app.get('/api/dev/sign-in', (req, res) => {
      const token = String(req.query.token ?? '');
      if (!store.sessionUser(token)) return void res.status(401).type('text').send('That session is not signed in here: run npm run setup again.');
      setSession(req, res, token);
      res.redirect(`${o.devClient}/`);
    });

  // ---------------------------------------------------------------- joining by invite

  /** The invited account behind a code (wrong codes count against the address). */
  const invited = (req: Request): store.User => {
    if (locked(`join:${req.ip}`)) throw new Error('Too many failed attempts. Try again in a few minutes.');
    const u = store.userByInvite(String(req.params.code ?? ''));
    if (!u) {
      fail(`join:${req.ip}`);
      throw new Error('This invite link is not valid (it may have been used or have expired). Ask for a new one.');
    }
    return u;
  };
  const JoinName = z.object({ username: Typed.optional(), displayName: Typed.optional() });

  /** The user name chosen when setting up (an account reset keeps the one it has). */
  const chosenName = (u: store.User, username?: string) => u.username ?? store.validUsername(username ?? '');

  app.get('/api/join/:code', handle((req, res) => {
    const u = invited(req);
    res.json({ username: u.username, displayName: u.displayName });
  }));

  /** Whether a user name can be chosen, asked while it is typed: why not (badly formed, or taken), or null. */
  app.get('/api/join/:code/username', handle((req, res) => {
    invited(req);
    res.json({ problem: store.usernameProblem(Typed.parse(req.query.name ?? '')) ?? null });
  }));

  app.post('/api/join/:code/password', handle((req, res) => {
    const u = invited(req);
    const body = JoinName.extend({ password: Typed }).parse(req.body);
    // All or nothing: a password that is refused leaves the user name unchosen.
    store.tx(() => {
      store.claimInvite(u.id, body);
      store.setPassword(u.id, body.password);
      store.activateUser(u.id);
    });
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.post('/api/join/:code/passkey/start', handle(async (req, res) => {
    const u = invited(req);
    const body = z.object({ username: Typed.optional() }).parse(req.body ?? {});
    const rp = rpOf(req);
    // The passkey carries the user name, so it is chosen (and checked) before the device makes one.
    const options = await registrationOptions({ ...u, username: chosenName(u, body.username) }, rp.rpID);
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'register', userId: u.id }), options });
  }));

  app.post('/api/join/:code/passkey/finish', handle(async (req, res) => {
    const u = invited(req);
    const body = JoinName.extend({ flow: z.string(), response: z.unknown(), name: z.string().trim().min(1, 'Name the passkey.').max(40) }).parse(req.body);
    const passkey = await verifiedPasskey(takeFlow(body.flow, 'register', u.id), body.response as RegistrationResponseJSON, u.id, body.name);
    // Only a passkey that checked out fixes the user name, and all of it is kept or none.
    store.tx(() => {
      store.claimInvite(u.id, body);
      store.addPasskey(passkey);
      store.activateUser(u.id);
    });
    setSession(req, res, store.createSession(u.id));
    res.json(meOf(store.getUser(u.id)!));
  }));

  // ---------------------------------------------------------------- your account

  app.get('/api/me', auth, (req, res) => {
    res.json(meOf((req as AuthedRequest).user));
  });

  app.patch('/api/account', auth, handle((req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ displayName: Typed }).parse(req.body);
    store.setDisplayName(u.id, body.displayName);
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.put('/api/account/settings', auth, handle((req, res) => {
    res.json(store.setSettings((req as AuthedRequest).user.id, req.body));
  }));

  /** Start a passkey proof (to confirm it is you before changing how you sign in). */
  app.post('/api/account/proof/start', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const rp = rpOf(req);
    const options = await generateAuthenticationOptions({ rpID: rp.rpID, userVerification: 'preferred', allowCredentials: store.listPasskeys(u.id).map((p) => ({ id: p.id, transports: p.transports })) });
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'proof', userId: u.id }), options });
  }));

  /** Set or replace your password. Your other sessions are signed out. */
  app.post('/api/account/password', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ proof: Proof, next: Typed }).parse(req.body);
    await prove(u, body.proof);
    store.setPassword(u.id, body.next, cookie(req, SESSION_COOKIE));
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.delete('/api/account/password', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    store.clearPassword(u.id);
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.post('/api/account/passkeys/start', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    const rp = rpOf(req);
    const options = await registrationOptions(u, rp.rpID);
    res.json({ flow: newFlow({ challenge: options.challenge, ...rp, purpose: 'register', userId: u.id }), options });
  }));

  app.post('/api/account/passkeys/finish', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    const body = z.object({ flow: z.string(), response: z.unknown(), name: z.string().trim().min(1, 'Name the passkey.').max(40) }).parse(req.body);
    store.addPasskey(await verifiedPasskey(takeFlow(body.flow, 'register', u.id), body.response as RegistrationResponseJSON, u.id, body.name));
    res.json(meOf(store.getUser(u.id)!));
  }));

  app.delete('/api/account/passkeys/:id', auth, handle(async (req, res) => {
    const u = (req as AuthedRequest).user;
    await prove(u, Proof.parse(req.body?.proof));
    store.removePasskey(u.id, String(req.params.id), true);
    res.json(meOf(store.getUser(u.id)!));
  }));

  // ---------------------------------------------------------------- administration

  /** An administrator's change to another account (not their own: no locking yourself out by a slip). */
  const target = (req: Request): store.User => {
    const id = String(req.params.id);
    if (id === (req as AuthedRequest).user.id) throw new Error('Change your own account on the Account page.');
    const u = store.getUser(id);
    if (!u) throw new Error('No such user.');
    return u;
  };

  // Everything under /api/admin has passed the administrators' guard (admin.ts).

  app.get('/api/admin/users', (_req, res) => {
    res.json(store.listUsers().map(userRow));
  });

  /** The whole server's AI spending today and its ceiling. */
  app.get('/api/admin/spending', (_req, res) => {
    const s = genai().config.spending ?? {};
    res.json({ today: round(store.spentTodayTotal()), dailyTotalUsd: s.dailyTotalUsd ?? null, adminsUnlimited: s.adminsUnlimited !== false, systemMonth: round(store.spentThisMonth('system').usd) });
  });

  /** Make an account: invited, with a name saying who it is for and a code for its invite link. */
  app.post('/api/admin/users', handle((req, res) => {
    const body = z.object({ displayName: Typed, monthlyBudgetUsd: z.number().min(0).max(10_000).optional() }).parse(req.body);
    res.json(userRow(store.createUser(body)));
  }));

  app.patch('/api/admin/users/:id', handle((req, res) => {
    const u = target(req);
    const body = z.object({ displayName: Typed.optional(), monthlyBudgetUsd: z.number().min(0).max(10_000).optional(), isAdmin: z.boolean().optional(), enabled: z.boolean().optional() }).parse(req.body);
    if (body.displayName !== undefined) store.setDisplayName(u.id, body.displayName);
    if (body.monthlyBudgetUsd !== undefined) store.setMonthlyBudget(u.id, body.monthlyBudgetUsd);
    if (body.isAdmin !== undefined) store.setAdmin(u.id, body.isAdmin);
    if (body.enabled !== undefined) {
      store.setEnabled(u.id, body.enabled);
      if (!body.enabled) o.endGames?.(u.id, 'Your account was disabled.');
    }
    res.json(userRow(store.getUser(u.id)!));
  }));

  /** Invited again with a new code: its password and passkeys are removed and it is signed out. */
  app.post('/api/admin/users/:id/reset', handle((req, res) => {
    const u = store.resetUser(target(req).id);
    o.endGames?.(u.id, 'Your account was reset. Ask for your new invite link.');
    res.json(userRow(u));
  }));

  /** Wrong passwords forgotten: a locked or blocked account takes passwords again. */
  app.post('/api/admin/users/:id/unlock', handle((req, res) => {
    const u = target(req);
    store.unlockUser(u.id);
    log('account unlocked', { user: u.id, by: (req as AuthedRequest).user.id });
    res.json(userRow(store.getUser(u.id)!));
  }));

  app.delete('/api/admin/users/:id/passkeys/:pid', handle((req, res) => {
    const u = target(req);
    store.removePasskey(u.id, String(req.params.pid), false);
    res.json(userRow(store.getUser(u.id)!));
  }));
}
