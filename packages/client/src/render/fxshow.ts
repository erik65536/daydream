/**
 * Showing what happens in a fight: each effect the server tells of is drawn when it is seen to happen (a blow when
 * its shot lands or its rush arrives), and whoever listens is told then (sound and haptics keep time with the view).
 */
import type { ClipName, FxBlast, FxEvent, FxLook } from '@daydream/shared';
import { hexToRgb, mix, rgb } from './color';
import { playOnce } from './actors';
import { Z } from './fx';
import { kindColor, kindLook, kindMoves, skillStatusLook } from '../rules';
import { pic, type View } from './view';
import type { Figures } from './figures';
import type { SteerPredictor } from './predict';

/** Lifting someone up, and weighing them down (the statuses that follow show on them as they last). */
const BUFF: FxLook = { shapes: ['mote', 'star'], colors: ['#ffe7a0', '#ffc850'], glow: true, motion: 'rise', trail: 'none' };
const DEBUFF: FxLook = { shapes: ['mote', 'droplet'], colors: ['#d8a8ff', '#8a50c8'], glow: true, motion: 'fall', trail: 'none' };
/** An effect that changes its target's Health or brings it down (what the Health shown waits for). */
export const strikes = (ev: FxEvent) => (ev.kind === 'damage' || ev.kind === 'death') && !!ev.targetId;

export class FxShow {
  private v: View;
  private figures: Figures;
  private steering: SteerPredictor;

  constructor(v: View, figures: Figures, steering: SteerPredictor) {
    this.v = v;
    this.figures = figures;
    this.steering = steering;
  }

  /** Effects of a blow still in flight, shown when it lands: per attacker, the time it lands and what waits. */
  inFlight = new Map<string, { at: number; events: FxEvent[] }>();

  /** Start a one-shot clip (a blow, a flinch) on an actor that has clip sheets. */
  private playClip(id: string | undefined, clip: ClipName) {
    const a = id ? this.figures.anims.get(id) : undefined;
    const e = id ? this.v.client.state.entities.get(id) : undefined;
    if (a && e) playOnce(a.motion, clip, this.figures.actorAnim(e.sprite));
  }

  shownListeners = new Set<(events: FxEvent[]) => void>();

  /**
   * Effects as the view shows them, each when it is seen (a blow when its shot lands or its rush arrives), so what is
   * heard and felt keeps time with what is seen. Returns the unsubscribe.
   */
  onShown(fn: (events: FxEvent[]) => void) {
    this.shownListeners.add(fn);
    return () => this.shownListeners.delete(fn);
  }

  onFx(events: FxEvent[]) {
    // A hidden page draws nothing: what happens meanwhile is not kept to burst out all at once on return.
    if (document.hidden) return;
    for (const ev of events) {
      if ((ev.kind === 'skill' || ev.kind === 'projectile') && ev.sourceId && ev.tx !== undefined && ev.ty !== undefined)
        this.v.alsoFrame = { of: ev.sourceId, p: { x: ev.tx, y: ev.ty }, until: this.v.t + 1.6 };
      // What a blow in flight does shows when it lands: its hits, and a fall or words on whoever it hits.
      const held = ev.kind === 'damage' && ev.sourceId ? this.inFlight.get(ev.sourceId) : (ev.kind === 'death' || ev.kind === 'text') && ev.targetId ? [...this.inFlight.values()].find((f) => f.events.some((x) => x.targetId === ev.targetId)) : undefined;
      if (held && held.at > this.v.t) {
        held.events.push(ev);
        // Its target's Health and fall wait for it too.
        if (strikes(ev)) this.v.client.holdHealth(ev.targetId!);
      } else this.showFx(ev);
    }
  }

  flushHeld() {
    for (const [id, f] of this.inFlight)
      if (f.at <= this.v.t) {
        this.inFlight.delete(id);
        for (const ev of f.events) {
          this.showFx(ev);
          if (strikes(ev)) this.v.client.landed(ev.targetId!);
        }
      }
  }

  private showFx(ev: FxEvent) {
    // A rush is shown when it arrives (it comes back here then, without its landing spot).
    if (ev.kind === 'skill' && ev.land && ev.sourceId) return this.startRush(ev);
    for (const f of this.shownListeners) f([ev]);
    const st = this.v.client.state;
    const posOf = (id?: string) => {
      const e = id ? st.entities.get(id) : undefined;
      return e ? this.v.client.entityPos(e) : null;
    };
    const tp = posOf(ev.targetId) ?? (ev.x !== undefined ? { x: ev.x, y: ev.y! } : null);
    switch (ev.kind) {
      case 'damage': {
        const d = ev.damage;
        if (!tp || !d) break;
        const color = kindColor(d.type, '#ffffff');
        const look = kindLook(d.type);
        const w = d.share ?? 0.1;
        const gain = d.type === 'heal';
        if (d.miss) {
          this.v.fx.text(tp.x, tp.y, 'Miss', '#c8c8c8', 13);
          break;
        }
        this.v.fx.number(tp.x, tp.y, d.amount, color, w, { crit: d.crit, gain });
        if (gain) {
          this.v.fx.emit(look, tp.x, tp.y, 0.9, 4 + Math.round(16 * Math.sqrt(Math.min(1, w))), 1, 0.3);
          break;
        }
        const target = ev.targetId ? st.entities.get(ev.targetId) : undefined;
        const from = posOf(ev.sourceId);
        this.v.fx.impact(look, tp.x, tp.y, w, { crit: d.crit, from: from ?? undefined });
        const a = ev.targetId ? this.figures.anims.get(ev.targetId) : undefined;
        if (a) {
          a.hurt = 0.3;
          a.flash = Math.min(1, 0.45 + w * 2);
          a.flashColor = rgb(mix([255, 255, 255], hexToRgb(color), 0.3), 1);
          if (from) {
            const dx = tp.x - from.x, dy = tp.y - from.y, n = Math.hypot(dx, dy) || 1, push = 3 + 12 * Math.min(1, w);
            a.knock.x += (dx / n) * push;
            a.knock.y += (dy / n) * push * 0.6;
          }
        }
        this.playClip(ev.targetId, 'hit');
        if (d.fatal) this.v.fx.kill(look, tp.x, tp.y, !!target?.bossId);
        // The big moments (a heavy blow, a fallen boss, a hero of the player's down) hold the action and shake it.
        const mine = target?.ownerUserId === st.userId;
        const big = w >= 0.3 || (d.crit && w >= 0.15) || (d.fatal && (target?.bossId || mine));
        if (big && !this.v.fx.calm && this.v.felt(tp, ev.targetId)) {
          this.v.hold = Math.max(this.v.hold, 0.05 + Math.min(0.07, w * 0.1));
          this.v.shake = Math.max(this.v.shake, Math.min(1, 0.45 + w));
        }
        break;
      }
      case 'text':
        if (tp) this.v.fx.text(tp.x, tp.y, ev.text ?? '', ev.color ?? '#ffffff');
        break;
      case 'projectile': {
        const sp = posOf(ev.sourceId) ?? { x: ev.x ?? 0, y: ev.y ?? 0 };
        const to = posOf(ev.targetId) ?? { x: ev.tx ?? sp.x, y: ev.ty ?? sp.y };
        // Healing, buffs, and weakenings fly as orbs of their own look; blows as their kind of damage's shot.
        const helps = ev.fx === 'heal' || ev.fx === 'buff' || ev.fx === 'debuff';
        const look = ev.fx === 'heal' ? kindLook('heal') : helps ? skillStatusLook(ev.skillId) ?? kindLook(ev.element) : kindLook(ev.element);
        const moves = kindMoves(ev.element);
        const shot = helps ? 'orb' : ev.fx === 'beam' ? 'bolt' : moves.shot;
        const a = ev.sourceId ? this.figures.anims.get(ev.sourceId) : undefined;
        if (a) a.attack = 1;
        this.playClip(ev.sourceId, 'attack');
        const dur = this.v.fx.projectile(sp.x, sp.y, to.x, to.y, look, shot, () => {
          if (ev.radius) this.blast(helps ? 'ring' : moves.blast, look, to.x, to.y, ev.radius);
          else this.v.fx.emit(look, to.x, to.y, 1, 4, 0.8);
        });
        if (ev.sourceId) this.inFlight.set(ev.sourceId, { at: this.v.t + dur, events: this.inFlight.get(ev.sourceId)?.events ?? [] });
        break;
      }
      case 'skill': {
        const sp = posOf(ev.sourceId) ?? { x: ev.x ?? 0, y: ev.y ?? 0 };
        const center = { x: ev.tx ?? sp.x, y: ev.ty ?? sp.y };
        const look = kindLook(ev.element);
        const a = ev.sourceId ? this.figures.anims.get(ev.sourceId) : undefined;
        if (a) a.attack = 1;
        this.playClip(ev.sourceId, 'attack');
        const spread = ev.radius ? ev.radius * 0.5 : 0.3;
        // Buffs and weakenings in the colors of the status they bring (rising and falling as it helps or harms).
        const own = skillStatusLook(ev.skillId);
        if (ev.fx === 'heal') this.v.fx.emit(kindLook('heal'), center.x, center.y, 0.6, ev.radius ? 22 : 10, 1, spread);
        else if (ev.fx === 'buff') this.v.fx.emit(own ? { ...own, motion: 'rise' } : BUFF, center.x, center.y, 0.6, ev.radius ? 18 : 10, 1, spread);
        else if (ev.fx === 'debuff') this.v.fx.emit(own ? { ...own, motion: 'fall' } : DEBUFF, center.x, center.y, 1.4, ev.radius ? 18 : 10, 1, spread);
        else if (ev.fx === 'nova') this.blast(kindMoves(ev.element).blast, look, center.x, center.y, ev.radius ?? 2);
        else if (ev.fx === 'shadow') {
          // Magic up close: a swirl of the kind's own look and a sweep across the target in its color.
          this.v.fx.smoke(center.x, center.y, look.colors[look.colors.length - 1]!, 8, spread);
          this.v.fx.emit({ ...look, motion: 'swirl' }, center.x, center.y, 0.9, 12, 1, spread);
          const t = posOf(ev.targetId);
          if (t) this.v.fx.slash(t.x, t.y, sp, look.colors[0]!);
        } else if (ev.fx === 'cloud') {
          this.v.fx.smoke(center.x, center.y, look.colors[1] ?? look.colors[0]!, 12, spread);
          this.v.fx.emit({ ...look, motion: 'drift' }, center.x, center.y, 0.6, 14, 1, spread);
        } else if (ev.fx === 'slash' && ev.targetId) {
          const t = posOf(ev.targetId);
          if (t) this.v.fx.slash(t.x, t.y, sp, ev.element ? look.colors[0]! : '#f0f0ff');
        }
        // Every area shows the ground it covers, so everyone it strikes can see why (a nova draws its own).
        if (ev.radius && ev.fx !== 'nova') this.v.fx.ring(center.x, center.y, ev.radius, look.colors[0]!);
        break;
      }
      case 'death':
        if (tp) this.v.fx.smoke(tp.x, tp.y, '#46403c', 10);
        break;
      case 'relocate': {
        // Gone in a puff where it stood, then fading in where it now stands.
        if (ev.x !== undefined && ev.y !== undefined) this.v.fx.smoke(ev.x, ev.y, '#d8d2c8', 8, 0.35);
        const a = ev.targetId ? this.figures.anims.get(ev.targetId) : undefined;
        if (a && ev.tx !== undefined && ev.ty !== undefined) {
          [a.px, a.py] = [ev.tx, ev.ty];
          a.shown = 0;
          a.appear = 0;
        }
        if (ev.targetId === st.player?.leaderId) this.steering.predicted = null;
        break;
      }
      case 'levelup':
        if (tp) {
          this.v.fx.emit(BUFF, tp.x, tp.y, 0.4, 40, 1.4, 0.4);
          this.v.fx.text(tp.x, tp.y, ev.text ?? 'Level up!', '#ffe080', 22, true);
        }
        break;
    }
  }

  /** An area landing as its blast; a quake shakes the view a little. */
  private blast(kind: FxBlast, look: FxLook, x: number, y: number, r: number) {
    this.v.fx.blast(kind, look, x, y, r);
    if (kind === 'quake' && !this.v.fx.calm && this.v.felt({ x, y })) this.v.shake = Math.max(this.v.shake, 0.4);
  }

  /**
   * A skill that rushes: its user runs (or blurs, blinks, streaks, or leaps, as its kind of damage's rush) from where it
   * stood to where the server landed it, and the blow and its hits show when it arrives.
   */
  private startRush(ev: FxEvent) {
    const id = ev.sourceId!, land = ev.land!;
    const a = this.figures.anims.get(id);
    const from = a ? { x: a.px, y: a.py } : { x: ev.x ?? land.x, y: ev.y ?? land.y };
    const look = kindLook(ev.element), style = kindMoves(ev.element).rush;
    const d = Math.hypot(land.x - from.x, land.y - from.y);
    const clamp = (v: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, v));
    const dur = { dash: clamp(d / 16, 0.16, 0.4), blur: clamp(d / 20, 0.14, 0.32), blink: 0.32, streak: clamp(d / 30, 0.1, 0.22), leap: clamp(0.3 + d * 0.03, 0.34, 0.5) }[style];
    if (a) {
      a.rush = { x0: from.x, y0: from.y, x1: land.x, y1: land.y, t: 0, dur, style, look, next: 0 };
      a.face = Math.atan2(land.y - from.y, land.x - from.x);
    }
    if (style === 'dash' || style === 'leap') this.v.fx.dust(from.x, from.y, 6);
    else if (style === 'blink') this.v.fx.emit({ ...look, motion: 'burst' }, from.x, from.y, 0.9, 14, 0.9, 0.25);
    // The swing and its hits wait for the arrival.
    this.inFlight.set(id, { at: this.v.t + dur, events: [{ ...ev, land: undefined }, ...(this.inFlight.get(id)?.events ?? [])] });
  }

  drawFx() {
    this.v.fx.draw(this.v.ctx);
  }

  drawTexts() {
    const ctx = this.v.ctx;
    ctx.save();
    ctx.textAlign = 'center';
    for (const p of this.v.fx.particles) {
      if (p.kind !== 'text') continue;
      const s = pic(p.x, p.y);
      const k = p.life / p.max;
      ctx.globalAlpha = Math.min(1, k * 2.2);
      ctx.font = p.font ?? '700 15px Inter';
      const y = s.y - p.z * Z;
      const pop = k > 0.85 ? 1 + (k - 0.85) * 2 : 1;
      ctx.save();
      ctx.translate(s.x, y);
      ctx.scale(pop / this.v.zoom, pop / this.v.zoom);
      ctx.lineWidth = 4;
      ctx.strokeStyle = 'rgba(0,0,0,0.85)';
      ctx.strokeText(p.text ?? '', 0, 0);
      ctx.fillStyle = p.color;
      ctx.fillText(p.text ?? '', 0, 0);
      ctx.restore();
    }
    ctx.restore();
  }
}
