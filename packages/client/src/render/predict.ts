/**
 * Walking with a stick, as this screen shows it: the leader is walked here at once, every frame, and only eased toward
 * where the server has them, so the server's renewals of the walk never show (input/steer.ts tells the server).
 */
import { STEER_TRUST_M, WALK_SPEED, type Vec2 } from '@daydream/shared';
import type { View } from './view';
import type { Anim } from './figures';

export class SteerPredictor {
  private v: View;

  constructor(v: View) {
    this.v = v;
  }

  /**
   * Controller walking: the stick's direction (ground space) while held. The leader is then moved here every
   * frame (client-side prediction) and only eased toward the server's position, so its path renewals never show.
   */
  steer: Vec2 | null = null;

  /** How the steered walk went this frame: free, sliding along a wall, or stopped against one (and since when). */
  push: { how: 'free' | 'slide' | 'stopped'; since: number } = { how: 'free', since: 0 };

  /** Walking into a wall head-on with a stick (once per bump): the game rumbles the controller or the phone. */
  onBump?: () => void;

  predicted: Vec2 | null = null;

  /** After the stick is let go: hold the leader where they stopped until the server agrees. */
  private holdUntil = 0;
  private predictedZone: string | undefined;

  /** Where this screen has the steered leader (sent to the server, which takes it). */
  predictedPos(): Vec2 | null {
    return this.predicted ? { ...this.predicted } : null;
  }

  /** The steered leader's position this frame: walked locally, pulled gently toward where the server has it. */
  predict(server: { x: number; y: number; moving: boolean; facing: number }, a: Anim) {
    if (!this.steer) {
      // Stopped: stay exactly where the walk ended while the server catches up (it was told this spot).
      const p = this.predicted;
      if (!p) return server;
      if (!this.holdUntil) this.holdUntil = performance.now() + 1500;
      // (A new move — a click — releases it too, once the stop has reached the server.)
      if ((server.moving && performance.now() > this.holdUntil - 1100) || Math.hypot(server.x - p.x, server.y - p.y) < 0.12 || performance.now() > this.holdUntil) {
        this.predicted = null;
        this.holdUntil = 0;
        return server;
      }
      return { x: p.x, y: p.y, moving: false, facing: server.facing };
    }
    this.holdUntil = 0;
    // A new place (a way out walked through) starts from where the server put the party.
    const zid = this.v.client.state.zone?.id;
    if (this.predictedZone !== zid) {
      this.predictedZone = zid;
      this.predicted = { x: server.x, y: server.y };
    }
    const p = (this.predicted ??= { x: a.px, y: a.py });
    // In real time, as the server walks them: a hit-stop holds the view's clock, not the walk.
    const step = WALK_SPEED * this.v.real;
    const d = this.steer;
    // Walk on, sliding along a wall on whichever axis is free.
    let how: 'free' | 'slide' | 'stopped' = 'stopped';
    for (const [k, [mx, my]] of ([[d.x, d.y], [d.x, 0], [0, d.y]] as const).entries()) {
      const len = Math.hypot(mx, my);
      if (len < 0.2) continue;
      const nx = p.x + (mx / len) * step, ny = p.y + (my / len) * step;
      if (this.v.canStand(nx, ny)) {
        p.x = nx;
        p.y = ny;
        how = k === 0 ? 'free' : 'slide';
        break;
      }
    }
    if (how !== this.push.how) {
      if (how === 'stopped') this.onBump?.();
      this.push = { how, since: this.v.t };
    }
    // This screen leads (the server takes its position); only a big disagreement — a teleport or a new place —
    // snaps back.
    if (Math.hypot(server.x - p.x, server.y - p.y) > STEER_TRUST_M) {
      p.x = server.x;
      p.y = server.y;
    }
    return { x: p.x, y: p.y, moving: true, facing: Math.atan2(d.y, d.x) };
  }
}
