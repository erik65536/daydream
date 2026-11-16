/**
 * Adventure storage: one SQLite file per adventure, holding the state split into sections.
 *
 * The parts of an adventure that keep growing over a campaign (journal, conversations, NPC memories, explored maps,
 * per-zone runtime, each player) rarely change between autosaves, so each section is stored as its own row and an autosave
 * writes only the rows whose content changed, all in one transaction.
 */
import fs from 'node:fs';
import crypto from 'node:crypto';
import zlib from 'node:zlib';
import { DatabaseSync } from 'node:sqlite';
import type { AdventureState, PlayerState } from '@daydream/shared';

const SCHEMA = `
  CREATE TABLE IF NOT EXISTS sections (key TEXT PRIMARY KEY, hash TEXT NOT NULL, data BLOB NOT NULL);
  CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
`;

/** Split a state into independently stored sections. Keys are stable so unchanged sections are skipped. */
function splitState(s: AdventureState): Map<string, unknown> {
  const out = new Map<string, unknown>();
  const { players, npcs, zones, journal, conversations, explored, ...core } = s;
  out.set('core', { ...core, players: Object.keys(players), npcs: Object.keys(npcs), zones: Object.keys(zones), conversations: Object.keys(conversations), explored: Object.keys(explored) });
  out.set('journal', journal);
  for (const [npcId, turns] of Object.entries(conversations)) out.set(`conv:${npcId}`, turns);
  for (const [zoneId, bits] of Object.entries(explored)) out.set(`explored:${zoneId}`, bits);
  for (const [uid, p] of Object.entries(players)) out.set(`player:${uid}`, p);
  for (const [id, n] of Object.entries(npcs)) out.set(`npc:${id}`, n);
  for (const [id, z] of Object.entries(zones)) out.set(`zone:${id}`, z);
  return out;
}

type Core = Omit<AdventureState, 'players' | 'npcs' | 'zones' | 'journal' | 'conversations' | 'explored'> & { players: string[]; npcs: string[]; zones: string[]; conversations: string[]; explored: string[] };

function joinState(get: (key: string) => unknown): AdventureState | null {
  const core = get('core') as Core | undefined;
  if (!core) return null;
  const collect = <T>(ids: string[], prefix: string) => {
    const out: Record<string, T> = {};
    for (const id of ids) {
      const v = get(`${prefix}:${id}`) as T | undefined;
      if (v !== undefined) out[id] = v;
    }
    return out;
  };
  return {
    ...core,
    players: collect<PlayerState>(core.players, 'player'),
    npcs: collect<AdventureState['npcs'][string]>(core.npcs, 'npc'),
    zones: collect<AdventureState['zones'][string]>(core.zones, 'zone'),
    conversations: collect<AdventureState['conversations'][string]>(core.conversations, 'conv'),
    explored: collect<string>(core.explored, 'explored'),
    journal: (get('journal') as AdventureState['journal']) ?? [],
  };
}

export class AdventureFile {
  private db: DatabaseSync;
  /** Hash of each stored section, so a save only writes what changed. */
  private hashes = new Map<string, string>();
  readonly file: string;

  constructor(file: string) {
    this.file = file;
    this.db = new DatabaseSync(file, { timeout: 10_000 });
    this.db.exec('PRAGMA busy_timeout = 10000');
    // Rollback journal (not WAL) keeps a save a single file; FULL sync makes each save durable.
    this.db.exec(`PRAGMA journal_mode = DELETE; PRAGMA synchronous = FULL; ${SCHEMA}`);
    for (const r of this.db.prepare('SELECT key, hash FROM sections').all() as { key: string; hash: string }[]) this.hashes.set(r.key, r.hash);
  }

  /** Write changed sections and delete vanished ones in one transaction. Returns how many rows were written. */
  save(s: AdventureState): number {
    const sections = splitState(s);
    const upsert = this.db.prepare('INSERT INTO sections (key, hash, data) VALUES (?, ?, ?) ON CONFLICT(key) DO UPDATE SET hash = excluded.hash, data = excluded.data');
    const del = this.db.prepare('DELETE FROM sections WHERE key = ?');
    const next = new Map<string, string>();
    let written = 0;
    this.db.exec('BEGIN IMMEDIATE');
    try {
      for (const [key, value] of sections) {
        const json = JSON.stringify(value);
        const hash = crypto.createHash('sha1').update(json).digest('base64');
        next.set(key, hash);
        if (this.hashes.get(key) === hash) continue;
        upsert.run(key, hash, zlib.deflateSync(json, { level: 1 }));
        written++;
      }
      for (const key of this.hashes.keys()) if (!next.has(key)) del.run(key);
      this.db.exec('COMMIT');
    } catch (e) {
      this.db.exec('ROLLBACK');
      throw e;
    }
    this.hashes = next;
    return written;
  }

  load(): AdventureState | null {
    const rows = new Map<string, Uint8Array>();
    for (const r of this.db.prepare('SELECT key, data FROM sections').all() as { key: string; data: Uint8Array }[]) rows.set(r.key, r.data);
    return joinState((key) => {
      const b = rows.get(key);
      return b ? JSON.parse(zlib.inflateSync(b).toString('utf8')) : undefined;
    });
  }

  /** Consistent copy of the whole save into a new file (used for exports and backups). */
  copyTo(file: string) {
    fs.rmSync(file, { force: true });
    this.db.prepare('VACUUM INTO ?').run(file);
  }

  close() {
    this.db.close();
  }
}
