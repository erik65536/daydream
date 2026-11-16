/**
 * Where people can walk and see in a painted place. Game positions are meters on the ground; the painting is a
 * top-down map of that ground (x across, y down the picture). The reader turns the painting into two bit grids of
 * half-meter cells: walkable (where a character's center may stand, clearance already included) and see-through.
 */
import { BitSet } from '../util/encode.ts';
import { findPath, hasLineOfSight, reachable, type PathOptions, type Vec2 } from '../util/grid.ts';

/**
 * Picture pixels per meter: the one scale of the game. Ground runs this many pixels per meter both ways (the places
 * are top-down maps), and figures stand this many pixels per meter tall (a 1.75 m person is 82 px).
 */
export const PX_PER_METER = 82 / 1.75;
/** Navigation cell size in meters. */
export const NAV_CELL = 0.5;
/** How much unbroken sight-blocking ground (m) blocks a line of sight (see Nav.sees). */
const SIGHT_WALL = 1.5;

/** Ground meters to picture pixels, given the picture position of the ground origin. */
export function groundToPicture(x: number, y: number, ox: number, oy: number): Vec2 {
  return { x: x * PX_PER_METER + ox, y: y * PX_PER_METER + oy };
}

/** Picture pixels to ground meters. */
export function pictureToGround(px: number, py: number, ox: number, oy: number): Vec2 {
  return { x: (px - ox) / PX_PER_METER, y: (py - oy) / PX_PER_METER };
}

/** A way out within this many meters of the map's edge leads across it; one further in is drawn inside (a door). */
const EDGE_WAY_M = 8;

/**
 * The stretch of ground a way out covers: from where it stands to where its road meets the map's edge, and the way
 * across the edge (none for a way drawn inside the map).
 */
export interface WayOut {
  from: Vec2;
  to: Vec2;
  out?: Vec2;
}

/** The point of a way out's road nearest `p`. */
export function nearestOnWay(w: WayOut, p: Vec2): Vec2 {
  const dx = w.to.x - w.from.x, dy = w.to.y - w.from.y, len2 = dx * dx + dy * dy;
  const t = len2 ? Math.max(0, Math.min(1, ((p.x - w.from.x) * dx + (p.y - w.from.y) * dy) / len2)) : 0;
  return { x: w.from.x + dx * t, y: w.from.y + dy * t };
}

export interface NavDef {
  cols: number;
  rows: number;
  /** Base64 bitsets of cols*rows cells: walkable, and see-through. */
  walk: string;
  sight: string;
}

export interface NavPathOptions {
  /** Extra cost (meters) for entering a cell, e.g. an ally to squeeze past. */
  extraCost?: (cx: number, cy: number) => number;
  /** Cells that are blocked for this walk only (other people in combat). */
  blocked?: (cx: number, cy: number) => boolean;
  /** Stop once within this many meters of the goal. */
  stopWithin?: number;
  /** Plan to the goal even when it can't be stood on (walking up to someone). */
  allowBlockedGoal?: boolean;
  /** When the goal can't be stood on or reached, end at the reachable spot nearest it instead of failing. */
  closest?: boolean;
  maxNodes?: number;
}

export class Nav {
  readonly cols: number;
  readonly rows: number;
  private walk: BitSet;
  private sight: BitSet;

  constructor(def: NavDef) {
    this.cols = def.cols;
    this.rows = def.rows;
    this.walk = new BitSet(def.cols * def.rows, def.walk);
    this.sight = new BitSet(def.cols * def.rows, def.sight);
  }

  /** Ground size in meters. */
  get width() {
    return this.cols * NAV_CELL;
  }
  get height() {
    return this.rows * NAV_CELL;
  }

  cellOf(x: number, y: number): [number, number] {
    return [Math.floor(x / NAV_CELL), Math.floor(y / NAV_CELL)];
  }

  center(cx: number, cy: number): Vec2 {
    return { x: (cx + 0.5) * NAV_CELL, y: (cy + 0.5) * NAV_CELL };
  }

  inside(cx: number, cy: number) {
    return cx >= 0 && cy >= 0 && cx < this.cols && cy < this.rows;
  }

  walkableCell(cx: number, cy: number) {
    return this.inside(cx, cy) && this.walk.get(cy * this.cols + cx);
  }

  seeThroughCell(cx: number, cy: number) {
    return this.inside(cx, cy) && this.sight.get(cy * this.cols + cx);
  }

  walkable(x: number, y: number) {
    const [cx, cy] = this.cellOf(x, y);
    return this.walkableCell(cx, cy);
  }

  /**
   * Whether one can see from a to b (meters). Only something solid blocks the view: SIGHT_WALL meters of unbroken
   * sight-blocking ground (a wall, a building). A thinner strip (the sight plan reads ferns and bushes as solid too)
   * and the meter around either end (the cover one stands in or by) never do.
   */
  sees(a: Vec2, b: Vec2): boolean {
    const [ax, ay] = this.cellOf(a.x, a.y), [bx, by] = this.cellOf(b.x, b.y);
    // Cells are whole numbers, so comparing squared distances is exact.
    const wall = Math.round(SIGHT_WALL / NAV_CELL), edge2 = (1 / NAV_CELL) ** 2;
    let run = 0;
    return hasLineOfSight({ x: ax, y: ay }, { x: bx, y: by }, (x, y) => {
      if ((x - ax) ** 2 + (y - ay) ** 2 <= edge2 || (x - bx) ** 2 + (y - by) ** 2 <= edge2 || this.seeThroughCell(x, y)) run = 0;
      else run++;
      return run >= wall;
    });
  }

  /** The straight walk a→b stays on walkable ground (checked every quarter meter). */
  clear(a: Vec2, b: Vec2, ok: (cx: number, cy: number) => boolean = (cx, cy) => this.walkableCell(cx, cy)): boolean {
    const steps = Math.max(1, Math.ceil(Math.hypot(b.x - a.x, b.y - a.y) / (NAV_CELL / 2)));
    for (let i = 1; i <= steps; i++) {
      const f = i / steps;
      const [cx, cy] = this.cellOf(a.x + (b.x - a.x) * f, a.y + (b.y - a.y) * f);
      if (!ok(cx, cy)) return false;
    }
    return true;
  }

  private gridOptions(o: NavPathOptions): PathOptions {
    const blocked = o.blocked;
    return {
      width: this.cols,
      height: this.rows,
      passable: blocked ? (x, y) => this.walkableCell(x, y) && !blocked(x, y) : (x, y) => this.walkableCell(x, y),
      extraCost: o.extraCost ? (x, y) => o.extraCost!(x, y) / NAV_CELL : undefined,
      maxNodes: o.maxNodes ?? 30000,
      stopWithin: o.stopWithin !== undefined ? o.stopWithin / NAV_CELL : undefined,
      allowBlockedGoal: o.allowBlockedGoal,
      closest: o.closest,
    };
  }

  /**
   * A walk from a to b in meters: an any-angle path (waypoints after the start), ending at b itself when b can be
   * stood on. Null when there is no way.
   */
  path(from: Vec2, to: Vec2, o: NavPathOptions = {}): Vec2[] | null {
    const g = this.gridOptions(o);
    const [sx, sy] = this.cellOf(from.x, from.y), [gx, gy] = this.cellOf(to.x, to.y);
    const cells = findPath({ x: sx, y: sy }, { x: gx, y: gy }, g);
    if (!cells) return null;
    const ok = (cx: number, cy: number) => g.passable(cx, cy);
    const pts = cells.map((c) => this.center(c.x, c.y));
    const ends = pts.length && cells[cells.length - 1]!.x === gx && cells[cells.length - 1]!.y === gy && ok(gx, gy);
    if (ends) pts[pts.length - 1] = { x: to.x, y: to.y };
    // Any-angle: skip waypoints while the straight walk stays clear.
    const out: Vec2[] = [];
    let cur = from;
    for (let i = 0; i < pts.length; ) {
      let j = pts.length - 1;
      while (j > i && !this.clear(cur, pts[j]!, ok)) j--;
      out.push(pts[j]!);
      cur = pts[j]!;
      i = j + 1;
    }
    return out;
  }

  /** Meters along a walk. */
  static length(from: Vec2, path: Vec2[]): number {
    let len = 0, p = from;
    for (const q of path) {
      len += Math.hypot(q.x - p.x, q.y - p.y);
      p = q;
    }
    return len;
  }

  /** Walking cost in meters to every cell reachable within `budget` meters (cell index → cost). */
  reach(from: Vec2, budget: number, o: NavPathOptions = {}): Map<number, number> {
    const { cells, costs } = this.reachCells(from, budget, o);
    const out = new Map<number, number>();
    for (let k = 0; k < cells.length; k++) out.set(cells[k]!, costs[k]!);
    return out;
  }

  /** The same as `reach`, as cell indices in the order the walk finds them and their costs. */
  reachCells(from: Vec2, budget: number, o: NavPathOptions = {}): { cells: number[]; costs: number[] } {
    const [sx, sy] = this.cellOf(from.x, from.y);
    const { found, cost } = reachable({ x: sx, y: sy }, budget / NAV_CELL, this.gridOptions(o));
    return { cells: found, costs: found.map((i) => cost[i]! * NAV_CELL) };
  }

  /** The nearest walkable point to p (searching outwards up to `maxR` meters), or null. */
  nearestWalkable(p: Vec2, maxR = 6, ok: (cx: number, cy: number) => boolean = (cx, cy) => this.walkableCell(cx, cy)): Vec2 | null {
    const [px, py] = this.cellOf(p.x, p.y);
    if (ok(px, py)) return p;
    const R = Math.ceil(maxR / NAV_CELL);
    for (let r = 1; r <= R; r++) {
      let best: Vec2 | null = null, bd = Infinity;
      for (let dy = -r; dy <= r; dy++)
        for (let dx = -r; dx <= r; dx++) {
          if (Math.max(Math.abs(dx), Math.abs(dy)) !== r || !ok(px + dx, py + dy)) continue;
          const c = this.center(px + dx, py + dy);
          const d = Math.hypot(c.x - p.x, c.y - p.y);
          if (d < bd) (bd = d), (best = c);
        }
      if (best) return best;
    }
    return null;
  }

  /**
   * The road a way out at `f` covers. One at the map's edge stands a few meters in (where people arriving by it stand,
   * clear of the mist), while its road runs on to the edge: the way out is all of that last stretch, so it can be
   * pointed at and used wherever one walks along it. One drawn inside the map (a door, a cave mouth) is its spot.
   */
  wayOut(f: Vec2): WayOut {
    const W = this.cols * NAV_CELL, H = this.rows * NAV_CELL;
    const out = [
      { d: f.x, ux: -1, uy: 0 },
      { d: W - f.x, ux: 1, uy: 0 },
      { d: f.y, ux: 0, uy: -1 },
      { d: H - f.y, ux: 0, uy: 1 },
    ].reduce((m, e) => (e.d < m.d ? e : m));
    if (out.d >= EDGE_WAY_M) return { from: f, to: f };
    // Straight out toward the edge while there is ground (half a meter either side, for a road that wanders).
    let far = 0;
    for (let s = 0.25; s < out.d; s += 0.25) {
      const open = [-0.5, 0, 0.5].some((k) => this.walkable(f.x + out.ux * s - out.uy * k, f.y + out.uy * s + out.ux * k));
      if (!open) break;
      far = s;
    }
    return { from: f, to: { x: f.x + out.ux * far, y: f.y + out.uy * far }, out: { x: out.ux, y: out.uy } };
  }

  /**
   * Where a party coming in at `at` (a way out at the map's edge, or a door) stands: the nearest open ground by walking,
   * a step or more away and never nearer the map's edge (the way out's cleared gap through the barrier is open too),
   * so it does not arrive lined up single file in a narrow way in. The most open spot within `within` meters when
   * none is open all round.
   */
  arrival(at: Vec2, within = 8): Vec2 {
    const start = this.walkable(at.x, at.y) ? at : this.nearestWalkable(at);
    if (!start) return at;
    const W = this.cols * NAV_CELL, H = this.rows * NAV_CELL, edge = (p: Vec2) => Math.min(p.x, p.y, W - p.x, H - p.y);
    const R = 1.5, full = this.cellsWithin(this.center(Math.floor(this.cols / 2), Math.floor(this.rows / 2)), R, false).length;
    let best: { p: Vec2; open: number } | undefined;
    for (const [i, cost] of [...this.reach(start, within)].sort((a, b) => a[1] - b[1])) {
      const p = this.center(i % this.cols, Math.floor(i / this.cols));
      if (cost < 1.5 || edge(p) < edge(start)) continue;
      const open = this.cellsWithin(p, R).length;
      if (open >= 0.95 * full) return p;
      if (!best || open > best.open) best = { p, open };
    }
    return best?.p ?? start;
  }

  /** Indices of the cells within r meters of p: the walkable ones, or all of them. */
  cellsWithin(p: Vec2, r: number, walkableOnly = true): number[] {
    const out: number[] = [];
    const [px, py] = this.cellOf(p.x, p.y);
    const R = Math.ceil(r / NAV_CELL);
    for (let cy = Math.max(0, py - R); cy <= Math.min(this.rows - 1, py + R); cy++)
      for (let cx = Math.max(0, px - R); cx <= Math.min(this.cols - 1, px + R); cx++) {
        const c = this.center(cx, cy);
        if (Math.hypot(c.x - p.x, c.y - p.y) > r) continue;
        if (walkableOnly && !this.walkableCell(cx, cy)) continue;
        out.push(cy * this.cols + cx);
      }
    return out;
  }
}

/** A navigation grid from tests at each cell's center (arenas and tests). */
export function makeNav(width: number, height: number, walk: (x: number, y: number) => boolean, sight: (x: number, y: number) => boolean = walk): NavDef {
  const cols = Math.ceil(width / NAV_CELL), rows = Math.ceil(height / NAV_CELL);
  const w = new BitSet(cols * rows), s = new BitSet(cols * rows);
  for (let cy = 0; cy < rows; cy++)
    for (let cx = 0; cx < cols; cx++) {
      const x = (cx + 0.5) * NAV_CELL, y = (cy + 0.5) * NAV_CELL;
      if (walk(x, y)) w.set(cy * cols + cx);
      if (sight(x, y)) s.set(cy * cols + cx);
    }
  return { cols, rows, walk: w.encode(), sight: s.encode() };
}

/** Explored ground is remembered per square meter: a bitset of fog.w × fog.h. */
export const fogSize = (z: { width: number; height: number }) => ({ w: Math.ceil(z.width), h: Math.ceil(z.height) });
