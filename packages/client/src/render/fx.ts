/**
 * Particles, projectiles, and floating combat text. Positions are in ground meters plus a height `z` (`Z` picture px
 * a unit).
 *
 * Every effect is drawn from a world's look (rules.ts `kindLook`): one or two shapes in two or three colors, a
 * motion and a trail, so an office throws paper and coffee and a forest leaves and petals. Shapes are drawn once into
 * small stamps (no per-frame blur or gradients), glowing ones with their halo baked in, and drawn over the scene
 * rather than added as light, which would wash out on a bright painting by day.
 *
 * How much is drawn follows how much a moment matters: a scratch is a few flecks and a small number, a blow that takes
 * a third of someone's Health a full burst, a flash, and a big number, a kill a burst and a ring. There is a particle
 * budget (smaller on touch screens), and reduced motion halves it.
 */
import { PX_PER_METER, type FxBlast, type FxLook, type FxShape, type FxShot } from '@daydream/shared';
import { isTouch } from '../input/pointer';

const M = PX_PER_METER;
/** Picture px a unit of height stands for. */
export const Z = 32;
/**
 * Figures are drawn from a three-quarter camera over the top-down ground, so what lies flat around their feet (their
 * contact shadow, the rings under them and on the ground) is drawn flattened by this, as that camera sees it.
 */
export const SHADOW_FLAT = 0.6;

interface Particle {
  kind: 'stamp' | 'ring' | 'text' | 'slash' | 'flash' | 'line' | 'shaft';
  x: number;
  y: number;
  z: number;
  vx: number;
  vy: number;
  vz: number;
  life: number;
  max: number;
  /** Picture px across (ring: line width; text: font px). */
  size: number;
  color: string;
  glow?: boolean;
  gravity?: number;
  /** Share of speed lost a second. */
  drag?: number;
  stamp?: HTMLCanvasElement;
  rot?: number;
  spin?: number;
  /** Turned along its flight (streaks, embers, bolts). */
  orient?: boolean;
  /** Size at the end of its life over size at the start. */
  grow?: number;
  /** Circling: center, radius, angle, turn rate, and how fast the radius grows (a share a second; drawn in below 0). */
  orbit?: { cx: number; cy: number; r: number; a: number; w: number; dr?: number };
  /** A line's far end (it is drawn from there to x, y). */
  from?: { x: number; y: number };
  text?: string;
  font?: string;
  /** Ring radius in meters; slash facing. */
  r?: number;
  a0?: number;
}

interface Projectile {
  x0: number;
  y0: number;
  x1: number;
  y1: number;
  t: number;
  /** Seconds until it lands (a ray or a bolt then lingers a moment). */
  dur: number;
  look: FxLook;
  kind: FxShot;
  onHit?: () => void;
  /** How high it arcs (height units). */
  arc: number;
  /** Time to the next trail particle. */
  emit: number;
}

/** A swarm's shapes, and the seconds between one setting off and the next. */
const SWARM_N = 7;
const SWARM_GAP = 0.035;

// ---------------------------------------------------------------------------------------------------- stamps

const S = 32;
const stamps = new Map<string, HTMLCanvasElement>();

function shade(hex: string, k: number): string {
  const n = parseInt(hex.slice(1), 16);
  const f = (c: number) => Math.round(k < 0 ? c * (1 + k) : c + (255 - c) * k);
  return `#${[(n >> 16) & 255, (n >> 8) & 255, n & 255].map((c) => f(c).toString(16).padStart(2, '0')).join('')}`;
}

/** Draw one shape about 26 px across, centered at 0,0, pointing right where it has a direction. */
function shapePath(g: CanvasRenderingContext2D, shape: FxShape, color: string) {
  const light = shade(color, 0.55), dark = shade(color, -0.35);
  g.fillStyle = color;
  g.strokeStyle = color;
  g.lineCap = 'round';
  g.lineJoin = 'round';
  const fill = (path: () => void, edge?: string) => {
    g.beginPath();
    path();
    g.fill();
    if (edge) {
      g.strokeStyle = edge;
      g.lineWidth = 1.5;
      g.stroke();
    }
  };
  switch (shape) {
    case 'spark':
    case 'mote':
      fill(() => g.arc(0, 0, shape === 'spark' ? 6 : 8, 0, Math.PI * 2));
      g.fillStyle = light;
      fill(() => g.arc(0, 0, shape === 'spark' ? 3 : 4, 0, Math.PI * 2));
      break;
    case 'dust':
      fill(() => g.arc(0, 0, 5, 0, Math.PI * 2));
      break;
    case 'ember':
      fill(() => g.ellipse(0, 0, 11, 4, 0, 0, Math.PI * 2));
      g.fillStyle = light;
      fill(() => g.ellipse(2, 0, 6, 2, 0, 0, Math.PI * 2));
      break;
    case 'streak':
      g.lineWidth = 4;
      g.beginPath();
      g.moveTo(-13, 0);
      g.lineTo(13, 0);
      g.stroke();
      g.strokeStyle = light;
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(-4, 0);
      g.lineTo(13, 0);
      g.stroke();
      break;
    case 'shard':
      fill(() => {
        g.moveTo(13, 0);
        g.lineTo(-4, -5);
        g.lineTo(-12, 1);
        g.lineTo(-3, 4);
        g.closePath();
      }, dark);
      g.fillStyle = light;
      fill(() => {
        g.moveTo(11, 0);
        g.lineTo(-3, -3);
        g.lineTo(-2, 0);
        g.closePath();
      });
      break;
    case 'droplet':
      fill(() => {
        g.moveTo(13, 0);
        g.bezierCurveTo(4, -2, -10, -8, -10, 0);
        g.bezierCurveTo(-10, 8, 4, 2, 13, 0);
      }, dark);
      g.fillStyle = light;
      fill(() => g.arc(-5, -2, 2.2, 0, Math.PI * 2));
      break;
    case 'bubble':
      g.lineWidth = 2;
      g.beginPath();
      g.arc(0, 0, 9, 0, Math.PI * 2);
      g.stroke();
      g.globalAlpha = 0.25;
      fill(() => g.arc(0, 0, 9, 0, Math.PI * 2));
      g.globalAlpha = 1;
      g.fillStyle = '#ffffff';
      fill(() => g.arc(-3.5, -3.5, 2.2, 0, Math.PI * 2));
      break;
    case 'flake':
      g.lineWidth = 2;
      for (let i = 0; i < 3; i++) {
        const a = (i * Math.PI) / 3;
        g.beginPath();
        g.moveTo(Math.cos(a) * 11, Math.sin(a) * 11);
        g.lineTo(-Math.cos(a) * 11, -Math.sin(a) * 11);
        g.stroke();
      }
      g.fillStyle = light;
      fill(() => g.arc(0, 0, 2.5, 0, Math.PI * 2));
      break;
    case 'petal':
      fill(() => {
        g.moveTo(-11, 0);
        g.quadraticCurveTo(0, -9, 11, 0);
        g.quadraticCurveTo(0, 9, -11, 0);
      }, dark);
      g.fillStyle = light;
      fill(() => g.ellipse(-2, -1, 5, 2, 0, 0, Math.PI * 2));
      break;
    case 'leaf':
      fill(() => {
        g.moveTo(-12, 0);
        g.quadraticCurveTo(-2, -10, 12, 0);
        g.quadraticCurveTo(-2, 10, -12, 0);
      }, dark);
      g.strokeStyle = light;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(-12, 0);
      g.lineTo(10, 0);
      g.stroke();
      break;
    case 'chunk':
      // A rough lump knocked loose (stone, wood, ice), lit on its upper face.
      fill(() => {
        g.moveTo(-9, -5);
        g.lineTo(-2, -10);
        g.lineTo(8, -7);
        g.lineTo(11, 2);
        g.lineTo(4, 9);
        g.lineTo(-7, 8);
        g.lineTo(-11, 1);
        g.closePath();
      }, dark);
      g.fillStyle = light;
      fill(() => {
        g.moveTo(-7, -4);
        g.lineTo(-2, -8);
        g.lineTo(6, -5);
        g.lineTo(0, -1);
        g.closePath();
      });
      break;
    case 'paper':
      fill(() => {
        g.moveTo(-10, -7);
        g.lineTo(9, -9);
        g.lineTo(11, 6);
        g.lineTo(-8, 8);
        g.closePath();
      }, dark);
      g.strokeStyle = dark;
      g.lineWidth = 1;
      g.beginPath();
      g.moveTo(-6, -2);
      g.lineTo(6, -3);
      g.moveTo(-5, 2);
      g.lineTo(5, 1.5);
      g.stroke();
      break;
    case 'pixel':
      g.fillRect(-7, -7, 14, 14);
      g.fillStyle = light;
      g.fillRect(-7, -7, 14, 4);
      break;
    case 'glyph':
      g.lineWidth = 2.5;
      g.beginPath();
      g.moveTo(-3, -11);
      g.lineTo(-3, 11);
      g.moveTo(-3, -6);
      g.lineTo(7, -11);
      g.moveTo(-3, 1);
      g.lineTo(7, -4);
      g.moveTo(-3, 4);
      g.lineTo(5, 10);
      g.stroke();
      break;
    case 'star':
      fill(() => {
        for (let i = 0; i < 10; i++) {
          const a = -Math.PI / 2 + (i * Math.PI) / 5, r = i % 2 ? 4.5 : 12;
          g.lineTo(Math.cos(a) * r, Math.sin(a) * r);
        }
        g.closePath();
      });
      g.fillStyle = light;
      fill(() => g.arc(0, 0, 3, 0, Math.PI * 2));
      break;
    case 'smoke': {
      const r = g.createRadialGradient(0, 0, 0, 0, 0, 14);
      // Thin, so puffs that pile up stay smoke and never become a solid disc.
      r.addColorStop(0, color + '60');
      r.addColorStop(0.5, color + '38');
      r.addColorStop(1, color + '00');
      g.fillStyle = r;
      fill(() => g.arc(0, 0, 14, 0, Math.PI * 2));
      break;
    }
    case 'note':
      fill(() => g.ellipse(-4, 7, 5, 3.5, -0.4, 0, Math.PI * 2));
      g.lineWidth = 2;
      g.beginPath();
      g.moveTo(0.5, 6);
      g.lineTo(0.5, -11);
      g.quadraticCurveTo(7, -8, 8, -2);
      g.stroke();
      break;
    case 'feather':
      fill(() => {
        g.moveTo(-12, 0);
        g.quadraticCurveTo(-2, -8, 12, -1);
        g.quadraticCurveTo(0, 6, -12, 0);
      }, dark);
      g.strokeStyle = light;
      g.lineWidth = 1.2;
      g.beginPath();
      g.moveTo(-13, 1);
      g.quadraticCurveTo(0, -1, 12, -1);
      g.stroke();
      break;
    case 'coin':
      fill(() => g.ellipse(0, 0, 9, 9, 0, 0, Math.PI * 2), dark);
      g.strokeStyle = light;
      g.lineWidth = 1.5;
      g.beginPath();
      g.arc(0, 0, 5.5, Math.PI * 0.9, Math.PI * 1.9);
      g.stroke();
      break;
    case 'crescent':
      fill(() => {
        g.arc(0, 0, 11, Math.PI * 0.3, Math.PI * 1.7);
        g.arc(4, 0, 8, Math.PI * 1.55, Math.PI * 0.45, true);
        g.closePath();
      });
      g.fillStyle = light;
      fill(() => g.arc(-6, -3, 2, 0, Math.PI * 2));
      break;
    case 'halo':
      g.lineWidth = 3;
      g.beginPath();
      g.ellipse(0, 0, 11, 6, 0, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = light;
      g.lineWidth = 1.2;
      g.beginPath();
      g.ellipse(0, 0, 11, 6, 0, Math.PI * 1.1, Math.PI * 1.7);
      g.stroke();
      break;
    case 'bolt':
      g.lineWidth = 3;
      g.beginPath();
      g.moveTo(-13, -2);
      g.lineTo(-4, 3);
      g.lineTo(1, -4);
      g.lineTo(13, 2);
      g.stroke();
      g.strokeStyle = '#ffffff';
      g.lineWidth = 1.2;
      g.stroke();
      break;
  }
}

/** A shape in a color, drawn once: S px for matter, 2S with a soft halo for what glows. */
export function stamp(shape: FxShape, color: string, glow: boolean): HTMLCanvasElement {
  const key = `${shape}|${color}|${glow ? 1 : 0}`;
  let c = stamps.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  const size = glow ? S * 2 : S;
  c.width = c.height = size;
  const g = c.getContext('2d')!;
  g.translate(size / 2, size / 2);
  if (glow) {
    const r = g.createRadialGradient(0, 0, 0, 0, 0, S);
    r.addColorStop(0, color + '88');
    r.addColorStop(0.35, color + '30');
    r.addColorStop(1, color + '00');
    g.fillStyle = r;
    g.fillRect(-S, -S, S * 2, S * 2);
  }
  // Matter gets a soft dark edge so it reads on any ground, light or dark (baked in once, not blurred per frame).
  if (!glow && shape !== 'smoke') {
    g.shadowColor = 'rgba(0,0,0,0.7)';
    g.shadowBlur = 2.5;
  }
  shapePath(g, shape, color);
  stamps.set(key, c);
  return c;
}

/** A column of light in a color, drawn once: brightest along its middle and at its foot, fading up and to its sides. */
function shaftStamp(color: string): HTMLCanvasElement {
  const key = `shaft|${color}`;
  let c = stamps.get(key);
  if (c) return c;
  c = document.createElement('canvas');
  c.width = 32;
  c.height = 128;
  const g = c.getContext('2d')!;
  const across = g.createLinearGradient(0, 0, 32, 0);
  across.addColorStop(0, color + '00');
  across.addColorStop(0.35, color + 'a0');
  across.addColorStop(0.5, shade(color, 0.6));
  across.addColorStop(0.65, color + 'a0');
  across.addColorStop(1, color + '00');
  g.fillStyle = across;
  g.fillRect(0, 0, 32, 128);
  const up = g.createLinearGradient(0, 128, 0, 0);
  up.addColorStop(0, 'rgba(0,0,0,1)');
  up.addColorStop(0.6, 'rgba(0,0,0,0.55)');
  up.addColorStop(1, 'rgba(0,0,0,0)');
  g.globalCompositeOperation = 'destination-in';
  g.fillStyle = up;
  g.fillRect(0, 0, 32, 128);
  stamps.set(key, c);
  return c;
}

/** One shape of a look drawn `size` px across at the current origin's top left (a status's icon in the interface). */
export function drawShapeIcon(ctx: CanvasRenderingContext2D, shape: FxShape, color: string, size: number) {
  ctx.drawImage(stamp(shape, color, false), 0, 0, size, size);
}

const ORIENTED = new Set<FxShape>(['streak', 'ember', 'bolt', 'droplet', 'feather']);
/** Shapes with weight: they fall back down when thrown. */
const HEAVY = new Set<FxShape>(['shard', 'chunk', 'droplet', 'paper', 'pixel', 'dust', 'leaf', 'petal', 'flake', 'coin']);

const rnd = (a: number, b: number) => a + Math.random() * (b - a);
const pick = <T>(xs: readonly T[]): T => xs[Math.floor(Math.random() * xs.length)]!;
/** The first color most often, the others for variety. */
const colorOf = (l: FxLook) => (l.colors.length > 1 && Math.random() < 0.4 ? pick(l.colors.slice(1)) : l.colors[0]!);
/** The main shape most often. */
const shapeOf = (l: FxLook) => (l.shapes.length > 1 && Math.random() < 0.35 ? l.shapes[1]! : l.shapes[0]!);

/** Seconds a shot stays drawn after it lands (a flash or a beam fading). */
const linger = (k: FxShot) => (k === 'bolt' ? 0.2 : k === 'ray' ? 0.3 : 0);

/** The player's reduced-motion preference, asked for once (the answer follows the setting as it changes). */
const calmQuery = typeof matchMedia === 'function' ? matchMedia('(prefers-reduced-motion: reduce)') : null;
const reducedMotion = () => !!calmQuery?.matches;

// ---------------------------------------------------------------------------------------------------- system

export class FxSystem {
  particles: Particle[] = [];
  projectiles: Projectile[] = [];
  /** Parts of an effect that come a moment later (a vortex's burst, a quake's later rings). */
  private later: { at: number; run: () => void }[] = [];
  private clock = 0;

  /** Most particles alive at once, and how many of a burst's are drawn. */
  private budget() {
    const k = (isTouch() ? 0.45 : 1) * (reducedMotion() ? 0.5 : 1);
    return { max: Math.round(700 * k), share: k };
  }

  /** How many of `n` particles to spawn now, within the budget. */
  private count(n: number) {
    const b = this.budget();
    const room = Math.max(0, b.max - this.particles.length);
    return Math.min(room, Math.max(n > 0 ? 1 : 0, Math.round(n * b.share)));
  }

  get calm() {
    return reducedMotion();
  }

  update(dt: number) {
    this.clock += dt;
    if (this.later.length) {
      const due = this.later.filter((l) => l.at <= this.clock);
      this.later = this.later.filter((l) => l.at > this.clock);
      for (const l of due) l.run();
    }
    for (const p of this.particles) {
      p.life -= dt;
      if (p.orbit) {
        const o = p.orbit;
        o.a += o.w * dt;
        o.r = Math.max(0.03, o.r * (1 + dt * (o.dr ?? 0.25)));
        p.x = o.cx + Math.cos(o.a) * o.r;
        p.y = o.cy + Math.sin(o.a) * o.r * SHADOW_FLAT;
        p.z += p.vz * dt;
        continue;
      }
      if (p.drag) {
        const k = Math.max(0, 1 - p.drag * dt);
        p.vx *= k;
        p.vy *= k;
        p.vz *= p.gravity ? 1 : k;
      }
      p.x += p.vx * dt;
      p.y += p.vy * dt;
      p.z += p.vz * dt;
      if (p.spin) p.rot = (p.rot ?? 0) + p.spin * dt;
      if (p.gravity) p.vz -= p.gravity * dt;
      if (p.z < 0 && p.gravity) {
        p.z = 0;
        p.vz *= -0.3;
        p.vx *= 0.5;
        p.vy *= 0.5;
        p.spin = (p.spin ?? 0) * 0.5;
      }
    }
    this.particles = this.particles.filter((p) => p.life > 0);
    for (const pr of this.projectiles) {
      pr.t += dt;
      if (pr.t >= pr.dur && pr.onHit) {
        pr.onHit();
        pr.onHit = undefined;
      }
      if ((pr.kind === 'orb' || pr.kind === 'lob' || pr.kind === 'swarm') && pr.t < pr.dur) {
        pr.emit -= dt;
        if (pr.emit <= 0) {
          pr.emit = pr.kind === 'swarm' ? 1 / 20 : 1 / 45;
          const f = pr.kind === 'swarm' ? Math.min(1, pr.t / (pr.dur - (SWARM_N - 1) * SWARM_GAP)) : pr.t / pr.dur;
          this.trail(pr, pr.x0 + (pr.x1 - pr.x0) * f, pr.y0 + (pr.y1 - pr.y0) * f, 1.2 + Math.sin(f * Math.PI) * pr.arc);
        }
      }
    }
    this.projectiles = this.projectiles.filter((p) => p.t < p.dur + linger(p.kind));
  }

  private trail(pr: Projectile, x: number, y: number, z: number) {
    const l = pr.look;
    if (l.trail === 'none' || l.trail === 'streak' || !this.count(1)) return;
    const c = colorOf(l);
    const base = { x: x + rnd(-0.05, 0.05), y: y + rnd(-0.05, 0.05), z, kind: 'stamp' as const, color: c, rot: rnd(0, 6.3) };
    if (l.trail === 'sparks') this.particles.push({ ...base, vx: rnd(-0.4, 0.4), vy: rnd(-0.4, 0.4), vz: rnd(-0.6, 0.2), life: 0.3, max: 0.3, size: rnd(8, 12), glow: true, stamp: stamp('spark', c, true), grow: 0.3 });
    else if (l.trail === 'smoke') this.particles.push({ ...base, vx: 0, vy: 0, vz: 0.3, life: 0.6, max: 0.6, size: rnd(16, 24), stamp: stamp('smoke', shade(c, -0.2), false), grow: 1.8 });
    else if (l.trail === 'bubbles') this.particles.push({ ...base, vx: rnd(-0.2, 0.2), vy: 0, vz: 0.6, life: 0.7, max: 0.7, size: rnd(8, 13), stamp: stamp('bubble', c, false), grow: 1.1 });
    else if (l.trail === 'motes') this.particles.push({ ...base, vx: rnd(-0.3, 0.3), vy: rnd(-0.3, 0.3), vz: rnd(0, 0.4), life: 0.5, max: 0.5, size: rnd(7, 11), glow: l.glow, stamp: stamp('mote', c, l.glow), grow: 0.4 });
  }

  /**
   * `n` shapes of a look at a point, moving as the look moves. `power` (about 0.5 to 2) scales speed and size;
   * `spread` is the radius they start in (meters).
   */
  emit(look: FxLook, x: number, y: number, z: number, n: number, power = 1, spread = 0.15) {
    n = this.count(n);
    for (let i = 0; i < n; i++) {
      const shape = shapeOf(look), c = colorOf(look);
      const glow = look.glow && shape !== 'smoke' && shape !== 'dust';
      const heavy = HEAVY.has(shape);
      const size = (shape === 'smoke' ? rnd(26, 40) : shape === 'dust' ? rnd(7, 11) : rnd(16, 24)) * (0.8 + power * 0.25);
      const p: Particle = { kind: 'stamp', x: x + rnd(-spread, spread), y: y + rnd(-spread, spread) * 0.7, z, vx: 0, vy: 0, vz: 0, life: 0, max: 0, size, color: c, glow, stamp: stamp(shape, c, glow), rot: rnd(0, 6.3), spin: ORIENTED.has(shape) ? 0 : rnd(-6, 6), orient: ORIENTED.has(shape), grow: shape === 'smoke' ? 1.8 : 0.6 };
      const a = rnd(0, Math.PI * 2);
      switch (look.motion) {
        case 'burst': {
          const s = rnd(1.4, 3.2) * power;
          Object.assign(p, { vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.7, vz: rnd(0.2, 1.8) * power, gravity: heavy ? 7 : 0, drag: heavy ? 0.8 : 3.5, life: rnd(0.35, 0.6) });
          break;
        }
        case 'splash': {
          const s = rnd(0.6, 1.8) * power;
          Object.assign(p, { vx: Math.cos(a) * s, vy: Math.sin(a) * s * 0.7, vz: rnd(2, 3.6) * power, gravity: 9, drag: 0.5, life: rnd(0.5, 0.8) });
          break;
        }
        case 'swirl':
          Object.assign(p, { orbit: { cx: x, cy: y, r: rnd(0.35, 0.6) * Math.min(1.5, power), a, w: rnd(5, 8) * (Math.random() < 0.5 ? 1 : -1) }, z: z * rnd(0.3, 1.2), vz: rnd(0.3, 0.8), life: rnd(0.5, 0.8) });
          break;
        case 'rise':
          Object.assign(p, { x: x + rnd(-0.4, 0.4), y: y + rnd(-0.3, 0.3), z: rnd(0, z), vx: rnd(-0.15, 0.15), vy: 0, vz: rnd(0.8, 1.6) * Math.min(1.4, power), drag: 0.5, life: rnd(0.7, 1.1), grow: 0.4 });
          break;
        case 'fall':
          Object.assign(p, { x: x + rnd(-0.45, 0.45), y: y + rnd(-0.3, 0.3), z: z + rnd(0.4, 1), vx: rnd(-0.1, 0.1), vy: 0, vz: rnd(-1.6, -0.6), gravity: 2, life: rnd(0.6, 0.9) });
          break;
        case 'drift':
          Object.assign(p, { x: x + rnd(-0.5, 0.5), y: y + rnd(-0.35, 0.35), z: rnd(0.3, z + 0.5), vx: rnd(-0.4, 0.4), vy: rnd(-0.3, 0.3), vz: rnd(-0.1, 0.3), drag: 0.6, life: rnd(0.8, 1.3) });
          break;
      }
      if (p.orient) p.rot = Math.atan2(p.vy - p.vz * 0.6, p.vx || 0.01);
      p.max = p.life;
      this.particles.push(p);
    }
  }

  /**
   * A hit (or heal) on someone, as much as it matters: `weight` is the share of their Health it took,
   * a crit counts for more. Matter is thrown away from the blow (`from` is the attacker).
   */
  impact(look: FxLook, x: number, y: number, weight: number, opts: { crit?: boolean; from?: { x: number; y: number }; z?: number } = {}) {
    const w = Math.min(1, weight * (opts.crit ? 1.6 : 1));
    const z = opts.z ?? 1;
    // A quick flash where it lands for anything more than a scratch.
    if (w >= 0.06) {
      const c = shade(look.colors[0]!, 0.5);
      this.particles.push({ kind: 'flash', x, y, z, vx: 0, vy: 0, vz: 0, life: 0.13, max: 0.13, size: 34 + 60 * Math.sqrt(w), color: c, glow: look.glow });
    }
    const n = 3 + Math.round(26 * Math.sqrt(w));
    const before = this.particles.length;
    this.emit(look, x, y, z, n, 0.7 + w * 1.3);
    // Thrown things carry on the way the blow went.
    if (opts.from && (look.motion === 'burst' || look.motion === 'splash')) {
      const dx = x - opts.from.x, dy = y - opts.from.y, d = Math.hypot(dx, dy) || 1;
      for (let i = before; i < this.particles.length; i++) {
        const p = this.particles[i]!;
        p.vx += (dx / d) * 1.4;
        p.vy += (dy / d) * 1.0;
      }
    }
  }

  /** Someone fell: a full burst of what struck them and a fading ring on the ground. */
  kill(look: FxLook, x: number, y: number, big = false) {
    this.emit(look, x, y, 0.9, big ? 46 : 28, big ? 2 : 1.5, 0.3);
    this.ring(x, y, big ? 2.4 : 1.4, look.colors[0]!, 0.6);
  }

  /** A melee swing: a bright crescent across the target, facing from the attacker. */
  slash(x: number, y: number, from: { x: number; y: number } | null, color: string, weight = 0.2) {
    const a = from ? Math.atan2(y - from.y, x - from.x) : rnd(0, Math.PI * 2);
    this.particles.push({ kind: 'slash', x, y, z: 1, vx: 0, vy: 0, vz: 0, life: 0.2, max: 0.2, size: 3 + weight * 6, color: shade(color, 0.6), r: 0.55 + weight * 0.3, a0: a });
  }

  ring(x: number, y: number, r: number, color: string, life = 0.55) {
    this.particles.push({ kind: 'ring', x, y, z: 0.05, vx: 0, vy: 0, vz: 0, life, max: life, size: 3, color, r });
  }

  /** Soft puffs (a fall, a shadow, a cloud). */
  smoke(x: number, y: number, color = '#504646', n = 10, r = 0.3) {
    this.emit({ shapes: ['smoke'], colors: [color], glow: false, motion: 'drift', trail: 'none' }, x, y, 0.4, n, 1, r);
  }

  /** One shape of a look about someone with a lasting state (called now and then, so it lingers quietly). */
  aura(look: FxLook, x: number, y: number, height: number) {
    if (!this.count(1)) return;
    const shape = shapeOf(look), c = colorOf(look);
    // About the figure, however big it is: a third of its height across.
    const top = height / Z, w = 0.14 * top;
    const p: Particle = { kind: 'stamp', x: x + rnd(-w, w), y: y + rnd(-w, w) * 0.4, z: rnd(0.2, top), vx: 0, vy: 0, vz: 0, life: 0, max: 0, size: rnd(13, 18), color: c, glow: look.glow, stamp: stamp(shape, c, look.glow), rot: rnd(0, 6.3), spin: rnd(-2, 2), grow: 0.5 };
    if (look.motion === 'fall' || look.motion === 'splash') Object.assign(p, { z: rnd(top * 0.4, top), vz: -rnd(0.5, 0.9), life: 0.7 });
    else if (look.motion === 'swirl') Object.assign(p, { orbit: { cx: x, cy: y, r: Math.max(0.4, w * 1.3), a: rnd(0, 6.3), w: 3 }, z: rnd(0.3, top * 0.8), vz: 0.2, life: 1 });
    else if (look.motion === 'drift') Object.assign(p, { vx: rnd(-0.2, 0.2), vz: rnd(-0.1, 0.2), life: 1.1 });
    else Object.assign(p, { vz: rnd(0.4, 0.8), life: 0.9 });
    p.max = p.life;
    this.particles.push(p);
  }

  /**
   * A skill landing over an area of radius `r` (meters), as its kind of damage's blast: a ring spreading out, a column
   * bursting up, a shower from above, a vortex drawn in before it bursts, or a quake of shock rings and dust.
   */
  blast(kind: FxBlast, look: FxLook, x: number, y: number, r: number) {
    const c0 = look.colors[0]!, deep = look.colors[look.colors.length - 1]!;
    const piece = (glowOk = true) => {
      const shape = shapeOf(look), c = colorOf(look);
      const glow = glowOk && look.glow && shape !== 'smoke' && shape !== 'dust';
      return { shape, c, glow, stamp: stamp(shape, c, glow) };
    };
    switch (kind) {
      case 'ring':
        this.ring(x, y, r, c0);
        this.emit(look, x, y, 0.6, 26, 1.8, r * 0.4);
        break;
      case 'pillar': {
        this.particles.push({ kind: 'shaft', x, y, z: 0, vx: 0, vy: 0, vz: 0, life: 0.55, max: 0.55, size: r * M * 0.9, color: c0, glow: look.glow });
        this.ring(x, y, r * 0.7, c0, 0.45);
        const n = this.count(24);
        for (let i = 0; i < n; i++) {
          const a = rnd(0, Math.PI * 2), d = Math.sqrt(Math.random()) * r * 0.55, q = piece(), life = rnd(0.5, 0.85);
          this.particles.push({ kind: 'stamp', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.7, z: rnd(0, 0.4), vx: 0, vy: 0, vz: rnd(3, 6.5), drag: 1.6, life, max: life, size: rnd(16, 24), color: q.c, glow: q.glow, stamp: q.stamp, rot: rnd(0, 6.3), spin: rnd(-4, 4), grow: 0.5 });
        }
        break;
      }
      case 'rain': {
        const n = this.count(28);
        for (let i = 0; i < n; i++) {
          const a = rnd(0, Math.PI * 2), d = Math.sqrt(Math.random()) * r, q = piece(), life = rnd(0.9, 1.2), o = ORIENTED.has(q.shape);
          this.particles.push({ kind: 'stamp', x: x + Math.cos(a) * d, y: y + Math.sin(a) * d * 0.7, z: rnd(3, 7), vx: rnd(-0.2, 0.2), vy: 0, vz: -rnd(5, 8), gravity: 6, life, max: life, size: rnd(15, 22), color: q.c, glow: q.glow, stamp: q.stamp, rot: rnd(0, 6.3), orient: o, spin: o ? 0 : rnd(-5, 5), grow: 0.6 });
        }
        this.later.push({ at: this.clock + 0.45, run: () => this.ring(x, y, r, c0, 0.5) });
        break;
      }
      case 'vortex': {
        const n = this.count(24);
        for (let i = 0; i < n; i++) {
          const q = piece(), life = rnd(0.4, 0.5);
          this.particles.push({ kind: 'stamp', x, y, z: rnd(0.2, 1.3), vx: 0, vy: 0, vz: 0.4, life, max: life, size: rnd(15, 21), color: q.c, glow: q.glow, stamp: q.stamp, rot: rnd(0, 6.3), spin: rnd(-6, 6), grow: 0.6, orbit: { cx: x, cy: y, r: r * rnd(0.8, 1.15), a: rnd(0, Math.PI * 2), w: 7, dr: -3.2 } });
        }
        this.later.push({
          at: this.clock + 0.42,
          run: () => {
            this.emit({ ...look, motion: 'burst' }, x, y, 0.7, 26, 2, 0.2);
            this.ring(x, y, r * 0.8, c0, 0.45);
          },
        });
        break;
      }
      case 'quake': {
        const dust: FxLook = { shapes: ['dust', 'smoke'], colors: [shade(deep, -0.35), shade(deep, -0.55)], glow: false, motion: 'splash', trail: 'none' };
        [0, 0.12, 0.24].forEach((t, i) => this.later.push({ at: this.clock + t, run: () => this.ring(x, y, r * (0.55 + i * 0.35), i ? deep : c0, 0.5) }));
        this.emit(dust, x, y, 0.1, 22, 1.2, r * 0.6);
        this.emit({ ...look, motion: 'splash' }, x, y, 0.2, 12, 1.4, r * 0.5);
        break;
      }
    }
  }

  /** A bright line from one point to another that fades from where it began (a rush as a streak). */
  streak(x0: number, y0: number, x1: number, y1: number, color: string, glow: boolean) {
    this.particles.push({ kind: 'line', x: x1, y: y1, z: 0.9, vx: 0, vy: 0, vz: 0, life: 0.4, max: 0.4, size: 16, color, glow, from: { x: x0, y: y0 } });
  }

  /** A kick of dust low on the ground (a rush setting off or landing). */
  dust(x: number, y: number, n = 8, spread = 0.25) {
    this.emit({ shapes: ['smoke', 'dust'], colors: ['#8e7c62', '#5f5343'], glow: false, motion: 'drift', trail: 'none' }, x, y, 0.15, n, 1.1, spread);
  }

  /** Someone downed getting up: the healing's look rising about them and a soft ring at their feet. */
  rise(look: FxLook, x: number, y: number) {
    this.emit({ ...look, motion: 'rise' }, x, y, 1.2, 18, 1.1, 0.35);
    this.ring(x, y, 1, look.colors[0]!, 0.6);
  }

  text(x: number, y: number, text: string, color: string, size = 15, heavy = false) {
    // Stack texts so simultaneous numbers don't overlap.
    const here = this.particles.filter((p) => p.kind === 'text' && Math.abs(p.x - x) < 0.5 && Math.abs(p.y - y) < 0.5);
    const near = here.filter((p) => p.life > p.max - 0.4).length;
    // A figure under quick fire keeps its three newest numbers; older ones fade out early rather than climb in a column.
    here.sort((a, b) => b.life / b.max - a.life / a.max).slice(2).forEach((p) => (p.life = Math.min(p.life, 0.3)));
    const life = 1.1 + size / 60;
    this.particles.push({ kind: 'text', x, y, z: 1.9 + (near * (size + 4)) / Z, vx: 0, vy: 0, vz: 0.7, life, max: life, size, color, text, font: heavy ? `700 ${size}px Cinzel, serif` : `700 ${size}px Inter, sans-serif` });
  }

  /** A number: bigger the more of someone's Health it is, in the kind's color. */
  number(x: number, y: number, amount: number, color: string, weight: number, opts: { crit?: boolean; gain?: boolean } = {}) {
    // Amounts are fractional on the server: whole numbers here, and a real hit never reads as 0.
    const shown = amount > 0 ? Math.max(1, Math.round(amount)) : Math.round(amount);
    const size = Math.round(13 + 13 * Math.sqrt(Math.min(1, weight)) + (opts.crit ? 4 : 0));
    this.text(x, y, `${opts.gain ? '+' : ''}${shown}${opts.crit ? '!' : ''}`, color, size, !!opts.crit);
  }

  /** What a ranged skill sends, flying as its shot; `onHit` runs when it lands. Returns the seconds until then. */
  projectile(x0: number, y0: number, x1: number, y1: number, look: FxLook, kind: FxShot, onHit?: () => void): number {
    const d = Math.hypot(x1 - x0, y1 - y0);
    const dur = { bolt: 0.12, ray: 0.14, arrow: Math.max(0.15, d / 22), orb: Math.max(0.15, d / 14), lob: Math.max(0.35, d / 9), swarm: Math.max(0.3, d / 11) + (SWARM_N - 1) * SWARM_GAP }[kind];
    const arc = { arrow: Math.min(1.2, d * 0.08), orb: 0.2, lob: Math.min(3, 0.6 + d * 0.25), swarm: 0.5, bolt: 0, ray: 0 }[kind];
    this.projectiles.push({ x0, y0, x1, y1, t: 0, dur, look, kind, onHit, arc, emit: 0 });
    return dur;
  }

  // -------------------------------------------------------------------------------------------- drawing

  /** Particles and projectiles, in a world transform without rotation (picture px). */
  draw(ctx: CanvasRenderingContext2D) {
    const T = ctx.getTransform();
    const k = T.a;
    ctx.save();
    for (const p of this.particles) {
      if (p.kind === 'text') continue;
      const life = Math.max(0, p.life / p.max);
      const sx = p.x * M, sy = p.y * M - p.z * Z;
      if (p.kind === 'stamp' && p.stamp) {
        const size = p.size * (p.grow === undefined ? 1 : p.grow + (1 - p.grow) * life) * (p.glow ? 2 : 1);
        const rot = p.orient ? Math.atan2(p.vy - p.vz * 0.6, p.vx || 0.0001) : p.rot ?? 0;
        const c = Math.cos(rot) * k, s = Math.sin(rot) * k;
        ctx.setTransform(c, s, -s, c, T.e + sx * k, T.f + sy * k);
        // Drawn over, not added as light: added light vanishes on a bright painted ground by day (the halo in the
        // stamp and the light it casts make it glow at night).
        ctx.globalAlpha = Math.min(1, life * 2.2);
        ctx.globalCompositeOperation = 'source-over';
        ctx.drawImage(p.stamp, -size / 2, -size / 2, size, size);
        continue;
      }
      ctx.setTransform(T);
      if (p.kind === 'flash') {
        ctx.globalCompositeOperation = p.glow ? 'lighter' : 'source-over';
        ctx.globalAlpha = life * (p.glow ? 1 : 0.7);
        ctx.drawImage(stamp('mote', p.color, true), sx - p.size, sy - p.size, p.size * 2, p.size * 2);
      } else if (p.kind === 'ring') {
        const r = (1 - life) * (p.r ?? 1) * M + 6;
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = p.color;
        ctx.save();
        ctx.translate(sx, sy);
        ctx.scale(1, SHADOW_FLAT);
        ctx.globalAlpha = life * 0.35;
        ctx.lineWidth = 10 * life + 2;
        ctx.beginPath();
        ctx.arc(0, 0, r, 0, Math.PI * 2);
        ctx.stroke();
        ctx.globalAlpha = life;
        ctx.lineWidth = 3 * life + 1;
        ctx.stroke();
        ctx.restore();
      } else if (p.kind === 'line' && p.from) {
        // Brightest and widest where it ends, thinning back toward where it began.
        const fx = p.from.x * M, fy = p.from.y * M - p.z * Z;
        ctx.globalCompositeOperation = p.glow ? 'lighter' : 'source-over';
        ctx.strokeStyle = p.color;
        ctx.lineCap = 'round';
        for (const [w, al, back, c] of [[p.size, 0.3, 1, p.color], [p.size * 0.45, 0.85, 0.7, p.color], [p.size * 0.18, 1, 0.4, shade(p.color, 0.6)]] as const) {
          ctx.strokeStyle = c;
          ctx.globalAlpha = Math.min(1, life * 1.5) * al;
          ctx.lineWidth = w * (0.4 + 0.6 * life);
          ctx.beginPath();
          ctx.moveTo(sx + (fx - sx) * back * life, sy + (fy - sy) * back * life);
          ctx.lineTo(sx, sy);
          ctx.stroke();
        }
      } else if (p.kind === 'shaft') {
        // A column rising from the ground, narrowing as it fades.
        const w = p.size * (0.35 + 0.65 * life), h = 6 * Z * (0.8 + 0.2 * life);
        ctx.globalCompositeOperation = 'source-over';
        ctx.globalAlpha = Math.min(1, life * 1.8) * (p.glow ? 0.85 : 0.6);
        ctx.drawImage(shaftStamp(p.color), sx - w / 2, sy - h, w, h + 4);
      } else if (p.kind === 'slash') {
        // A crescent sweeping across in the first half of its life, fading in the second.
        const t = 1 - life, sweep = Math.min(1, t * 2.5);
        const r = (p.r ?? 0.6) * M, a = p.a0 ?? 0;
        ctx.globalCompositeOperation = 'lighter';
        ctx.strokeStyle = p.color;
        ctx.lineCap = 'round';
        ctx.save();
        ctx.translate(sx, sy);
        ctx.rotate(a + Math.PI / 2);
        ctx.scale(1, 0.7);
        const from = -1.1, to = from + 2.2 * sweep;
        ctx.globalAlpha = Math.min(1, life * 2) * 0.35;
        ctx.lineWidth = p.size * 2.4;
        ctx.beginPath();
        ctx.arc(0, 0, r, from, to);
        ctx.stroke();
        ctx.globalAlpha = Math.min(1, life * 2);
        ctx.lineWidth = p.size;
        ctx.beginPath();
        ctx.arc(0, 0, r, Math.max(from, to - 1.2), to);
        ctx.stroke();
        ctx.restore();
      }
    }
    ctx.setTransform(T);
    for (const pr of this.projectiles) this.drawProjectile(ctx, pr);
    ctx.restore();
  }

  private drawProjectile(ctx: CanvasRenderingContext2D, pr: Projectile) {
    const f = Math.min(1, pr.t / pr.dur);
    const l = pr.look, c0 = l.colors[0]!;
    const a = { x: pr.x0 * M, y: pr.y0 * M }, b = { x: pr.x1 * M, y: pr.y1 * M };
    if (pr.kind === 'bolt') {
      const fade = 1 - Math.max(0, pr.t - pr.dur) / linger('bolt');
      const pts: [number, number][] = [];
      const steps = 7;
      for (let i = 0; i <= steps; i++) {
        const t = i / steps, j = i > 0 && i < steps ? 12 : 0;
        pts.push([a.x + (b.x - a.x) * t + rnd(-j, j), a.y - 40 + (b.y - a.y + 8) * t + rnd(-j, j)]);
      }
      ctx.globalCompositeOperation = l.glow ? 'lighter' : 'source-over';
      ctx.strokeStyle = c0;
      ctx.lineJoin = 'round';
      for (const [w, al] of [[9, 0.25], [3, 1]] as const) {
        ctx.globalAlpha = fade * al;
        ctx.lineWidth = w;
        ctx.beginPath();
        pts.forEach(([x, y], i) => (i ? ctx.lineTo(x, y) : ctx.moveTo(x, y)));
        ctx.stroke();
      }
      return;
    }
    if (pr.kind === 'ray') {
      // A steady beam reaching out at once, swelling, then thinning away.
      const reach = Math.min(1, pr.t / pr.dur), fade = 1 - Math.max(0, pr.t - pr.dur) / linger('ray');
      const sy = a.y - 1.2 * Z, hx = a.x + (b.x - a.x) * reach, hy = sy + (b.y - 1 * Z - sy) * reach;
      ctx.globalCompositeOperation = l.glow ? 'lighter' : 'source-over';
      ctx.lineCap = 'round';
      for (const [w, al, c] of [[16, 0.22, c0], [7, 0.75, c0], [2.5, 1, shade(c0, 0.7)]] as const) {
        ctx.globalAlpha = fade * al;
        ctx.strokeStyle = c;
        ctx.lineWidth = w * (0.5 + 0.5 * fade);
        ctx.beginPath();
        ctx.moveTo(a.x, sy);
        ctx.lineTo(hx, hy);
        ctx.stroke();
      }
      return;
    }
    if (pr.kind === 'swarm') {
      // Many small shapes one after another, weaving about the line between.
      const each = pr.dur - (SWARM_N - 1) * SWARM_GAP, len = Math.hypot(b.x - a.x, b.y - a.y) || 1;
      const nx = -(b.y - a.y) / len, ny = (b.x - a.x) / len, size = l.glow ? 28 : 16;
      ctx.globalCompositeOperation = 'source-over';
      ctx.globalAlpha = 1;
      for (let i = 0; i < SWARM_N; i++) {
        const fi = (pr.t - i * SWARM_GAP) / each;
        if (fi < 0 || fi > 1) continue;
        const wob = Math.sin(fi * Math.PI) * Math.sin(pr.t * 11 + i * 2.1) * 14;
        const x = a.x + (b.x - a.x) * fi + nx * wob, y = a.y + (b.y - a.y) * fi + ny * wob - (1.1 + Math.sin(fi * Math.PI) * pr.arc) * Z;
        const shape = l.shapes[i % l.shapes.length]!, c = l.colors[i % l.colors.length]!;
        ctx.save();
        ctx.translate(x, y);
        ctx.rotate(ORIENTED.has(shape) ? Math.atan2(b.y - a.y, b.x - a.x) : pr.t * 9 + i);
        ctx.drawImage(stamp(shape, c, l.glow), -size / 2, -size / 2, size, size);
        ctx.restore();
      }
      return;
    }
    const x = a.x + (b.x - a.x) * f, y0 = a.y + (b.y - a.y) * f;
    const z = 1.2 + Math.sin(f * Math.PI) * pr.arc;
    const y = y0 - z * Z;
    const ang = Math.atan2(b.y - a.y - Math.cos(f * Math.PI) * pr.arc * Z, b.x - a.x);
    ctx.globalAlpha = 1;
    if (pr.kind === 'arrow') {
      ctx.globalCompositeOperation = 'source-over';
      ctx.strokeStyle = '#e8e0d0';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(x - Math.cos(ang) * 10, y - Math.sin(ang) * 10);
      ctx.lineTo(x + Math.cos(ang) * 6, y + Math.sin(ang) * 6);
      ctx.stroke();
      return;
    }
    if (l.trail === 'streak') {
      const back = Math.min(f, 0.25);
      const tx = a.x + (b.x - a.x) * (f - back), ty = a.y + (b.y - a.y) * (f - back) - (1.2 + Math.sin((f - back) * Math.PI) * pr.arc) * Z;
      ctx.globalCompositeOperation = l.glow ? 'lighter' : 'source-over';
      ctx.strokeStyle = c0;
      ctx.lineCap = 'round';
      ctx.globalAlpha = 0.5;
      ctx.lineWidth = 5;
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(x, y);
      ctx.stroke();
    }
    // The head: the look's main shape (spinning matter, or a glowing mote with its shape inside). A throw is bigger
    // and casts a shadow on the ground under it, so its arc reads as height.
    const shape = l.shapes[0]!, big = pr.kind === 'lob' ? 1.3 : 1;
    ctx.globalAlpha = 1;
    ctx.globalCompositeOperation = 'source-over';
    if (pr.kind === 'lob') {
      ctx.fillStyle = 'rgba(0,0,0,0.28)';
      ctx.beginPath();
      ctx.ellipse(x, y0, 9, 4, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    if (l.glow) ctx.drawImage(stamp('mote', c0, true), x - 26 * big, y - 26 * big, 52 * big, 52 * big);
    const s = stamp(shape, c0, false);
    const rot = ORIENTED.has(shape) ? ang : pr.t * (pr.kind === 'lob' ? 8 : 12);
    ctx.save();
    ctx.translate(x, y);
    ctx.rotate(rot);
    ctx.drawImage(s, -13 * big, -13 * big, 26 * big, 26 * big);
    ctx.restore();
  }
}
