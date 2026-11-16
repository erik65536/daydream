/**
 * Actors' clip sheets, held as decoded bitmaps at the resolution the view needs.
 *
 * A sheet is fetched and decoded off the main thread (createImageBitmap), scaled down to the pixels the screen
 * shows (a sheet is rendered for the closest zoom on a sharp screen), and kept only while it is drawn: past a
 * memory budget the least recently drawn are released. An <img> would leave decoding to the browser, which drops
 * big images from its cache under pressure and decodes them again inside drawImage, frame after frame.
 */
import { retryDelay } from './sprites';

export interface Sheet {
  bitmap: ImageBitmap;
  /** Bitmap pixels per sheet pixel, across and down (the resolution, give or take rounding). */
  kx: number;
  ky: number;
  /** The resolution it was asked for. */
  res: number;
}

interface Entry {
  sheet: Sheet | null;
  /** The resolution being fetched, if any. */
  loading: number;
  /** How often it failed to load, and when it may be tried again. */
  tries: number;
  retryAt: number;
  used: number;
  /** The sheet's own size (pixels). */
  w: number;
  h: number;
}

/**
 * Decoded bytes kept before the least recently drawn sheets go. Phones and tablets get far less: iOS Safari drops a
 * page's canvases past a few hundred megabytes in all, and small devices report little memory.
 */
const BUDGET = (() => {
  const mem = (navigator as Navigator & { deviceMemory?: number }).deviceMemory;
  const handheld = matchMedia('(pointer: coarse)').matches && !matchMedia('(any-pointer: fine)').matches;
  return handheld || (mem !== undefined && mem <= 4) ? 160e6 : 384e6;
})();
/** Sheets drawn this recently are never released. */
const KEEP_MS = 3000;
/** Sheets decoding at once. */
const PARALLEL = 3;

const entries = new Map<string, Entry>();
const queue: string[] = [];
let busy = 0;
let bytes = 0;

const size = (s: Sheet | null) => (s ? s.bitmap.width * s.bitmap.height * 4 : 0);

/** The resolution to hold a sheet at (bitmap pixels per sheet pixel) for `px` screen pixels per sheet pixel. */
export const sheetRes = (px: number) => Math.min(1, Math.max(0.25, Math.ceil(px * 4 - 0.05) / 4));

/**
 * A sheet (`w` x `h` sheet pixels) to draw now, or null while none is decoded. `res` is the resolution wanted (see
 * `sheetRes`): one held sharper is kept unless it is twice that, and one held coarser is drawn while the sharper one
 * decodes. `urgent` puts it ahead of sheets only fetched in advance.
 */
export function getSheet(url: string, w: number, h: number, res: number, urgent = true): Sheet | null {
  let e = entries.get(url);
  if (!e) entries.set(url, (e = { sheet: null, loading: 0, tries: 0, retryAt: 0, used: 0, w, h }));
  const now = performance.now();
  if (urgent) e.used = now;
  const held = e.sheet?.res;
  // A sheet wanted only in advance is fetched once, and not while memory is short (it would push out sheets in use
  // and come back); it gets sharper when it is drawn.
  if (!urgent && (e.sheet || bytes > BUDGET * 0.6)) return e.sheet;
  if (now >= e.retryAt && !e.loading && (held === undefined || res > held || res * 2 <= held)) {
    e.loading = res;
    if (urgent) queue.unshift(url);
    else queue.push(url);
    pump();
  } else if (urgent && !e.sheet && queue.indexOf(url) > 0) {
    // Fetched in advance and still waiting, but wanted now.
    queue.splice(queue.indexOf(url), 1);
    queue.unshift(url);
  }
  return e.sheet;
}

function pump() {
  while (busy < PARALLEL && queue.length) {
    const url = queue.shift()!;
    const e = entries.get(url);
    if (!e) continue;
    busy++;
    void decode(url, e)
      .then((s) => {
        bytes -= size(e.sheet);
        e.sheet?.bitmap.close();
        e.sheet = s;
        bytes += size(s);
        e.tries = 0;
      })
      .catch(() => {
        // Tried again later, when it is next wanted (a dropped request, the network back).
        e.retryAt = performance.now() + retryDelay(++e.tries);
      })
      .finally(() => {
        e.loading = 0;
        busy--;
        trim();
        pump();
      });
  }
}

async function decode(url: string, e: Entry): Promise<Sheet> {
  const res = e.loading;
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${r.status}`);
  const blob = await r.blob();
  const bitmap = await (res >= 1 ? createImageBitmap(blob) : createImageBitmap(blob, { resizeWidth: Math.max(1, Math.round(e.w * res)), resizeHeight: Math.max(1, Math.round(e.h * res)), resizeQuality: 'high' }));
  return { bitmap, kx: bitmap.width / e.w, ky: bitmap.height / e.h, res };
}

/** Release the least recently drawn sheets while over the budget. */
function trim() {
  if (bytes <= BUDGET) return;
  const now = performance.now();
  const old = [...entries].filter(([, e]) => e.sheet && !e.loading && now - e.used > KEEP_MS).sort((a, b) => a[1].used - b[1].used);
  for (const [url, e] of old) {
    if (bytes <= BUDGET) break;
    bytes -= size(e.sheet);
    e.sheet!.bitmap.close();
    entries.delete(url);
  }
}
