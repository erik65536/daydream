/**
 * Carry a world from one machine to another (development and production) as a single file, so a world built once
 * (hours of GPU) can be played elsewhere, and a world from production can be brought home to fix a bug in it.
 *
 *   node src/cli/worldpack.ts export <worldId> <file.worldpack> [--adventures] [--rigs] [--draft]
 *   node src/cli/worldpack.ts import <file.worldpack> --owner <username> [--replace]
 *
 * A pack holds the world (world.json, its art, its voices, its sounds, and its build records) and, with --adventures, its adventures. --rigs adds the animation's painting
 * steps (only needed to animate again without painting what is done), --draft the build's intermediate steps (only
 * needed to lay places out again).
 *
 * On import the world belongs to --owner. Adventures keep their players: each is given to the account of the same name
 * here, or to the owner when there is none. A world or adventure already here is left alone unless --replace.
 *
 * The file is a gzipped tar made and read with the system's tar (Windows 10+, Linux, macOS); it is checked before
 * anything is copied in: only a world, its adventures, and a manifest, no links, no paths out of it.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import type { AdventureState, WorldDefinition } from '@daydream/shared';
import { findUser, getUser, listAdventures, loadAdventure, loadWorld, saveAdventure, saveWorld, worldDir, type User } from '../storage.ts';

interface Manifest {
  format: 1;
  worldId: string;
  title: string;
  exportedAt: number;
  /** User ids found in the adventures, and their account names (to find the same people on the other machine). */
  users: Record<string, string>;
  adventures: string[];
}

const args = process.argv.slice(2);
const flag = (name: string) => args.includes(name);
const option = (name: string) => {
  const i = args.indexOf(name);
  return i >= 0 ? args[i + 1] : undefined;
};

/**
 * Run tar inside `dir`, the archive streamed through a file Node opens: tar is never given a path, so a Windows
 * drive letter cannot be read as a remote host (as Git Bash's GNU tar does).
 */
function tar(mode: 'pack' | 'unpack', dir: string, file: string) {
  const fd = fs.openSync(file, mode === 'pack' ? 'w' : 'r');
  try {
    const r = spawnSync('tar', mode === 'pack' ? ['-cz', '.'] : ['-xz'], { cwd: dir, stdio: mode === 'pack' ? ['ignore', fd, 'inherit'] : [fd, 'inherit', 'inherit'] });
    if (r.error || r.status !== 0) throw new Error(`tar failed${r.error ? `: ${r.error.message}` : ''}`);
  } finally {
    fs.closeSync(fd);
  }
}

function exportWorld(worldId: string, out: string) {
  const w = loadWorld(worldId);
  if (!w) throw new Error(`No world "${worldId}".`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpack-'));
  try {
    const src = worldDir(worldId), dst = path.join(tmp, 'world');
    fs.mkdirSync(dst);
    fs.copyFileSync(path.join(src, 'world.json'), path.join(dst, 'world.json'));
    for (const [dir, wanted] of [['assets', true], ['metrics', true], ['anim', flag('--rigs')], ['draft', flag('--draft')]] as const)
      if (wanted && fs.existsSync(path.join(src, dir))) fs.cpSync(path.join(src, dir), path.join(dst, dir), { recursive: true });
    const users: Record<string, string> = {};
    const adventures: string[] = [];
    if (flag('--adventures')) {
      fs.mkdirSync(path.join(tmp, 'adventures'));
      for (const s of listAdventures(worldId)) {
        fs.writeFileSync(path.join(tmp, 'adventures', `${s.id}.json`), JSON.stringify(s));
        adventures.push(s.id);
        // Everyone with a place in it, whether or not they have made heroes yet.
        for (const uid of [s.ownerId, ...s.members, ...Object.keys(s.players)]) users[uid] = getUser(uid)?.username ?? uid;
      }
    }
    const manifest: Manifest = { format: 1, worldId, title: w.concept.title, exportedAt: Date.now(), users, adventures };
    fs.writeFileSync(path.join(tmp, 'manifest.json'), JSON.stringify(manifest, null, 2));
    tar('pack', tmp, out);
    console.log(`Packed "${w.concept.title}" (${worldId}) with ${adventures.length} adventure(s) into ${out} (${(fs.statSync(out).size / 1e6).toFixed(1)} MB).`);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

/** Every path under `root` (relative, with forward slashes); throws on a link or anything but files and folders. */
function walk(root: string, rel = ''): string[] {
  const out: string[] = [];
  for (const name of fs.readdirSync(path.join(root, rel))) {
    const r = rel ? `${rel}/${name}` : name;
    const st = fs.lstatSync(path.join(root, r));
    if (st.isSymbolicLink() || !(st.isFile() || st.isDirectory())) throw new Error(`The pack holds something that is not a plain file: ${r}`);
    out.push(r);
    if (st.isDirectory()) out.push(...walk(root, r));
  }
  return out;
}

/**
 * Add a world from its folder (world.json and the parts a pack carries) to this machine's, owned by `owner`. A world
 * already here is left alone unless `replace`. Also used by `npm run setup` (setup.ts) on the main checkout's worlds.
 */
export function addWorld(src: string, owner: User, replace: boolean, parts = ['assets', 'metrics', 'anim', 'draft']) {
  const w = JSON.parse(fs.readFileSync(path.join(src, 'world.json'), 'utf8')) as WorldDefinition;
  const dest = worldDir(w.id);
  if (fs.existsSync(dest) && !replace) return void console.log(`"${w.concept.title}" (${w.id}) is already here: kept as it is (--replace to overwrite it).`);
  fs.rmSync(dest, { recursive: true, force: true });
  fs.mkdirSync(dest, { recursive: true });
  fs.copyFileSync(path.join(src, 'world.json'), path.join(dest, 'world.json'));
  for (const dir of parts) if (fs.existsSync(path.join(src, dir))) fs.cpSync(path.join(src, dir), path.join(dest, dir), { recursive: true });
  w.ownerId = owner.id;
  w.ownerName = owner.displayName;
  saveWorld(w);
  console.log(`Added "${w.concept.title}" (${w.id}), owned by ${owner.username}.`);
}

function importWorld(file: string) {
  const ownerName = option('--owner');
  const owner = ownerName ? findUser(ownerName) : undefined;
  if (!owner) throw new Error(`Name the account the world will belong to: --owner <username>${ownerName ? ` (no account "${ownerName}")` : ''}.`);
  const replace = flag('--replace');
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'worldpack-'));
  try {
    tar('unpack', tmp, file);
    const allowed = /^(manifest\.json|world(\/(world\.json|(assets|metrics|anim|draft)(\/[\w.@-]+)*))?|adventures(\/[\w-]+\.json)?)$/;
    for (const r of walk(tmp)) if (!allowed.test(r)) throw new Error(`Not a world pack (unexpected ${r}).`);
    const manifest = JSON.parse(fs.readFileSync(path.join(tmp, 'manifest.json'), 'utf8')) as Manifest;
    const w = JSON.parse(fs.readFileSync(path.join(tmp, 'world', 'world.json'), 'utf8')) as WorldDefinition;
    if (manifest.format !== 1 || !/^w_[a-z0-9]+$/i.test(w.id) || w.id !== manifest.worldId) throw new Error('Not a world pack (its manifest and world do not match).');

    addWorld(path.join(tmp, 'world'), owner, replace);

    // Each player in the adventures becomes the account of the same name here, or the owner.
    const ids = new Map(Object.entries(manifest.users).map(([uid, name]) => [uid, findUser(name)?.id ?? owner.id]));
    for (const id of manifest.adventures) {
      if (!/^[\w-]+$/.test(id)) continue;
      if (loadAdventure(id) && !replace) {
        console.log(`Adventure ${id} is already here: kept as it is.`);
        continue;
      }
      let text = fs.readFileSync(path.join(tmp, 'adventures', `${id}.json`), 'utf8');
      for (const [from, to] of ids) text = text.split(from).join(to);
      const s = JSON.parse(text) as AdventureState;
      if (s.id !== id || s.worldId !== w.id) throw new Error(`Adventure ${id} does not belong to this world.`);
      // Players who became the same account here (the owner, for those with none) hold one place between them.
      s.members = [...new Set(s.members)].filter((m) => m !== s.ownerId);
      saveAdventure(s);
      console.log(`Added adventure "${s.name}" (${id}) for ${[...new Set(Object.keys(s.players).map((u) => getUser(u)?.username ?? u))].join(', ')}.`);
    }
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

// Run as a tool (setup.ts imports addWorld).
if (import.meta.main) {
  const [cmd, a, b] = args;
  if (cmd === 'export' && a && b) exportWorld(a, b);
  else if (cmd === 'import' && a) importWorld(a);
  else console.log('usage: worldpack export <worldId> <file.worldpack> [--adventures] [--rigs] [--draft] | import <file.worldpack> --owner <username> [--replace]');
}
