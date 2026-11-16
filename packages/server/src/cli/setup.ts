/**
 * Set up a worktree to run and test the game: `npm run setup` from its root, again any time (it keeps what is
 * still right).
 *
 *   npm run setup                         ports, the test administrator, a signed-in session
 *   npm run setup -- --world <id|title>   also copy a world from the main checkout (`--world` alone lists them)
 *
 * 1. Ports. The worktree takes the lowest free slot n (1, 2, …) no other worktree holds: the server on 3000 + 10 n,
 *    the game (Vite) on 5173 + 10 n, the pipeline editor on 5190 + 10 n. `npm run dev` and `npm run designer` use
 *    them (checkout.ts), and the session cookie is named after the server's port, so checkouts on localhost do not
 *    sign each other out. The worktree's .claude/launch.json gets the same ports and is marked skip-worktree, so git
 *    neither shows nor commits the change.
 * 2. The test administrator, from config/dev-test-account.json (the main checkout's when the worktree has none; one
 *    with a random password is made here when neither has it). The password is never printed.
 * 3. A session for tools, kept while it is valid. data/dev.json then holds the addresses, the session cookie (name
 *    and value) for scripts, and `signIn`: opened in a browser while `npm run dev` runs, it signs that browser in.
 * 4. With --world, a world copied from the main checkout's data (only read there), owned by the test administrator.
 *
 * Only in a worktree: the main checkout's data (and production's) is real and is never touched. A worktree's
 * secrets, models and installed dependencies are the main checkout's, read in place (checkout.ts); setup copies none,
 * but links the worktree's own packages into its node_modules, so its tools run its own shared code.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { describePath, devFile, IS_WORKTREE, linkWorkspaces, MAIN_ROOT, ownOrMain, readDev, ROOT_DIR, sessionCookie, slotPorts, type DevInfo, type Ports } from '../checkout.ts';

if (!IS_WORKTREE) {
  console.error('npm run setup is for a worktree: this is the main checkout (or production), whose data is real. Run it in a worktree under .claude/worktrees/.');
  process.exit(1);
}
if (process.env.DAYDREAM_DATA_DIR && path.resolve(process.env.DAYDREAM_DATA_DIR) !== path.join(ROOT_DIR, 'data')) {
  console.error('npm run setup sets up the worktree\'s own data/: unset DAYDREAM_DATA_DIR.');
  process.exit(1);
}

const args = process.argv.slice(2);
const git = (...a: string[]) => execFileSync('git', a, { cwd: ROOT_DIR, encoding: 'utf8' });

// ------------------------------------------------------------------------------------ ports

const free = (port: number) =>
  new Promise<boolean>((resolve) => {
    const s = net.createServer().once('error', () => resolve(false));
    s.listen(port, () => s.close(() => resolve(true)));
  });

/** Slots the other worktrees hold (their data/dev.json). */
function takenSlots(): Set<number> {
  const roots = git('worktree', 'list', '--porcelain').split('\n').filter((l) => l.startsWith('worktree ')).map((l) => path.resolve(l.slice(9).trim()));
  return new Set(roots.filter((r) => r !== ROOT_DIR).map((r) => readDev(r)?.slot ?? 0).filter((n) => n > 0));
}

/** This worktree's slot: the one it has unless another took it, else the lowest one held by none and free now. */
async function chooseSlot(): Promise<number> {
  const taken = takenSlots();
  const had = readDev()?.slot;
  if (had && !taken.has(had)) return had;
  for (let n = 1; n < 100; n++) {
    if (taken.has(n)) continue;
    const p = slotPorts(n);
    if ((await free(p.server)) && (await free(p.client)) && (await free(p.designer))) return n;
  }
  throw new Error('No free slot for ports (1 to 99).');
}

/** The committed .claude/launch.json with this worktree's ports, kept out of git's sight (skip-worktree). */
function writeLaunch(p: Ports) {
  const file = path.join(ROOT_DIR, '.claude', 'launch.json');
  const ours: Record<string, number> = { 3000: p.server, 5173: p.client, 5190: p.designer };
  const launch = git('show', 'HEAD:.claude/launch.json').replace(/("port":\s*)(\d+)/g, (m, key: string, port: string) => (ours[port] ? `${key}${ours[port]}` : m));
  git('update-index', '--skip-worktree', '.claude/launch.json');
  fs.writeFileSync(file, launch);
}

// ------------------------------------------------------------------------------------ the test administrator

/** The test account's name and password: config/dev-test-account.json (this worktree's or the main checkout's), else a new one here. */
function testAccount(): { username: string; password: string } {
  const file = ownOrMain('config/dev-test-account.json');
  if (fs.existsSync(file)) return JSON.parse(fs.readFileSync(file, 'utf8')) as { username: string; password: string };
  const account = { _comment: 'The local test administrator (npm run setup). Git-ignored: never commit it.', username: 'tester', password: crypto.randomBytes(18).toString('base64url') };
  fs.writeFileSync(file, `${JSON.stringify(account, null, 2)}\n`);
  console.log(`Made a test account in ${path.relative(ROOT_DIR, file)} (git-ignored).`);
  return account;
}

// ------------------------------------------------------------------------------------ setup

const slot = await chooseSlot();
const p = slotPorts(slot);
writeLaunch(p);

// The game's code imports @daydream/shared: the worktree's own, linked before anything loads it (console tools too).
linkWorkspaces();
// The game's storage opens the database on import: only now, inside the worktree's own data/.
const store = await import('../storage.ts');
const { addWorld } = await import('./worldpack.ts');

const account = testAccount();
let user = store.findUser(account.username);
if (!user) {
  const invited = store.createUser({ displayName: account.username });
  store.claimInvite(invited.id, { username: account.username });
  store.setPassword(invited.id, account.password);
  store.activateUser(invited.id);
  user = store.getUser(invited.id)!;
  console.log(`Made the test administrator "${account.username}".`);
}
if (!store.checkPassword(user, account.password)) store.setPassword(user.id, account.password);
store.unlockUser(user.id);
if (user.status !== 'active') store.activateUser(user.id);
if (!store.getUser(user.id)!.isAdmin) store.setAdmin(user.id, true);
user = store.getUser(user.id)!;

const cookie = sessionCookie(p.server);
const had = readDev()?.cookie.value;
const token = had && store.sessionUser(had)?.id === user.id ? had : store.createSession(user.id);

// A world from the main checkout: its folder is only read.
const worldArg = args.indexOf('--world');
if (worldArg >= 0) {
  const worldsDir = path.join(MAIN_ROOT, 'data', 'worlds');
  const worlds = (fs.existsSync(worldsDir) ? fs.readdirSync(worldsDir) : []).flatMap((id) => {
    try {
      const w = JSON.parse(fs.readFileSync(path.join(worldsDir, id, 'world.json'), 'utf8')) as { id: string; concept: { title: string } };
      return [{ id: w.id, title: w.concept.title, dir: path.join(worldsDir, id) }];
    } catch {
      return [];
    }
  });
  const wanted = args[worldArg + 1]?.toLowerCase();
  const found = wanted ? worlds.filter((w) => w.id.toLowerCase() === wanted || w.title.toLowerCase().includes(wanted)) : [];
  if (found.length === 1) addWorld(found[0].dir, user, true, ['assets', 'metrics']);
  else {
    console.log(wanted ? `${found.length ? 'Several' : 'No'} worlds in the main checkout match "${wanted}". They are:` : 'The main checkout\'s worlds:');
    for (const w of worlds) console.log(`  ${w.id}  ${w.title}`);
  }
}

const urls = { game: `http://localhost:${p.client}`, server: `http://localhost:${p.server}`, designer: `http://localhost:${p.designer}` };
const info: DevInfo = {
  slot, ports: p, urls, username: user.username!, cookie: { name: cookie, value: token },
  signIn: `${urls.game}/api/dev/sign-in?token=${token}`,
};
fs.mkdirSync(path.dirname(devFile()), { recursive: true });
fs.writeFileSync(devFile(), `${JSON.stringify(info, null, 2)}\n`);

console.log(`
This worktree is set up (slot ${slot}).
  game        ${urls.game}   (npm run dev; the preview's "game" in .claude/launch.json)
  server      ${urls.server}
  editor      ${urls.designer}   (npm run designer)
  signed in   as the administrator "${user.username}": open data/dev.json's "signIn" in a browser, or send its
              "cookie" (name=value) from a script.
  models      ${describePath(ownOrMain('config/genai.json'))}${fs.existsSync(ownOrMain('.env')) ? `, keys in ${describePath(ownOrMain('.env'))}` : ''}`);
