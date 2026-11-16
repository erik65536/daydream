/** Serving a world's generated images, whole or at a smaller size, and its sounds. */
import fs from 'node:fs';
import path from 'node:path';
import type { Response } from 'express';
import sharp from 'sharp';
import { SOUND_FILE } from '@daydream/shared';

/** File names the asset route serves. */
const ASSET_FILE = /^[\w.-]+\.(png|webp)$/;

/**
 * The smaller widths an asset can be asked for (`?w=`): what a chart or a thumbnail needs instead of a painting
 * thousands of pixels across. A short fixed list, so the copies kept on disk stay few.
 */
const ASSET_WIDTHS = [256, 512] as const;

/**
 * Send one asset file from `dir`, whole or no wider than `width`. Paintings of places carry a version in their name
 * (.webp), so they can be kept for a year; other art is repainted under the same name, so it is revalidated. The
 * cache header goes only on the file itself, never on a 404 (a missing file must be asked for again), and `dir` may
 * sit under a dot-folder (the data of a checkout in .claude/worktrees).
 */
export async function sendAsset(res: Response, dir: string, file: string, width?: number) {
  if (!ASSET_FILE.test(file)) return void res.status(400).end();
  if (width !== undefined && !(ASSET_WIDTHS as readonly number[]).includes(width)) return void res.status(400).end();
  const missing = () => void (!res.headersSent && res.status(404).setHeader('Cache-Control', 'no-store').end());
  let sent = path.join(dir, file);
  if (width) {
    const small = await smaller(dir, file, width).catch(() => null);
    if (!small) return missing();
    sent = small;
  }
  res.sendFile(sent, { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': file.endsWith('.webp') ? 'public, max-age=31536000, immutable' : 'no-cache' } }, (err) => err && missing());
}

/** Copies being made, so asking twice at once makes one. */
const making = new Map<string, Promise<string>>();

/**
 * The asset at no more than `width` pixels across, as WebP, made on first asking and kept beside the assets in
 * `.sized/<width>/` (made again when the asset is repainted under the same name).
 */
function smaller(dir: string, file: string, width: number): Promise<string> {
  const src = path.join(dir, file);
  const out = path.join(dir, '.sized', String(width), `${file}.webp`);
  const pending = making.get(out);
  if (pending) return pending;
  const job = (async () => {
    const from = await fs.promises.stat(src);
    const have = await fs.promises.stat(out).catch(() => null);
    if (have && have.mtimeMs >= from.mtimeMs) return out;
    await fs.promises.mkdir(path.dirname(out), { recursive: true });
    const tmp = `${out}.${process.pid}.tmp`;
    // From memory, not the path: sharp keeps files it opened, which locks them on Windows.
    await sharp(await fs.promises.readFile(src)).resize({ width, height: width, fit: 'inside', withoutEnlargement: true }).webp({ quality: 82 }).toFile(tmp);
    await fs.promises.rename(tmp, out);
    return out;
  })().finally(() => making.delete(out));
  making.set(out, job);
  return job;
}

/** Send one of a world's sound files (Ogg Opus). A sound made again keeps its name, so it is revalidated. */
export function sendSound(res: Response, dir: string, file: string) {
  if (!SOUND_FILE.test(file)) return void res.status(400).end();
  res.sendFile(path.join(dir, file), { dotfiles: 'allow', cacheControl: false, headers: { 'Cache-Control': 'no-cache', 'Content-Type': 'audio/ogg' } }, (err) => err && !res.headersSent && void res.status(404).setHeader('Cache-Control', 'no-store').end());
}
