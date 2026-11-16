/**
 * Persistence, chosen per kind of data:
 *
 *   data/daydream.sqlite            global SQLite (WAL): users, sessions, and a catalog of worlds and adventures,
 *                                  shared by the server and CLI tools
 *   data/worlds/<id>/world.json    one per world: written during generation, then read whole — plain JSON, so it
 *                                  can be inspected, hand-edited, and copied; its generated art sits in the same folder
 *   data/adventures/<id>.sqlite    one per adventure: state split into sections so an autosave writes only
 *                                  what changed, transactionally (see adventurestore.ts)
 */
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { DatabaseSync } from 'node:sqlite';
import { checkDisplayName, checkPassword as passwordRules, checkUsername, normalizeSettings, TRASH_DAYS, type Check, type AdventureState, type PlayerSettings, type WorldDefinition } from '@daydream/shared';
import { DATA_DIR, WORLDS_DIR, worldDir } from './paths.ts';
import { AdventureFile } from './adventurestore.ts';

const worldsDir = WORLDS_DIR;
// The path helpers live in paths.ts, which opens no database; they are part of storage's interface too.
export { worldAssetDir, worldDir } from './paths.ts';
const adventuresDir = path.join(DATA_DIR, 'adventures');
const trashDir = path.join(DATA_DIR, 'trash');
fs.mkdirSync(worldsDir, { recursive: true });
fs.mkdirSync(adventuresDir, { recursive: true });

export function writeJsonAtomic(file: string, data: unknown) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, JSON.stringify(data));
  fs.renameSync(tmp, file);
}

function readJson<T>(file: string): T | null {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8')) as T;
  } catch {
    return null;
  }
}

// ------------------------------------------------------------------------------------ global database

const db = new DatabaseSync(path.join(DATA_DIR, 'daydream.sqlite'), { timeout: 10_000 });
// Busy timeout first, so several processes (server, CLI, test workers) can open the database at once.
db.exec('PRAGMA busy_timeout = 10000');
db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL;
  -- Accounts (see "users" below): invited with a code, then active once they have a user name and a password or a passkey.
  CREATE TABLE IF NOT EXISTS users (
    id TEXT PRIMARY KEY, username TEXT UNIQUE COLLATE NOCASE, display_name TEXT NOT NULL, password_hash TEXT, salt TEXT,
    created_at INTEGER NOT NULL, is_admin INTEGER NOT NULL DEFAULT 0, status TEXT NOT NULL, invite_code TEXT UNIQUE, invite_expires INTEGER,
    monthly_budget_usd REAL NOT NULL,
    -- Wrong passwords in a row, and what they led to (see tryPassword).
    failed_passwords INTEGER NOT NULL DEFAULT 0, locked_until INTEGER, blocked INTEGER NOT NULL DEFAULT 0,
    -- The player's own preferences (PlayerSettings in shared/settings.ts), as JSON.
    settings TEXT NOT NULL DEFAULT '{}'
  );
  CREATE TABLE IF NOT EXISTS passkeys (
    id TEXT PRIMARY KEY, user_id TEXT NOT NULL, name TEXT NOT NULL, public_key BLOB NOT NULL, counter INTEGER NOT NULL,
    transports TEXT NOT NULL, created_at INTEGER NOT NULL, last_used_at INTEGER
  );
  CREATE INDEX IF NOT EXISTS passkeys_user ON passkeys (user_id);
  -- A session by the SHA-256 of its token (sessionKey): the token itself is only in the player's cookie.
  CREATE TABLE IF NOT EXISTS sessions (token TEXT PRIMARY KEY, user_id TEXT NOT NULL, expires INTEGER NOT NULL);
  -- Spending on paid models, per user and day.
  CREATE TABLE IF NOT EXISTS spend (user_id TEXT NOT NULL, day TEXT NOT NULL, usd REAL NOT NULL DEFAULT 0, calls INTEGER NOT NULL DEFAULT 0, PRIMARY KEY (user_id, day));
  CREATE TABLE IF NOT EXISTS worlds (
    id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, status TEXT NOT NULL, public INTEGER NOT NULL, title TEXT NOT NULL,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS adventures (
    id TEXT PRIMARY KEY, world_id TEXT NOT NULL, owner_id TEXT NOT NULL, name TEXT NOT NULL, copy_of TEXT,
    created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
  );
  CREATE INDEX IF NOT EXISTS adventures_world ON adventures (world_id, updated_at DESC);
  -- Who besides its creator may play an adventure (kept from the adventure's own members list).
  CREATE TABLE IF NOT EXISTS adventure_members (adventure_id TEXT NOT NULL, user_id TEXT NOT NULL, PRIMARY KEY (adventure_id, user_id));
  CREATE INDEX IF NOT EXISTS adventure_members_user ON adventure_members (user_id);
`);

/** The shared database (jobs and the GPU page's process reports live here too, so every process sees them). */
export const globalDb = () => db;

/** Run `fn` as one transaction: all of it is kept, or (when it throws) none. Inside another, it is part of that one. */
export function tx<T>(fn: () => T): T {
  if (inTx) return fn();
  db.exec('BEGIN IMMEDIATE');
  inTx = true;
  try {
    const r = fn();
    db.exec('COMMIT');
    return r;
  } catch (e) {
    db.exec('ROLLBACK');
    throw e;
  } finally {
    inTx = false;
  }
}
let inTx = false;

// ------------------------------------------------------------------------------------ files

const worldFile = (id: string) => path.join(worldsDir, id, 'world.json');
const adventureFile = (id: string) => path.join(adventuresDir, `${id}.sqlite`);
const adventureFiles = new Map<string, AdventureFile>();

function adventureDb(id: string, create: boolean): AdventureFile | null {
  let f = adventureFiles.get(id);
  if (f) return f;
  if (!create && !fs.existsSync(adventureFile(id))) return null;
  f = new AdventureFile(adventureFile(id));
  adventureFiles.set(id, f);
  return f;
}

function removeSqlite(file: string) {
  for (const f of [file, `${file}-wal`, `${file}-shm`, `${file}-journal`]) fs.rmSync(f, { force: true });
}

const q = {
  insertSession: db.prepare('INSERT OR REPLACE INTO sessions (token, user_id, expires) VALUES (?, ?, ?)'),
  session: db.prepare('SELECT user_id, expires FROM sessions WHERE token = ?'),
  deleteSession: db.prepare('DELETE FROM sessions WHERE token = ?'),
  expireSessions: db.prepare('DELETE FROM sessions WHERE expires < ?'),
  upsertWorld: db.prepare(`INSERT INTO worlds (id, owner_id, status, public, title, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET owner_id = excluded.owner_id, status = excluded.status, public = excluded.public, title = excluded.title, updated_at = excluded.updated_at`),
  worldStamp: db.prepare('SELECT updated_at FROM worlds WHERE id = ?'),
  worldIds: db.prepare('SELECT id FROM worlds ORDER BY updated_at DESC'),
  deleteWorld: db.prepare('DELETE FROM worlds WHERE id = ?'),
  upsertAdventure: db.prepare(`INSERT INTO adventures (id, world_id, owner_id, name, copy_of, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)
    ON CONFLICT(id) DO UPDATE SET world_id = excluded.world_id, owner_id = excluded.owner_id, name = excluded.name, copy_of = excluded.copy_of, updated_at = excluded.updated_at`),
  adventureIds: db.prepare('SELECT id FROM adventures ORDER BY updated_at DESC'),
  adventureIdsOfWorld: db.prepare('SELECT id FROM adventures WHERE world_id = ? ORDER BY updated_at DESC'),
  deleteAdventure: db.prepare('DELETE FROM adventures WHERE id = ?'),
  deleteMembers: db.prepare('DELETE FROM adventure_members WHERE adventure_id = ?'),
  addMember: db.prepare('INSERT OR IGNORE INTO adventure_members (adventure_id, user_id) VALUES (?, ?)'),
  adventureIdsFor: db.prepare(`SELECT id FROM adventures WHERE world_id = ? AND (owner_id = ? OR id IN (SELECT adventure_id FROM adventure_members WHERE user_id = ?)) ORDER BY updated_at DESC`),
  memberInWorld: db.prepare('SELECT 1 FROM adventures a JOIN adventure_members m ON m.adventure_id = a.id WHERE a.world_id = ? AND m.user_id = ? LIMIT 1'),
};

const catalogWorld = (w: WorldDefinition) => q.upsertWorld.run(w.id, w.ownerId, w.status, w.public ? 1 : 0, w.concept.title, w.createdAt, w.updatedAt);
function catalogAdventure(s: AdventureState) {
  q.upsertAdventure.run(s.id, s.worldId, s.ownerId, s.name, s.copyOf ?? null, s.createdAt, s.updatedAt);
  q.deleteMembers.run(s.id);
  for (const u of s.members) q.addMember.run(s.id, u);
}

function uncatalogAdventure(id: string) {
  q.deleteAdventure.run(id);
  q.deleteMembers.run(id);
}

// ------------------------------------------------------------------------------------ users

/**
 * An account's life: an administrator makes it "invited" with an invite code and a name saying who it is for; the
 * user follows the invite link, picks their user name and chooses a password, a passkey, or both, which makes it
 * "active"; an administrator can disable it, or reset it to "invited" again with a new code (its password and passkeys
 * are gone; its user name, worlds, and adventures stay: a user name never changes once chosen).
 */
export type UserStatus = 'invited' | 'active' | 'disabled';

export interface User {
  id: string;
  /** The sign-in name the user chose when setting the account up (case-insensitive, never changes); null until then. */
  username: string | null;
  /** What other players see; the user can change it. */
  displayName: string;
  passwordHash: string | null;
  salt: string | null;
  createdAt: number;
  isAdmin: boolean;
  status: UserStatus;
  /** While invited: the code in the invite link, and when it stops working. */
  inviteCode: string | null;
  inviteExpires: number | null;
  /** What this user may spend on paid models in a calendar month (dollars). */
  monthlyBudgetUsd: number;
  /** Wrong passwords in a row since the last right one (or a passkey sign-in, or an unlock). */
  failedPasswords: number;
  /** Until when password sign-in waits, after LOCK_AFTER wrong ones. */
  lockedUntil: number | null;
  /** After BLOCK_AFTER wrong ones: no password sign-in until an administrator unlocks it or a passkey is used. */
  blocked: boolean;
  /** The player's own preferences: sound now, more later. */
  settings: PlayerSettings;
}

interface UserRow {
  id: string;
  username: string | null;
  display_name: string;
  password_hash: string | null;
  salt: string | null;
  created_at: number;
  is_admin: number;
  status: UserStatus;
  invite_code: string | null;
  invite_expires: number | null;
  monthly_budget_usd: number;
  failed_passwords: number;
  locked_until: number | null;
  blocked: number;
  settings: string;
}

export interface Passkey {
  /** The credential id (base64url). */
  id: string;
  userId: string;
  name: string;
  publicKey: Uint8Array;
  counter: number;
  transports: string[];
  createdAt: number;
  lastUsedAt: number | null;
}

interface PasskeyRow {
  id: string;
  user_id: string;
  name: string;
  public_key: Uint8Array;
  counter: number;
  transports: string;
  created_at: number;
  last_used_at: number | null;
}

/** A new account's monthly budget unless the administrator sets another. */
const DEFAULT_MONTHLY_BUDGET = 10;
/** How long an invite link works. */
export const INVITE_DAYS = 5;
/** Wrong passwords in a row before an account waits (30 seconds, doubling to 15 minutes), and before it is blocked. */
export const LOCK_AFTER = 5;
export const BLOCK_AFTER = 20;

const uq = {
  insert: db.prepare('INSERT INTO users (id, display_name, created_at, is_admin, status, invite_code, invite_expires, monthly_budget_usd) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'),
  setUsername: db.prepare('UPDATE users SET username = ? WHERE id = ? AND username IS NULL'),
  all: db.prepare('SELECT * FROM users ORDER BY created_at'),
  byName: db.prepare('SELECT * FROM users WHERE username = ?'),
  byId: db.prepare('SELECT * FROM users WHERE id = ?'),
  byInvite: db.prepare('SELECT * FROM users WHERE invite_code = ?'),
  count: db.prepare('SELECT COUNT(*) AS n FROM users'),
  activeAdmins: db.prepare("SELECT COUNT(*) AS n FROM users WHERE is_admin = 1 AND status = 'active'"),
  setPassword: db.prepare('UPDATE users SET password_hash = ?, salt = ? WHERE id = ?'),
  setStatus: db.prepare('UPDATE users SET status = ? WHERE id = ?'),
  setInvite: db.prepare("UPDATE users SET status = 'invited', invite_code = ?, invite_expires = ?, password_hash = NULL, salt = NULL, is_admin = 0, failed_passwords = 0, locked_until = NULL, blocked = 0 WHERE id = ?"),
  failedPassword: db.prepare('UPDATE users SET failed_passwords = failed_passwords + 1 WHERE id = ? RETURNING failed_passwords'),
  lock: db.prepare('UPDATE users SET locked_until = ?, blocked = ? WHERE id = ?'),
  unlock: db.prepare('UPDATE users SET failed_passwords = 0, locked_until = NULL, blocked = 0 WHERE id = ?'),
  activate: db.prepare("UPDATE users SET status = 'active', invite_code = NULL, invite_expires = NULL WHERE id = ?"),
  setName: db.prepare('UPDATE users SET display_name = ? WHERE id = ?'),
  setBudget: db.prepare('UPDATE users SET monthly_budget_usd = ? WHERE id = ?'),
  setAdmin: db.prepare('UPDATE users SET is_admin = ? WHERE id = ?'),
  setSettings: db.prepare('UPDATE users SET settings = ? WHERE id = ?'),
  signOut: db.prepare('DELETE FROM sessions WHERE user_id = ? AND token != ?'),
  passkeys: db.prepare('SELECT * FROM passkeys WHERE user_id = ? ORDER BY created_at'),
  passkey: db.prepare('SELECT * FROM passkeys WHERE id = ?'),
  addPasskey: db.prepare('INSERT INTO passkeys (id, user_id, name, public_key, counter, transports, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)'),
  usePasskey: db.prepare('UPDATE passkeys SET counter = ?, last_used_at = ? WHERE id = ?'),
  removePasskey: db.prepare('DELETE FROM passkeys WHERE id = ? AND user_id = ?'),
  removePasskeys: db.prepare('DELETE FROM passkeys WHERE user_id = ?'),
};

const toUser = (r: UserRow | undefined): User | undefined =>
  r && {
    id: r.id, username: r.username, displayName: r.display_name, passwordHash: r.password_hash, salt: r.salt, createdAt: r.created_at, isAdmin: !!r.is_admin,
    status: r.status, inviteCode: r.invite_code, inviteExpires: r.invite_expires, monthlyBudgetUsd: r.monthly_budget_usd,
    failedPasswords: r.failed_passwords, lockedUntil: r.locked_until, blocked: !!r.blocked, settings: parseSettings(r.settings),
  };

const toPasskey = (r: PasskeyRow | undefined): Passkey | undefined =>
  r && { id: r.id, userId: r.user_id, name: r.name, publicKey: new Uint8Array(r.public_key), counter: r.counter, transports: JSON.parse(r.transports || '[]') as string[], createdAt: r.created_at, lastUsedAt: r.last_used_at };

function hashPassword(password: string, salt: string): string {
  return crypto.scryptSync(password, salt, 64).toString('hex');
}

/** An invite code: 12 characters in three groups, no look-alike characters (about 60 bits). */
function inviteCode(): string {
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
  const c = Array.from({ length: 12 }, () => alphabet[crypto.randomInt(alphabet.length)]).join('');
  return `${c.slice(0, 4)}-${c.slice(4, 8)}-${c.slice(8)}`;
}

/** The cleaned-up value when it keeps the account rules (@daydream/shared accounts.ts), else their explanation. */
function kept(c: Check): string {
  if (c.problem) throw new Error(c.problem);
  return c.value;
}

/** Why a user name cannot be chosen (badly formed, or taken), if it cannot. Case does not matter. */
export function usernameProblem(username: string): string | undefined {
  const c = checkUsername(username);
  return c.problem ?? (uq.byName.get(c.value) ? 'That user name is taken. Choose another.' : undefined);
}

/** A user name that is well formed and free (checked again when it is taken). */
export function validUsername(username: string): string {
  const problem = usernameProblem(username);
  if (problem) throw new Error(problem);
  return checkUsername(username).value;
}

const validDisplayName = (name: string) => kept(checkDisplayName(name));
const validPassword = (password: string) => kept(passwordRules(password));

function requireUser(id: string): User {
  const u = getUser(id);
  if (!u) throw new Error('No such user.');
  return u;
}

const activeAdmins = () => (uq.activeAdmins.get() as { n: number }).n;
/** The last active administrator cannot be disabled, reset, or demoted. */
function keepAnAdmin(u: User) {
  if (u.isAdmin && u.status === 'active' && activeAdmins() <= 1) throw new Error('The server needs at least one active administrator.');
}

/**
 * An administrator makes an account: invited, with a name saying who it is for and a code for its invite link. An
 * invite is never an administrator; an account becomes one after it is set up.
 */
export function createUser(o: { displayName: string; monthlyBudgetUsd?: number }): User {
  const displayName = validDisplayName(o.displayName);
  const id = `u_${crypto.randomBytes(6).toString('hex')}`;
  uq.insert.run(id, displayName, Date.now(), 0, 'invited', inviteCode(), Date.now() + INVITE_DAYS * 86400_000, Math.max(0, o.monthlyBudgetUsd ?? DEFAULT_MONTHLY_BUDGET));
  return getUser(id)!;
}

/**
 * Invited again with a new code (an account not set up yet gets a fresh link; an administrator resetting one ends
 * its password and passkeys, signs it out everywhere, and makes it a player again). Its worlds and adventures stay.
 */
export function resetUser(userId: string): User {
  return tx(() => {
    keepAnAdmin(requireUser(userId));
    uq.setInvite.run(inviteCode(), Date.now() + INVITE_DAYS * 86400_000, userId);
    uq.removePasskeys.run(userId);
    uq.signOut.run(userId, '');
    return getUser(userId)!;
  });
}

/** The account an invite code is for, while the code still works. */
export function userByInvite(code: string): User | undefined {
  const u = toUser(uq.byInvite.get(code.trim().toUpperCase()) as UserRow | undefined);
  return u && u.status === 'invited' && (u.inviteExpires ?? 0) > Date.now() ? u : undefined;
}

/**
 * Setting up from an invite: the user name (only when the account has none yet: it never changes once chosen) and
 * the name others see. Done in one transaction with storing the first way to sign in (accounts.ts), so a taken name
 * stops it cleanly and a way to sign in that is refused leaves the name free to choose again.
 */
export function claimInvite(userId: string, o: { username?: string; displayName?: string }) {
  tx(() => {
    const u = requireUser(userId);
    if (!u.username) {
      if (!o.username) throw new Error('Choose a user name.');
      uq.setUsername.run(validUsername(o.username), userId);
    }
    if (o.displayName !== undefined) uq.setName.run(validDisplayName(o.displayName), userId);
  });
}

/**
 * The account's first way to sign in is set: it becomes active and the invite code is spent. On a server without an
 * active administrator (a fresh one), the first account set up becomes the administrator.
 */
export function activateUser(userId: string) {
  tx(() => {
    uq.activate.run(userId);
    if (!activeAdmins()) uq.setAdmin.run(1, userId);
  });
}

export function setEnabled(userId: string, enabled: boolean) {
  tx(() => {
    const u = requireUser(userId);
    if (u.status === 'invited') throw new Error('This account has not been set up yet.');
    if (!enabled) keepAnAdmin(u);
    uq.setStatus.run(enabled ? 'active' : 'disabled', userId);
    if (!enabled) uq.signOut.run(userId, '');
  });
}

function parseSettings(json: string): PlayerSettings {
  try {
    return normalizeSettings(JSON.parse(json));
  } catch {
    return normalizeSettings({});
  }
}

/** Save a player's preferences (anything missing or out of range becomes its default). */
export function setSettings(userId: string, settings: unknown): PlayerSettings {
  const s = normalizeSettings(settings);
  uq.setSettings.run(JSON.stringify(s), userId);
  return s;
}

export function setDisplayName(userId: string, name: string) {
  requireUser(userId);
  uq.setName.run(validDisplayName(name), userId);
}

export function setMonthlyBudget(userId: string, usd: number) {
  requireUser(userId);
  uq.setBudget.run(Math.max(0, usd), userId);
}

export function setAdmin(userId: string, isAdmin: boolean): void {
  tx(() => {
    const u = requireUser(userId);
    if (isAdmin && u.status === 'invited') throw new Error('An invite cannot be an administrator: make them one after they set up their account.');
    if (!isAdmin) keepAnAdmin(u);
    uq.setAdmin.run(isAdmin ? 1 : 0, userId);
  });
}

/** The user's password, when they have one (the same cost whether or not they do). */
export function checkPassword(u: User, password: string): boolean {
  if (!u.passwordHash || !u.salt) {
    hashPassword(password, 'timing');
    return false;
  }
  return crypto.timingSafeEqual(Buffer.from(hashPassword(password, u.salt), 'hex'), Buffer.from(u.passwordHash, 'hex'));
}

type PasswordCheck = { ok: true } | { ok: false; why: 'wrong' | 'locked' | 'blocked'; until?: number };

/**
 * An account's password, guarded against guessing. Wrong ones in a row are counted on the account: from the
 * LOCK_AFTER-th it waits before taking another (30 seconds, doubling to 15 minutes), and at BLOCK_AFTER it is blocked
 * until an administrator unlocks it or its owner signs in with a passkey (which a guesser cannot do). While it waits
 * or is blocked, nothing is checked or counted. A right password clears the count.
 */
export function tryPassword(u: User, password: string): PasswordCheck {
  if (u.blocked) return { ok: false, why: 'blocked' };
  if ((u.lockedUntil ?? 0) > Date.now()) return { ok: false, why: 'locked', until: u.lockedUntil! };
  if (checkPassword(u, password)) {
    if (u.failedPasswords) uq.unlock.run(u.id);
    return { ok: true };
  }
  const n = (uq.failedPassword.get(u.id) as { failed_passwords: number }).failed_passwords;
  const blocked = n >= BLOCK_AFTER;
  if (n >= LOCK_AFTER) uq.lock.run(Date.now() + Math.min(15 * 60_000, 30_000 * 2 ** (n - LOCK_AFTER)), blocked ? 1 : 0, u.id);
  return { ok: false, why: blocked ? 'blocked' : 'wrong' };
}

/** Sign in with a user name and password: active accounts that have a password. */
export function verifyUser(username: string, password: string): { user: User } | { user?: undefined; why: 'wrong' | 'locked' | 'blocked'; until?: number } {
  const u = findUser(username);
  if (!u || u.status !== 'active') {
    hashPassword(password, 'timing');
    return { why: 'wrong' };
  }
  const r = tryPassword(u, password);
  return r.ok ? { user: getUser(u.id)! } : { why: r.why, until: r.until };
}

/** Wrong passwords forgotten: by an administrator, or because the owner signed in with a passkey. */
export const unlockUser = (userId: string) => void uq.unlock.run(userId);

/** Set (or replace) a password. The user's other sessions are signed out. */
export function setPassword(userId: string, password: string, keepToken = '') {
  validPassword(password);
  const salt = crypto.randomBytes(16).toString('hex');
  uq.setPassword.run(hashPassword(password, salt), salt, userId);
  uq.unlock.run(userId);
  uq.signOut.run(userId, keepToken && sessionKey(keepToken));
}

/** Remove the password: only for someone who signs in with a passkey. */
export function clearPassword(userId: string) {
  if (!listPasskeys(userId).length) throw new Error('Add a passkey before removing your password, or you could not sign in.');
  uq.setPassword.run(null, null, userId);
}

export function listPasskeys(userId: string): Passkey[] {
  return (uq.passkeys.all(userId) as unknown as PasskeyRow[]).map((r) => toPasskey(r)!);
}

export function getPasskey(id: string): Passkey | undefined {
  return toPasskey(uq.passkey.get(id) as PasskeyRow | undefined);
}

export function addPasskey(p: Omit<Passkey, 'createdAt' | 'lastUsedAt'>) {
  const name = p.name.trim().slice(0, 40) || 'Passkey';
  uq.addPasskey.run(p.id, p.userId, name, p.publicKey, p.counter, JSON.stringify(p.transports), Date.now());
}

export function passkeyUsed(id: string, counter: number) {
  uq.usePasskey.run(counter, Date.now(), id);
}

/**
 * Remove a passkey. A user removing their own (`own`) keeps a way to sign in; an administrator may remove the last
 * one (the account then needs its password, or a reset).
 */
export function removePasskey(userId: string, passkeyId: string, own: boolean) {
  const u = requireUser(userId);
  if (own && !u.passwordHash && listPasskeys(userId).length <= 1) throw new Error('This is your only way to sign in: set a password or add another passkey first.');
  uq.removePasskey.run(passkeyId, userId);
}

export function listUsers(): User[] {
  return (uq.all.all() as unknown as UserRow[]).map((r) => toUser(r)!);
}

export function getUser(id: string): User | undefined {
  return toUser(uq.byId.get(id) as UserRow | undefined);
}

export function findUser(username: string): User | undefined {
  return toUser(uq.byName.get(username.trim()) as UserRow | undefined);
}

/** A server without accounts gets an invite for its administrator (the first account set up): its code is returned. */
export function ensureAdmin(): string | null {
  if ((uq.count.get() as { n: number }).n > 0) return null;
  return createUser({ displayName: 'Administrator' }).inviteCode;
}

// ------------------------------------------------------------------------------------ spending

/** Today's date (server local time), the spending ledger's key. */
const spendDay = (t = Date.now()) => {
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

/** The first day of this calendar month: budgets start again then. */
const monthStart = (t = Date.now()) => `${spendDay(t).slice(0, 7)}-01`;

const sq = {
  add: db.prepare('INSERT INTO spend (user_id, day, usd, calls) VALUES (?, ?, ?, 1) ON CONFLICT(user_id, day) DO UPDATE SET usd = usd + excluded.usd, calls = calls + 1'),
  since: db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd, COALESCE(SUM(calls), 0) AS calls FROM spend WHERE user_id = ? AND day >= ?'),
  total: db.prepare('SELECT COALESCE(SUM(usd), 0) AS usd FROM spend WHERE day = ?'),
};

export function recordSpend(userId: string, usd: number) {
  sq.add.run(userId, spendDay(), usd);
}

/** What a user has spent this calendar month. */
export function spentThisMonth(userId: string): { usd: number; calls: number } {
  return sq.since.get(userId, monthStart()) as { usd: number; calls: number };
}

export const spentTodayTotal = () => (sq.total.get(spendDay()) as { usd: number }).usd;

// ------------------------------------------------------------------------------------ sessions

/**
 * What the database keeps of a session: the SHA-256 of its token. The token is in the player's cookie alone, so a
 * copy of the database (a backup, say) signs nobody in.
 */
const sessionKey = (token: string) => crypto.createHash('sha256').update(token).digest('hex');

/** A new session for a user: its token, for their cookie. */
export function createSession(userId: string): string {
  const token = crypto.randomBytes(32).toString('hex');
  q.expireSessions.run(Date.now());
  q.insertSession.run(sessionKey(token), userId, Date.now() + 30 * 24 * 3600_000);
  return token;
}

/** The signed-in user of a session: only an active account. */
export function sessionUser(token: string | undefined): User | null {
  if (!token) return null;
  const s = q.session.get(sessionKey(token)) as { user_id: string; expires: number } | undefined;
  if (!s || s.expires < Date.now()) return null;
  const u = getUser(s.user_id);
  return u && u.status === 'active' ? u : null;
}

export function deleteSession(token: string) {
  q.deleteSession.run(sessionKey(token));
}

// ------------------------------------------------------------------------------------ worlds


/** Parsed worlds, revalidated against the catalog's updated_at so writes from other processes are picked up. */
const worldCache = new Map<string, { stamp: number; world: WorldDefinition }>();

export function saveWorld(w: WorldDefinition) {
  w.updatedAt = Math.max(Date.now(), (worldCache.get(w.id)?.stamp ?? 0) + 1);
  writeJsonAtomic(worldFile(w.id), w);
  catalogWorld(w);
  worldCache.set(w.id, { stamp: w.updatedAt, world: w });
}

export function loadWorld(id: string): WorldDefinition | null {
  if (!/^[\w-]+$/.test(id)) return null;
  const stamp = (q.worldStamp.get(id) as { updated_at: number } | undefined)?.updated_at;
  if (stamp === undefined) {
    worldCache.delete(id);
    return null;
  }
  const c = worldCache.get(id);
  if (c && c.stamp === stamp) return c.world;
  const world = readJson<WorldDefinition>(worldFile(id));
  if (!world) return null;
  worldCache.set(id, { stamp, world });
  return world;
}

export function listWorlds(): WorldDefinition[] {
  return (q.worldIds.all() as { id: string }[]).map((r) => loadWorld(r.id)).filter((w): w is WorldDefinition => !!w);
}

// ------------------------------------------------------------------------------------ trash

export { TRASH_DAYS };

/** A deleted world in data/trash/<id>/: its folder (world/), its adventures (adventures/), and this record (trash.json). */
export interface TrashEntry {
  id: string;
  title: string;
  ownerId: string;
  ownerName: string;
  deletedAt: number;
  deletedBy: string;
  adventures: number;
}

const trashEntryDir = (id: string) => path.join(trashDir, id);

/** Rename, or copy and remove when a rename is refused (another drive; on Windows, a file someone has open). */
function movePath(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  try {
    fs.renameSync(from, to);
  } catch {
    fs.cpSync(from, to, { recursive: true });
    fs.rmSync(from, { recursive: true, force: true });
  }
}

/** Delete a world: it and its adventures move to the trash, where an administrator can restore them for TRASH_DAYS days. */
export function deleteWorld(id: string, deletedBy = '') {
  const w = loadWorld(id);
  worldCache.delete(id);
  const entry = trashEntryDir(id);
  fs.rmSync(entry, { recursive: true, force: true });
  const adventures = q.adventureIdsOfWorld.all(id) as { id: string }[];
  for (const r of adventures) {
    uncatalogAdventure(r.id);
    closeAdventure(r.id);
    if (fs.existsSync(adventureFile(r.id))) moveSqlite(adventureFile(r.id), path.join(entry, 'adventures', `${r.id}.sqlite`));
  }
  q.deleteWorld.run(id);
  if (fs.existsSync(worldDir(id))) movePath(worldDir(id), path.join(entry, 'world'));
  const record: TrashEntry = { id, title: w?.concept.title ?? id, ownerId: w?.ownerId ?? '', ownerName: w?.ownerName ?? '', deletedAt: Date.now(), deletedBy, adventures: adventures.length };
  writeJsonAtomic(path.join(entry, 'trash.json'), record);
}

function moveSqlite(file: string, to: string) {
  for (const sfx of ['', '-wal', '-shm', '-journal']) if (fs.existsSync(file + sfx)) movePath(file + sfx, to + sfx);
}

/** Deleted worlds, most recently deleted first. */
export function listTrash(): TrashEntry[] {
  if (!fs.existsSync(trashDir)) return [];
  return fs
    .readdirSync(trashDir)
    .map((id) => readJson<TrashEntry>(path.join(trashEntryDir(id), 'trash.json')))
    .filter((e): e is TrashEntry => !!e)
    .sort((a, b) => b.deletedAt - a.deletedAt);
}

/** Bring a deleted world and its adventures back. */
export function restoreWorld(id: string): WorldDefinition {
  if (!/^[\w-]+$/.test(id)) throw new Error('Not in the trash.');
  const entry = trashEntryDir(id);
  if (!fs.existsSync(path.join(entry, 'trash.json'))) throw new Error('Not in the trash.');
  if (fs.existsSync(worldDir(id))) throw new Error('A world with this id already exists.');
  if (!fs.existsSync(path.join(entry, 'world'))) throw new Error('The deleted world has no files to restore.');
  movePath(path.join(entry, 'world'), worldDir(id));
  const w = readJson<WorldDefinition>(worldFile(id));
  if (!w) throw new Error('The deleted world could not be read.');
  catalogWorld(w);
  const dir = path.join(entry, 'adventures');
  for (const name of fs.existsSync(dir) ? fs.readdirSync(dir) : []) {
    if (!name.endsWith('.sqlite')) continue;
    const sid = name.slice(0, -'.sqlite'.length);
    moveSqlite(path.join(dir, name), adventureFile(sid));
    const s = adventureDb(sid, false)?.load();
    if (s) catalogAdventure(s);
  }
  fs.rmSync(entry, { recursive: true, force: true });
  return w;
}

/** Remove a deleted world for good. */
export function purgeTrashEntry(id: string) {
  if (!/^[\w-]+$/.test(id)) return;
  fs.rmSync(trashEntryDir(id), { recursive: true, force: true });
}

/** Remove worlds deleted more than TRASH_DAYS days ago; returns how many. */
export function purgeTrash(now = Date.now()): number {
  const old = listTrash().filter((e) => now - e.deletedAt > TRASH_DAYS * 86400_000);
  for (const e of old) purgeTrashEntry(e.id);
  return old.length;
}

// ------------------------------------------------------------------------------------ adventures

export function saveAdventure(s: AdventureState) {
  s.updatedAt = Date.now();
  adventureDb(s.id, true)!.save(s);
  catalogAdventure(s);
}

export function loadAdventure(id: string): AdventureState | null {
  if (!/^[\w-]+$/.test(id)) return null;
  return adventureDb(id, false)?.load() ?? null;
}

export function listAdventures(worldId?: string): AdventureState[] {
  const ids = (worldId ? q.adventureIdsOfWorld.all(worldId) : q.adventureIds.all()) as { id: string }[];
  return ids.map((r) => loadAdventure(r.id)).filter((s): s is AdventureState => !!s);
}

/** The adventures in a world a user may play: their own and those they were given a place in. */
export function adventuresFor(worldId: string, userId: string): AdventureState[] {
  const ids = q.adventureIdsFor.all(worldId, userId, userId) as { id: string }[];
  return ids.map((r) => loadAdventure(r.id)).filter((s): s is AdventureState => !!s);
}

/** Whether a user was given a place in someone's adventure in this world (so they may see the world). */
export function memberInWorld(worldId: string, userId: string): boolean {
  return !!q.memberInWorld.get(worldId, userId);
}

/** Close an adventure's file, once nothing is running it: the next read or save of it opens the file again. */
export function closeAdventure(id: string) {
  adventureFiles.get(id)?.close();
  adventureFiles.delete(id);
}

export function deleteAdventure(id: string) {
  uncatalogAdventure(id);
  closeAdventure(id);
  removeSqlite(adventureFile(id));
}

/**
 * World folders without a catalog entry (copied in while nothing ran, as when one is restored from a backup) are
 * listed from the next start on. Tools that add a world while the server runs save it (`saveWorld`), which lists it.
 */
function adoptWorldFolders() {
  for (const id of fs.readdirSync(worldsDir)) {
    if (q.worldStamp.get(id) || !fs.existsSync(worldFile(id))) continue;
    const w = readJson<WorldDefinition>(worldFile(id));
    if (w && w.id === id) catalogWorld(w);
  }
}


adoptWorldFolders();
