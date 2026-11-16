/**
 * Where one can walk, shown on the ground: the marker of the spot a click walks to, the edge of the walkable ground
 * about a party walked with a stick, and the developer's view of the walk grid.
 */
import { NAV_CELL, type Vec2 } from '@daydream/shared';
import type { ZoneData } from '../net/game';
import { M, pic, type View } from './view';
import type { SteerPredictor } from './predict';

/** Size (m) of the squares the walkable outline is filed under, so a frame draws only the part near the mouse. */
const OUTLINE_BUCKET = 4;

export class WalkHints {
  private v: View;
  private steering: SteerPredictor;

  constructor(v: View, steering: SteerPredictor) {
    this.v = v;
    this.steering = steering;
  }

  /** Where the last click or tap is walking the party (cleared on arrival), and when it was given. */
  private dest: { x: number; y: number; t: number } | null = null;

  /**
   * Where a click at `p` walks to: the spot itself, or the nearest one someone can stand on when it is a wall, a tree
   * or water (null when there is none near, and a click there does nothing).
   */
  walkTarget(p: Vec2): Vec2 | null {
    return this.v.client.state.zone?.walk.nearestWalkable(p, 2.5) ?? null;
  }

  /** Show where the party is walking: a marker that settles on the spot and stays until they get there. */
  markDestination(p: Vec2) {
    this.dest = { x: p.x, y: p.y, t: this.v.t };
  }

  /**
   * Where one can walk, said by showing where one will go rather than with symbols to learn. Under the mouse is the
   * marker of the spot a click walks to; over a wall or water it moves to the nearest spot one can stand on, with a
   * faint thread from the pointer, so the click visibly goes there instead. After a click (or a tap) the same marker
   * settles on the spot and stays until the party arrives. With a controller or a finger's stick there is no pointer:
   * the edge of the walkable ground fades in around the leader instead.
   */
  drawWalkHints(z: ZoneData) {
    const st = this.v.client.state;
    if (st.combat || st.dialog) this.dest = null;
    if (st.combat || st.dialog || st.panel || st.targeting) return;
    const leader = this.v.client.leaderEntity();
    const at = leader ? this.v.client.entityPos(leader) : null;
    if (this.dest && (!at || Math.hypot(at.x - this.dest.x, at.y - this.dest.y) < 0.4 || this.v.t - this.dest.t > 8)) this.dest = null;
    if (this.dest) {
      // Settles from wide and faint to its place in a fifth of a second, then breathes.
      const k = Math.min(1, (this.v.t - this.dest.t) / 0.2), ease = 1 - (1 - k) ** 3;
      this.walkMark(this.dest, 0.3 + 0.35 * (1 - ease) + 0.025 * Math.sin((this.v.t - this.dest.t) * 5), 0.85 * ease);
    }
    if (this.steering.steer) {
      // A stick has no pointer: the ground's edge lights where it pushes, brighter where the walk is held back.
      if (at) {
        const held = this.steering.push.how === 'free' ? 0 : Math.min(1, (this.v.t - this.steering.push.since) / 0.15);
        this.walkEdges(z, at, 2.6 + 0.6 * held, 0.4 + 0.45 * held, this.steering.steer);
      }
      return;
    }
    if (st.inputMode === 'pad') return;
    const h = this.v.hover.point;
    if (!h || this.v.hover.entityId || this.v.hover.featureId || this.v.hover.lootId) return;
    const to = this.walkTarget(h);
    if (!to || (this.dest && Math.hypot(to.x - this.dest.x, to.y - this.dest.y) < 0.3)) return;
    if (Math.hypot(to.x - h.x, to.y - h.y) > 0.15) {
      // A thread that gathers toward the marker: it reads as "the click goes there", not as a warning (the click
      // still walks, so nothing here is red).
      const ctx = this.v.ctx, a = pic(h.x, h.y), b = pic(to.x, to.y);
      const g = ctx.createLinearGradient(a.x, a.y, b.x, b.y);
      g.addColorStop(0, 'rgba(255,248,225,0)');
      g.addColorStop(1, 'rgba(255,248,225,0.6)');
      ctx.save();
      ctx.strokeStyle = g;
      ctx.lineWidth = 1.5;
      ctx.lineCap = 'round';
      ctx.setLineDash([0.1, 5]);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.lineTo(b.x, b.y);
      ctx.stroke();
      ctx.restore();
    }
    this.walkMark(to, 0.3, 0.55);
  }

  /** The walk marker: a ring on the ground with a dot at its heart, in the warm light of the interface. */
  private walkMark(p: Vec2, r: number, alpha: number) {
    const ctx = this.v.ctx, c = pic(p.x, p.y);
    ctx.save();
    ctx.shadowColor = `rgba(0,0,0,${(0.7 * alpha).toFixed(3)})`;
    ctx.shadowBlur = 4;
    ctx.strokeStyle = `rgba(255,248,225,${alpha.toFixed(3)})`;
    ctx.lineWidth = 2;
    this.v.groundCircle(p.x, p.y, r);
    ctx.stroke();
    ctx.fillStyle = `rgba(255,248,225,${alpha.toFixed(3)})`;
    ctx.beginPath();
    ctx.ellipse(c.x, c.y, 0.06 * M, 0.06 * M, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  /** The walkable ground's outline: smooth segments in meters, bucketed by OUTLINE_BUCKET-meter squares. */
  private outline: { key: string; seg: Float32Array; buckets: Map<number, number[]>; bw: number } | null = null;

  /**
   * The edge of the walkable ground as a smooth line: marching squares at the half-way level over the walk grid
   * softened twice (cell corners, then a 3×3 blur), so it follows the ground in slopes and curves, not cell steps.
   * Made once per place.
   */
  private walkOutline(z: ZoneData) {
    const key = `${this.v.zoneKey}`;
    if (this.outline?.key === key) return this.outline;
    const nav = z.walk, C = nav.cols + 1, R = nav.rows + 1;
    const corner = new Float32Array(C * R);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < C; x++) {
        let open = 0;
        for (const [i, j] of [[x - 1, y - 1], [x, y - 1], [x - 1, y], [x, y]] as const) if (nav.walkableCell(i, j)) open++;
        corner[y * C + x] = open / 4;
      }
    const f = new Float32Array(C * R);
    for (let y = 0; y < R; y++)
      for (let x = 0; x < C; x++) {
        let sum = 0, n = 0;
        for (let j = Math.max(0, y - 1); j <= Math.min(R - 1, y + 1); j++)
          for (let i = Math.max(0, x - 1); i <= Math.min(C - 1, x + 1); i++) (sum += corner[j * C + i]!), n++;
        f[y * C + x] = sum / n;
      }
    const out: number[] = [];
    const at = (x0: number, y0: number, v0: number, x1: number, y1: number, v1: number) => {
      const t = (0.5 - v0) / (v1 - v0);
      return [(x0 + (x1 - x0) * t) * NAV_CELL, (y0 + (y1 - y0) * t) * NAV_CELL];
    };
    for (let y = 0; y < R - 1; y++)
      for (let x = 0; x < C - 1; x++) {
        const a = f[y * C + x]!, b = f[y * C + x + 1]!, c = f[(y + 1) * C + x + 1]!, d = f[(y + 1) * C + x]!;
        // Crossings on the top, right, bottom, and left sides of this square (or none).
        const top = (a >= 0.5) !== (b >= 0.5) ? at(x, y, a, x + 1, y, b) : null;
        const right = (b >= 0.5) !== (c >= 0.5) ? at(x + 1, y, b, x + 1, y + 1, c) : null;
        const bottom = (d >= 0.5) !== (c >= 0.5) ? at(x, y + 1, d, x + 1, y + 1, c) : null;
        const left = (a >= 0.5) !== (d >= 0.5) ? at(x, y, a, x, y + 1, d) : null;
        const pts = [top, right, bottom, left].filter((q): q is number[] => !!q);
        if (pts.length === 2) out.push(...pts[0]!, ...pts[1]!);
        else if (pts.length === 4) {
          // A saddle: the center decides which corners join.
          const joinAB = ((a + b + c + d) / 4 >= 0.5) === (a >= 0.5);
          if (joinAB) out.push(...top!, ...right!, ...bottom!, ...left!);
          else out.push(...top!, ...left!, ...bottom!, ...right!);
        }
      }
    const seg = Float32Array.from(out), bw = Math.ceil((nav.cols * NAV_CELL) / OUTLINE_BUCKET) + 1;
    const buckets = new Map<number, number[]>();
    for (let i = 0; i < seg.length; i += 4) {
      const k = Math.floor((seg[i + 1]! + seg[i + 3]!) / 2 / OUTLINE_BUCKET) * bw + Math.floor((seg[i]! + seg[i + 2]!) / 2 / OUTLINE_BUCKET);
      (buckets.get(k) ?? buckets.set(k, []).get(k)!).push(i);
    }
    return (this.outline = { key, seg, buckets, bw });
  }

  /**
   * The walkable ground's edge within `R` meters of `at`, fading outward; with `dir`, only the edge ahead that way
   * (and whatever is right at hand), as a lantern held in the walking direction.
   */
  private walkEdges(z: ZoneData, at: Vec2, R: number, alpha: number, dir?: Vec2) {
    const ctx = this.v.ctx, o = this.walkOutline(z);
    ctx.save();
    ctx.lineWidth = 2;
    ctx.lineCap = 'round';
    ctx.shadowColor = 'rgba(255,240,200,0.6)';
    ctx.shadowBlur = 4;
    const bx0 = Math.floor((at.x - R) / OUTLINE_BUCKET), bx1 = Math.floor((at.x + R) / OUTLINE_BUCKET);
    const by0 = Math.floor((at.y - R) / OUTLINE_BUCKET), by1 = Math.floor((at.y + R) / OUTLINE_BUCKET);
    for (let by = by0; by <= by1; by++)
      for (let bx = bx0; bx <= bx1; bx++)
        for (const i of o.buckets.get(by * o.bw + bx) ?? []) {
          const s = o.seg, d = Math.hypot((s[i]! + s[i + 2]!) / 2 - at.x, (s[i + 1]! + s[i + 3]!) / 2 - at.y);
          if (d >= R) continue;
          let a = alpha * (1 - d / R);
          if (dir) {
            const mx = (s[i]! + s[i + 2]!) / 2 - at.x, my = (s[i + 1]! + s[i + 3]!) / 2 - at.y;
            const ahead = (mx * dir.x + my * dir.y) / (d || 1) / (Math.hypot(dir.x, dir.y) || 1);
            a *= Math.max(Math.min(1, Math.max(0, ahead + 0.25) / 0.85) ** 1.5, d < 0.7 ? 1 - d / 0.7 : 0);
          }
          if (a < 0.01) continue;
          const p = pic(s[i]!, s[i + 1]!), q = pic(s[i + 2]!, s[i + 3]!);
          ctx.strokeStyle = `rgba(255,244,215,${a.toFixed(3)})`;
          ctx.beginPath();
          ctx.moveTo(p.x, p.y);
          ctx.lineTo(q.x, q.y);
          ctx.stroke();
        }
    ctx.restore();
  }

  /** Developer view of the navigation grid. */
  drawWalkable(z: ZoneData) {
    const ctx = this.v.ctx;
    const nav = z.walk;
    const view = [this.v.screenToGround(0, 0), this.v.screenToGround(this.v.W, 0), this.v.screenToGround(0, this.v.H), this.v.screenToGround(this.v.W, this.v.H)];
    const [x0, y0] = nav.cellOf(Math.min(...view.map((v) => v.x)), Math.min(...view.map((v) => v.y)));
    const [x1, y1] = nav.cellOf(Math.max(...view.map((v) => v.x)), Math.max(...view.map((v) => v.y)));
    for (let cy = Math.max(0, y0); cy <= Math.min(nav.rows - 1, y1); cy++)
      for (let cx = Math.max(0, x0); cx <= Math.min(nav.cols - 1, x1); cx++) {
        const walk = nav.walkableCell(cx, cy), sight = nav.seeThroughCell(cx, cy);
        if (!walk && sight) continue;
        const p = pic((cx + 0.5) * NAV_CELL, (cy + 0.5) * NAV_CELL);
        ctx.fillStyle = walk ? 'rgba(60,220,90,0.28)' : 'rgba(60,110,255,0.3)';
        ctx.fillRect(p.x - (M * NAV_CELL) / 2, p.y - (M * NAV_CELL) / 2, M * NAV_CELL, M * NAV_CELL);
      }
  }
}
