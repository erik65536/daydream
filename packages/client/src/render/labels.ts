/**
 * Words and marks over the place, in screen pixels: names, Health and statuses over heads, quest marks, whose turn
 * it is, what people say, friends out of view, and the name of what the pointer is on.
 */
import { PX_PER_METER, nearestOnWay, rx, type EntityView, type FeatureDef } from '@daydream/shared';
import type { ZoneData } from '../net/game';
import { drawShapeIcon } from './fx';
import { drawMark, seedOf, type MarkKind } from './marks';
import { statusLook } from '../rules';
import type { View } from './view';
import { OBJECT_ART } from './things';

export class Labels {
  private v: View;

  constructor(v: View) {
    this.v = v;
  }

  labels: { e: EntityView; x: number; y: number; hovered: boolean; marker?: MarkKind; inCombat: boolean; acting?: 'lead' | 'also' }[] = [];

  /**
   * Over whoever acts: a bobbing pointer, so the one whose turn it is stands out in a crowd. Gold over the hero the
   * player commands now (smaller over their other heroes sharing the turn) and over every other hero acting,
   * red over a foe.
   */
  private turnMarker(x: number, y: number, acting: 'lead' | 'also', hostile?: boolean) {
    const ctx = this.v.ctx;
    const k = acting === 'lead' ? 1 : 0.7;
    const bob = this.v.fx.calm ? 0 : Math.sin(this.v.t * 4.2) * 3;
    const color = hostile ? '#ff6a55' : acting === 'lead' ? '#ffd56a' : '#e9dcae';
    const w = 9 * k, h = 10 * k, ty = y - 4 + bob;
    ctx.save();
    ctx.lineJoin = 'round';
    ctx.beginPath();
    ctx.moveTo(x - w, ty - h);
    ctx.quadraticCurveTo(x, ty - h * 0.55, x + w, ty - h);
    ctx.lineTo(x, ty);
    ctx.closePath();
    ctx.shadowColor = color;
    ctx.shadowBlur = acting === 'lead' ? 10 : 0;
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fill();
    ctx.restore();
  }

  drawOverlayLabels(z: ZoneData) {
    const ctx = this.v.ctx;
    this.v.setScreenTransform();
    for (const l of this.labels) {
      const e = l.e;
      if (e.dead || !this.v.client.seen(e.x, e.y)) continue;
      // Friends' heroes always carry their names, in their player's color, with their Health once hurt.
      const friend = e.kind === 'character' && e.ownerUserId !== this.v.client.state.userId;
      const showBars = l.inCombat || l.hovered || (e.hp < e.maxHp && (e.kind === 'monster' || friend));
      let y = l.y;
      if (l.marker === 'hunt') {
        // Which creatures a quest counts, in a fight too: small, just over the head.
        drawMark(ctx, 'hunt', l.x, y - 16, this.v.t, seedOf(e.id), 40);
        y -= 26;
      } else if (l.marker && !l.inCombat) {
        drawMark(ctx, l.marker, l.x, y - 16, this.v.t, seedOf(e.id));
        y -= 30;
      }
      if (showBars) {
        const w = 54;
        const x0 = l.x - w / 2;
        let by = y - 4;
        const bar = (frac: number, color: string, h: number) => {
          ctx.fillStyle = 'rgba(0,0,0,0.7)';
          ctx.fillRect(x0 - 1, by - 1, w + 2, h + 2);
          ctx.fillStyle = color;
          ctx.fillRect(x0, by, w * Math.max(0, Math.min(1, frac)), h);
          by -= h + 2;
        };
        bar(e.hp / Math.max(1, e.maxHp), e.hostile ? '#c8322a' : '#3fb34a', 5);
        y = by - 2;
      }
      // Lasting states over the bar wherever a bar or a friend's name shows (the figure's aura shows them too).
      if ((showBars || friend) && e.statuses.length) y = this.statusRow(e.statuses, l.x, y);
      if (friend && !l.hovered) {
        this.outlinedText(e.name, l.x, y - 4, this.v.client.colorOf(e.ownerUserId), '600 11px Inter, sans-serif');
        y -= 14;
      }
      if (l.hovered || (e.bossId && l.inCombat)) {
        const name = `${e.name}${e.kind === 'monster' ? `  ·  ${this.v.client.state.world?.ruleset.terminology.level ?? 'Lv'} ${e.level}` : ''}`;
        this.outlinedText(name, l.x, y - 4, e.hostile ? '#ff9a8a' : e.kind === 'npc' ? '#f0e0b0' : this.v.client.colorOf(e.ownerUserId), `600 ${e.bossId ? 14 : 12}px Inter, sans-serif`);
        if (e.title && e.kind !== 'character') this.outlinedText(e.title, l.x, y - 18, '#d8ccb0', 'italic 11px "EB Garamond", serif');
      }
      if (l.acting) this.turnMarker(l.x, y - 6, l.acting, e.hostile);
      if (e.bark && e.bark.until > this.v.client.serverNow()) this.speechBubble(l.x, y - 22, e.bark.text);
    }
    this.labels = [];
    this.drawFriendArrows();
    // The hovered pile's best thing, in its color (a controller's prompt already names it).
    const pile = this.v.hover.lootId && this.v.client.state.inputMode !== 'pad' ? this.v.client.state.lootPiles.find((l) => l.id === this.v.hover.lootId) : undefined;
    if (pile) {
      const { text, color } = this.v.client.lootSummary(pile);
      const s = this.v.groundToScreen(pile.x, pile.y, 30);
      this.nameplate(text, s.x, s.y, color);
    }
    // The hovered feature's name.
    const f = this.v.hover.featureId ? z.features.find((x) => x.id === this.v.hover.featureId) : undefined;
    const name = f && this.featureLabel(f);
    if (f && name) {
      // (A way out's name stands over the part of its road the pointer is on.)
      const at = f.kind === 'exit' ? nearestOnWay(this.v.wayOf(f), this.v.hover.point ?? f) : f;
      const s = this.v.groundToScreen(at.x, at.y, (OBJECT_ART[f.kind]?.height ?? 1) * PX_PER_METER + 12);
      this.outlinedText(name, s.x, s.y, '#ffe8b0', '600 12px Inter, sans-serif');
    }
  }

  /** Words with a dark edge, so they read on any ground: centered on x (screen pixels), in `color`. */
  private outlinedText(text: string, x: number, y: number, color: string, font: string) {
    const ctx = this.v.ctx;
    ctx.font = font;
    ctx.textAlign = 'center';
    ctx.lineWidth = 3;
    ctx.strokeStyle = 'rgba(0,0,0,0.85)';
    ctx.strokeText(text, x, y);
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /**
   * A row of status icons centered on x with its bottom at y (screen pixels), each its own shape on a dark chip, a
   * harmful one with a red foot as in the party display; returns the y above it.
   */
  private statusRow(statuses: EntityView['statuses'], x: number, y: number): number {
    const ctx = this.v.ctx;
    const ix = rx(this.v.client.r);
    const list = statuses.slice(0, 5);
    const S = 12, gap = 2, w = list.length * S + (list.length - 1) * gap;
    const top = y - 2 - S;
    list.forEach((st, i) => {
      const cx = x - w / 2 + i * (S + gap);
      const look = statusLook(st.id);
      ctx.fillStyle = 'rgba(10, 9, 13, 0.82)';
      ctx.beginPath();
      ctx.roundRect(cx - 1, top - 1, S + 2, S + 2, 3);
      ctx.fill();
      ctx.save();
      ctx.translate(cx + 1, top + 1);
      drawShapeIcon(ctx, look.shapes[0]!, look.colors[0]!, S - 2);
      ctx.restore();
      if (ix.status.get(st.id)?.harmful) {
        ctx.fillStyle = '#e0604a';
        ctx.fillRect(cx + 1, top + S + 1, S - 2, 1.5);
      }
    });
    return top - 3;
  }

  /** A short label on a dark rounded backing, centered over (x, y) in screen pixels. */
  private nameplate(text: string, x: number, y: number, color: string) {
    const ctx = this.v.ctx;
    ctx.font = '600 12px Inter, sans-serif';
    ctx.textAlign = 'center';
    ctx.textBaseline = 'alphabetic';
    const w = ctx.measureText(text).width + 16, h = 20;
    ctx.fillStyle = 'rgba(10, 9, 11, 0.78)';
    ctx.strokeStyle = 'rgba(255, 224, 138, 0.28)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(Math.round(x - w / 2) + 0.5, Math.round(y - h + 5) + 0.5, Math.round(w), h, 6);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.fillText(text, x, y);
  }

  /** Friends in this place but out of sight: an arrow at the screen's edge toward their leader, in their color, with their name. */
  private drawFriendArrows() {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    const margin = 34;
    for (const r of st.roster) {
      if (r.userId === st.userId || !r.online || r.zoneId !== st.zone?.id) continue;
      const e = st.entities.get(r.leaderId);
      if (!e) continue;
      const p = this.v.client.entityPos(e);
      const s = this.v.groundToScreen(p.x, p.y, 40);
      if (s.x > margin && s.x < this.v.W - margin && s.y > margin && s.y < this.v.H - margin) continue;
      const cx = this.v.W / 2, cy = this.v.H / 2;
      const dx = s.x - cx, dy = s.y - cy;
      const k = Math.min((cx - margin) / Math.max(1e-6, Math.abs(dx)), (cy - margin) / Math.max(1e-6, Math.abs(dy)));
      const ax = cx + dx * k, ay = cy + dy * k, ang = Math.atan2(dy, dx);
      ctx.save();
      ctx.translate(ax, ay);
      ctx.rotate(ang);
      ctx.fillStyle = r.color;
      ctx.strokeStyle = 'rgba(0,0,0,0.8)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(12, 0);
      ctx.lineTo(-8, -9);
      ctx.lineTo(-4, 0);
      ctx.lineTo(-8, 9);
      ctx.closePath();
      ctx.stroke();
      ctx.fill();
      ctx.restore();
      this.outlinedText(r.name, ax - Math.cos(ang) * 18, ay + (dy > 0 ? -16 : 22), r.color, '600 11px Inter, sans-serif');
    }
  }

  private featureLabel(f: FeatureDef): string {
    const fs = this.v.client.state.features.get(f.id);
    switch (f.kind) {
      case 'exit':
        return f.name ?? 'Passage';
      case 'chest':
        return `${f.name ?? 'Chest'}${fs?.empty ? ' (empty)' : ''}`;
      default:
        return f.name ?? f.kind;
    }
  }

  /** Where the HUD stands over the view (`data-hud`), in the view's pixels: words in the world keep clear of it. Measured once a frame. */
  private hudAt = { t: -1, rects: [] as DOMRect[] };

  private hudRects(): DOMRect[] {
    if (this.hudAt.t === this.v.t) return this.hudAt.rects;
    const view = this.v.canvas.getBoundingClientRect();
    const rects = [...document.querySelectorAll('[data-hud]')].map((el) => el.getBoundingClientRect()).filter((r) => r.width && r.height).map((r) => new DOMRect(r.x - view.x, r.y - view.y, r.width, r.height));
    this.hudAt = { t: this.v.t, rects };
    return rects;
  }

  /**
   * Words over someone's head. A bubble that would fall under the HUD (a party display, the tracker) moves just clear
   * of it, without its tail, and none runs off the edge of the view.
   */
  private speechBubble(x: number, y: number, text: string) {
    const ctx = this.v.ctx;
    ctx.font = 'italic 14px "EB Garamond", serif';
    const lines: string[] = [];
    let cur = '';
    for (const w of text.split(' ')) {
      if (ctx.measureText(`${cur} ${w}`).width > 200 && cur) {
        lines.push(cur);
        cur = w;
      } else cur = cur ? `${cur} ${w}` : w;
    }
    if (cur) lines.push(cur);
    const w = Math.min(220, Math.max(...lines.map((l) => ctx.measureText(l).width)) + 18);
    const h = lines.length * 17 + 10;
    const PAD = 8;
    let left = Math.max(PAD, Math.min(this.v.W - w - PAD, x - w / 2));
    let top = Math.max(PAD, y - h);
    for (const r of this.hudRects())
      if (left < r.right && left + w > r.left && top < r.bottom && top + h + 7 > r.top) {
        // Below the HUD's piece when there is room for it, else beside it.
        if (r.bottom + PAD + h < this.v.H) top = r.bottom + PAD;
        else left = r.right + PAD + w < this.v.W ? r.right + PAD : r.left - PAD - w;
      }
    const tail = Math.abs(left + w / 2 - x) < w / 2 - 8 && Math.abs(top + h - y) < 1;
    ctx.fillStyle = 'rgba(250,244,228,0.95)';
    ctx.strokeStyle = 'rgba(60,40,20,0.6)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.roundRect(left, top, w, h, 8);
    if (tail) {
      ctx.moveTo(x - 6, y);
      ctx.lineTo(x, y + 7);
      ctx.lineTo(x + 6, y);
    }
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = '#3a2a1a';
    ctx.textAlign = 'center';
    lines.forEach((l, i) => ctx.fillText(l, left + w / 2, top + 18 + i * 17));
  }
}
