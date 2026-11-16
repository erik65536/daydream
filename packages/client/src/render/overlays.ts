/**
 * What a fight and aiming draw on the ground: how far the one acting can walk and the walk to the pointer, the reach
 * of what is aimed and the area or target under the pointer, and friends' aims.
 */
import { NAV_CELL, SPACING, itemSkill, rx, squeezeCost, walkAmong, walkCost, type Aim, type EntityView } from '@daydream/shared';
import type { ZoneData } from '../net/game';
import { aimVerdict, type AimVerdict } from './aiming';
import { pic, type View } from './view';

/** Line segments (meters) tracing where `inside` changes over a grid of half-meter cells (marching squares). */
function contour(cols: number, rows: number, inside: (cx: number, cy: number) => boolean): number[] {
  const out: number[] = [];
  const v = (cx: number, cy: number) => (cx >= 0 && cy >= 0 && cx < cols && cy < rows && inside(cx, cy) ? 1 : 0);
  // Corners are cell centers; edges cut halfway between them.
  const c = (cx: number) => (cx + 0.5) * NAV_CELL;
  for (let cy = -1; cy < rows; cy++)
    for (let cx = -1; cx < cols; cx++) {
      const a = v(cx, cy), b = v(cx + 1, cy), d = v(cx, cy + 1), e = v(cx + 1, cy + 1);
      const k = a | (b << 1) | (e << 2) | (d << 3);
      if (k === 0 || k === 15) continue;
      const x0 = c(cx), x1 = c(cx + 1), y0 = c(cy), y1 = c(cy + 1), xm = (x0 + x1) / 2, ym = (y0 + y1) / 2;
      const top = [xm, y0], right = [x1, ym], bottom = [xm, y1], left = [x0, ym];
      const seg = (p: number[], q: number[]) => out.push(p[0]!, p[1]!, q[0]!, q[1]!);
      switch (k) {
        case 1: case 14: seg(left, top); break;
        case 2: case 13: seg(top, right); break;
        case 3: case 12: seg(left, right); break;
        case 4: case 11: seg(right, bottom); break;
        case 6: case 9: seg(top, bottom); break;
        case 7: case 8: seg(left, bottom); break;
        case 5: seg(left, top); seg(right, bottom); break;
        case 10: seg(top, right); seg(left, bottom); break;
      }
    }
  return out;
}

export class Overlays {
  private v: View;

  constructor(v: View) {
    this.v = v;
  }

  /** Those the area being aimed would catch, with the color they glow in. */
  caught = new Map<string, string>();
  reach: { key: string; cells: Map<number, number>; lines: number[][] } | null = null;

  /** Others in the fight, as the active fighter's walk sees them (strangers block, allies can be squeezed past). */
  private walkersFor(active: EntityView) {
    const st = this.v.client.state;
    return [...st.entities.values()].filter((e) => e.id !== active.id && !e.dead && e.inCombat).map((e) => ({ x: e.x, y: e.y, ally: e.hostile === active.hostile }));
  }

  drawGroundOverlays(z: ZoneData) {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    const combat = st.combat;
    const active = combat ? st.entities.get(this.v.client.myActor() ?? combat.activeId) : undefined;
    const myTurn = this.v.client.isMyTurn() && active;
    const ch = active ? st.player?.party.find((c) => c.id === active.id) : undefined;
    const tgt = st.targeting;
    const nav = z.walk;
    this.drawFriendAims();
    let aim: Aim | null = null;
    // How far the active character can move this turn: a soft area with a ring at its edge and at each AP step.
    if (myTurn && ch && !tgt?.skillId && !tgt?.itemId) {
      const stats = this.v.client.charStats(ch);
      const order = combat!.order.find((o) => o.id === active!.id)!;
      const budget = order.movementLeft + order.ap * stats.move;
      const apOf = (cost: number) => (cost <= order.movementLeft ? 0 : Math.ceil((cost - order.movementLeft) / stats.move));
      const others = this.walkersFor(active!);
      const key = `${active!.x.toFixed(2)},${active!.y.toFixed(2)},${budget},${combat!.round},${others.map((o) => `${o.x.toFixed(1)},${o.y.toFixed(1)}`).join(';')}`;
      if (this.reach?.key !== key) {
        const cells = nav.reach(active!, budget, walkAmong(nav, others));
        // Nobody can stop where someone already stands.
        for (const i of [...cells.keys()]) {
          const c = nav.center(i % nav.cols, Math.floor(i / nav.cols));
          if (others.some((o) => Math.hypot(o.x - c.x, o.y - c.y) < SPACING - 0.01)) cells.delete(i);
        }
        const bands = Math.max(0, ...[...cells.values()].map(apOf));
        const lines = Array.from({ length: bands + 1 }, (_, b) => contour(nav.cols, nav.rows, (cx, cy) => {
          const c = cells.get(cy * nav.cols + cx);
          return c !== undefined && apOf(c) <= b;
        }));
        this.reach = { key, cells, lines };
      }
      ctx.save();
      ctx.lineCap = 'round';
      this.reach.lines.forEach((segs, b) => {
        const last = b === this.reach!.lines.length - 1;
        ctx.strokeStyle = last ? 'rgba(140,220,255,0.85)' : 'rgba(140,220,255,0.35)';
        ctx.lineWidth = last ? 2.2 : 1.4;
        ctx.shadowColor = 'rgba(60,160,255,0.9)';
        ctx.shadowBlur = last ? 6 : 0;
        ctx.beginPath();
        for (let i = 0; i < segs.length; i += 4) {
          const a = pic(segs[i]!, segs[i + 1]!), c = pic(segs[i + 2]!, segs[i + 3]!);
          ctx.moveTo(a.x, a.y);
          ctx.lineTo(c.x, c.y);
        }
        ctx.stroke();
      });
      ctx.restore();
      // The walk to the hovered point, and what it costs.
      const h = this.v.hover.point;
      if (h && !this.v.hover.entityId && nav.walkable(h.x, h.y)) {
        const path = nav.path(active!, h, { ...walkAmong(nav, others), maxNodes: 12000 });
        if (path?.length) {
          const len = walkCost(active!, path, squeezeCost(others.filter((o) => o.ally)));
          ctx.strokeStyle = 'rgba(255,240,180,0.9)';
          ctx.setLineDash([4, 4]);
          ctx.lineWidth = 2;
          ctx.beginPath();
          const s0 = pic(active!.x, active!.y);
          ctx.moveTo(s0.x, s0.y);
          for (const t of path) {
            const s = pic(t.x, t.y);
            ctx.lineTo(s.x, s.y);
          }
          ctx.stroke();
          ctx.setLineDash([]);
          const cost = apOf(len);
          const ok = len <= budget + 1e-6;
          ctx.fillStyle = ok ? 'rgba(255,230,140,0.3)' : 'rgba(255,80,60,0.3)';
          ctx.strokeStyle = ok ? 'rgba(255,230,140,0.9)' : 'rgba(255,80,60,0.9)';
          this.v.groundCircle(h.x, h.y, 0.4);
          ctx.fill();
          ctx.stroke();
          this.cursorNote = { text: ok ? `${cost} ${st.world?.ruleset.terminology.actionPoints ?? 'AP'}` : 'Too far', ok };
          if (ok) aim = { charId: active!.id, move: true, x: h.x, y: h.y };
        }
      }
    }
    // Skill and item targeting: the range ring, and the area or target under the cursor.
    this.caught.clear();
    // What is being aimed is good only once this frame finds where it points and that it can be used there.
    this.aimValid = !(tgt && (tgt.skillId || tgt.itemId));
    this.aim = null;
    if (tgt && (tgt.skillId || tgt.itemId)) {
      const user = st.entities.get(tgt.charId);
      const skill = tgt.skillId && st.world ? rx(st.world.ruleset).skill.get(tgt.skillId) : undefined;
      const chr = st.player?.party.find((c) => c.id === tgt.charId);
      if (user && chr) {
        const stats = this.v.client.charStats(chr);
        const item = tgt.itemId ? st.player?.inventory.find((i) => i.id === tgt.itemId) : undefined;
        const base = item && st.world ? rx(st.world.ruleset).item.get(item.baseId) : undefined;
        // (An item is aimed as the server uses it: the same reach and area.)
        const thrown = base?.use ? itemSkill(base) : undefined;
        const up = this.v.client.entityPos(user);
        const verdict = (this.aim = aimVerdict({ r: st.world!.ruleset, skill, thrown, stats, from: up, point: this.v.hover.point, sees: (a, b) => nav.sees(a, b), entities: st.entities.values(), at: (e) => this.v.client.entityPos(e) }));
        const { range, radius, center } = verdict;
        if (range > 0) {
          ctx.save();
          ctx.strokeStyle = 'rgba(255,230,150,0.55)';
          ctx.setLineDash([6, 6]);
          ctx.lineWidth = 2;
          this.v.groundCircle(up.x, up.y, range);
          ctx.stroke();
          ctx.restore();
        }
        if (center) {
          for (const id of verdict.caught) this.caught.set(id, verdict.harmful ? 'rgba(255,80,60,0.95)' : 'rgba(150,255,170,0.95)');
          const color = verdict.ok ? '255,220,120' : '255,80,60';
          ctx.fillStyle = `rgba(${color},${radius ? 0.22 : 0.3})`;
          ctx.strokeStyle = `rgba(${color},0.9)`;
          this.v.groundCircle(center.x, center.y, radius || 0.45);
          ctx.fill();
          ctx.stroke();
          this.cursorNote = verdict.note;
          this.aimValid = verdict.ok;
          if (combat) aim = { charId: tgt.charId, skillId: tgt.skillId, itemId: tgt.itemId, x: center.x, y: center.y };
        }
      }
    }
    // Friends see where one aims during a fight.
    if (combat) this.v.client.aim(aim);
  }

  /**
   * Friends' aims during a fight, in their colors: a faint line from their hero to the point, and the area their
   * skill or item would cover there (a small mark for a walk).
   */
  private drawFriendAims() {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    const now = Date.now();
    for (const [userId, a] of st.aims) {
      if (now - a.at > 4000) continue;
      const e = st.entities.get(a.charId);
      if (!e || e.dead) continue;
      const from = this.v.client.entityPos(e);
      const ix = st.world ? rx(st.world.ruleset) : undefined;
      const skill = a.skillId ? ix?.skill.get(a.skillId) : undefined;
      const radius = skill?.radius ?? (a.itemId ? 0.6 : 0);
      const color = this.v.client.colorOf(userId);
      ctx.save();
      ctx.globalAlpha = 0.85;
      ctx.strokeStyle = color;
      ctx.lineWidth = 2;
      ctx.setLineDash(a.move ? [3, 5] : [7, 5]);
      ctx.beginPath();
      const s0 = pic(from.x, from.y), s1 = pic(a.x, a.y);
      ctx.moveTo(s0.x, s0.y);
      ctx.lineTo(s1.x, s1.y);
      ctx.stroke();
      ctx.setLineDash([]);
      ctx.fillStyle = color;
      ctx.globalAlpha = a.move ? 0.25 : radius ? 0.16 : 0.3;
      this.v.groundCircle(a.x, a.y, a.move ? 0.35 : radius || 0.45);
      ctx.fill();
      ctx.globalAlpha = 0.9;
      ctx.stroke();
      ctx.restore();
    }
  }

  cursorNote: { text: string; ok: boolean } | null = null;

  /** Whether the skill or item being aimed could be used where it points now (false out of range or sight). */
  aimValid = true;
  /** The verdict on what is being aimed where the pointer is (see aiming.ts); null while nothing is aimed. */
  aim: AimVerdict | null = null;
}
