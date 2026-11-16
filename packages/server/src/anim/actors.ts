/**
 * Which of a world's sprites are actors to animate, and what each needs: everyone who fights (heroes, monsters,
 * bosses) gets every clip; townspeople, who never fight, only move.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { clipKey, type AssetRecord, type ClipName, type WorldDefinition } from '@daydream/shared';
import { worldAssetDir } from '../storage.ts';

/** The standing views of characters and creatures. */
export function actorSprites(w: WorldDefinition): AssetRecord[] {
  return Object.values(w.assets).filter((a) => a.kind === 'sprite' && a.status === 'ok' && !!a.file && a.key.startsWith('spr_'));
}

/** Whether an actor takes part in fights: anyone but a townsperson. */
export function fights(rec: AssetRecord): boolean {
  return !rec.key.startsWith('spr_npc_');
}

/** The painted view an actor's painting is: front (people and upright figures) or left profile (other bodies). */
export const ownView = (rec: AssetRecord): 'S' | 'W' => (rec.view === 'side' ? 'W' : 'S');

/** Hashes read, by file, with the file's time and size they were read at. */
const hashes = new Map<string, { at: number; size: number; hash: string }>();

/**
 * An actor's painting, told by its content: a repainted actor keeps its file name, so what was animated from the
 * earlier painting is known by this. Empty when the file cannot be read. The file is read once and again when it
 * changes.
 */
export function paintingHash(worldId: string, rec: AssetRecord): string {
  try {
    const file = path.join(worldAssetDir(worldId), rec.file!);
    const st = fs.statSync(file), known = hashes.get(file);
    if (known && known.at === st.mtimeMs && known.size === st.size) return known.hash;
    const hash = crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex').slice(0, 16);
    hashes.set(file, { at: st.mtimeMs, size: st.size, hash });
    return hash;
  } catch {
    return '';
  }
}

/**
 * Whether an actor's sheets are missing (any of them) or were made from an earlier painting (`anim.from` is the hash
 * of the painting they were made from).
 */
export const needsAnimation = (w: WorldDefinition, rec: AssetRecord) =>
  !rec.anim || rec.anim.from !== paintingHash(w.id, rec) || (Object.keys(rec.anim.clips) as ClipName[]).some((c) => !w.assets[clipKey(rec.key, c)]?.file);
