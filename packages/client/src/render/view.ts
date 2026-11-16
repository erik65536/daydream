/**
 * What every part of the game view shares: the canvas and its clock, where the camera looks, and the one transform
 * between ground meters, picture pixels and screen pixels that drawing and hit testing both use. What the pointer is
 * on, what can be hit this frame, the place's light and the effects are kept here too, for the parts that draw.
 */
import { PX_PER_METER, groundToPicture, type EntityView, type FeatureDef, type Vec2, type WayOut } from '@daydream/shared';
import type { GameClient, ZoneData } from '../net/game';
import { PlaceLight } from './light';
import { FxSystem } from './fx';

/** Ground meters to picture pixels (the ground origin at the picture origin). */
export const M = PX_PER_METER;
export const pic = (x: number, y: number) => groundToPicture(x, y, 0, 0);

/** Something standing in the place, drawn in depth order (nearest the viewer last). */
export interface Drawable {
  depth: number;
  draw: () => void;
}

export interface HoverInfo {
  /** The ground point under the cursor (meters), when it is on the place. */
  point: Vec2 | null;
  entityId?: string;
  featureId?: string;
  lootId?: string;
  screenX: number;
  screenY: number;
}

export class View {
  ctx: CanvasRenderingContext2D;
  dpr = Math.min(2, window.devicePixelRatio || 1);
  W = 0;
  H = 0;
  camX = 0;
  camY = 0;
  zoom = 1;
  camInit = false;

  /**
   * In a fight, where the player has moved the view to (ground meters), instead of following their hero: foes can
   * stand beyond the screen while still in reach of a bow or a spell. Forgotten when a turn or the fight changes.
   */
  panTo: Vec2 | null = null;

  /** Where the camera is easing to this frame (it lags a little behind). */
  look: Vec2 = { x: 0, y: 0 };
  panKey = '';

  /**
   * In a fight, where the camera rests (ground meters) and how fast it is gliding there (meters a second). It moves
   * only to keep whoever acts, and what they act on, well inside the view.
   */
  fightLook: Vec2 | null = null;
  camVel = { x: 0, y: 0 };

  /** How fast the view is sliding (screen pixels a second): the arrow keys, a pointer at the edge, a dragging finger. */
  panSpeed = { x: 0, y: 0 };
  zoneKey = '';
  light = new PlaceLight();
  readonly fx = new FxSystem();
  hover: HoverInfo = { point: null, screenX: 0, screenY: 0 };
  hitRects: { id: string; kind: 'entity' | 'feature' | 'loot'; x: number; y: number; w: number; h: number; depth: number }[] = [];
  t = 0;

  /** The last frame's real length (s): the view's own clock `t` runs slower during a hit-stop. */
  real = 0;

  /** Hit-stop left (s) and shake strength (0..1). */
  hold = 0;
  shake = 0;
  canvas: HTMLCanvasElement;
  client: GameClient;

  constructor(canvas: HTMLCanvasElement, client: GameClient) {
    this.canvas = canvas;
    this.client = client;
    this.ctx = canvas.getContext('2d')!;
  }

  worldToScreen(wx: number, wy: number) {
    const c = pic(this.camX, this.camY);
    return { x: (wx - c.x) * this.zoom + this.W / 2, y: (wy - c.y) * this.zoom + this.H / 2 };
  }

  /** Ground meters (and `z` pixels up) to screen pixels. */
  groundToScreen(x: number, y: number, z = 0) {
    const p = pic(x, y);
    return this.worldToScreen(p.x, p.y - z);
  }

  screenToGround(sx: number, sy: number): Vec2 {
    const c = pic(this.camX, this.camY);
    const wx = (sx - this.W / 2) / this.zoom + c.x;
    const wy = (sy - this.H / 2) / this.zoom + c.y;
    return { x: wx / M, y: wy / M };
  }

  setWorldTransform() {
    const c = pic(this.camX, this.camY);
    const k = this.dpr * this.zoom;
    // A shake for the big moments: a few picture px, dying away fast.
    const s = this.shake > 0 ? this.shake * this.shake * 7 : 0;
    const sx = s ? Math.sin(this.t * 83) * s : 0, sy = s ? Math.cos(this.t * 67) * s : 0;
    this.ctx.setTransform(k, 0, 0, k, (this.W / 2) * this.dpr - (c.x + sx) * k, (this.H / 2) * this.dpr - (c.y + sy) * k);
  }

  setScreenTransform() {
    this.ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
  }

  canStand(x: number, y: number): boolean {
    return !!this.client.state.zone?.walk.walkable(x, y);
  }

  /** Developer option: zoom far out to see a whole place. */
  devZoom = false;

  /** How much of the screen's bottom the skills and menus cover (CSS pixels; set by the game screen). */
  hudBottom = 0;

  /**
   * Where the camera may look to show ground point `g`: the view stays inside the painting, and a place smaller than
   * the screen sits centered with mist around it. At the bottom it may look past the painting by what the skills and
   * menus cover, so the end of a road out at the bottom edge is in view above them, not under them.
   */
  framed(z: ZoneData, g: Vec2): Vec2 {
    if (!z.painting) return g;
    const c = pic(g.x, g.y), P = z.painting;
    const fit = (v: number, lo: number, hi: number, half: number) => (hi - lo <= half * 2 ? (lo + hi) / 2 : Math.max(lo + half, Math.min(hi - half, v)));
    const cx = fit(c.x, -P.ox, P.width - P.ox, this.W / 2 / this.zoom), cy = fit(c.y, -P.oy, P.height - P.oy + this.hudBottom / this.zoom, this.H / 2 / this.zoom);
    return { x: cx / M, y: cy / M };
  }

  /** The figure the fight camera follows: the player's own hero on their turn, else the first of those acting. */
  private fightSubject(cb: NonNullable<GameClient['state']['combat']>): EntityView | undefined {
    const e = this.client.state.entities.get(this.client.myActor() ?? cb.activeId);
    // A foe acting out of sight stays out of sight: the camera does not go looking for it.
    return e && !e.dead && (!e.hostile || this.client.seen(e.x, e.y)) ? e : undefined;
  }

  /**
   * The fight camera. It keeps whoever acts well inside the middle of the view, and moves only when they are not:
   * when a turn passes to someone near the edge or off screen, or as they walk out of the middle. It glides there
   * smoothly (a damped spring, settled in about half a second) and cuts at once to someone more than two screens
   * away, which no glide shows usefully. What they strike or cast at is brought into view as well while both fit
   * (`frameAlso`), so what an AI-played hero or a foe does never happens off screen. `shownAt` says where a figure
   * is drawn now (figures.ts).
   */
  fightCamera(z: ZoneData, cb: NonNullable<GameClient['state']['combat']>, lead: Vec2, dt: number, shownAt: (e: EntityView) => Vec2) {
    const subject = this.fightSubject(cb);
    const at = subject ? shownAt(subject) : lead;
    const halfW = this.W / 2 / this.zoom / M, halfH = (this.H - this.hudBottom) / 2 / this.zoom / M;
    let rest = this.fightLook ?? { x: this.camX, y: this.camY };
    // The middle of the view, where the one acting may move without the camera following.
    const inX = halfW * 0.45, inY = halfH * 0.4;
    const hold = (p: Vec2, c: Vec2) => ({ x: Math.max(p.x - inX, Math.min(p.x + inX, c.x)), y: Math.max(p.y - inY, Math.min(p.y + inY, c.y)) });
    rest = hold(at, rest);
    const also = this.alsoFrame && this.alsoFrame.until > this.t && this.alsoFrame.of === subject?.id ? this.alsoFrame.p : null;
    if (also && Math.abs(also.x - at.x) < inX * 2 && Math.abs(also.y - at.y) < inY * 2) rest = hold(also, rest);
    rest = this.framed(z, rest);
    this.fightLook = rest;
    const look = (this.look = this.panTo ?? rest);
    const far = Math.abs(look.x - this.camX) > halfW * 4 || Math.abs(look.y - this.camY) > halfH * 4;
    if (far) {
      this.camX = look.x;
      this.camY = look.y;
      this.camVel = { x: 0, y: 0 };
      return;
    }
    // A critically damped spring: no jolt at the start, no overshoot at the end.
    const T = 0.16, o = 2 / T, x = o * dt, e = 1 / (1 + x + 0.48 * x * x + 0.235 * x * x * x);
    const step = (cur: number, to: number, v: number): [number, number] => {
      const c = cur - to, t = (v + o * c) * dt;
      return [to + (c + t) * e, (v - o * t) * e];
    };
    [this.camX, this.camVel.x] = step(this.camX, look.x, this.camVel.x);
    [this.camY, this.camVel.y] = step(this.camY, look.y, this.camVel.y);
  }

  /** A point the fight camera also keeps in view for a moment: what the one acting strikes or casts at. */
  alsoFrame: { of: string; p: Vec2; until: number } | null = null;

  /** Move the view by screen pixels, in a fight (outside one the camera stays on the party, who walk). */
  panBy(dx: number, dy: number) {
    const z = this.client.state.zone;
    if (!z || !this.client.state.combat || (!dx && !dy)) return;
    const from = this.panTo ?? this.look;
    this.panTo = this.framed(z, { x: from.x + dx / this.zoom / M, y: from.y + dy / this.zoom / M });
  }

  /** Bring a ground point into view if it is near or past the screen's edges (the controller's cursor). */
  keepInView(g: Vec2, margin = 0.2) {
    // Measured against where the view is going, not where it is while it eases there.
    const v = this.panTo ?? this.look;
    const s = { x: (g.x - v.x) * M * this.zoom + this.W / 2, y: (g.y - v.y) * M * this.zoom + this.H / 2 };
    const mx = this.W * margin, top = this.H * margin, bottom = this.H - this.hudBottom - this.H * margin;
    this.panBy(s.x < mx ? s.x - mx : s.x > this.W - mx ? s.x - (this.W - mx) : 0, s.y < top ? s.y - top : s.y > bottom ? s.y - bottom : 0);
  }

  private get minZoom() {
    return this.devZoom ? 0.12 : 0.55;
  }

  zoomBy(f: number) {
    this.zoom = Math.max(this.minZoom, Math.min(1.9, this.zoom * f));
  }

  /** Ways out of the place entered, by feature (see Nav.wayOut). */
  ways = new Map<string, WayOut>();

  /** The road a way out covers, from where it stands to the map's edge. */
  wayOf(f: FeatureDef): WayOut {
    let w = this.ways.get(f.id);
    if (!w) this.ways.set(f.id, (w = this.client.state.zone!.walk.wayOut(f)));
    return w;
  }

  /** A circle on the ground around (x, y), `r` meters across. */
  groundCircle(x: number, y: number, r: number) {
    const ctx = this.ctx;
    const c = pic(x, y);
    ctx.beginPath();
    ctx.arc(c.x, c.y, r * M, 0, Math.PI * 2);
  }

  /**
   * Whether a big moment at `p` is felt (the action held, the view shaken): one in the player's own fight, or one
   * they can see on the screen. A fight only watched from afar goes on without shaking the view.
   */
  felt(p: Vec2 | null, id?: string): boolean {
    if (id && this.client.state.combat?.order.some((o) => o.id === id)) return true;
    if (!p || !this.client.seen(p.x, p.y)) return false;
    const s = this.groundToScreen(p.x, p.y);
    return s.x >= 0 && s.y >= 0 && s.x <= this.W && s.y <= this.H;
  }
}
