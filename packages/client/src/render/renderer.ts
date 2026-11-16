/**
 * The game view. The place's painting is the ground; everything that moves is drawn over it in depth order (lit like
 * the place, see light.ts), then the place's mist (fog of war and the painting's edge, see mist.ts: what lies past the
 * edge is drawn with the ground), light, weather, and the combat and targeting overlays. Positions are ground meters:
 * the painting is a top-down map of that ground (a meter runs PX_PER_METER pixels across and down).
 *
 * This is the frame and what the game screen and the input code use; the parts of a frame each have their file:
 * view.ts (the canvas, the camera and the one transform), predict.ts (a steered walk), walkhints.ts, things.ts
 * (features and loot), figures.ts and labels.ts (everyone, and the words over them), lit.ts (lighting a figure),
 * overlays.ts (a fight's and aiming's marks on the ground), fxshow.ts (effects as they are seen), and sky.ts (fog,
 * mist, light and weather). The mouse is read by input/mouse.ts, beside the finger and the controller.
 */
import { nearestOnWay, type FeatureDef, type FxEvent, type Vec2, type WayOut } from '@daydream/shared';
import type { GameClient, ZoneData } from '../net/game';
import { MouseInput } from '../input/mouse';
import { reportError } from '../report';
import type { AimVerdict } from './aiming';
import { Figures } from './figures';
import { FxShow, strikes } from './fxshow';
import { Labels } from './labels';
import { Lit } from './lit';
import { Overlays } from './overlays';
import { SteerPredictor } from './predict';
import { Sky } from './sky';
import { loadImage } from './sprites';
import { Things } from './things';
import { M, View, type Drawable, type HoverInfo } from './view';
import { WalkHints } from './walkhints';

export type { HoverInfo } from './view';

/** How near a way out's road the pointer picks it (m). */
const WAY_REACH = 1.2;
/** The touch stick's reach (screen pixels): the knob stops at it and the ring follows a finger that goes further. */
export const STICK_R = 52;

export class Renderer {
  private v: View;
  private steering: SteerPredictor;
  private hints: WalkHints;
  private lit: Lit;
  private things: Things;
  private overlays: Overlays;
  private labels: Labels;
  private figures: Figures;
  private shows: FxShow;
  private sky: Sky;
  private mouse: MouseInput;
  private raf = 0;
  private last = performance.now();
  private unsubFx: () => void;
  private unsubToast: () => void;
  onClick?: (info: HoverInfo, button: number, ev: MouseEvent) => void;
  /** The view's size follows the canvas (the window, or less while an on-screen keyboard is up). */
  private sizer = new ResizeObserver(() => this.resize());

  constructor(canvas: HTMLCanvasElement, client: GameClient) {
    const v = (this.v = new View(canvas, client));
    this.steering = new SteerPredictor(v);
    this.hints = new WalkHints(v, this.steering);
    this.lit = new Lit(v);
    this.things = new Things(v, this.lit);
    this.overlays = new Overlays(v);
    this.labels = new Labels(v);
    this.figures = new Figures(v, this.lit, this.steering, this.overlays, this.labels);
    this.shows = new FxShow(v, this.figures, this.steering);
    this.sky = new Sky(v, this.figures);
    client.lookHome = () => void (this.v.panTo = null);
    client.view = () => (this.v.camInit ? { x: this.v.camX, y: this.v.camY, halfWidth: this.v.W / 2 / this.v.zoom / M } : null);
    this.unsubFx = client.onFx((ev) => this.shows.onFx(ev));
    this.unsubToast = client.onToast((kind, _sound, text) => kind === 'pickup' && this.things.pickedUp(text));
    this.resize();
    this.sizer.observe(canvas);
    this.mouse = new MouseInput(canvas, this, client);
    this.raf = requestAnimationFrame(this.frame);
  }

  destroy() {
    cancelAnimationFrame(this.raf);
    this.sizer.disconnect();
    this.mouse.destroy();
    this.unsubFx();
    this.unsubToast();
    this.shows.shownListeners.clear();
    this.sky.mist.destroy();
    this.v.client.view = () => null;
    this.v.client.lookHome = () => {};
  }

  private resize = () => {
    // The screen's density changes with the browser's zoom and from one monitor to another.
    this.v.dpr = Math.min(2, window.devicePixelRatio || 1);
    const r = this.v.canvas.getBoundingClientRect();
    this.v.W = r.width;
    this.v.H = r.height;
    this.v.canvas.width = Math.round(r.width * this.v.dpr);
    this.v.canvas.height = Math.round(r.height * this.v.dpr);
    this.sky.lightCanvas.width = Math.ceil(r.width / 2);
    this.sky.lightCanvas.height = Math.ceil(r.height / 2);
    this.sky.fogCanvas.width = Math.ceil(r.width / 4);
    this.sky.fogCanvas.height = Math.ceil(r.height / 4);
  };

  private frame = (now: number) => {
    // The first timestamp can come from before the renderer was made: never a step back in time.
    const real = Math.max(0, Math.min(0.05, (now - this.last) / 1000));
    this.last = now;
    this.v.real = real;
    if (Math.min(2, window.devicePixelRatio || 1) !== this.v.dpr) this.resize();
    // Hit-stop: a heavy blow holds the action for a few hundredths of a second.
    const dt = this.v.hold > 0 ? real * 0.08 : real;
    this.v.hold = Math.max(0, this.v.hold - real);
    this.v.shake = Math.max(0, this.v.shake - real * 3.5);
    this.v.t += dt;
    this.shows.flushHeld();
    this.render(dt);
    this.raf = requestAnimationFrame(this.frame);
  };

  // ---------------------------------------------------------------------------- what the game screen and the input use

  /** What the pointer is on (a mouse hovering, a finger held, a controller's focus or cursor). */
  get hover(): HoverInfo {
    return this.v.hover;
  }
  set hover(info: HoverInfo) {
    this.v.hover = info;
  }

  /** How fast the view is sliding (screen pixels a second): the arrow keys, a pointer at the edge, a dragging finger. */
  get panSpeed() {
    return this.v.panSpeed;
  }
  set panSpeed(speed: { x: number; y: number }) {
    this.v.panSpeed = speed;
  }

  /** How much of the screen's bottom the skills and menus cover (CSS pixels; set by the game screen). */
  get hudBottom() {
    return this.v.hudBottom;
  }
  set hudBottom(px: number) {
    this.v.hudBottom = px;
  }

  /** Developer option: zoom far out to see a whole place. */
  get devZoom() {
    return this.v.devZoom;
  }
  set devZoom(on: boolean) {
    this.v.devZoom = on;
  }

  /** Developer option: light figures like the place (off: drawn as painted or rendered). */
  get figureLight() {
    return this.lit.figureLight;
  }
  set figureLight(on: boolean) {
    this.lit.figureLight = on;
  }

  /** Walking with a stick: its direction on the ground while held (see predict.ts). */
  get steer(): Vec2 | null {
    return this.steering.steer;
  }
  set steer(dir: Vec2 | null) {
    this.steering.steer = dir;
  }

  /** Walking into a wall head-on with a stick (once per bump): the game rumbles the controller or the phone. */
  get onBump() {
    return this.steering.onBump;
  }
  set onBump(fn: (() => void) | undefined) {
    this.steering.onBump = fn;
  }

  /** What to say beside the pointer about the walk or the aim under it (the game screen shows it and clears it). */
  get cursorNote() {
    return this.overlays.cursorNote;
  }
  set cursorNote(note: { text: string; ok: boolean } | null) {
    this.overlays.cursorNote = note;
  }

  /** Whether the skill or item being aimed could be used where it points now (false out of range or sight). */
  get aimValid() {
    return this.overlays.aimValid;
  }

  /** The verdict on what is being aimed where the pointer is (see aiming.ts); null while nothing is aimed. */
  get aim(): AimVerdict | null {
    return this.overlays.aim;
  }

  /** Ground meters (and `z` pixels up) to screen pixels. */
  groundToScreen(x: number, y: number, z = 0) {
    return this.v.groundToScreen(x, y, z);
  }

  screenToGround(sx: number, sy: number): Vec2 {
    return this.v.screenToGround(sx, sy);
  }

  canStand(x: number, y: number): boolean {
    return this.v.canStand(x, y);
  }

  /** Move the view by screen pixels, in a fight (outside one the camera stays on the party, who walk). */
  panBy(dx: number, dy: number) {
    this.v.panBy(dx, dy);
  }

  /** Bring a ground point into view if it is near or past the screen's edges (the controller's cursor). */
  keepInView(g: Vec2, margin = 0.2) {
    this.v.keepInView(g, margin);
  }

  zoomBy(f: number) {
    this.v.zoomBy(f);
  }

  /** The road a way out covers, from where it stands to the map's edge. */
  wayOf(f: FeatureDef): WayOut {
    return this.v.wayOf(f);
  }

  /** Where this screen has the steered leader (sent to the server, which takes it). */
  predictedPos(): Vec2 | null {
    return this.steering.predictedPos();
  }

  /**
   * Where a click at `p` walks to: the spot itself, or the nearest one someone can stand on when it is a wall, a tree
   * or water (null when there is none near, and a click there does nothing).
   */
  walkTarget(p: Vec2): Vec2 | null {
    return this.hints.walkTarget(p);
  }

  /** Show where the party is walking: a marker that settles on the spot and stays until they get there. */
  markDestination(p: Vec2) {
    this.hints.markDestination(p);
  }

  /**
   * Effects as the view shows them, each when it is seen (a blow when its shot lands or its rush arrives), so what is
   * heard and felt keeps time with what is seen. Returns the unsubscribe.
   */
  onShown(fn: (events: FxEvent[]) => void) {
    return this.shows.onShown(fn);
  }

  /** Hover set by a controller (a ground cursor or a focused target). Moving the mouse takes over again. */
  padHover: HoverInfo | null = null;

  setPadHover(info: HoverInfo | null) {
    this.padHover = info;
    if (info) this.v.hover = info;
    else this.v.hover = { point: null, screenX: this.v.hover.screenX, screenY: this.v.hover.screenY };
  }

  /** What a controller cursor at this ground point points at. */
  hoverAt(p: Vec2, ids: { entityId?: string; featureId?: string; lootId?: string } = {}): HoverInfo {
    const s = this.v.groundToScreen(p.x, p.y);
    return { point: { x: p.x, y: p.y }, screenX: s.x, screenY: s.y, ...ids };
  }

  /** Developer option: a click or tap on the ground teleports the party there. */
  tapTeleport = false;
  /** Developer option: show where people can walk (green) and see through (blue). */
  showWalk = false;

  /** What lies under a screen point (canvas pixels); a finger also finds a figure or thing within `slop` pixels. */
  pickAt(sx: number, sy: number, slop = 0): HoverInfo {
    const info = this.pick(sx, sy);
    if (slop <= 0 || info.entityId || info.featureId || info.lootId) return info;
    for (const [dx, dy] of [[0, -1], [0, 1], [-1, 0], [1, 0], [-0.7, -0.7], [0.7, -0.7], [-0.7, 0.7], [0.7, 0.7]] as const) {
      const near = this.pick(sx + dx * slop, sy + dy * slop);
      if (near.entityId || near.featureId || near.lootId) return { ...near, point: info.point, screenX: sx, screenY: sy };
    }
    return info;
  }

  /** Set by touch: what a finger points at (or held on), shown as hovering is for a mouse. */
  setTouchHover(info: HoverInfo | null) {
    this.v.hover = info ?? { point: null, screenX: this.v.hover.screenX, screenY: this.v.hover.screenY };
  }

  /** A finger's walking stick: where it was put down and where the finger is now (screen pixels). */
  stick: { ox: number; oy: number; x: number; y: number } | null = null;

  private pick(sx: number, sy: number): HoverInfo {
    const p = this.v.screenToGround(sx, sy);
    const z = this.v.client.state.zone;
    const inside = !!z && p.x >= 0 && p.y >= 0 && p.x < z.width && p.y < z.height;
    const info: HoverInfo = { point: inside ? p : null, screenX: sx, screenY: sy };
    // Overlapping figures: the one whose body center is nearest the cursor wins, so a figure standing just
    // behind another can still be clicked on its visible part. Any figure under the cursor beats things on the
    // ground (a creature standing over a satchel or a sign is the one picked).
    let best: (typeof this.v.hitRects)[number] | null = null;
    let bestScore = Infinity;
    for (const h of this.v.hitRects) {
      if (sx < h.x || sy < h.y || sx > h.x + h.w || sy > h.y + h.h) continue;
      const nx = (sx - (h.x + h.w / 2)) / (h.w / 2), ny = (sy - (h.y + h.h * 0.45)) / (h.h / 2);
      const score = nx * nx + ny * ny + (h.kind === 'entity' ? 0 : 100) - h.depth * 1e-4;
      if (score < bestScore) {
        best = h;
        bestScore = score;
      }
    }
    if (best) {
      if (best.kind === 'entity') info.entityId = best.id;
      else if (best.kind === 'feature') info.featureId = best.id;
      else info.lootId = best.id;
    }
    // A way out at the map's edge is all of its road out to the edge, not just where it stands.
    if (!best && info.point && z) {
      let bd = WAY_REACH;
      for (const f of z.features) {
        if (f.kind !== 'exit') continue;
        const q = nearestOnWay(this.v.wayOf(f), info.point), d = Math.hypot(q.x - info.point.x, q.y - info.point.y);
        if (d < bd) (bd = d), (info.featureId = f.id);
      }
    }
    return info;
  }

  // ---------------------------------------------------------------------------- frame

  private enteredZone(z: ZoneData) {
    const key = `${z.id}:${this.v.client.state.world?.id}`;
    if (key === this.v.zoneKey) return;
    this.v.zoneKey = key;
    this.figures.anims.clear();
    this.v.camInit = false;
    this.sky.weather = [];
    this.overlays.reach = null;
    this.sky.fogBytes = null;
    this.things.chests.clear();
    this.v.ways.clear();
    this.things.piles.clear();
    this.things.pickups = [];
    // Blows still in flight in the place left are not shown here; what they held back shows at once.
    for (const f of this.shows.inFlight.values()) for (const ev of f.events) if (strikes(ev)) this.v.client.landed(ev.targetId!);
    this.shows.inFlight.clear();
  }

  /** The place's painting, once loaded. */
  private painting(z: ZoneData): HTMLImageElement | null {
    return z.painting ? loadImage(this.v.client.assetUrl(z.painting.image)) : null;
  }

  private render(dt: number) {
    const st = this.v.client.state;
    const ctx = this.v.ctx;
    this.v.setScreenTransform();
    const z = st.zone;
    ctx.fillStyle = '#07060a';
    ctx.fillRect(0, 0, this.v.W, this.v.H);
    // A canvas with no size (the game screen closing, or hidden) has nothing to draw, and its light and fog layers
    // cannot be drawn from.
    if (!z || !this.sky.lightCanvas.width || !this.sky.lightCanvas.height) return;
    this.enteredZone(z);
    this.v.fx.update(dt);
    // The camera follows the leader. In a fight it follows whoever acts, whichever side and whoever commands them,
    // unless the player has moved the view (see fightCamera).
    const cb = st.combat;
    const key = cb ? `${cb.round}:${cb.actingIds.join()}` : '';
    if (key !== this.v.panKey) (this.v.panKey = key), (this.v.panTo = null), (this.v.panSpeed = { x: 0, y: 0 });
    const vx = this.v.panSpeed.x + this.mouse.edge.x, vy = this.v.panSpeed.y + this.mouse.edge.y;
    if (vx || vy) this.v.panBy(vx * dt, vy * dt);
    const leader = this.v.client.leaderEntity();
    if (!cb) {
      // The view is moved only in a fight: what moved it is forgotten with the fight.
      this.v.fightLook = null;
      this.mouse.dragging = null;
      this.mouse.edge = { x: 0, y: 0 };
    }
    if (leader) {
      const lp = this.v.client.entityPos(leader);
      if (cb && this.v.camInit) this.v.fightCamera(z, cb, lp, dt, (e) => this.figures.shownAt(e));
      else {
        const k = this.v.camInit ? Math.min(1, dt * 6) : 1;
        const look = (this.v.look = this.v.panTo ?? this.v.framed(z, lp));
        this.v.camX += (look.x - this.v.camX) * k;
        this.v.camY += (look.y - this.v.camY) * k;
        this.v.camVel = { x: 0, y: 0 };
      }
      this.v.camInit = true;
      this.sky.updateExplored(z, lp);
    }
    // 1. The ground: the place's painting (darkness until it has loaded).
    const img = this.painting(z);
    if (!img || !z.painting) {
      // Nothing of the place left behind can be pointed at meanwhile.
      this.v.hitRects = [];
      return;
    }
    this.v.setWorldTransform();
    ctx.imageSmoothingQuality = 'high';
    ctx.drawImage(img, -z.painting.ox, -z.painting.oy, z.painting.width, z.painting.height);
    this.v.light.update(`${this.v.zoneKey}:${z.painting.image}`, z.look, img, -z.painting.ox, -z.painting.oy);
    this.sky.drawMist(z, 'ground');
    if (this.showWalk) this.hints.drawWalkable(z);
    // 2. On the ground: combat and targeting overlays.
    this.overlays.drawGroundOverlays(z);
    // 3. Everything standing, nearest the viewer last.
    this.v.hitRects = [];
    const list: Drawable[] = [];
    this.things.collectFeatures(list, z);
    this.things.collectLoot(list);
    this.figures.collectEntities(list, dt);
    list.sort((a, b) => a.depth - b.depth);
    for (const d of list) {
      try {
        d.draw();
      } catch (e) {
        ctx.restore?.();
        if (!this.warned) {
          console.error('[renderer] drawable failed', e);
          reportError(e, 'drawing the game view');
        }
        this.warned = true;
      }
    }
    // 4. Particles and projectiles, the mist (fog of war), light, weather; floating texts and labels on top.
    this.shows.drawFx();
    this.sky.drawMist(z, 'air');
    this.sky.drawLighting(z);
    this.sky.drawWeather(dt, z);
    this.v.setWorldTransform();
    // Walk hints over the light, so they read at night too.
    this.hints.drawWalkHints(z);
    this.shows.drawTexts();
    this.labels.drawOverlayLabels(z);
    this.drawStick();
    // The mouse shows a hand over anyone or anything a click would use.
    const h = this.v.hover, usable = st.inputMode === 'mouse' && !!(h.entityId || h.featureId || h.lootId);
    if (usable !== this.usable) this.v.canvas.classList.toggle('usable', (this.usable = usable));
  }

  /** The touch stick: a soft ring where the finger went down and a knob under it. */
  private drawStick() {
    const s = this.stick;
    if (!s) return;
    const ctx = this.v.ctx;
    this.v.setScreenTransform();
    const R = STICK_R, dx = s.x - s.ox, dy = s.y - s.oy, d = Math.hypot(dx, dy), k = d > R ? R / d : 1;
    ctx.save();
    ctx.fillStyle = 'rgba(10, 9, 13, 0.28)';
    ctx.strokeStyle = 'rgba(255, 246, 225, 0.35)';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(s.ox, s.oy, R, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = 'rgba(255, 246, 225, 0.55)';
    ctx.shadowColor = 'rgba(0, 0, 0, 0.6)';
    ctx.shadowBlur = 8;
    ctx.beginPath();
    ctx.arc(s.ox + dx * k, s.oy + dy * k, 20, 0, Math.PI * 2);
    ctx.fill();
    ctx.restore();
  }

  private usable = false;
  private warned = false;
}
