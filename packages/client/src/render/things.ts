/**
 * What stands in a place and can be used: the objects the game draws over every painting (chests, signs, the
 * waypoint), the marks on what is in the painting itself (ways out, notes, what a quest step needs), and the spoils
 * foes drop.
 */
import { PX_PER_METER, nearestOnWay, type FeatureDef, type FxLook, type Vec2 } from '@daydream/shared';
import type { ZoneData } from '../net/game';
import { loadImage } from './sprites';
import { featureUsable } from './features';
import { HIGHLIGHT, drawOutline } from './highlight';
import { drawMark } from './marks';
import { M, pic, type Drawable, type View } from './view';
import type { Lit } from './lit';

/** The glint of something picked up. */
const PICKUP: FxLook = { shapes: ['mote', 'star'], colors: ['#fff4c8', '#ffe08a'], glow: true, motion: 'rise', trail: 'none' };

/** Objects the game draws over every painting (one look per world), and how tall they stand in meters. */
export const OBJECT_ART: Record<string, { key: string; height: number }> = {
  chest: { key: 'obj_chest', height: 0.85 },
  sign: { key: 'obj_sign', height: 1.7 },
  waypoint: { key: 'obj_waypoint', height: 2.1 },
  craft_station: { key: 'obj_craft_station', height: 1.1 },
  storage: { key: 'obj_storage', height: 1.2 },
};

/** The spoils a foe drops, painted once per world, and how tall they stand in meters. */
const LOOT_ART = { key: 'obj_loot', height: 0.6 };

const sized = new WeakMap<HTMLImageElement, Map<number, HTMLCanvasElement>>();
/** An image scaled to `h` pixels tall, as a canvas (for outlines), cached with the image it was made from. */
function sizedSprite(img: HTMLImageElement, h: number): HTMLCanvasElement {
  let byHeight = sized.get(img);
  if (!byHeight) sized.set(img, (byHeight = new Map()));
  const k = Math.round(h);
  let c = byHeight.get(k);
  if (c) return c;
  c = document.createElement('canvas');
  c.height = Math.round(h);
  c.width = Math.max(1, Math.round((img.naturalWidth / img.naturalHeight) * h));
  const g = c.getContext('2d')!;
  g.imageSmoothingQuality = 'high';
  g.drawImage(img, 0, 0, c.width, c.height);
  byHeight.set(k, c);
  return c;
}

export class Things {
  private v: View;
  private lit: Lit;

  constructor(v: View, lit: Lit) {
    this.v = v;
    this.lit = lit;
  }

  /** Chests seen with something in them, and when each was emptied (it fades away then). */
  chests = new Map<string, number | null>();

  collectFeatures(list: Drawable[], z: ZoneData) {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    const leader = this.v.client.leaderEntity();
    const lp = leader ? this.v.client.entityPos(leader) : null;
    for (const f of z.features) {
      const fs = st.features.get(f.id);
      const p = pic(f.x, f.y);
      const hovered = this.v.hover.featureId === f.id;
      // What can be used glows as one comes near: not a way out (it has its own mark and lights on hover), nor a
      // note already read.
      const usable = featureUsable(f, fs) && f.kind !== 'exit' && !(f.kind === 'lore' && fs?.opened);
      const at = f.kind === 'exit' && lp ? nearestOnWay(this.v.wayOf(f), lp) : f;
      const near = lp ? Math.hypot(lp.x - at.x, lp.y - at.y) : 99;
      const proximity = near < 10 ? 1 - Math.max(0, near - 4) / 6 : 0;
      const pulse = 0.5 + Math.sin(this.v.t * 3 + f.x * 0.7) * 0.5;
      // An emptied chest fades away (one already empty when the place is entered is not drawn at all).
      let fade = 1;
      if (f.kind === 'chest') {
        const emptied = !!(fs?.opened && fs.empty);
        if (!emptied) this.chests.set(f.id, null);
        else if (!this.chests.has(f.id)) continue;
        else {
          const t0 = this.chests.get(f.id) ?? this.v.t;
          this.chests.set(f.id, t0);
          fade = 1 - (this.v.t - t0) / 0.6;
          if (fade <= 0) continue;
        }
      }
      const art = this.objectArt(f);
      const depth = f.y + (art ? 0.03 : -0.2);
      list.push({
        depth,
        draw: () => {
          if (art) {
            const x = p.x - art.width / 2, y = p.y - art.height + 3;
            const l = this.v.light.at(p.x, p.y);
            ctx.save();
            ctx.globalAlpha = fade;
            ctx.translate(p.x, p.y);
            this.lit.contactShadow(art.width / (2 * M), l);
            this.lit.drawLit(art.width, art.height, l, (g) => g.drawImage(art, -art.width / 2, 3 - art.height));
            ctx.restore();
            if (fade < 1) return;
            if (usable || hovered) drawOutline(ctx, art, x, y, HIGHLIGHT.use, hovered ? 1 : usable ? proximity * (0.35 + pulse * 0.35) : 0);
            const s = this.v.worldToScreen(x, y);
            this.v.hitRects.push({ id: f.id, kind: 'feature', x: s.x, y: s.y, w: art.width * this.v.zoom, h: art.height * this.v.zoom, depth });
            return;
          }
          // Everything else is in the painting (a way out, the thing a quest asks about) or small (a note):
          // a mark on the ground shows it can be used.
          // What a quest step needs is marked from afar; other things as one comes near.
          const objective = !!f.questId;
          const glow = hovered ? 1 : objective ? 0.6 + proximity * 0.4 : f.kind === 'exit' ? 0.25 + proximity * 0.45 : usable ? 0.2 + proximity * (0.4 + pulse * 0.3) : 0;
          if (glow > 0.01) this.groundMark(f, glow);
          const s = this.v.groundToScreen(f.x, f.y, 24);
          this.v.hitRects.push({ id: f.id, kind: 'feature', x: s.x - 26 * this.v.zoom, y: s.y - 30 * this.v.zoom, w: 52 * this.v.zoom, h: 64 * this.v.zoom, depth });
        },
      });
    }
  }

  /**
   * A world object's art (a chest, a sign, the waypoint, the crafting station), scaled to its height. What a quest sends
   * the heroes to find has none: it is the thing itself, where placement put it, shown by its mark on the ground.
   */
  private objectArt(f: FeatureDef): HTMLCanvasElement | null {
    const o = f.questId ? undefined : OBJECT_ART[f.kind];
    if (!o) return null;
    const img = loadImage(this.v.client.assetUrl(o.key, 'figure'));
    return img ? sizedSprite(img, o.height * PX_PER_METER) : null;
  }

  /**
   * The ground mark of a feature. A way out: cool light with chevrons flowing toward where it leads. What a quest step
   * needs (a thing to look at, something to find): the quest's "!" over it.
   * Others (notes, signs, traps): a soft ring (dashed and red for a trap).
   */
  private groundMark(f: FeatureDef, alpha: number) {
    if (f.kind === 'exit') return this.exitMark(f, alpha);
    if (f.questId) return this.objectiveMark(f, alpha);
    const ctx = this.v.ctx;
    const p = pic(f.x, f.y);
    const color = f.kind === 'lore' ? '255,226,140' : '200,230,255';
    ctx.save();
    ctx.translate(p.x, p.y);
    ctx.lineWidth = 2.5;
    ctx.strokeStyle = `rgba(${color},${Math.min(1, alpha)})`;
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 10;
    ctx.beginPath();
    ctx.arc(0, 0, 0.55 * M, 0, Math.PI * 2);
    ctx.stroke();
    ctx.restore();
    if (f.kind === 'lore') this.floatingLight(p, alpha, color);
  }

  /** A soft light on the ground, a disc of `r` meters. */
  private groundGlow(p: Vec2, r: number, color: string, alpha: number) {
    const g = this.v.ctx.createRadialGradient(p.x, p.y, 0, p.x, p.y, r * M);
    g.addColorStop(0, `rgba(${color},${alpha})`);
    g.addColorStop(1, `rgba(${color},0)`);
    this.v.ctx.fillStyle = g;
    this.v.ctx.fillRect(p.x - r * M, p.y - r * M, 2 * r * M, 2 * r * M);
  }

  private exitMark(f: FeatureDef, alpha: number) {
    const ctx = this.v.ctx;
    const p = pic(f.x, f.y), color = '175,215,255';
    this.groundGlow(p, 1.1, color, 0.3 * Math.max(alpha, 0.5));
    ctx.save();
    ctx.lineWidth = 3;
    ctx.lineCap = 'round';
    ctx.lineJoin = 'round';
    ctx.shadowColor = `rgba(${color},0.9)`;
    ctx.shadowBlur = 8;
    const a = Math.min(1, alpha * 1.4);
    const way = this.v.wayOf(f), out = way.out;
    if (out) {
      // A way across the edge: chevrons flowing along its whole road and off the map, so the road itself reads as
      // the way out wherever one stands on it.
      const len = Math.max(1.2, Math.hypot(way.to.x - way.from.x, way.to.y - way.from.y));
      const n = Math.max(3, Math.round(len / 1.1));
      this.groundGlow(pic(way.to.x, way.to.y), 1.1, color, 0.3 * Math.max(alpha, 0.5));
      for (let i = 0; i < n; i++) {
        const ph = (this.v.t * 0.7 / (len / 1.2) + i / n) % 1, s = ph * (len + 0.6) - 0.5;
        const at = pic(f.x + out.x * s, f.y + out.y * s);
        const w = 0.32 * M, back = 0.2 * M;
        ctx.strokeStyle = `rgba(${color},${(Math.sin(ph * Math.PI) * a).toFixed(3)})`;
        ctx.beginPath();
        ctx.moveTo(at.x - out.x * back - out.y * w, at.y - out.y * back + out.x * w);
        ctx.lineTo(at.x, at.y);
        ctx.lineTo(at.x - out.x * back + out.y * w, at.y - out.y * back - out.x * w);
        ctx.stroke();
      }
    } else {
      // A way in drawn inside the place (a door, a cave mouth): rings closing in on it.
      for (let i = 0; i < 2; i++) {
        const ph = (this.v.t * 0.6 + i / 2) % 1;
        ctx.strokeStyle = `rgba(${color},${(Math.sin(ph * Math.PI) * a).toFixed(3)})`;
        this.v.groundCircle(f.x, f.y, 0.95 - ph * 0.7);
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  /**
   * What a quest step needs: the "!" a quest giver carries, floating over where it is, fainter from afar. A place's
   * things stand for an area more than a point, so nothing on the ground claims a spot.
   */
  private objectiveMark(f: FeatureDef, alpha: number) {
    const ctx = this.v.ctx, p = pic(f.x, f.y);
    ctx.save();
    ctx.globalAlpha *= Math.min(1, alpha);
    drawMark(ctx, 'quest', p.x, p.y - 30, this.v.t, f.x);
    ctx.restore();
  }

  /** A small light hovering over a note one can read. */
  private floatingLight(p: Vec2, alpha: number, color: string) {
    const ctx = this.v.ctx;
    const y = p.y - 26 + Math.sin(this.v.t * 2.2 + p.x) * 4;
    const g = ctx.createRadialGradient(p.x, y, 0, p.x, y, 12);
    g.addColorStop(0, `rgba(255,248,210,${alpha})`);
    g.addColorStop(0.35, `rgba(${color},${alpha * 0.6})`);
    g.addColorStop(1, `rgba(${color},0)`);
    ctx.fillStyle = g;
    ctx.fillRect(p.x - 12, y - 12, 24, 24);
  }

  /** Piles seen last frame (to tell one picked up from one walked away from), and satchels on their way to a hero. */
  piles = new Map<string, Vec2>();
  pickups: { x: number; y: number; to: string; t0: number }[] = [];

  /** What the party just picked up, rising softly over its leader. */
  pickedUp(text: string) {
    const e = this.v.client.leaderEntity();
    if (!e) return;
    const p = this.v.client.entityPos(e);
    this.v.fx.text(p.x, p.y, text, '#f0dfae', 12);
  }

  /**
   * Dropped spoils: the world's own painting of them, lit by the place and outlined in gold, pulsing until picked up.
   * Until the painting has loaded (or in a world painted before it existed), a gold ring marks the spot.
   */
  collectLoot(list: Drawable[]) {
    const ctx = this.v.ctx;
    const img = loadImage(this.v.client.assetUrl(LOOT_ART.key, 'figure'));
    const art = img ? sizedSprite(img, LOOT_ART.height * PX_PER_METER) : null;
    const st = this.v.client.state;
    // A pile that is gone from beside one of the player's heroes was picked up: it flies to that hero in a glint.
    const now = new Map(st.lootPiles.map((l) => [l.id, { x: l.x, y: l.y }]));
    for (const [id, at] of this.piles) {
      if (now.has(id)) continue;
      const hero = st.player?.party.map((c) => st.entities.get(c.id)).find((e) => e && Math.hypot(e.x - at.x, e.y - at.y) < 1.5);
      if (!hero) continue;
      this.pickups.push({ ...at, to: hero.id, t0: this.v.t });
      this.v.fx.emit(PICKUP, at.x, at.y, 0.3, 10, 0.8, 0.2);
    }
    this.piles = now;
    for (const l of st.lootPiles) {
      const p = pic(l.x, l.y);
      const depth = l.y + 0.01;
      const hovered = this.v.hover.lootId === l.id;
      list.push({
        depth,
        draw: () => {
          // Hovered, the spoils lift a little over a warm glow and their outline burns steady.
          const lift = hovered ? 3 + Math.sin(this.v.t * 5) * 1 : 0;
          if (hovered) this.groundGlow(p, 0.45, '255,224,138', 0.35);
          const pulse = 0.5 + Math.sin(this.v.t * 4 + l.x) * 0.5;
          const glow = hovered ? 1 : 0.45 + pulse * 0.45;
          // A box at least half a meter across, so a small bag is still easy to tap.
          const w = Math.max(art?.width ?? 0, 0.5 * M), h = Math.max(art?.height ?? 0, 0.5 * M);
          if (art) {
            const x = p.x - art.width / 2, y = p.y - art.height + 3 - lift;
            const lt = this.v.light.at(p.x, p.y);
            ctx.save();
            ctx.translate(p.x, p.y);
            this.lit.contactShadow(art.width / (2 * M), lt);
            this.lit.drawLit(art.width, art.height, lt, (g) => g.drawImage(art, -art.width / 2, 3 - art.height - lift));
            ctx.restore();
            drawOutline(ctx, art, x, y, HIGHLIGHT.loot, glow);
          } else {
            ctx.save();
            ctx.translate(p.x, p.y);
            this.lit.atFeet(0.3 * M, () => {
              ctx.lineWidth = 2.5;
              ctx.strokeStyle = `rgba(255,224,138,${glow})`;
              ctx.shadowColor = 'rgba(255,224,138,0.9)';
              ctx.shadowBlur = 10;
              ctx.stroke();
            });
            ctx.restore();
          }
          const s = this.v.worldToScreen(p.x - w / 2, p.y + 3 - h);
          this.v.hitRects.push({ id: l.id, kind: 'loot', x: s.x, y: s.y, w: w * this.v.zoom, h: h * this.v.zoom, depth });
        },
      });
    }
    // Spoils flying to the hero who took them: up in an arc, shrinking into them.
    const FLY = 0.35;
    this.pickups = this.pickups.filter((k) => this.v.t - k.t0 < FLY);
    for (const k of art ? this.pickups : []) {
      const e = st.entities.get(k.to);
      if (!e) continue;
      const to = this.v.client.entityPos(e);
      const u = (this.v.t - k.t0) / FLY, ease = u * u;
      const a = pic(k.x, k.y), b = pic(to.x, to.y);
      const x = a.x + (b.x - a.x) * ease, y = a.y + (b.y - a.y) * ease - Math.sin(u * Math.PI) * 30 - u * 40;
      list.push({
        depth: to.y + 0.02,
        draw: () => {
          ctx.save();
          ctx.globalAlpha = 1 - u * 0.8;
          const sc = 1 - u * 0.6;
          ctx.translate(x, y);
          ctx.scale(sc, sc);
          ctx.drawImage(art!, -art!.width / 2, -art!.height + 3);
          ctx.restore();
        },
      });
    }
  }
}
