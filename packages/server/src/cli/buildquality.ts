/**
 * Judge built worlds' places the same way whatever painted them, so two builds can be compared: from the game's
 * own walk grid, how much walkable ground is cut off from the arrival point, which ways out, people, things, and
 * monsters can be reached, how much of the ground lies behind passages under 1.5 m wide, and the widest passage between each pair of ways out; and Sol's review of each finished map against one
 * fixed rubric. Also writes a sheet of each world's maps and one of its art. Art scores are in scripts/buildcost.mjs.
 *
 *   node src/cli/buildquality.ts <worldId> [worldId ...] [--out <dir>] [--no-judge]
 *
 * --no-judge skips Sol (no OpenAI spend). Sol's review costs about two cents a place; the cost is printed (this tool,
 * like every console tool, is outside the spend ledger). Set DAYDREAM_DATA_DIR to read another checkout's worlds.
 */
import fs from 'node:fs';
import path from 'node:path';
import sharp from 'sharp';
import { z } from 'zod';
import { NAV_CELL, Nav, PX_PER_METER, type WorldDefinition, type ZoneDef } from '@daydream/shared';
import { loadWorld, worldAssetDir } from '../storage.ts';
import { DATA_DIR } from '../paths.ts';
import { genai } from '../genai/service.ts';

process.env.DAYDREAM_METER = '1';
const args = process.argv.slice(2);
const out = args.includes('--out') ? args[args.indexOf('--out') + 1]! : '.';
const judge = !args.includes('--no-judge');
const ids = args.filter((a, i) => !a.startsWith('--') && args[i - 1] !== '--out');
if (!ids.length) throw new Error('usage: buildquality <worldId> [worldId ...] [--out <dir>] [--no-judge]');
fs.mkdirSync(out, { recursive: true });

const Review = z.object({
  theme: z.number().int().min(1).max(10).describe('How well the map shows this place and its theme'),
  view: z.number().int().min(1).max(10).describe('How well it reads as a map seen from straight above: 10 = no walkable ground hidden behind tall things, 1 = a side view'),
  routes: z.number().int().min(1).max(10).describe('How clearly a player can see where they can walk and how the areas join up'),
  detail: z.number().int().min(1).max(10).describe('Finish and detail at full size: crisp, varied surfaces, not soft or smeared'),
  coherence: z.number().int().min(1).max(10).describe('Free of flaws: seams, repeated patches, garbled shapes, writing, things cut off, mismatched styles'),
  edge: z.number().int().min(1).max(10).describe('How well the outer edge closes the place off, apart from clear, inviting ways out'),
  problems: z.array(z.string().max(200)).max(6).describe('The most visible problems, worst first, each where it is on the map'),
});
const RUBRIC = 'You review maps for a 2D top-down RPG at the quality of a finished commercial game. Score strictly and the same way for every map: 5 is acceptable, 8 is very good, 10 is flawless.';

/** Cells walkable and reachable from the arrival point, and each cell's clearance (cells to the nearest blocked one). */
function grid(nav: Nav) {
  const { cols, rows } = nav;
  const free = (i: number) => nav.walkableCell(i % cols, Math.floor(i / cols));
  const clear = new Int32Array(cols * rows).fill(-1);
  const q: number[] = [];
  for (let i = 0; i < cols * rows; i++) if (!free(i)) (clear[i] = 0), q.push(i);
  for (let h = 0; h < q.length; h++) {
    const i = q[h]!, x = i % cols, y = Math.floor(i / cols);
    for (let dy = -1; dy <= 1; dy++)
      for (let dx = -1; dx <= 1; dx++) {
        const nx = x + dx, ny = y + dy;
        // The map's own edge counts as blocked.
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows) continue;
        const j = ny * cols + nx;
        if (clear[j]! < 0) (clear[j] = clear[i]! + 1), q.push(j);
      }
  }
  for (let i = 0; i < cols * rows; i++) if (clear[i]! < 0) clear[i] = Math.min(i % cols, Math.floor(i / cols), cols - 1 - (i % cols), rows - 1 - Math.floor(i / cols)) + 1;
  /** Cells reachable from any of `from` keeping a clearance of at least `c` (`from` itself is exempt). */
  const reach = (from: number[], c: number) => {
    const seen = new Uint8Array(cols * rows);
    const q = from.filter((i) => free(i));
    for (const i of q) seen[i] = 1;
    for (let h = 0; h < q.length; h++) {
      const i = q[h]!, x = i % cols, y = Math.floor(i / cols);
      for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
        const nx = x + dx, ny = y + dy, j = ny * cols + nx;
        if (nx < 0 || ny < 0 || nx >= cols || ny >= rows || seen[j] || !free(j) || clear[j]! < c) continue;
        seen[j] = 1;
        q.push(j);
      }
    }
    return seen;
  };
  return { cols, rows, free, clear, reach };
}

async function place(w: WorldDefinition, z: ZoneDef) {
  const nav = new Nav(z.nav!);
  const g = grid(nav);
  const cell = (p: { x: number; y: number }) => {
    const q = nav.nearestWalkable(p, 2) ?? p;
    const [cx, cy] = nav.cellOf(q.x, q.y);
    return cy * g.cols + cx;
  };
  const start = cell(z.entry);
  const seen = g.reach([start], 1);
  let walkable = 0, reached = 0;
  for (let i = 0; i < g.cols * g.rows; i++) if (g.free(i)) (walkable++, seen[i] && reached++);
  const things = [
    ...z.features.map((f) => ({ kind: f.kind, name: f.kind === 'exit' ? f.name ?? 'way out' : f.kind, x: f.x, y: f.y })),
    ...w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ kind: 'person', name: n.name, x: n.x, y: n.y })),
    ...z.spawns.map((s) => ({ kind: s.bossId ? 'boss' : 'monster', name: s.familyId, x: s.x, y: s.y })),
  ];
  const unreached = things.filter((t) => !seen[cell(t)]);
  // The widest passage between each pair of ways out: the largest clearance a walk from one to the other can keep
  // all the way. The last END meters at either end are left out: the walk grid opens a way out as a narrow lane
  // through the barrier band, whatever width is painted there, so the measure is of the place's own passages. A
  // place with one way out has no pair.
  const END = 6;
  const around = (p: { x: number; y: number }) => nav.cellsWithin(p, END).filter((i) => seen[i]);
  const maxClear = Math.max(...g.clear);
  const ways = z.features.filter((f) => f.kind === 'exit');
  const exits = ways.flatMap((a, k) => ways.slice(k + 1).map((f) => {
    const from = around(a), goal = around(f);
    let lo = 0, hi = maxClear;
    while (lo < hi) {
      const c = Math.ceil((lo + hi) / 2);
      const r = g.reach(from, c);
      if (goal.some((i) => r[i])) lo = c;
      else hi = c - 1;
    }
    return { name: `${a.name ?? 'way out'} to ${f.name ?? 'way out'}`, widestPassageM: lo ? +((2 * lo - 1) * NAV_CELL).toFixed(1) : 0 };
  }));
  // How much of the ground a walker who needs a passage ROOMY meters wide reaches from the arrival point: what lies
  // only behind narrower squeezes counts as hard to reach.
  const ROOMY = 1.5;
  const c = Math.ceil((ROOMY / NAV_CELL + 1) / 2);
  const centers = g.reach(around(z.entry), c);
  // The walker's body covers the cells round where it stands, up to the obstacles.
  const roomy = new Uint8Array(g.cols * g.rows);
  for (let i = 0; i < g.cols * g.rows; i++) {
    if (!centers[i]) continue;
    const x = i % g.cols, y = Math.floor(i / g.cols);
    for (let dy = 1 - c; dy < c; dy++) for (let dx = 1 - c; dx < c; dx++) if (x + dx >= 0 && y + dy >= 0 && x + dx < g.cols && y + dy < g.rows) roomy[(y + dy) * g.cols + x + dx] = 1;
  }
  let roomyCells = 0;
  for (let i = 0; i < g.cols * g.rows; i++) if (roomy[i] && seen[i]) roomyCells++;
  const asset = w.assets[z.painting!.image]!;
  const png = fs.readFileSync(path.join(worldAssetDir(w.id), asset.file!));
  let review: z.infer<typeof Review> | undefined;
  if (judge) {
    const meta = await sharp(png).metadata();
    const whole = await sharp(png).resize({ width: 1536, height: 1536, fit: 'inside' }).jpeg({ quality: 88 }).toBuffer();
    const detail = await sharp(png).extract({ left: Math.max(0, Math.round(meta.width! / 2 - 512)), top: Math.max(0, Math.round(meta.height! / 2 - 512)), width: Math.min(1024, meta.width!), height: Math.min(1024, meta.height!) }).jpeg({ quality: 90 }).toBuffer();
    review = await genai().structured('world.design', {
      model: genai().strongModel('world.design'),
      system: RUBRIC,
      prompt: `The first picture is the whole map of ${z.name}, a ${z.kind} place: ${z.description.slice(0, 400)} The game's characters are about ${Math.round(1.75 * PX_PER_METER)} pixels tall on the full-size map (${meta.width}×${meta.height}). The second picture is a piece from its middle at full size, to judge its detail. Review the map.`,
      schema: Review,
      name: 'map_review',
      maxTokens: 8000,
      images: [whole, detail],
    });
  }
  return {
    world: w.id, place: z.name, kind: z.kind, tiles: `${z.tiles[0]}x${z.tiles[1]}`, meters: `${Math.round(z.width)}x${Math.round(z.height)}`,
    walkableShare: +(walkable / (g.cols * g.rows)).toFixed(3),
    cutOffShare: +(1 - reached / Math.max(1, walkable)).toFixed(3),
    roomyShare: +(roomyCells / Math.max(1, reached)).toFixed(3),
    things: things.length, unreached: unreached.length, unreachedList: unreached.map((t) => `${t.kind}: ${t.name}`).join('; '),
    exits: ways.length, narrowestExitPassageM: exits.length ? Math.min(...exits.map((e) => e.widestPassageM)) : null,
    exitPassages: exits.map((e) => `${e.name} ${e.widestPassageM} m`).join('; '),
    ...(review ? { ...Object.fromEntries(Object.entries(review).filter(([k]) => k !== 'problems')), mean: +((review.theme + review.view + review.routes + review.detail + review.coherence + review.edge) / 6).toFixed(2), problems: review.problems.join(' | ') } : {}),
  };
}

/** A strip of one world's maps, and a grid of its characters, creatures, objects, and icons. */
async function sheets(w: WorldDefinition) {
  const dir = worldAssetDir(w.id);
  const tile = async (file: string, h: number, label: string, bg = '#202020') => {
    const img = await sharp(path.join(dir, file)).resize({ height: h, width: Math.round(h * 1.6), fit: 'contain', background: bg }).flatten({ background: bg }).png().toBuffer();
    const m = await sharp(img).metadata();
    const text = Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${m.width}" height="28"><rect width="100%" height="100%" fill="#000"/><text x="6" y="20" font-size="18" font-family="sans-serif" fill="#fff">${label.replace(/[<&]/g, '').slice(0, Math.floor((h * 1.6) / 10))}</text></svg>`);
    return sharp({ create: { width: m.width!, height: h + 28, channels: 3, background: '#000' } }).composite([{ input: img, top: 0, left: 0 }, { input: text, top: h, left: 0 }]).png().toBuffer();
  };
  const row = async (tiles: Buffer[], file: string, perRow: number) => {
    if (!tiles.length) return;
    const metas = await Promise.all(tiles.map((t) => sharp(t).metadata()));
    const cw = Math.max(...metas.map((m) => m.width!)), ch = Math.max(...metas.map((m) => m.height!));
    const cols = Math.min(perRow, tiles.length), rows = Math.ceil(tiles.length / cols);
    await sharp({ create: { width: cols * (cw + 8), height: rows * (ch + 8), channels: 3, background: '#000' } })
      .composite(tiles.map((input, i) => ({ input, left: (i % cols) * (cw + 8), top: Math.floor(i / cols) * (ch + 8) })))
      .jpeg({ quality: 85 }).toFile(path.join(out, file));
  };
  const maps = [];
  for (const z of w.zones) {
    const a = z.painting && w.assets[z.painting.image];
    if (a?.file) maps.push(await tile(a.file, 600, z.name));
  }
  await row(maps, `maps_${w.id}.jpg`, 3);
  const art = [];
  for (const a of Object.values(w.assets).filter((a) => ['sprite', 'object', 'icon'].includes(a.kind) && a.file && a.status === 'ok').sort((a, b) => a.key.localeCompare(b.key)))
    art.push(await tile(a.file!, 200, `${a.score?.toFixed(1) ?? '-'} ${a.key.replace(/^(spr|obj|icon)_/, '')}`, '#5a5a5a'));
  await row(art, `art_${w.id}.jpg`, 8);
}

const rows: Awaited<ReturnType<typeof place>>[] = [];
for (const id of ids) {
  const w = loadWorld(id);
  if (!w) throw new Error(`no world ${id}`);
  for (const z of w.zones.filter((z) => z.nav && z.painting)) {
    const r = await place(w, z);
    console.log(`${w.id} ${z.name}: ${Math.round(r.cutOffShare * 100)}% cut off, ${Math.round(r.roomyShare * 100)}% roomy, ${r.unreached} of ${r.things} unreached, narrowest passage between ways out ${r.narrowestExitPassageM ?? '-'} m${'mean' in r ? `, Sol ${r.mean}` : ''}`);
    rows.push(r);
  }
  await sheets(w);
}
const summary = ids.map((id) => {
  const rs = rows.filter((r) => r.world === id);
  const mean = (k: string) => +(rs.reduce((a, r) => a + Number((r as Record<string, unknown>)[k] ?? 0), 0) / Math.max(1, rs.length)).toFixed(3);
  return { world: id, places: rs.length, cutOffShare: mean('cutOffShare'), roomyShare: mean('roomyShare'), unreached: rs.reduce((a, r) => a + r.unreached, 0), things: rs.reduce((a, r) => a + r.things, 0), ...(judge ? Object.fromEntries(['theme', 'view', 'routes', 'detail', 'coherence', 'edge', 'mean'].map((k) => [k, mean(k)])) : {}) };
});
const spent = (() => {
  const f = path.join(DATA_DIR, 'logs', 'meter.jsonl');
  if (!fs.existsSync(f)) return 0;
  return fs.readFileSync(f, 'utf8').split('\n').filter((l) => l.includes(`"pid":${process.pid},`)).map((l) => JSON.parse(l)).filter((m) => m.kind === 'call').reduce((a, m) => a + m.usd, 0);
})();
fs.writeFileSync(path.join(out, 'quality.json'), JSON.stringify({ measuredAt: new Date().toISOString(), usd: +spent.toFixed(4), summary, places: rows }, null, 1));
const keys = [...new Set(rows.flatMap((r) => Object.keys(r)))];
fs.writeFileSync(path.join(out, 'quality.csv'), [keys.join(','), ...rows.map((r) => keys.map((k) => { const v = (r as Record<string, unknown>)[k]; return typeof v === 'string' && /[,"\n]/.test(v) ? `"${v.replace(/"/g, '""')}"` : v ?? ''; }).join(','))].join('\n') + '\n');
console.log(JSON.stringify(summary, null, 1));
console.log(`OpenAI: $${spent.toFixed(4)}`);
