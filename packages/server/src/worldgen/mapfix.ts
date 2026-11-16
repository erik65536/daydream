/**
 * Making a read map usable without repainting it (see docs/places.md). The character may clip a little through
 * things that look solid, if that gives a map it can use.
 *
 * 1. Clean: blocked specks under 0.5 m² inside open ground open (reader noise, tiny props); open specks under 1 m²
 *    close.
 * 2. The barrier band round the edge is blocked, except the gaps at the ways out.
 * 3. Widen: the character's center keeps CLEARANCE (one cell) from blocked cells. Thin walls stay walls (blocked cells
 *    are never walkable), but passages a reader drew a little narrow open up.
 * 4. Connect: every other region of at least MIN_REGION m² joins the main one along the cheapest route (walkable cells
 *    cost little, open but narrow ones more, blocked ones most, less where a reading saw ground), carved open CARVE
 *    either side. The cheapest region joins first and the rest are measured again, so an island beyond an island
 *    joins once its neighbor has. A route may punch through MAX_PUNCH of blocked ground no reading saw as ground,
 *    and cross up to MAX_CROSS where readings saw some (a bridge, stairs, or a doorway one plan drew as blocked). A
 *    route through more than CONFIRM_FROM of blocked ground joins only if the painting shows a way across there
 *    (`Links.confirm`: Luna, shown the route, asked about a bridge, stairs, a door...): judging the way, not the area
 *    beyond it, keeps roofs out without losing islands past a bridge. A refused crossing is closed and the region looks
 *    for another way (MAX_TRIES at most). Every way out joins too, however far and whatever the painting shows: its
 *    gap is not one of the regions above (no look is spent on it, and no refused crossing stands in its way).
 */
import { CELL, components, neighbours, walkOf, type Grid, type Side } from './mapgrid.ts';

const MIN_REGION = 4, MAX_PUNCH = 3, MAX_CROSS = 10, CONFIRM_FROM = 0.5, MAX_TRIES = 3, SEEN = 0.5, CARVE = 0.45, SPECK = 0.5, ISLAND = 1;

/**
 * What tells a connector from a wall: each cell's walk evidence (0 to 1, the most any reading saw of it as ground),
 * and a check of a route on the painting (Luna: can a person cross here?).
 */
interface Links {
  evidence: Float32Array;
  confirm?: (route: number[]) => Promise<boolean>;
}

/** A way out: the side of the map, where along it (0 to 1), and its gap through the barrier band (m). */
interface Gap {
  side: Side;
  at: number;
}

interface Fixed {
  /** Open ground after the fixes, and where the character can walk (the main region, clearance kept). */
  open: Uint8Array;
  walk: Uint8Array;
  /** Cells carved open; regions joined and left out; ways out that needed a route. */
  carved: Uint8Array;
  joined: number;
  left: number;
  exits: number;
}

function disc(R: number): [number, number][] {
  const out: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= R * R + 0.5) out.push([dr, dc]);
  return out;
}

/** Cheapest cost from the `from` cells to every cell (cost per cell entered), and each cell's step back toward them. */
function search(g: Grid, cost: (i: number) => number, from: number[]): { dist: Float64Array; prev: Int32Array } {
  const n = g.cols * g.rows, dist = new Float64Array(n).fill(Infinity), prev = new Int32Array(n).fill(-1);
  const heap: [number, number][] = [];
  const push = (e: [number, number]) => {
    heap.push(e);
    for (let k = heap.length - 1; k > 0; ) {
      const p = (k - 1) >> 1;
      if (heap[p]![0] <= heap[k]![0]) break;
      [heap[p], heap[k]] = [heap[k]!, heap[p]!];
      k = p;
    }
  };
  const pop = (): [number, number] => {
    const top = heap[0]!, last = heap.pop()!;
    if (heap.length) {
      heap[0] = last;
      for (let k = 0; ; ) {
        const l = 2 * k + 1, r = l + 1;
        let m = k;
        if (l < heap.length && heap[l]![0] < heap[m]![0]) m = l;
        if (r < heap.length && heap[r]![0] < heap[m]![0]) m = r;
        if (m === k) break;
        [heap[m], heap[k]] = [heap[k]!, heap[m]!];
        k = m;
      }
    }
    return top;
  };
  for (const i of from) (dist[i] = 0), push([0, i]);
  while (heap.length) {
    const [d, i] = pop();
    if (d > dist[i]!) continue;
    for (const j of neighbours(i, g)) {
      const nd = d + cost(j);
      if (nd < dist[j]!) (dist[j] = nd), (prev[j] = i), push([nd, j]);
    }
  }
  return { dist, prev };
}

/** The route back from `end` to where the search started. */
function routeTo(prev: Int32Array, end: number): number[] {
  const path: number[] = [];
  for (let k = end; k >= 0; k = prev[k]!) path.push(k);
  return path;
}

/** The cells of each way out's gap through the barrier band (`band`, `gap` in cells). */
function gapCells(g: Grid, gaps: Gap[], band: number, gap: number): number[][] {
  return gaps.map((e) => {
    const out: number[] = [];
    const a = e.at * (e.side === 'top' || e.side === 'bottom' ? g.cols : g.rows), half = gap / 2;
    for (let r = 0; r < g.rows; r++)
      for (let c = 0; c < g.cols; c++) {
        const inGap = e.side === 'top' ? r < band && Math.abs(c - a) < half : e.side === 'bottom' ? r >= g.rows - band && Math.abs(c - a) < half
          : e.side === 'left' ? c < band && Math.abs(r - a) < half : c >= g.cols - band && Math.abs(r - a) < half;
        if (inGap) out.push(r * g.cols + c);
      }
    return out;
  });
}

/** Make a read map usable (see the file comment). `band` and `gap` are in cells. */
export async function fixMap(read: Uint8Array, g: Grid, gaps: Gap[], band: number, gap: number, link?: Links): Promise<Fixed> {
  const open = Uint8Array.from(read), n = open.length;
  const border = (i: number) => { const r = Math.floor(i / g.cols), c = i % g.cols; return r === 0 || c === 0 || r === g.rows - 1 || c === g.cols - 1; };
  for (const p of components(g, (i) => !open[i])) if (!p.some(border) && p.length * CELL * CELL < SPECK) for (const i of p) open[i] = 1;
  for (const p of components(g, (i) => !!open[i])) if (p.length * CELL * CELL < ISLAND) for (const i of p) open[i] = 0;
  for (let r = 0; r < g.rows; r++) for (let c = 0; c < g.cols; c++) if (Math.min(r, c, g.rows - 1 - r, g.cols - 1 - c) < band) open[r * g.cols + c] = 0;
  const gapsAt = gapCells(g, gaps, band, gap);
  for (const cells of gapsAt) for (const i of cells) open[i] = 1;

  const minCells = MIN_REGION / (CELL * CELL);
  /** Cells of regions refused a route (never tried again). */
  const tried = new Uint8Array(n);
  let left = 0;
  const carved = new Uint8Array(n), cd = disc(Math.round(CARVE / CELL));
  const carve = (path: number[]) => {
    for (const i of path) {
      const r = Math.floor(i / g.cols), c = i % g.cols;
      for (const [dr, dc] of cd) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= g.rows || cc >= g.cols) continue;
        const k = rr * g.cols + cc;
        if (!open[k]) (open[k] = 1), (carved[k] = 1);
      }
    }
  };
  let w = walkOf(open, g);
  // Blocked cells some reading saw as ground (a bridge, stairs, a doorway one plan drew) are cheaper to cross.
  // A crossing the painting refused is closed to later routes (they look for another way, a bridge beside the rocks).
  const refused = new Uint8Array(n), tries = new Map<number, number>();
  const step = (i: number) => (w.walk[i] ? 0.02 : open[i] ? 0.2 : 1 - 0.8 * Math.min(1, (link?.evidence[i] ?? 0) / SEEN));
  const cost = (i: number) => (refused[i] ? Infinity : step(i));
  const mainCells = () => { const out: number[] = []; w.label.forEach((l, i) => { if (l === w.main) out.push(i); }); return out; };
  let joined = 0, exits = 0;
  for (let found = true; found; ) {
    // Cheapest first, measured again after every join: a region beyond another is nearer once that one has joined.
    found = false;
    const { dist, prev } = search(g, cost, mainCells());
    const nearest = new Map<number, number>();
    // A way out's gap joins by itself, below.
    const gapRegions = new Set(gapsAt.flat().map((i) => w.label[i]!));
    w.label.forEach((l, i) => { if (l >= 0 && l !== w.main && !gapRegions.has(l) && w.sizes[l]! >= minCells && !tried[i] && (!nearest.has(l) || dist[i]! < dist[nearest.get(l)!]!)) nearest.set(l, i); });
    for (const [l, end] of [...nearest.entries()].sort((a, b) => dist[a[1]]! - dist[b[1]]!)) {
      if (!Number.isFinite(dist[end]!)) continue;
      const reg: number[] = [];
      w.label.forEach((x, i) => { if (x === l) reg.push(i); });
      const refuse = () => { for (const i of reg) tried[i] = 1; };
      const path = routeTo(prev, end), punch = path.filter((i) => !open[i]).length * CELL;
      const unseen = path.filter((i) => !open[i] && (link?.evidence[i] ?? 0) < SEEN / 2).length * CELL;
      if (unseen > MAX_PUNCH || punch > (link ? MAX_CROSS : MAX_PUNCH)) continue;
      if (punch > CONFIRM_FROM && link?.confirm && !(await link.confirm(path))) {
        for (const i of path) if (!open[i]) refused[i] = 1;
        const k = (tries.get(reg[0]!) ?? 0) + 1;
        tries.set(reg[0]!, k);
        if (k >= MAX_TRIES) refuse();
        found = true;
        break;
      }
      carve(path);
      joined++;
      w = walkOf(open, g);
      found = true;
      break;
    }
  }
  for (const cells of gapsAt) {
    if (!cells.length || cells.some((i) => w.label[i] === w.main)) continue;
    const { dist, prev } = search(g, step, cells);
    let end = -1;
    w.label.forEach((l, i) => { if (l === w.main && Number.isFinite(dist[i]!) && (end < 0 || dist[i]! < dist[end]!)) end = i; });
    if (end >= 0) (carve(routeTo(prev, end)), exits++, (w = walkOf(open, g)));
  }
  left = w.sizes.filter((size, l) => l !== w.main && size >= minCells).length;
  return { open, walk: Uint8Array.from(w.label, (l) => (l === w.main ? 1 : 0)), carved, joined, left, exits };
}
