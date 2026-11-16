/**
 * How people walk among each other on a place's ground (meters), shared by the server's rules and the client's
 * previews. People are discs of BODY meters, so two never stand closer than SPACING; a walk goes around strangers
 * and can squeeze past allies at a cost.
 */
import { NAV_CELL, type Nav, type NavPathOptions } from './nav.ts';
import type { Vec2 } from '../util/grid.ts';

/** A person's radius in meters. */
export const BODY = 0.45;
/** The closest two people stand. */
export const SPACING = 2 * BODY;
/** Extra walking cost (meters) per meter walked through an ally. */
export const SQUEEZE = 2;
/** How fast a hero walks (meters a second): on the server, and on the screen of a player steering their leader. */
export const WALK_SPEED = 4.2;
/** How far a hero sees (meters): the server uncovers the ground this near, and the client dims remembered ground past it. */
export const SIGHT_RADIUS = 11;
/**
 * Walking with a stick. The client tells the server the direction again every STEER_REMIND_MS while the stick is
 * held, and the server stops a party it has not heard from for STEER_TIMEOUT_MS: several reminders, so one that
 * comes late does not stop the walk.
 */
export const STEER_REMIND_MS = 150;
export const STEER_TIMEOUT_MS = 700;
/**
 * How far (meters) a steered leader may be on the walker's screen from where the server has them: within it the
 * server takes the screen's place, and beyond it the screen takes the server's.
 */
export const STEER_TRUST_M = 6;

/** Someone else on the ground, as a walk sees them. */
interface Walker extends Vec2 {
  ally: boolean;
}

/** Within SPACING of someone in the list. */
const crowded = (others: Vec2[], p: Vec2) => others.some((o) => Math.hypot(o.x - p.x, o.y - p.y) < SPACING - 0.01);

/**
 * The cells (index cy * cols + cx) whose centers are crowded by someone in the list: each body marks the few cells
 * around it, which answers `crowded` for every cell at once.
 */
export function crowdedCells(nav: Nav, others: Vec2[]): Set<number> {
  const out = new Set<number>();
  const r = Math.ceil(SPACING / NAV_CELL) + 1;
  for (const o of others) {
    const [ox, oy] = nav.cellOf(o.x, o.y);
    for (let cy = Math.max(0, oy - r); cy <= Math.min(nav.rows - 1, oy + r); cy++)
      for (let cx = Math.max(0, ox - r); cx <= Math.min(nav.cols - 1, ox + r); cx++) {
        const c = nav.center(cx, cy);
        if (Math.hypot(o.x - c.x, o.y - c.y) < SPACING - 0.01) out.add(cy * nav.cols + cx);
      }
  }
  return out;
}

/** Walking options among others: a stranger's body blocks, an ally's costs SQUEEZE per meter. */
export function walkAmong(nav: Nav, others: Walker[]): NavPathOptions {
  return walkAmongCells(nav, crowdedCells(nav, others.filter((o) => !o.ally)), crowdedCells(nav, others.filter((o) => o.ally)));
}

/** Walking options given the cells strangers and allies crowd (`crowdedCells`). */
export function walkAmongCells(nav: Nav, strangers: Set<number>, allies: Set<number>): NavPathOptions {
  return {
    blocked: strangers.size ? (cx, cy) => strangers.has(cy * nav.cols + cx) : undefined,
    extraCost: (cx, cy) => (allies.has(cy * nav.cols + cx) ? NAV_CELL * SQUEEZE : 0),
  };
}

/** The extra cost per meter at p of walking among these allies (plus `cost`). */
export const squeezeCost = (allies: Vec2[], cost?: (p: Vec2) => number) => (p: Vec2) => (crowded(allies, p) ? SQUEEZE : 0) + (cost?.(p) ?? 0);

/** Cost of walking a path: meters plus the extra cost per meter `extra` gives, sampled every quarter meter. */
export function walkCost(from: Vec2, path: Vec2[], extra: (p: Vec2) => number): number {
  let total = 0, p = from;
  for (const q of path) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) total += (len / n) * (1 + extra({ x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n }));
    p = q;
  }
  return total;
}

/**
 * The part of a path that costs at most `budget` (ending exactly where the budget runs out), backed off until
 * it ends on a free spot. Empty when not even a step fits.
 */
export function cutPath(from: Vec2, path: Vec2[], budget: number, extra: (p: Vec2) => number, free: (p: Vec2) => boolean): Vec2[] {
  const out: Vec2[] = [];
  let spent = 0, p = from;
  walk: for (const q of path) {
    const len = Math.hypot(q.x - p.x, q.y - p.y);
    const n = Math.max(1, Math.ceil(len / 0.25));
    for (let i = 1; i <= n; i++) {
      const s = { x: p.x + ((q.x - p.x) * i) / n, y: p.y + ((q.y - p.y) * i) / n };
      const step = (len / n) * (1 + extra(s));
      if (spent + step > budget + 1e-6) {
        if (i > 1) out.push({ x: p.x + ((q.x - p.x) * (i - 1)) / n, y: p.y + ((q.y - p.y) * (i - 1)) / n });
        break walk;
      }
      spent += step;
    }
    out.push(q);
    p = q;
  }
  // Never stop inside someone: step back along the walk until the spot is free.
  while (out.length) {
    const end = out[out.length - 1]!;
    if (free(end)) return out;
    const prev = out.length > 1 ? out[out.length - 2]! : from;
    const len = Math.hypot(end.x - prev.x, end.y - prev.y);
    if (len <= 0.25) out.pop();
    else out[out.length - 1] = { x: end.x + ((prev.x - end.x) * 0.25) / len, y: end.y + ((prev.y - end.y) * 0.25) / len };
  }
  return out;
}
