/** Grid geometry: A* paths, reachability, and line of sight over integer cells (the navigation grid's), and distance. */

export interface Vec2 {
  x: number;
  y: number;
}

/** Diagonal-aware distance (octile) used for movement costs and ranges. */
function octile(ax: number, ay: number, bx: number, by: number): number {
  const dx = Math.abs(ax - bx);
  const dy = Math.abs(ay - by);
  return Math.max(dx, dy) + (Math.SQRT2 - 1) * Math.min(dx, dy);
}

export function dist(a: Vec2, b: Vec2): number {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

export interface PathOptions {
  width: number;
  height: number;
  /** Return true when the tile can be stood on. */
  passable: (x: number, y: number) => boolean;
  /** Extra cost for entering a tile. */
  extraCost?: (x: number, y: number) => number;
  maxNodes?: number;
  /** Stop as soon as a tile within this (euclidean) distance of the goal is reached. */
  stopWithin?: number;
  /** Allow the goal tile itself to be impassable (e.g. path next to an NPC standing there). */
  allowBlockedGoal?: boolean;
  /**
   * When the goal cannot be stood on or reached, walk to the reachable tile nearest it instead of giving up (a click
   * on a wall or across water walks to the nearest spot one can get to).
   */
  closest?: boolean;
}

/** A binary heap of values by key (two parallel arrays, so a push makes no object). */
class MinHeap {
  private keys: number[] = [];
  private vals: number[] = [];
  get size() {
    return this.keys.length;
  }
  push(v: number, k: number) {
    const ks = this.keys, vs = this.vals;
    let i = ks.length;
    ks.push(k);
    vs.push(v);
    while (i > 0) {
      const p = (i - 1) >> 1;
      if (ks[p]! <= k) break;
      ks[i] = ks[p]!;
      vs[i] = vs[p]!;
      i = p;
    }
    ks[i] = k;
    vs[i] = v;
  }
  pop(): number | undefined {
    const ks = this.keys, vs = this.vals;
    if (!ks.length) return undefined;
    const top = vs[0]!;
    const k = ks.pop()!, v = vs.pop()!;
    const n = ks.length;
    if (n) {
      let i = 0;
      for (;;) {
        const l = i * 2 + 1;
        const r = l + 1;
        let m = i, mk = k;
        if (l < n && ks[l]! < mk) (m = l), (mk = ks[l]!);
        if (r < n && ks[r]! < mk) m = r;
        if (m === i) break;
        ks[i] = ks[m]!;
        vs[i] = vs[m]!;
        i = m;
      }
      ks[i] = k;
      vs[i] = v;
    }
    return top;
  }
}

const DIRS: [number, number, number][] = [
  [1, 0, 1], [-1, 0, 1], [0, 1, 1], [0, -1, 1],
  [1, 1, Math.SQRT2], [1, -1, Math.SQRT2], [-1, 1, Math.SQRT2], [-1, -1, Math.SQRT2],
];

const DX = DIRS.map((d) => d[0]), DY = DIRS.map((d) => d[1]), DC = DIRS.map((d) => d[2]);

/** A* over an 8-connected grid without diagonal corner cutting. Returns tiles excluding start. */
export function findPath(start: Vec2, goal: Vec2, opts: PathOptions): Vec2[] | null {
  const { width, height, passable } = opts;
  const sx = Math.round(start.x), sy = Math.round(start.y);
  const gx = Math.round(goal.x), gy = Math.round(goal.y);
  if (gx < 0 || gy < 0 || gx >= width || gy >= height) return null;
  if (sx < 0 || sy < 0 || sx >= width || sy >= height) return null;
  const stopWithin = opts.stopWithin ?? 0;
  const goalBlocked = !passable(gx, gy);
  if (goalBlocked && !opts.allowBlockedGoal && !opts.closest && stopWithin <= 0) return null;
  const idx = (x: number, y: number) => y * width + x;
  const n = width * height;
  const g = new Float64Array(n).fill(Infinity);
  const came = new Int32Array(n).fill(-1);
  const closed = new Uint8Array(n);
  const heap = new MinHeap();
  const si = idx(sx, sy);
  g[si] = 0;
  heap.push(si, octile(sx, sy, gx, gy));
  const maxNodes = opts.maxNodes ?? 20000;
  let expanded = 0;
  let endIndex = -1;
  // The tile nearest the goal seen so far (for `closest`), and its distance.
  let near = si, nearD = Math.hypot(sx - gx, sy - gy);
  const within = (x: number, y: number) => stopWithin > 0 && Math.hypot(x - gx, y - gy) <= stopWithin + 1e-6;
  while (heap.size) {
    const cur = heap.pop()!;
    if (closed[cur]) continue;
    closed[cur] = 1;
    const cx = cur % width, cy = (cur / width) | 0;
    if ((cx === gx && cy === gy) || within(cx, cy)) {
      endIndex = cur;
      break;
    }
    if (opts.closest) {
      const d = Math.hypot(cx - gx, cy - gy);
      if (d < nearD) (near = cur), (nearD = d);
    }
    if (++expanded > maxNodes) break;
    for (const [dx, dy, c] of DIRS) {
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      const isGoal = nx === gx && ny === gy;
      if (!passable(nx, ny) && !(isGoal && opts.allowBlockedGoal)) continue;
      if (dx !== 0 && dy !== 0 && (!passable(cx + dx, cy) || !passable(cx, cy + dy))) continue;
      const ni = idx(nx, ny);
      if (closed[ni]) continue;
      const ng = g[cur]! + c + (opts.extraCost ? opts.extraCost(nx, ny) : 0);
      if (ng < g[ni]!) {
        g[ni] = ng;
        came[ni] = cur;
        heap.push(ni, ng + octile(nx, ny, gx, gy));
      }
    }
  }
  if (endIndex < 0 && opts.closest) endIndex = near;
  if (endIndex < 0) return null;
  const path: Vec2[] = [];
  let c = endIndex;
  while (c !== si && c >= 0) {
    path.push({ x: c % width, y: (c / width) | 0 });
    c = came[c]!;
  }
  path.reverse();
  if (goalBlocked && path.length) {
    const last = path[path.length - 1]!;
    if (last.x === gx && last.y === gy) path.pop();
  }
  return path;
}

/** Bresenham line of sight. `blocksSight` should be true for walls and tall obstacles. */
export function hasLineOfSight(a: Vec2, b: Vec2, blocksSight: (x: number, y: number) => boolean): boolean {
  const ax = Math.round(a.x), ay = Math.round(a.y);
  let x0 = ax, y0 = ay;
  const x1 = Math.round(b.x), y1 = Math.round(b.y);
  const dx = Math.abs(x1 - x0), dy = -Math.abs(y1 - y0);
  const sx = x0 < x1 ? 1 : -1, sy = y0 < y1 ? 1 : -1;
  let err = dx + dy;
  for (;;) {
    if (x0 === x1 && y0 === y1) return true;
    if (!(x0 === ax && y0 === ay) && blocksSight(x0, y0)) return false;
    const e2 = 2 * err;
    if (e2 >= dy) { err += dy; x0 += sx; }
    if (e2 <= dx) { err += dx; y0 += sy; }
  }
}

/** All tiles within a radius (euclidean) of a center. */
export function tilesInRadius(cx: number, cy: number, r: number, width: number, height: number): Vec2[] {
  const out: Vec2[] = [];
  const ri = Math.ceil(r);
  const fx = Math.round(cx), fy = Math.round(cy);
  for (let y = Math.max(0, fy - ri); y <= Math.min(height - 1, fy + ri); y++)
    for (let x = Math.max(0, fx - ri); x <= Math.min(width - 1, fx + ri); x++)
      if (Math.hypot(x - cx, y - cy) <= r + 0.01) out.push({ x, y });
  return out;
}

/**
 * Dijkstra flood from a start (a tile on the grid) to every tile reachable within maxCost: the tiles' indices in the
 * order they were first found, and cost[index] (Infinity for a tile not reached). Each tile's passability and extra
 * cost is asked once.
 */
export function reachable(start: Vec2, maxCost: number, opts: PathOptions): { found: number[]; cost: Float64Array } {
  const { width, height, passable, extraCost } = opts;
  const n = width * height;
  const cost = new Float64Array(n).fill(Infinity);
  const found: number[] = [];
  // Per tile: 0 not yet asked, 1 passable, 2 not; and the extra cost of entering it, once asked.
  const open = new Uint8Array(n);
  const extra = extraCost ? new Float64Array(n).fill(NaN) : null;
  const done = new Uint8Array(n);
  const pass = (x: number, y: number) => {
    const i = y * width + x;
    if (!open[i]) open[i] = passable(x, y) ? 1 : 2;
    return open[i] === 1;
  };
  const heap = new MinHeap();
  const si = Math.round(start.y) * width + Math.round(start.x);
  cost[si] = 0;
  found.push(si);
  heap.push(si, 0);
  while (heap.size) {
    const cur = heap.pop()!;
    if (done[cur]) continue;
    done[cur] = 1;
    const cg = cost[cur]!;
    const cx = cur % width, cy = (cur / width) | 0;
    for (let k = 0; k < 8; k++) {
      const dx = DX[k]!, dy = DY[k]!, c = DC[k]!;
      const nx = cx + dx, ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= width || ny >= height) continue;
      if (!pass(nx, ny)) continue;
      if (dx !== 0 && dy !== 0 && (!pass(cx + dx, cy) || !pass(cx, cy + dy))) continue;
      const ni = ny * width + nx;
      let e = 0;
      if (extra) {
        if (Number.isNaN(extra[ni]!)) extra[ni] = extraCost!(nx, ny);
        e = extra[ni]!;
      }
      const ng = cg + c + e;
      if (ng > maxCost + 1e-6) continue;
      if (ng < cost[ni]!) {
        if (cost[ni] === Infinity) found.push(ni);
        cost[ni] = ng;
        heap.push(ni, ng);
      }
    }
  }
  return { found, cost };
}
