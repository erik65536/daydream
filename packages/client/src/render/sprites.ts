/** Drawing painted figures: loading their images, a still sprite's bob and lean, a placeholder while one loads. */

export function drawShadow(ctx: CanvasRenderingContext2D, w: number, a = 0.38) {
  const g = ctx.createRadialGradient(0, 0, 0, 0, 0, w);
  g.addColorStop(0, `rgba(0,0,0,${a})`);
  g.addColorStop(1, 'rgba(0,0,0,0)');
  ctx.save();
  ctx.scale(1, 0.45);
  ctx.fillStyle = g;
  ctx.beginPath();
  ctx.arc(0, 0, w, 0, Math.PI * 2);
  ctx.fill();
  ctx.restore();
}

/** The placeholder's width for its height. */
export const PLACEHOLDER_ASPECT = 0.32;

/**
 * A plain standing silhouette `h` px tall at the current origin (its feet): shown only while a figure's painting
 * loads, or for one whose painting failed.
 */
export function drawPlaceholder(ctx: CanvasRenderingContext2D, h: number, down = 0) {
  ctx.save();
  if (down) ctx.rotate((Math.PI / 2) * down);
  ctx.fillStyle = 'rgba(20, 22, 30, 0.55)';
  ctx.strokeStyle = 'rgba(255, 255, 255, 0.18)';
  ctx.lineWidth = 1.5;
  ctx.beginPath();
  ctx.roundRect(-h * PLACEHOLDER_ASPECT / 2, -h * 0.78, h * PLACEHOLDER_ASPECT, h * 0.78, h * 0.12);
  ctx.arc(0, -h * 0.87, h * 0.11, 0, Math.PI * 2);
  ctx.fill();
  ctx.stroke();
  ctx.restore();
}

// ------------------------------------------------------------------------- image sprites

const images = new Map<string, HTMLImageElement | null>();
/** Images that failed to load: how often, and when each may be tried again. */
const failures = new Map<string, { tries: number; retryAt: number }>();

/**
 * How long to wait (ms) before loading something again after it failed `tries` times: two seconds, doubling to a
 * minute at most. A dropped request is tried again; a file that is not there is asked for only now and then.
 */
export const retryDelay = (tries: number) => Math.min(60_000, 2000 * 2 ** (tries - 1));

/** An image once it has loaded (null meanwhile, and while one that failed waits to be tried again). */
export function loadImage(url: string | undefined): HTMLImageElement | null {
  if (!url) return null;
  if (images.has(url)) {
    const img = images.get(url)!;
    if (img) return img.complete && img.naturalWidth > 0 ? img : null;
    if (performance.now() < failures.get(url)!.retryAt) return null;
  }
  const img = new Image();
  img.src = url;
  images.set(url, img);
  img.onerror = () => {
    const tries = (failures.get(url)?.tries ?? 0) + 1;
    failures.set(url, { tries, retryAt: performance.now() + retryDelay(tries) });
    images.set(url, null);
    flushWaiters(url);
  };
  img.onload = () => {
    failures.delete(url);
    flushWaiters(url);
  };
  return null;
}

const waiters = new Map<string, (() => void)[]>();
function flushWaiters(url: string) {
  for (const cb of waiters.get(url) ?? []) cb();
  waiters.delete(url);
}

/** 'ok' once decoded, 'error' if it failed (draw the placeholder), 'loading' meanwhile. */
export function imageState(url: string | undefined): 'none' | 'loading' | 'ok' | 'error' {
  if (!url) return 'none';
  loadImage(url);
  const img = images.get(url);
  if (img === null) return 'error';
  return img && img.complete && img.naturalWidth > 0 ? 'ok' : 'loading';
}

/** Call `cb` once the image finishes loading (or fails). */
export function onImageSettled(url: string, cb: () => void) {
  if (imageState(url) !== 'loading') return cb();
  waiters.set(url, [...(waiters.get(url) ?? []), cb]);
}

/** How far a still sprite leans into a blow (radians); a walk leans less. */
const LUNGE = 0.18;

/**
 * Picture px a still figure `height` tall and `aspect` wide for its height reaches left/right of its feet, above
 * them, and below them, `down` of the way to lying: it turns about its feet as it falls, so lying it reaches its
 * height to one side and half its width above and below. With room for its bob, squash, shake, and lean.
 */
export function stillBounds(height: number, aspect: number, down = 0) {
  const w = aspect * height * 1.03 + 5, h = height * 1.01 + 4, turn = (Math.PI / 2) * down;
  let half = 0, above = 0, below = 0;
  for (const a of [turn - LUNGE, turn, turn + LUNGE])
    for (const [x, y] of [[-w / 2, 0], [w / 2, 0], [-w / 2, -h], [w / 2, -h]] as const) {
      const rx = x * Math.cos(a) - y * Math.sin(a), ry = x * Math.sin(a) + y * Math.cos(a);
      half = Math.max(half, Math.abs(rx));
      above = Math.max(above, -ry);
      below = Math.max(below, ry);
    }
  return { half, above, below };
}

/**
 * A still sprite (an actor without clip sheets yet, see actors.ts): the painted standing view, mirrored to face
 * the way it goes, with a breathing bob, a step bounce, and a lean while walking, a lunge for an attack.
 */
export function drawImageSprite(ctx: CanvasRenderingContext2D, img: HTMLImageElement, opts: { height: number; dir: 1 | -1; walk: number; amt?: number; t: number; down?: number; hurt?: number; attack?: number }) {
  const walking = !Number.isNaN(opts.walk);
  const m = walking ? opts.amt ?? 1 : 0;
  const h = opts.height;
  const w = (img.naturalWidth / img.naturalHeight) * h;
  // Idle breathing blended with a walking gait: a rise on each step, a slight compression at foot-fall.
  const idleBob = Math.sin(opts.t * 2) * 0.6, idleSq = 1 + Math.sin(opts.t * 2) * 0.008;
  const stepBob = walking ? Math.abs(Math.sin(opts.walk)) * 2.6 : 0;
  const stepSq = walking ? 1 - Math.pow(Math.cos(opts.walk), 8) * 0.035 : 1;
  const bob = idleBob * (1 - m) + stepBob * m;
  const squash = idleSq * (1 - m) + stepSq * m;
  ctx.save();
  // Lying down (1) or standing (0), and between while falling or getting up.
  if (opts.down) {
    ctx.rotate((Math.PI / 2) * opts.down);
    ctx.globalAlpha *= 1 - 0.15 * opts.down;
  }
  if (opts.hurt && opts.hurt > 0) ctx.translate(Math.sin(opts.hurt * 40) * 2.5, 0);
  // Lean into the direction of travel plus a gentle side-to-side sway per step, and into a blow.
  const lean = opts.attack ? Math.sin(opts.attack * Math.PI) * LUNGE : walking ? (0.05 + Math.sin(opts.walk) * 0.025) * m : 0;
  ctx.rotate(lean * opts.dir);
  // Painted characters face left (as their art direction asks): mirrored to go right.
  ctx.scale(-opts.dir, 1);
  // Widen slightly as it squashes, so the volume reads as constant.
  const wq = w * (1 + (1 - squash) * 0.6);
  ctx.drawImage(img, -wq / 2, -h * squash - bob, wq, h * squash);
  ctx.restore();
}
