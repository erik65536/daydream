/**
 * Everyone in the place: where each is shown (easing after the server, steered, rushing), which frame of which clip
 * or how a still sprite is posed, the rings at their feet, and the figure itself, lit like the place.
 */
import { BODY, PX_PER_METER, clipKey, rx, type ActorAnim, type ClipName, type EntityView, type FxLook, type FxRush, type Vec2 } from '@daydream/shared';
import { PLACEHOLDER_ASPECT, drawImageSprite, drawPlaceholder, loadImage, stillBounds } from './sprites';
import { advance, cellBounds, drawCell, fadeOf, frameOf, newMotion, rowOf, type Motion } from './actors';
import { getSheet, sheetRes, type Sheet } from './sheets';
import { SHADOW_FLAT, stamp } from './fx';
import { kindColor, kindLook, statusLook } from '../rules';
import { settings } from '../settings';
import { M, pic, type Drawable, type View } from './view';
import type { Lit } from './lit';
import type { SteerPredictor } from './predict';
import type { Overlays } from './overlays';
import type { Labels } from './labels';

export interface Anim {
  /** Displayed position: eases toward the server position so path changes never pop. */
  px: number;
  py: number;
  walk: number;
  moving: boolean;
  /** 0..1 blend between idle and walk poses, so starts and stops ease in and out. */
  amt: number;
  /** Screen-facing with hysteresis, so figures don't flicker when walking straight up or down the screen. */
  dir: 1 | -1;
  face: number;
  hurt: number;
  attack: number;
  /** A struck figure's flash (0..1, fading) in the color of what struck it, and its knock-back (picture px). */
  flash: number;
  flashColor: string;
  knock: { x: number; y: number };
  /** Time to the next mote of its statuses. */
  aura: number;
  death: number;
  fade: number;
  /** The animated actor's clip and timing (actors with clip sheets). */
  motion: Motion;
  /** Lying down: 1 down, 0 standing, between while falling or getting up (drawn for figures without clip sheets). */
  down: number;
  /** Whether it was downed when last drawn (getting up is noticed against it). */
  downed: boolean;
  /** A rush under way: from where, to where, seconds in and how long it takes, its style and its look. */
  rush?: { x0: number; y0: number; x1: number; y1: number; t: number; dur: number; style: FxRush; look: FxLook; next: number };
  /** Fading copies left by a rush that blurs (ground meters, seconds left). */
  ghosts: { x: number; y: number; life: number }[];
  /** Height above the ground while leaping (picture px), and how visible it is (a blink fades out and back). */
  lift: number;
  shown: number;
  /** Seconds since it was moved elsewhere at once (a retreat): it stays hidden a moment, then fades in. */
  appear?: number;
}

/** A figure moved elsewhere at once: seconds hidden, then seconds fading in where it now stands. */
const APPEAR_HIDDEN = 0.25, APPEAR_FADE = 0.45;

/** Seconds a rush's fading copies last. */
const GHOST_LIFE = 0.24;
const smooth = (t: number) => t * t * (3 - 2 * t);

export class Figures {
  private v: View;
  private lit: Lit;
  private steering: SteerPredictor;
  private overlays: Overlays;
  private labels: Labels;

  constructor(v: View, lit: Lit, steering: SteerPredictor, overlays: Overlays, labels: Labels) {
    this.v = v;
    this.lit = lit;
    this.steering = steering;
    this.overlays = overlays;
    this.labels = labels;
  }

  anims = new Map<string, Anim>();

  /** Where a figure is drawn now (its rush included), in ground meters. */
  shownAt(e: EntityView): Vec2 {
    const a = this.anims.get(e.id);
    return a ? { x: a.px, y: a.py } : this.v.client.entityPos(e);
  }

  /** An actor's animation (its painted clip sheets), when its world has one and the player has not turned animations off. */
  actorAnim(key: string | undefined): ActorAnim | undefined {
    const w = this.v.client.state.world;
    return key && w && !settings().animationsOff.includes(w.id) ? w.assets[key]?.anim : undefined;
  }

  /**
   * A clip's sheet at the resolution an actor of `size` needs at this zoom, once decoded (see sheets.ts). Only the
   * clips an actor plays are held: drawing one asks for its idle and walk too, and for every clip in a fight, ahead
   * of need.
   */
  private clipSheet(key: string, anim: ActorAnim, clip: ClipName, size: number, fighting: boolean): Sheet | null {
    const res = sheetRes((this.v.dpr * this.v.zoom * size) / anim.scale);
    const get = (c: ClipName, urgent: boolean) => {
      const rec = this.v.client.state.world?.assets[clipKey(key, c)];
      const url = rec?.width && rec.height ? this.v.client.assetUrl(rec.key) : undefined;
      return url ? getSheet(url, rec!.width!, rec!.height!, res, urgent) : null;
    };
    for (const c of Object.keys(anim.clips) as ClipName[]) if (c !== clip && (fighting || c === 'idle' || c === 'walk')) get(c, false);
    return get(clip, true);
  }

  private anim(e: EntityView): Anim {
    let a = this.anims.get(e.id);
    if (!a) {
      a = { px: e.x, py: e.y, walk: 0, moving: false, amt: 0, dir: 1, face: e.facing, hurt: 0, attack: 0, flash: 0, flashColor: '#ffffff', knock: { x: 0, y: 0 }, aura: 0, death: 0, fade: 0, motion: newMotion(), down: e.downed || e.dead ? 1 : 0, downed: !!e.downed, ghosts: [], lift: 0, shown: 1 };
      this.anims.set(e.id, a);
    }
    return a;
  }

  collectEntities(list: Drawable[], dt: number) {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    const combat = st.combat;
    // Fights the player only watches are drawn the same way: whose turn it is, and the foes' rings.
    const fight = !!combat || st.watched.length > 0;
    const acting = new Set([...(combat?.actingIds ?? []), ...st.watched.flatMap((f) => f.actingIds)]);
    const markers = st.player?.npcMarkers ?? {};
    const leadId = st.player?.leaderId;
    for (const e of st.entities.values()) {
      let target = this.v.client.entityPos(e);
      const a = this.anim(e);
      if (e.id === leadId && !combat) target = this.steering.predict(target, a);
      let gap = Math.hypot(target.x - a.px, target.y - a.py);
      // Small discrepancies (a new path, server correction) are eased out; big ones (teleport, a new place) snap.
      const k = gap > 2.5 ? 1 : 1 - Math.exp(-dt * (target.moving ? 18 : 12));
      const nx = a.px + (target.x - a.px) * k, ny = a.py + (target.y - a.py) * k;
      let moved = Math.hypot(nx - a.px, ny - a.py);
      a.px = nx;
      a.py = ny;
      a.moving = target.moving || moved > 0.004;
      // A rush carries the figure along its way however far the server already put it.
      if (a.rush) {
        moved = this.rushStep(a, dt);
        gap = 0;
        a.moving = true;
      }
      if (a.appear !== undefined) {
        a.appear += dt;
        a.shown = Math.max(0, Math.min(1, (a.appear - APPEAR_HIDDEN) / APPEAR_FADE));
        if (a.shown >= 1) a.appear = undefined;
      }
      for (const g of a.ghosts) g.life -= dt;
      if (a.ghosts.length) a.ghosts = a.ghosts.filter((g) => g.life > 0);
      // Falling and getting up: the downed figure lies down quickly and rises more slowly, with healing about it.
      if (e.dead) a.down = 1;
      else {
        if (a.downed && !e.downed) this.v.fx.rise(kindLook('heal'), a.px, a.py);
        a.down = e.downed ? Math.min(1, a.down + dt * 5) : Math.max(0, a.down - dt * 1.8);
      }
      a.downed = !!e.downed;
      const down = smooth(a.down);
      a.amt = Math.max(0, Math.min(1, a.amt + (a.moving ? dt * 7 : -dt * 5)));
      // Stride about 0.9 m per cycle; keep the phase running while easing out so legs settle.
      if (a.amt > 0) a.walk += (gap > 2.5 ? 0 : moved) * 7 + (a.moving ? 0 : dt * 2);
      // Turn smoothly toward the direction of travel.
      const dFace = Math.atan2(Math.sin(target.facing - a.face), Math.cos(target.facing - a.face));
      a.face += dFace * Math.min(1, dt * 14);
      a.hurt = Math.max(0, a.hurt - dt);
      a.attack = Math.max(0, a.attack - dt * 2.5);
      a.flash = Math.max(0, a.flash - dt * 6);
      const back = Math.exp(-dt * 14);
      a.knock.x *= back;
      a.knock.y *= back;
      // Lasting states show quietly: now and then a mote of each (two at most) about the figure.
      if (e.statuses.length && !e.dead && dt) {
        a.aura -= dt;
        if (a.aura <= 0) {
          a.aura = 0.14 + Math.random() * 0.1;
          const s = e.statuses[Math.floor(Math.random() * Math.min(2, e.statuses.length))]!;
          this.v.fx.aura(statusLook(s.id), a.px, a.py, 1.75 * PX_PER_METER * e.scale * 0.9);
        }
      }
      // Dying fades a figure out; one alive again (a game reloaded from before it fell) is whole at once.
      a.death = e.dead ? Math.min(1, a.death + dt * 1.2) : 0;
      a.fade = Math.min(1, a.fade + dt * 3);
      const p = pic(a.px, a.py);
      // A still sprite faces left or right as it goes (the map is top-down: ground x is screen x).
      const fx = Math.cos(a.face);
      if (fx < -0.3) a.dir = -1;
      else if (fx > 0.3) a.dir = 1;
      const anim = this.actorAnim(e.sprite);
      if (anim) advance(a.motion, anim, dt, a.moving && gap <= 2.5, gap > 2.5 || !dt ? 0 : moved / dt, !!(e.dead || e.downed));
      const dir = a.dir;
      const depth = a.py + 0.05;
      const hovered = this.v.hover.entityId === e.id;
      const active = acting.has(e.id);
      const isMine = e.ownerUserId === st.userId;
      const selected = isMine && st.selectedCharId === e.id;
      list.push({
        depth,
        draw: () => {
          ctx.save();
          ctx.translate(p.x + a.knock.x, p.y + a.knock.y);
          ctx.globalAlpha = (1 - a.death * 0.85) * a.fade;
          // Each player's heroes stand on a thin ring of their color, so friends tell theirs apart.
          if (e.kind === 'character' && !e.dead && !active && !selected)
            this.lit.atFeet(17 * e.scale, () => {
              ctx.lineWidth = 2;
              ctx.globalAlpha *= a.down > 0.5 ? 0.35 : 0.75;
              ctx.strokeStyle = this.v.client.colorOf(e.ownerUserId);
              ctx.stroke();
            });
          // Whoever acts stands in a soft pool of light under their ring.
          if (active && !e.downed)
            this.lit.atFeet(30 * e.scale, () => {
              const pool = ctx.createRadialGradient(0, 0, 0, 0, 0, 30 * e.scale);
              const c = e.hostile ? '255,110,90' : '255,220,130';
              pool.addColorStop(0, `rgba(${c},0.32)`);
              pool.addColorStop(1, `rgba(${c},0)`);
              ctx.fillStyle = pool;
              ctx.fill();
            });
          // Ground rings. Whoever the area being aimed would catch stands in a bright pulsing disc of its color.
          const caught = this.overlays.caught.get(e.id);
          if (caught)
            this.lit.atFeet(24 * e.scale, () => {
              const alpha = ctx.globalAlpha;
              ctx.globalAlpha = alpha * (0.22 + (0.5 + Math.sin(this.v.t * 6) * 0.5) * 0.14);
              ctx.fillStyle = caught;
              ctx.fill();
              ctx.globalAlpha = alpha;
              ctx.lineWidth = 3;
              ctx.strokeStyle = caught;
              ctx.stroke();
            });
          if (active || selected || hovered || (e.hostile && fight && e.inCombat))
            this.lit.atFeet(20 * e.scale, () => {
              ctx.lineWidth = active ? 3 : 2;
              ctx.strokeStyle = active ? (e.hostile ? `rgba(255,120,95,${0.75 + Math.sin(this.v.t * 5) * 0.2})` : `rgba(255,220,120,${0.75 + Math.sin(this.v.t * 5) * 0.2})`) : e.hostile ? 'rgba(255,90,70,0.7)' : selected ? 'rgba(140,220,255,0.8)' : 'rgba(255,255,255,0.6)';
              ctx.stroke();
            });
          const l = this.v.light.at(p.x, p.y);
          if (a.down < 0.5) this.lit.contactShadow(BODY * e.scale, l);
          const img = loadImage(this.v.client.assetUrl(e.sprite, 'figure'));
          const height = 1.75 * PX_PER_METER * e.scale;
          // A leap lifts the figure off its shadow; a blink fades it out and back.
          if (a.lift) ctx.translate(0, -a.lift);
          ctx.globalAlpha *= a.shown;
          if (hovered) {
            ctx.shadowColor = e.hostile ? 'rgba(255,80,60,0.9)' : 'rgba(255,240,200,0.9)';
            ctx.shadowBlur = 12;
          } else if (caught) {
            ctx.shadowColor = caught;
            ctx.shadowBlur = 9 + Math.sin(this.v.t * 6) * 3;
          }
          if (e.bossId) {
            const glow = e.named ? '#ffd060' : kindColor(e.element, '#ff6040');
            ctx.save();
            ctx.globalCompositeOperation = 'lighter';
            const gr = ctx.createRadialGradient(0, -height * 0.45, 4, 0, -height * 0.45, height * 0.7);
            gr.addColorStop(0, glow + '40');
            gr.addColorStop(1, glow + '00');
            ctx.fillStyle = gr;
            ctx.fillRect(-height, -height * 1.2, height * 2, height * 1.5);
            ctx.restore();
          }
          const walk = a.amt > 0.02 ? a.walk : NaN;
          // An actor painted without a fall lies down as a still figure does, turned about its feet.
          const acts = anim && (anim.clips.die || !a.down) ? anim : undefined;
          const figure = () => {
            // A clip still decoding shows the idle meanwhile.
            let clip = a.motion.clip, sheet = acts && this.clipSheet(e.sprite!, acts, clip, e.scale, !!e.inCombat);
            if (acts && !sheet && clip !== 'idle' && acts.clips.idle) sheet = this.clipSheet(e.sprite!, acts, (clip = 'idle'), e.scale, !!e.inCombat);
            if (acts && sheet) {
              const c = acts.clips[clip]!, at = rowOf(a.face, c);
              const fallen = clip === 'die' && a.motion.t > 0.4 * (c.frames / c.fps);
              // Standing still: the idle frame breathes (drawn in code), each actor at its own point in the breath.
              const breathOf = (k: ClipName) => (k === 'idle' ? this.v.t + (e.id.charCodeAt(e.id.length - 1) % 10) * 0.37 : undefined);
              // Just after a clip change, the frame it left fades out under the new one (the whole cell is drawn meanwhile).
              const from = a.motion.from, fade = fadeOf(a.motion), fc = from && acts.clips[from.clip];
              const fromSheet = fc && from.clip !== clip ? this.clipSheet(e.sprite!, acts, from.clip, e.scale, !!e.inCombat) : undefined;
              const b = fromSheet ? cellBounds(acts, e.scale) : cellBounds(acts, e.scale, c, at.row);
              this.lit.drawLit(b.half * 2, b.above, l, (g) => {
                const alpha = g.globalAlpha;
                if (fromSheet && fade) {
                  g.globalAlpha = alpha * fade.from;
                  drawCell(g, fromSheet, acts, fc!, from!.frame, rowOf(a.face, fc), e.scale, breathOf(from!.clip));
                  g.globalAlpha = alpha * fade.to;
                }
                drawCell(g, sheet, acts, c, frameOf(a.motion, c), at, e.scale, breathOf(clip));
                g.globalAlpha = alpha;
              }, fallen, b.below, cellBounds(acts, e.scale).above, a);
            } else {
              // A still figure turns about its feet as it falls: the box lit is the turned figure's.
              const b = stillBounds(height, img ? img.naturalWidth / img.naturalHeight : PLACEHOLDER_ASPECT, down);
              this.lit.drawLit(b.half * 2, b.above, l, (g) => {
                if (img) drawImageSprite(g, img, { height, dir, walk, amt: a.amt, t: this.v.t, down, hurt: a.hurt, attack: a.attack });
                else drawPlaceholder(g, height, down);
              }, a.down > 0.5, b.below, height, a);
            }
          };
          // A blurring rush leaves fading copies of the figure behind it, the oldest faintest.
          for (const copy of a.ghosts) {
            ctx.save();
            ctx.translate((copy.x - a.px) * M, (copy.y - a.py) * M + a.lift);
            ctx.globalAlpha *= 0.45 * (copy.life / GHOST_LIFE);
            figure();
            ctx.restore();
          }
          // A guarding status holds a ring of its own shapes about the figure: the far half behind it, the near half before.
          const guard = !e.dead ? this.guardOf(e) : null;
          if (guard) this.ward(guard, height, e.scale, 'far');
          figure();
          ctx.shadowBlur = 0;
          if (guard) this.ward(guard, height, e.scale, 'near');
          ctx.restore();
          const top = this.v.worldToScreen(p.x, p.y - height - 6);
          const s0 = this.v.worldToScreen(p.x - 18 * e.scale, p.y - height);
          if (!e.dead) this.v.hitRects.push({ id: e.id, kind: 'entity', x: s0.x, y: s0.y, w: 36 * e.scale * this.v.zoom, h: (height + 6) * this.v.zoom, depth });
          this.labels.labels.push({ e, x: top.x, y: top.y, hovered, marker: markers[e.id] ?? (e.kind === 'monster' && this.v.client.questFoe(e) ? 'hunt' : undefined), inCombat: fight && !!e.inCombat, acting: active ? (!isMine || e.id === this.v.client.myActor() || !this.v.client.isMyTurn() ? 'lead' : 'also') : undefined });
        },
      });
    }
  }

  /** The look of a helpful status on a figure that raises a defense (or dodging), if it has one. */
  private guardOf(e: EntityView): FxLook | null {
    const r = this.v.client.state.world?.ruleset;
    if (!r) return null;
    const ix = rx(r);
    const st = e.statuses.find((s) => {
      const d = ix.status.get(s.id);
      return d && !d.harmful && d.modifiers?.some((m) => m.value > 0 && (m.stat.startsWith('mit:') || m.stat === 'dodge'));
    });
    return st ? statusLook(st.id) : null;
  }

  /**
   * A guarding status: a ring of its own shapes and colors (the world's look for it, fightLooks) held about the
   * figure's middle on a faint band of its color, turning slowly as one, each bobbing a little. `half` draws the far
   * side (behind the figure) or the near side (in front of it); the far side is fainter and smaller, as if seen through.
   */
  private ward(look: FxLook, height: number, scale: number, half: 'far' | 'near') {
    const ctx = this.v.ctx;
    const rx = Math.max(24 * scale, height * 0.42), ry = rx * SHADOW_FLAT, n = 8, size = Math.max(12, height * 0.12);
    const turn = this.v.t * 0.55, cy = -height * 0.45;
    ctx.save();
    const alpha = ctx.globalAlpha;
    const band = ctx.createLinearGradient(0, cy - ry, 0, cy + ry);
    band.addColorStop(0, look.colors[0]! + '30');
    band.addColorStop(1, look.colors[0]! + '90');
    ctx.strokeStyle = band;
    ctx.lineWidth = Math.max(1.5, height * 0.012);
    ctx.globalAlpha = alpha * (0.75 + 0.25 * Math.sin(this.v.t * 2.2));
    ctx.beginPath();
    ctx.ellipse(0, cy, rx, ry, 0, half === 'far' ? Math.PI : 0, half === 'far' ? Math.PI * 2 : Math.PI);
    ctx.stroke();
    for (let i = 0; i < n; i++) {
      const a = turn + (i / n) * Math.PI * 2, depth = Math.sin(a);
      if ((depth < 0) !== (half === 'far')) continue;
      const shape = look.shapes[i % look.shapes.length]!, color = look.colors[i % look.colors.length]!;
      const img = stamp(shape, color, look.glow), k = (look.glow ? 2 : 1) * size * (0.85 + 0.15 * depth);
      const x = Math.cos(a) * rx, y = cy + depth * ry + Math.sin(this.v.t * 1.7 + i * 1.3) * 2.5;
      ctx.globalAlpha = alpha * (0.7 + 0.3 * depth);
      ctx.drawImage(img, x - k / 2, y - k / 2, k, k);
    }
    ctx.restore();
  }

  /** One frame of a rush: where the figure is along its way, and what it leaves behind. Returns how far it moved. */
  private rushStep(a: Anim, dt: number): number {
    const r = a.rush!;
    r.t += dt;
    const f = Math.min(1, r.t / r.dur);
    // Quick off the mark and easing in at the end; a leap keeps an even pace under its arc.
    const k = r.style === 'leap' ? f : 1 - Math.pow(1 - f, 2.2);
    const x = r.x0 + (r.x1 - r.x0) * k, y = r.y0 + (r.y1 - r.y0) * k;
    const moved = Math.hypot(x - a.px, y - a.py);
    a.px = x;
    a.py = y;
    const d = Math.hypot(r.x1 - r.x0, r.y1 - r.y0);
    a.lift = r.style === 'leap' ? Math.sin(f * Math.PI) * Math.min(1.5, 0.4 + d * 0.2) * M : 0;
    a.shown = r.style === 'blink' ? (f < 0.35 ? 1 - f / 0.35 : f > 0.65 ? (f - 0.65) / 0.35 : 0) : 1;
    r.next -= dt;
    if (r.next <= 0 && f < 1) {
      r.next = r.style === 'blur' || r.style === 'dash' ? 0.03 : 0.045;
      if (r.style === 'dash') this.v.fx.dust(x, y, 3, 0.15);
      else if (r.style === 'blur') a.ghosts.push({ x, y, life: GHOST_LIFE });
      else if (r.style === 'blink' && f > 0.3 && f < 0.7) this.v.fx.emit({ ...r.look, motion: 'drift' }, x, y, 0.8, 2, 0.6, 0.15);
      else if (r.style === 'streak') this.v.fx.emit({ ...r.look, motion: 'drift' }, x, y, 0.9, 2, 0.7, 0.1);
    }
    if (f >= 1) {
      a.rush = undefined;
      a.lift = 0;
      a.shown = 1;
      if (r.style === 'dash') this.v.fx.dust(x, y, 8, 0.3);
      else if (r.style === 'blink') this.v.fx.emit({ ...r.look, motion: 'burst' }, x, y, 0.9, 14, 0.9, 0.25);
      else if (r.style === 'streak') this.v.fx.streak(r.x0, r.y0, x, y, r.look.colors[0]!, r.look.glow);
      else if (r.style === 'leap') {
        this.v.fx.dust(x, y, 10, 0.35);
        this.v.fx.ring(x, y, 1.2, r.look.colors[0]!, 0.4);
        if (!this.v.fx.calm && this.v.felt({ x, y })) this.v.shake = Math.max(this.v.shake, 0.25);
      }
    }
    return moved;
  }
}
