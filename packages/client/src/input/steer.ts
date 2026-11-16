/**
 * Walking with a stick (a controller's, or a finger's on the game view): the renderer walks the leader on this screen
 * at once (`Renderer.steer`), and the server is told the direction when it changes and again every little while for as
 * long as the stick is held, with where this screen has the leader. The server stops a party it has not heard from
 * (a controller unplugged, a page gone), so the reminders come from a timer of their own: a stick held perfectly still
 * sends nothing by itself.
 */
import { STEER_REMIND_MS, type Vec2 } from '@daydream/shared';
import type { GameClient } from '../net/game';
import type { Renderer } from '../render/renderer';

/** A changed direction is sent at most this often (ms). */
const TURN_MS = 60;

export class Steer {
  private timer: ReturnType<typeof setInterval> | null = null;
  private dir: Vec2 = { x: 0, y: 0 };
  private sent: Vec2 = { x: 0, y: 0 };
  private sentAt = 0;
  private r: Renderer;
  private c: GameClient;

  constructor(r: Renderer, c: GameClient) {
    this.r = r;
    this.c = c;
  }

  /** Whether this stick is walking the party now. */
  get on() {
    return !!this.timer;
  }

  /** Walk this way (a unit direction on the ground): called as often as the stick is read. */
  go(dir: Vec2) {
    this.dir = dir;
    this.r.steer = dir;
    const started = !this.timer;
    this.timer ??= setInterval(() => this.send(), STEER_REMIND_MS);
    const turned = dir.x * this.sent.x + dir.y * this.sent.y < 0.99;
    if (started || (turned && performance.now() - this.sentAt > TURN_MS)) this.send();
  }

  /** The stick was let go: the party stops where this screen shows the leader. */
  stop() {
    if (!this.timer) return;
    clearInterval(this.timer);
    this.timer = null;
    this.r.steer = null;
    this.dir = { x: 0, y: 0 };
    this.send();
  }

  private send() {
    this.sent = this.dir;
    this.sentAt = performance.now();
    const at = this.r.predictedPos();
    this.c.send({ t: 'steer', dx: this.dir.x, dy: this.dir.y, x: at?.x, y: at?.y });
  }
}
