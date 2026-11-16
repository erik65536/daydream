/**
 * Logging, error reports and the server's basic numbers.
 *
 * - `log` and `warn` write one line per event to standard output: JSON in production (journald keeps it, and
 *   `journalctl -u daydream-server -o cat | jq` filters it), a readable line in development. What matters is logged
 *   (sign-ins, game connections, failed requests, jobs, an hourly line of numbers), not every request.
 * - `reportError` logs an error and keeps it in the shared database, the same error from any process (server, worker,
 *   a player's browser) counted under one entry, for the administrator's Errors page.
 * - Values under names that look secret (password, token, key, cookie, …) and anything shaped like an API key or a
 *   bearer token are hidden before a line is written or an error kept. Request bodies are never logged.
 * - `seenFrom` keeps, for a year, which addresses each account signs in and plays from (to look into a shared
 *   account, say: `users ips` in the console).
 * - `activity` keeps, for two years, what each account did that is worth counting later: signing in, worlds built
 *   and deleted, adventures started and deleted, and each time they played (for how long). `users activity` reads it.
 */
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import type { NextFunction, Request, Response } from 'express';
import { globalDb } from './storage.ts';
import { ROOT_DIR } from './paths.ts';

type LogSource = 'server' | 'worker' | 'client' | 'tool';
type Fields = Record<string, unknown>;

let source: LogSource = 'tool';
/** Which process this is, for its lines and the errors it reports. */
export function setLogSource(s: LogSource) {
  source = s;
}

const json = process.env.NODE_ENV === 'production';
const SECRET_NAME = /pass|secret|token|key|cookie|auth|credential/i;
const SECRET_TEXT = /\b(sk-[\w-]{12,}|Bearer\s+[\w.~+/=-]{8,})/g;

/** The code's commit (and whether it had changes), so an error can be read against the code that raised it. */
const VERSION = (() => {
  try {
    const run = (...args: string[]) => execFileSync('git', args, { cwd: ROOT_DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    return run('rev-parse', '--short', 'HEAD') + (run('status', '--porcelain', '--untracked-files=no') ? '+changes' : '');
  } catch {
    return 'unknown';
  }
})();
const startedAt = Date.now();

const scrub = (s: string) => s.replace(SECRET_TEXT, '[hidden]');
function clean(fields: Fields): Fields {
  const out: Fields = {};
  for (const [k, v] of Object.entries(fields)) {
    if (v === undefined) continue;
    out[k] = SECRET_NAME.test(k) ? '[hidden]' : typeof v === 'string' ? scrub(v) : v;
  }
  return out;
}

function write(level: 'info' | 'warn' | 'error', event: string, fields: Fields = {}) {
  const f = clean(fields);
  if (json) return void (level === 'info' ? process.stdout : process.stderr).write(`${JSON.stringify({ level, src: source, event, ...f })}\n`);
  const tail = Object.entries(f).map(([k, v]) => `${k}=${typeof v === 'string' && !/\s/.test(v) ? v : JSON.stringify(v)}`).join(' ');
  (level === 'info' ? console.log : console.warn)(`[${source}] ${level === 'info' ? '' : `${level.toUpperCase()} `}${event}${tail ? ` ${tail}` : ''}`);
}

export const log = (event: string, fields?: Fields) => write('info', event, fields);
export const warn = (event: string, fields?: Fields) => write('warn', event, fields);

// ------------------------------------------------------------------------------------ errors

const db = globalDb();
db.exec(`
  -- Errors from every process and players' browsers: one row per kind of error (its fingerprint), counted.
  CREATE TABLE IF NOT EXISTS errors (
    fingerprint TEXT PRIMARY KEY, source TEXT NOT NULL, message TEXT NOT NULL, stack TEXT NOT NULL, context TEXT NOT NULL,
    count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL
  );
`);
const q = {
  upsert: db.prepare(`INSERT INTO errors (fingerprint, source, message, stack, context, count, first_at, last_at) VALUES (?, ?, ?, ?, ?, 1, ?, ?)
    ON CONFLICT (fingerprint) DO UPDATE SET count = count + 1, last_at = excluded.last_at, stack = excluded.stack, context = excluded.context`),
  list: db.prepare('SELECT * FROM errors ORDER BY last_at DESC LIMIT ?'),
  prune: db.prepare('DELETE FROM errors WHERE last_at < ? OR fingerprint NOT IN (SELECT fingerprint FROM errors ORDER BY last_at DESC LIMIT ?)'),
  clear: db.prepare('DELETE FROM errors'),
};
/** Errors not seen for this long are forgotten, and only the most recent kinds are kept. */
const KEEP_MS = 30 * 86_400_000;
const KEEP_KINDS = 1000;

export interface ErrorEntry {
  fingerprint: string;
  source: LogSource;
  message: string;
  stack: string;
  context: Fields;
  count: number;
  firstAt: number;
  lastAt: number;
}

/**
 * Log an error and keep it for the Errors page. `context` says where it happened (a route, a job, a message type,
 * an adventure): ids and names, never request bodies or what a player typed.
 */
export function reportError(err: unknown, context: Fields = {}, from: LogSource = source) {
  const e = err instanceof Error ? err : new Error(typeof err === 'string' ? err : (JSON.stringify(err) ?? String(err)));
  const message = scrub(e.message || e.name).slice(0, 500);
  // What it was raised from (`new Error(…, { cause })`) belongs to the story, below its own stack.
  let full = e.stack ?? '';
  for (let c = e.cause, depth = 0; c !== undefined && depth < 3; c = c instanceof Error ? c.cause : undefined, depth++) full += `
Caused by: ${c instanceof Error ? (c.stack ?? c.message) : String(c)}`;
  const stack = scrub(full).slice(0, 12000);
  const ctx = clean({ ...context, ...(from === source ? { version: VERSION, upMinutes: Math.round((Date.now() - startedAt) / 60_000) } : { serverVersion: VERSION }) });
  counts.errors++;
  write('error', 'error', { message, ...ctx, ...(from !== source ? { from } : {}), stack: json ? stack : undefined });
  if (!json && stack) console.warn(stack);
  // The same error: same source, same words (numbers and ids aside), raised at the same place.
  const where = stack.split('\n').find((l) => /^\s+at /.test(l))?.trim() ?? '';
  const fingerprint = crypto.createHash('sha1').update(`${from}|${message.replace(/\b[\w-]*\d[\w-]*\b/g, '#')}|${where}`).digest('hex').slice(0, 16);
  try {
    const now = Date.now();
    q.upsert.run(fingerprint, from, message, stack, JSON.stringify(ctx), now, now);
    if (Math.random() < 0.05) q.prune.run(now - KEEP_MS, KEEP_KINDS);
  } catch {
    /* the database itself failing must not hide the original error, which is logged above */
  }
}

/**
 * An error a player's browser reported: kept as the client's, with where it happened, who met it, and the code the
 * page ran (`version`; the server's own is kept beside it, so an error from a tab left open is not taken for the
 * new code's).
 */
export function reportClientError(err: Error, report: { where?: string; context?: Fields; trail?: string[]; version?: string }, who: { user: string; ip?: string; browser?: string }) {
  reportError(err, { where: report.where, ...report.context, trail: report.trail, version: report.version, ...who }, 'client');
}

/**
 * The last handler of the web server: anything a route throws is logged and kept for the Errors page, and the player
 * gets a plain answer. A request that was itself wrong (a body that is not JSON or too large, an address that cannot
 * be read) is answered as such and is no error of the server's: anyone can send one, signed in or not.
 */
export function routeError(err: unknown, req: Request, res: Response, _next: NextFunction) {
  const status = Number((err as { status?: unknown } | null)?.status);
  if (status >= 400 && status < 500) return void (res.headersSent || res.status(status).json({ error: status === 413 ? 'That is too large.' : 'The request could not be read.' }));
  reportError(err, { method: req.method, path: req.path, user: (req as Request & { user?: { id: string } }).user?.id, ip: req.ip });
  if (!res.headersSent) res.status(500).json({ error: 'Something went wrong.' });
}

export function recentErrors(limit = 200): ErrorEntry[] {
  return (q.list.all(limit) as Record<string, unknown>[]).map((r) => ({
    fingerprint: String(r.fingerprint),
    source: r.source as LogSource,
    message: String(r.message),
    stack: String(r.stack),
    context: JSON.parse(String(r.context)) as Fields,
    count: Number(r.count),
    firstAt: Number(r.first_at),
    lastAt: Number(r.last_at),
  }));
}

export const clearErrors = () => void q.clear.run();

/** Crashes and forgotten promises are reported, then the process goes on (a crash still ends it, as Node would). */
export function reportProcessErrors() {
  process.on('uncaughtException', (e) => {
    reportError(e, { fatal: true });
    process.exit(1);
  });
  process.on('unhandledRejection', (e) => reportError(e, { unhandled: true }));
}

// ------------------------------------------------------------------------------------ addresses

db.exec(`
  -- Each account's addresses: one row per account and address, counted (sign-ins and game connections).
  CREATE TABLE IF NOT EXISTS user_addresses (
    user_id TEXT NOT NULL, ip TEXT NOT NULL, count INTEGER NOT NULL, first_at INTEGER NOT NULL, last_at INTEGER NOT NULL,
    PRIMARY KEY (user_id, ip)
  );
`);
const qa = {
  seen: db.prepare(`INSERT INTO user_addresses (user_id, ip, count, first_at, last_at) VALUES (?, ?, 1, ?, ?)
    ON CONFLICT (user_id, ip) DO UPDATE SET count = count + 1, last_at = excluded.last_at`),
  prune: db.prepare('DELETE FROM user_addresses WHERE last_at < ?'),
  of: db.prepare('SELECT * FROM user_addresses WHERE user_id = ? ORDER BY last_at DESC'),
  shared: db.prepare(`SELECT * FROM user_addresses WHERE ip IN (SELECT ip FROM user_addresses GROUP BY ip HAVING COUNT(*) > 1) ORDER BY ip, last_at DESC`),
};
const KEEP_ADDRESSES_MS = 365 * 86_400_000;

export interface AddressUse { userId: string; ip: string; count: number; firstAt: number; lastAt: number }
const addressUse = (r: Record<string, unknown>): AddressUse => ({ userId: String(r.user_id), ip: String(r.ip), count: Number(r.count), firstAt: Number(r.first_at), lastAt: Number(r.last_at) });

/** An account signed in or joined a game from this address. */
export function seenFrom(userId: string, ip: string | undefined) {
  if (!ip) return;
  const now = Date.now();
  qa.seen.run(userId, ip.replace(/^::ffff:/, ''), now, now);
  if (Math.random() < 0.01) qa.prune.run(now - KEEP_ADDRESSES_MS);
}

/** Where one account has been used from, most recent first. */
export const addressesOf = (userId: string) => (qa.of.all(userId) as Record<string, unknown>[]).map(addressUse);
/** Addresses more than one account has used (a household, or a shared account), by address. */
export const sharedAddresses = () => (qa.shared.all() as Record<string, unknown>[]).map(addressUse);

// ------------------------------------------------------------------------------------ activity

db.exec(`
  -- What accounts did, one row per event (see Activity).
  CREATE TABLE IF NOT EXISTS activity (
    at INTEGER NOT NULL, user_id TEXT NOT NULL, event TEXT NOT NULL, world_id TEXT, adventure_id TEXT, detail TEXT NOT NULL
  );
  CREATE INDEX IF NOT EXISTS activity_user ON activity (user_id, at);
`);
const qv = {
  add: db.prepare('INSERT INTO activity (at, user_id, event, world_id, adventure_id, detail) VALUES (?, ?, ?, ?, ?, ?)'),
  prune: db.prepare('DELETE FROM activity WHERE at < ?'),
  of: db.prepare('SELECT * FROM activity WHERE user_id = ? ORDER BY at DESC LIMIT ?'),
  all: db.prepare('SELECT * FROM activity WHERE at >= ? ORDER BY at'),
};
const KEEP_ACTIVITY_MS = 2 * 365 * 86_400_000;

type ActivityEvent =
  | 'signed in'
  | 'world started' // a build was asked for
  | 'world built'
  | 'world failed'
  | 'world deleted'
  | 'adventure started'
  | 'adventure shared' // a player was given a place in it
  | 'heroes made'
  | 'adventure deleted'
  | 'played'; // one game connection, from joining to leaving
export interface Activity { at: number; userId: string; event: ActivityEvent; worldId?: string; adventureId?: string; detail: Fields }

/** Something an account did: logged, and kept for counting later. `detail` holds ids and numbers, never what anyone typed. */
export function activity(event: ActivityEvent, userId: string, ids: { world?: string; adventure?: string } = {}, detail: Fields = {}) {
  write('info', event, { user: userId, world: ids.world, adventure: ids.adventure, ...detail });
  try {
    const now = Date.now();
    qv.add.run(now, userId, event, ids.world ?? null, ids.adventure ?? null, JSON.stringify(clean(detail)));
    if (Math.random() < 0.01) qv.prune.run(now - KEEP_ACTIVITY_MS);
  } catch (e) {
    warn('activity not kept', { event, message: (e as Error).message });
  }
}

const activityRow = (r: Record<string, unknown>): Activity => ({
  at: Number(r.at), userId: String(r.user_id), event: r.event as ActivityEvent,
  worldId: (r.world_id as string | null) ?? undefined, adventureId: (r.adventure_id as string | null) ?? undefined, detail: JSON.parse(String(r.detail)) as Fields,
});
/** One account's latest activity, newest first. */
export const activityOf = (userId: string, limit = 50) => (qv.of.all(userId, limit) as Record<string, unknown>[]).map(activityRow);
/** Everyone's activity since a time, oldest first. */
export const activitySince = (since: number) => (qv.all.all(since) as Record<string, unknown>[]).map(activityRow);

// ------------------------------------------------------------------------------------ numbers

export interface HourStats {
  /** The hour's start. */
  at: number;
  requests: number;
  failed: number;
  slow: number;
  signIns: number;
  /** Game connections opened. */
  joins: number;
  /** Errors reported here (this process's own, and players' browsers'). */
  errors: number;
  playersOnline: number;
  adventuresRunning: number;
  rssMb: number;
}

const counts = { requests: 0, failed: 0, slow: 0, signIns: 0, joins: 0, errors: 0 };
export const count = (k: keyof typeof counts) => void counts[k]++;
const hours: HourStats[] = [];
let hourStart = Date.now();
let live: () => { playersOnline: number; adventuresRunning: number } = () => ({ playersOnline: 0, adventuresRunning: 0 });

function snapshot(): HourStats {
  return { at: hourStart, ...counts, ...live(), rssMb: Math.round(process.memoryUsage().rss / 1e6) };
}

/** The server's numbers: an hourly log line, and the last day of hours for the Errors page. */
export function startStats(now: () => { playersOnline: number; adventuresRunning: number }) {
  live = now;
  setInterval(() => {
    const h = snapshot();
    log('stats', { ...h, at: undefined });
    hours.push(h);
    if (hours.length > 24) hours.shift();
    Object.keys(counts).forEach((k) => (counts[k as keyof typeof counts] = 0));
    hourStart = Date.now();
  }, 3600_000).unref();
}

export function statsReport() {
  return { startedAt, current: snapshot(), hours: [...hours].reverse() };
}
