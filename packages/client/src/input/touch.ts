/**
 * Touch play on the game view, designed for a finger rather than a mouse adapted to one:
 *
 *   Tap         what a click does: walk there, talk, open, attack, or aim the chosen skill there.
 *   Drag        exploring, a walking stick appears where the finger went down and the party walks that way while it
 *               is held. In a fight on your turn, the path and its cost follow the finger; lifting it leaves the plan
 *               showing, and a tap on the planned spot walks there (a tap anywhere else plans again).
 *               While aiming a skill, the aim follows the finger and lifting it uses the skill there.
 *   Long-press  look at someone or something (their name and health show); a chest or pile opens to pick items.
 *               In a fight, a dragging finger held near an edge of the screen slides the view that way.
 *   Pinch       zoom; in a fight, two fingers moving together also move the view (to find and reach far foes).
 *
 * A finger is a blunt pointer, so it also finds a figure or thing a little beside where it lands.
 */
import type { GameClient } from '../net/game';
import { STICK_R, type HoverInfo, type Renderer } from '../render/renderer';
import { HOLD_MS, buzz, edgePush } from './pointer';
import { Steer } from './steer';

/** How far (pixels) a finger moves before a press becomes a drag. */
const DRAG = 12;
/** How far beside a finger (pixels) it still finds a figure or thing. */
const SLOP = 22;
/** A planned walk is confirmed by a tap this close to it (meters). */
const CONFIRM_M = 0.9;
/** How near an edge of the screen (pixels) a dragging finger slides the view in a fight, and how fast at most. */
const EDGE = 40, EDGE_SPEED = 700;
/** How far (pixels) the finger must be from the stick's middle to walk: nearer, the party stands. */
const STICK_DEAD = 6;

type Gesture = 'press' | 'stick' | 'aim' | 'plan' | 'held' | 'pinch';

export class TouchInput {
  private touches = new Map<number, { x: number; y: number }>();
  private gesture: Gesture | null = null;
  private start = { x: 0, y: 0 };
  private holdTimer: ReturnType<typeof setTimeout> | null = null;
  private pinchFrom = 0;
  private pinchMid = { x: 0, y: 0 };
  /** While a finger aiming or planning rests near an edge, the view slides and what it points at is read again. */
  private edgeRaf = 0;
  private last = { x: 0, y: 0 };
  /** A walk planned in a fight, waiting for a confirming tap. */
  private planned: HoverInfo | null = null;
  private walk: Steer;
  private canvas: HTMLCanvasElement;
  private r: Renderer;
  private c: GameClient;
  private act: (info: HoverInfo, button: number) => void;
  private inspect: (info: HoverInfo) => void;

  constructor(
    canvas: HTMLCanvasElement,
    r: Renderer,
    c: GameClient,
    act: (info: HoverInfo, button: number) => void,
    inspect: (info: HoverInfo) => void,
  ) {
    this.canvas = canvas;
    this.r = r;
    this.c = c;
    this.act = act;
    this.inspect = inspect;
    this.walk = new Steer(r, c);
    canvas.addEventListener('pointerdown', this.down);
    canvas.addEventListener('pointermove', this.move);
    canvas.addEventListener('pointerup', this.up);
    canvas.addEventListener('pointercancel', this.cancel);
  }

  destroy() {
    this.canvas.removeEventListener('pointerdown', this.down);
    this.canvas.removeEventListener('pointermove', this.move);
    this.canvas.removeEventListener('pointerup', this.up);
    this.canvas.removeEventListener('pointercancel', this.cancel);
    this.stopSteering();
    this.stopEdge();
  }

  /** Forget a planned walk (the turn or the fight changed). */
  reset() {
    if (!this.planned) return;
    this.planned = null;
    this.r.setTouchHover(null);
  }

  /** A walk is planned and waits for the confirming tap (the HUD says so). */
  get awaitingConfirm() {
    return !!this.planned;
  }

  private at(e: PointerEvent) {
    const b = this.canvas.getBoundingClientRect();
    return { x: e.clientX - b.left, y: e.clientY - b.top };
  }

  private pick(p: { x: number; y: number }) {
    return this.r.pickAt(p.x, p.y, SLOP);
  }

  private down = (e: PointerEvent) => {
    if (e.pointerType !== 'touch') return;
    e.preventDefault();
    try {
      this.canvas.setPointerCapture(e.pointerId);
    } catch {
      /* a finger the browser no longer tracks */
    }
    if (this.c.state.inputMode !== 'touch') this.c.update({ inputMode: 'touch' });
    const p = this.at(e);
    this.touches.set(e.pointerId, p);
    if (this.touches.size === 2) {
      // A second finger: whatever the first was doing becomes a pinch.
      this.clearHold();
      this.stopSteering();
      this.gesture = 'pinch';
      this.stopEdge();
      const [a, b] = [...this.touches.values()];
      this.pinchFrom = Math.hypot(a!.x - b!.x, a!.y - b!.y);
      this.pinchMid = { x: (a!.x + b!.x) / 2, y: (a!.y + b!.y) / 2 };
      return;
    }
    if (this.touches.size > 2) return;
    this.gesture = 'press';
    this.start = p;
    this.clearHold();
    this.holdTimer = setTimeout(() => {
      if (this.gesture !== 'press') return;
      this.gesture = 'held';
      buzz();
      const info = this.pick(this.start);
      this.r.setTouchHover(info);
      this.inspect(info);
    }, HOLD_MS);
  };

  private move = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
    const p = this.at(e);
    this.touches.set(e.pointerId, p);
    if (this.gesture === 'pinch') {
      const [a, b] = [...this.touches.values()];
      if (!a || !b) return;
      const d = Math.hypot(a.x - b.x, a.y - b.y);
      if (this.pinchFrom > 0 && d > 0) this.r.zoomBy(d / this.pinchFrom);
      this.pinchFrom = d;
      const mid = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
      this.r.panBy(this.pinchMid.x - mid.x, this.pinchMid.y - mid.y);
      this.pinchMid = mid;
      return;
    }
    if (this.gesture === 'press' && Math.hypot(p.x - this.start.x, p.y - this.start.y) > DRAG) {
      this.clearHold();
      const st = this.c.state;
      this.gesture = st.targeting ? 'aim' : st.combat ? 'plan' : 'stick';
      this.planned = null;
      buzz(5);
    }
    if (this.gesture === 'aim' || this.gesture === 'plan') {
      this.r.setTouchHover(this.pick(p));
      this.edgeSlide(p);
    } else if (this.gesture === 'stick') this.steer(p);
  };

  /** A finger aiming or planning near an edge of the screen slides the view that way, faster the nearer it is. */
  private edgeSlide(p: { x: number; y: number }) {
    this.last = p;
    const b = this.canvas.getBoundingClientRect();
    const v = { x: edgePush(p.x, b.width, EDGE) * EDGE_SPEED, y: edgePush(p.y, b.height - this.r.hudBottom, EDGE) * EDGE_SPEED };
    if (!this.c.state.combat || (!v.x && !v.y)) return this.stopEdge();
    this.r.panSpeed = v;
    if (!this.edgeRaf) {
      const tick = () => {
        this.edgeRaf = requestAnimationFrame(tick);
        this.r.setTouchHover(this.pick(this.last));
      };
      this.edgeRaf = requestAnimationFrame(tick);
    }
  }

  private stopEdge() {
    if (!this.edgeRaf) return;
    cancelAnimationFrame(this.edgeRaf);
    this.edgeRaf = 0;
    this.r.panSpeed = { x: 0, y: 0 };
  }

  private up = (e: PointerEvent) => {
    if (e.pointerType !== 'touch' || !this.touches.has(e.pointerId)) return;
    const p = this.at(e);
    this.touches.delete(e.pointerId);
    this.clearHold();
    const g = this.gesture;
    this.stopEdge();
    if (g === 'pinch') {
      // Lifting one finger of a pinch does nothing; the gesture ends when both are up.
      if (!this.touches.size) this.gesture = null;
      return;
    }
    this.gesture = null;
    if (g === 'stick') return this.stopSteering();
    if (g === 'aim') {
      // Lifted where it cannot reach: keep aiming rather than spend the try.
      if (this.r.aimValid) (buzz(12), this.act(this.pick(p), 0));
      else buzz(20);
      return this.r.setTouchHover(null);
    }
    if (g === 'plan') {
      // The plan stays on screen; a tap on it walks.
      const info = this.pick(p);
      this.planned = info.point && !info.entityId && !info.featureId && !info.lootId ? info : null;
      if (!this.planned) this.r.setTouchHover(null);
      return;
    }
    if (g === 'held') return;
    if (g === 'press') (buzz(6), this.tap(p));
  };

  private cancel = (e: PointerEvent) => {
    this.touches.delete(e.pointerId);
    this.clearHold();
    this.stopEdge();
    if (!this.touches.size) {
      if (this.gesture === 'stick') this.stopSteering();
      this.gesture = null;
    }
  };

  private tap(p: { x: number; y: number }) {
    const st = this.c.state;
    const info = this.pick(p);
    // In a fight on your turn, a walk is shown first (with its cost) and taken on a second tap.
    const ground = !!info.point && !info.entityId && !info.featureId && !info.lootId;
    if (st.combat && !st.targeting && ground && this.c.isMyTurn()) {
      const plan = this.planned?.point;
      if (plan && Math.hypot(plan.x - info.point!.x, plan.y - info.point!.y) < CONFIRM_M) {
        this.planned = null;
        this.act({ ...info, point: plan }, 0);
        return this.r.setTouchHover(null);
      }
      this.planned = info;
      return this.r.setTouchHover(info);
    }
    this.planned = null;
    this.r.setTouchHover(null);
    this.act(info, 0);
  }

  // ---------------------------------------------------------------------------- the walking stick

  private steer(p: { x: number; y: number }) {
    let ox = this.r.stick?.ox ?? this.start.x, oy = this.r.stick?.oy ?? this.start.y;
    // A finger that goes past the ring drags the ring along, so turning back is always a short move.
    const dx = p.x - ox, dy = p.y - oy, d = Math.hypot(dx, dy);
    if (d > STICK_R) {
      ox = p.x - (dx / d) * STICK_R;
      oy = p.y - (dy / d) * STICK_R;
    }
    this.r.stick = { ox, oy, x: p.x, y: p.y };
    // Back at the stick's middle, or a fight begun under the finger: the party stands.
    if (d < STICK_DEAD || this.c.state.combat) return this.walk.stop();
    this.walk.go({ x: dx / d, y: dy / d });
  }

  private stopSteering() {
    this.r.stick = null;
    this.walk.stop();
  }

  private clearHold() {
    if (this.holdTimer) clearTimeout(this.holdTimer);
    this.holdTimer = null;
  }
}
