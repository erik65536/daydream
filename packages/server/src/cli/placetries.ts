/**
 * A sheet per place of every whole-place painting a build tried (draft/places/<zone>/paint_*.png), each with the walk
 * reader's cut-off ground in red (the reading the build made last: GPT Image's or Qwen's), its walkable and cut-off
 * shares and whether it was too steep, the kept one marked as the build chooses it (the fewest failed checks, the least
 * cut off among equals), and the final map with its ways out cut. For reviewing what the soundness check rejected.
 *
 *   node src/cli/placetries.ts <worldId> <outDir>
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { walkOf } from '../worldgen/mapgrid.ts';
import { TILE, cutOff, faults, mapGrid } from '../worldgen/mapdraw.ts';
import { loadWorld, worldDir } from '../storage.ts';

const [worldId, out] = process.argv.slice(2) as [string, string];
fs.mkdirSync(out, { recursive: true });
const root = path.join(worldDir(worldId), 'draft', 'places');
const names: Record<string, string> = Object.fromEntries((loadWorld(worldId)?.zones ?? []).map((z) => [z.id, z.name]));
/** A painting's seed, from its file's name: the build tries them in this order. */
const seedOf = (f: string) => Number(/\d+/.exec(f)![0]);
for (const id of fs.readdirSync(root)) {
  const dir = path.join(root, id);
  const files = fs.readdirSync(dir);
  const tries = files.filter((f) => /^paint_\d+\.png$/.test(f)).sort((a, b) => seedOf(a) - seedOf(b));
  if (!tries.length) continue;
  const panels: { img: Buffer; label: string; cut: number; faults: number }[] = [];
  for (const f of tries) {
    const name = f.replace('.png', '');
    const png = fs.readFileSync(path.join(dir, f));
    const { width: W, height: H } = await sharp(png).metadata();
    const g = mapGrid([W! / TILE, H! / TILE]);
    const view = fs.existsSync(path.join(dir, `${name}_view.json`)) ? JSON.parse(fs.readFileSync(path.join(dir, `${name}_view.json`), 'utf8')) : {};
    let label = `${name}: not read yet`, cut = 1, failed = 3, layer: Buffer | undefined;
    // The painting's open cells as its reader saved them (`<painting>_open` is Qwen's, `<painting>_gpt<models>a_open`
    // GPT Image's): the newest, when the place was read by both.
    const age = (x: string) => fs.statSync(path.join(dir, x)).mtimeMs;
    const read = files.filter((x) => x === `${name}_open.png` || (x.startsWith(`${name}_gpt`) && x.endsWith('_open.png'))).sort((a, b) => age(b) - age(a))[0];
    if (read) {
      const raw = await sharp(path.join(dir, read)).greyscale().resize(g.cols, g.rows, { kernel: 'nearest' }).raw().toBuffer();
      const w = walkOf(Uint8Array.from(raw, (v) => (v > 127 ? 1 : 0)), g);
      cut = cutOff(w);
      const px = Buffer.alloc(g.cols * g.rows * 4);
      w.label.forEach((l, i) => { if (l >= 0 && l !== w.main) px.set([255, 0, 0, 170], i * 4); });
      layer = await sharp(px, { raw: { width: g.cols, height: g.rows, channels: 4 } }).resize(W!, H!, { kernel: 'nearest' }).png().toBuffer();
      const share = raw.reduce((n, v) => n + (v > 127 ? 1 : 0), 0) / raw.length;
      failed = faults({ cut, share, steep: !!view.steep });
      label = `${name}: ${(share * 100).toFixed(0)}% walkable, ${(cut * 100).toFixed(1)}% cut off${view.steep ? ', too steep' : ''}`;
    }
    const img = await sharp(await sharp(png).composite(layer ? [{ input: layer }] : []).png().toBuffer()).resize({ width: 900, height: 900, fit: 'inside' }).png().toBuffer();
    panels.push({ img, label, cut, faults: failed });
  }
  const finalP = path.join(dir, 'final.png');
  // The kept painting, as the build chooses it (mapdraw.ts, choosePainting): the first with the fewest failed checks,
  // the least cut off among equals.
  const better = (p: (typeof panels)[number], b: (typeof panels)[number]) => p.faults < b.faults || (p.faults === b.faults && p.cut < b.cut);
  const keptAt = fs.existsSync(finalP) ? panels.reduce((b, p, i) => (better(p, panels[b]!) ? i : b), 0) : -1;
  if (fs.existsSync(finalP)) panels.push({ img: await sharp(finalP).resize({ width: 900, height: 900, fit: 'inside' }).png().toBuffer(), label: 'final: the kept painting with its ways out cut', cut: 0, faults: 0 });
  const tiles = await Promise.all(panels.map(async (p, i) => {
    const m = await sharp(p.img).metadata();
    const text = `${i === keptAt ? 'KEPT  ' : i < panels.length - (keptAt >= 0 ? 1 : 0) ? 'rejected  ' : ''}${p.label}`;
    const bar = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="40"><rect width="100%" height="100%" fill="#000"/><text x="8" y="28" font-size="22" font-family="sans-serif" fill="${i === keptAt ? '#7f7' : '#fff'}">${text.replace(/[<&]/g, '')}</text></svg>`);
    return sharp({ create: { width: m.width!, height: m.height! + 40, channels: 3, background: '#000' } }).composite([{ input: bar, top: 0, left: 0 }, { input: p.img, top: 40, left: 0 }]).png().toBuffer();
  }));
  const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
  const cw = Math.max(...metas.map((m) => m.width!)), ch = Math.max(...metas.map((m) => m.height!));
  const cols = Math.min(3, tiles.length), rows = Math.ceil(tiles.length / cols);
  const file = path.join(out, `tries_${id}_${(names[id] ?? id).replace(/[^\w-]+/g, '_')}.jpg`);
  await sharp({ create: { width: cols * (cw + 10), height: rows * (ch + 10), channels: 3, background: '#222' } }).composite(tiles.map((input, i) => ({ input, left: (i % cols) * (cw + 10), top: Math.floor(i / cols) * (ch + 10) }))).jpeg({ quality: 85 }).toFile(file);
  console.log(file, panels.map((p) => p.label).join(' | '));
}
