/**
 * A snapshot of everything worth keeping, taken while the game runs (the nightly timer in deploy/systemd).
 *
 *   node src/cli/backup.ts              take tonight's snapshot, then drop the ones no longer kept
 *   node src/cli/backup.ts list         the snapshots there are, with their sizes
 *
 * A snapshot is a folder <backups>/<YYYY-MM-DD>/ laid out like the data folder, ready to copy back (docs/hosting.md):
 *
 *   daydream.sqlite              accounts, the world and adventure catalog, jobs, errors, and activity (a consistent
 *                                copy made by SQLite, safe while the server writes)
 *   adventures/<id>.sqlite       every adventure, the same way
 *   worlds/<id>/…, trash/<id>/…  the worlds and the trash: files unchanged since the last snapshot are hard links to
 *                                it, so a night costs only what changed (a world's art is written once)
 *
 * Not kept: cache/ (made again when needed), logs/ (model-call logs), and backups themselves.
 * Kept: every snapshot of the last 14 days, and the first of each month for a year.
 *
 * The backups folder is DAYDREAM_BACKUP_DIR (production: its own folder on the same disk), else data/backups/.
 */
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { DATA_DIR } from '../paths.ts';

const BACKUP_DIR = process.env.DAYDREAM_BACKUP_DIR ? path.resolve(process.env.DAYDREAM_BACKUP_DIR) : path.join(DATA_DIR, 'backups');
const KEEP_DAYS = 14;
const KEEP_MONTHS = 12;
const SNAPSHOT = /^\d{4}-\d{2}-\d{2}$/;

/** The server's own calendar day (a night's snapshot is named for the day it was taken). */
const today = () => new Date().toLocaleDateString('sv');
const snapshots = () => (fs.existsSync(BACKUP_DIR) ? fs.readdirSync(BACKUP_DIR).filter((n) => SNAPSHOT.test(n)).sort() : []);

/** A consistent copy of a live SQLite database (WAL included). */
function copyDb(from: string, to: string) {
  fs.mkdirSync(path.dirname(to), { recursive: true });
  const db = new DatabaseSync(from, { readOnly: true, timeout: 30_000 });
  try {
    db.exec(`VACUUM INTO '${to.replace(/'/g, "''")}'`);
  } finally {
    db.close();
  }
}

/** Copy a folder, hard-linking each file the previous snapshot has unchanged (same size and time). */
function copyTree(from: string, to: string, prev: string | null, stats: { linked: number; copied: number; bytes: number }) {
  if (!fs.existsSync(from)) return;
  fs.mkdirSync(to, { recursive: true });
  for (const e of fs.readdirSync(from, { withFileTypes: true })) {
    const src = path.join(from, e.name), dst = path.join(to, e.name), old = prev && path.join(prev, e.name);
    if (e.isDirectory()) {
      copyTree(src, dst, old, stats);
      continue;
    }
    if (!e.isFile()) continue;
    if (e.name.endsWith('.sqlite')) {
      copyDb(src, dst); // a trashed world's adventures
      stats.copied++;
      continue;
    }
    if (e.name.endsWith('.sqlite-wal') || e.name.endsWith('.sqlite-shm')) continue;
    const s = fs.statSync(src);
    const o = old ? fs.statSync(old, { throwIfNoEntry: false }) : undefined;
    if (o && o.size === s.size && Math.abs(o.mtimeMs - s.mtimeMs) < 1) {
      fs.linkSync(old!, dst);
      stats.linked++;
    } else {
      fs.copyFileSync(src, dst);
      fs.utimesSync(dst, s.atime, s.mtime); // so tomorrow's snapshot sees it unchanged
      stats.copied++;
      stats.bytes += s.size;
    }
  }
}

function snapshot() {
  const name = today();
  const done = path.join(BACKUP_DIR, name);
  if (fs.existsSync(done)) return console.log(`Today's snapshot ${done} is already there.`);
  const prevName = snapshots().at(-1);
  const prev = prevName ? path.join(BACKUP_DIR, prevName) : null;
  // Written beside its final name and renamed when complete: a folder named by its date is a whole snapshot.
  const work = `${done}.partial`;
  fs.rmSync(work, { recursive: true, force: true });
  fs.mkdirSync(work, { recursive: true });
  const t0 = Date.now();
  const stats = { linked: 0, copied: 0, bytes: 0 };
  copyDb(path.join(DATA_DIR, 'daydream.sqlite'), path.join(work, 'daydream.sqlite'));
  const advDir = path.join(DATA_DIR, 'adventures');
  let adventures = 0;
  for (const f of fs.existsSync(advDir) ? fs.readdirSync(advDir) : []) {
    if (!f.endsWith('.sqlite')) continue;
    copyDb(path.join(advDir, f), path.join(work, 'adventures', f));
    adventures++;
  }
  for (const dir of ['worlds', 'trash']) copyTree(path.join(DATA_DIR, dir), path.join(work, dir), prev && path.join(prev, dir), stats);
  fs.renameSync(work, done);
  console.log(
    `Snapshot ${done}: the database, ${adventures} adventures, worlds, and trash (${stats.copied} files copied, ${(stats.bytes / 1e6).toFixed(1)} MB; ` +
      `${stats.linked} unchanged files linked to ${prevName ?? 'nothing'}) in ${((Date.now() - t0) / 1000).toFixed(1)} s.`,
  );
}

/** Every snapshot of the last KEEP_DAYS days, and the first one of each of the last KEEP_MONTHS months. */
function prune() {
  const all = snapshots();
  const now = Date.now();
  const firstOfMonth = new Map<string, string>();
  for (const n of all) if (!firstOfMonth.has(n.slice(0, 7))) firstOfMonth.set(n.slice(0, 7), n);
  const months = [...firstOfMonth.values()].slice(-KEEP_MONTHS);
  for (const n of all) {
    const age = (now - Date.parse(`${n}T00:00:00Z`)) / 86_400_000;
    if (age <= KEEP_DAYS || months.includes(n)) continue;
    fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });
    console.log(`Removed the snapshot of ${n}.`);
  }
  // A snapshot interrupted on another day.
  for (const n of fs.readdirSync(BACKUP_DIR)) if (n.endsWith('.partial') && !n.startsWith(today())) fs.rmSync(path.join(BACKUP_DIR, n), { recursive: true, force: true });
}

/** Sizes as a snapshot adds them (a file linked from the one before counts once, for the first). */
function list() {
  const seen = new Set<string>();
  const walk = (dir: string): number => {
    let bytes = 0;
    for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
      const p = path.join(dir, e.name);
      if (e.isDirectory()) bytes += walk(p);
      else {
        const s = fs.statSync(p, { bigint: true });
        const id = `${s.dev}:${s.ino}`;
        if (s.ino && seen.has(id)) continue;
        seen.add(id);
        bytes += Number(s.size);
      }
    }
    return bytes;
  };
  console.log(`Snapshots in ${BACKUP_DIR}:`);
  for (const n of snapshots()) console.log(`  ${n}  ${(walk(path.join(BACKUP_DIR, n)) / 1e6).toFixed(1).padStart(9)} MB new`);
}

const cmd = process.argv[2];
if (cmd === 'list') list();
else if (!cmd) {
  fs.mkdirSync(BACKUP_DIR, { recursive: true });
  snapshot();
  prune();
} else console.log('usage: backup [list]');
