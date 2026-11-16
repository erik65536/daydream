/**
 * The players of a playtest, and how their browsers are signed in without a password.
 *
 * Player 1 is the checkout's test administrator from data/dev.json (written by `npm run setup`). Players 2 to 6 are
 * accounts the harness makes in this checkout's own database (`tester2` …), administrators too so their agents can
 * use the developer commands. Each is signed in by a session made here and set as the session cookie in that
 * player's own browser context: no one types a password.
 *
 * Only for a worktree set up with `npm run setup`, whose game runs on this computer: data/dev.json must exist and its
 * addresses must be local.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DATA_DIR } from '../paths.ts';
import * as store from '../storage.ts';
import { PLAYTEST_DIR } from './files.ts';

/** What `npm run setup` wrote for this checkout (only the fields the harness reads). */
export interface Dev {
  urls: { game: string; server: string };
  username: string;
  cookie: { name: string; value: string };
}

export interface Player {
  n: number;
  userId: string;
  username: string;
  displayName: string;
  /** The session cookie to set in this player's browser. */
  cookie: { name: string; value: string };
}

export const MAX_PLAYERS = 6;

const LOCAL = new Set(['localhost', '127.0.0.1', '[::1]']);

export function readDev(): Dev {
  const file = path.join(DATA_DIR, 'dev.json');
  let dev: Dev;
  try {
    dev = JSON.parse(fs.readFileSync(file, 'utf8')) as Dev;
  } catch {
    throw new Error(`No ${file}: run "npm run setup" in this worktree first (it makes the test account and its session).`);
  }
  for (const url of [dev.urls.game, dev.urls.server])
    if (!LOCAL.has(new URL(url).hostname)) throw new Error(`The playtest harness only signs in to a game on this computer, not ${url}.`);
  return dev;
}

/** Sessions the harness made for players 2 and up, kept while they are still signed in. */
const sessionsFile = () => path.join(PLAYTEST_DIR, 'sessions.json');

function savedSessions(): Record<string, string> {
  try {
    return JSON.parse(fs.readFileSync(sessionsFile(), 'utf8')) as Record<string, string>;
  } catch {
    return {};
  }
}

/** Player n, made and signed in when needed. */
export function player(n: number, dev: Dev): Player {
  if (!Number.isInteger(n) || n < 1 || n > MAX_PLAYERS) throw new Error(`A player is a number from 1 to ${MAX_PLAYERS}.`);
  if (n === 1) {
    const u = store.sessionUser(dev.cookie.value);
    if (!u) throw new Error('The session in data/dev.json is no longer signed in: run "npm run setup" again.');
    return { n, userId: u.id, username: u.username ?? dev.username, displayName: u.displayName, cookie: dev.cookie };
  }
  const username = `tester${n}`;
  let u = store.findUser(username);
  if (!u) {
    u = store.createUser({ displayName: `Tester ${n}` });
    store.claimInvite(u.id, { username });
    store.activateUser(u.id);
  }
  if (!u.isAdmin) store.setAdmin(u.id, true);
  const sessions = savedSessions();
  let token = sessions[username];
  if (store.sessionUser(token)?.id !== u.id) {
    token = store.createSession(u.id);
    fs.mkdirSync(PLAYTEST_DIR, { recursive: true });
    fs.writeFileSync(sessionsFile(), JSON.stringify({ ...sessions, [username]: token }, null, 2));
  }
  u = store.getUser(u.id)!;
  return { n, userId: u.id, username, displayName: u.displayName, cookie: { name: dev.cookie.name, value: token } };
}
