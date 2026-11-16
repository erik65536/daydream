/**
 * This checkout of the repository: the main one, or a git worktree beside it (under .claude/worktrees/). Plain
 * Node with no imports from the game, so `npm run dev` (scripts/dev.mjs), the Vite config and the pipeline editor
 * read it too.
 *
 * A worktree has its own data/ but borrows the main checkout's secrets and installed models: a file a worktree
 * does not have itself (.env, config/genai.json, config/dev-test-account.json, models/) is read where it is in the
 * main checkout, never copied.
 *
 * `npm run setup` (cli/setup.ts) gives a worktree its own ports and writes them, with a signed-in session for
 * tools, to data/dev.json. Without that file a checkout runs on the usual ports.
 */
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/** Repository root of this checkout (two levels above packages/server/src). */
export const ROOT_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..', '..');

/**
 * The main checkout's root. In a worktree, .git is a file naming `<main>/.git/worktrees/<name>`; in the main
 * checkout (and a plain clone, as in production) it is the folder itself.
 */
function mainRoot(root: string): string {
  try {
    const m = /^gitdir:\s*(.+)$/m.exec(fs.readFileSync(path.join(root, '.git'), 'utf8'));
    if (m) return path.resolve(root, m[1].trim(), '..', '..', '..');
  } catch {
    /* .git is a folder, or there is none */
  }
  return root;
}
export const MAIN_ROOT = mainRoot(ROOT_DIR);
export const IS_WORKTREE = MAIN_ROOT !== ROOT_DIR;

/** A file or folder of this checkout (a path relative to the root), or the main checkout's when this one has none. */
export function ownOrMain(rel: string): string {
  const own = path.join(ROOT_DIR, rel);
  return IS_WORKTREE && !fs.existsSync(own) && fs.existsSync(path.join(MAIN_ROOT, rel)) ? path.join(MAIN_ROOT, rel) : own;
}

/**
 * Links this checkout's own packages into its node_modules (node_modules/@daydream/shared -> packages/shared, …).
 * A worktree has no install of its own: Node, tsc and Vite look upward for node_modules and find the main checkout's,
 * whose links lead to the main checkout's packages, so a worktree would run and typecheck main's shared code. Every
 * other dependency still comes from the main checkout. `npm run setup`, `npm run dev`, `npm run typecheck` and the
 * Vitest config call this first; in the main checkout (and production) npm's own links are already right.
 */
export function linkWorkspaces() {
  let changed = false;
  const read = (dir: string) => JSON.parse(fs.readFileSync(path.join(dir, 'package.json'), 'utf8'));
  for (const dir of read(ROOT_DIR).workspaces as string[]) {
    const target = path.join(ROOT_DIR, dir), link = path.join(ROOT_DIR, 'node_modules', read(target).name);
    let current = '';
    try {
      current = fs.realpathSync(link);
    } catch {
      /* no link yet, or a broken one */
    }
    if (current === fs.realpathSync(target)) continue;
    fs.rmSync(link, { force: true });
    fs.mkdirSync(path.dirname(link), { recursive: true });
    fs.symlinkSync(target, link, 'junction');
    changed = true;
  }
  // Vitest keeps each transformed file on disk with its imports already resolved, keyed by the file's content alone:
  // after a link changes, those resolutions lead to the old packages.
  if (changed) fs.rmSync(path.join(ROOT_DIR, 'node_modules', '.vitest-cache'), { recursive: true, force: true });
}

/** A path for people: relative to this checkout, or "the main checkout's …". */
export function describePath(file: string): string {
  const [base, prefix] = path.relative(ROOT_DIR, file).startsWith('..') ? [MAIN_ROOT, "the main checkout's "] : [ROOT_DIR, ''];
  return prefix + path.relative(base, file).split(path.sep).join('/');
}

export interface Ports {
  server: number;
  client: number;
  designer: number;
}
/** The main checkout's ports; a worktree's slot n (from `npm run setup`) adds 10 n to each. */
const DEFAULT_PORTS: Ports = { server: 3000, client: 5173, designer: 5190 };
export const slotPorts = (slot: number): Ports => ({ server: 3000 + 10 * slot, client: 5173 + 10 * slot, designer: 5190 + 10 * slot });

/** What `npm run setup` wrote for a checkout (data/dev.json): its ports and a signed-in session for tools. */
export interface DevInfo {
  slot: number;
  ports: Ports;
  /** The game in a browser (the Vite client), the server's API, the pipeline editor. */
  urls: { game: string; server: string; designer: string };
  /** The test administrator: their user name and a session, sent as the cookie `name=value` by tools. */
  username: string;
  cookie: { name: string; value: string };
  /** Opened in a browser, signs it in as the test administrator (only while `npm run dev` runs). */
  signIn: string;
}

/** A checkout's data/dev.json; this checkout's is in its data folder (DAYDREAM_DATA_DIR, as tests set). */
export const devFile = (root?: string) =>
  path.join(root ? path.join(root, 'data') : process.env.DAYDREAM_DATA_DIR ? path.resolve(process.env.DAYDREAM_DATA_DIR) : path.join(ROOT_DIR, 'data'), 'dev.json');

export function readDev(root?: string): DevInfo | null {
  try {
    return JSON.parse(fs.readFileSync(devFile(root), 'utf8')) as DevInfo;
  } catch {
    return null;
  }
}

/** This checkout's ports: the environment's DAYDREAM_PORT, DAYDREAM_CLIENT_PORT and DAYDREAM_DESIGNER_PORT, else data/dev.json's. */
export function ports(): Ports {
  const p = readDev()?.ports ?? DEFAULT_PORTS;
  const env = (name: string, fallback: number) => Number(process.env[name] || fallback);
  return { server: env('DAYDREAM_PORT', p.server), client: env('DAYDREAM_CLIENT_PORT', p.client), designer: env('DAYDREAM_DESIGNER_PORT', p.designer) };
}

/**
 * The session cookie's name. Cookies are shared by every port of a host, so a server off the usual port names its
 * own: checkouts running side by side on localhost do not sign each other out.
 */
export const sessionCookie = (serverPort: number) => (serverPort === DEFAULT_PORTS.server ? 'daydream_session' : `daydream_session_${serverPort}`);
