/**
 * The marks over people and things that matter to a quest: a gold "!" where there is quest business (work to take, a
 * thing a step needs), a gold "?" where a quest is to be finished, a quiet speech bubble, in the world's own interface
 * colors, where someone on the way is to be seen, and a small gold diamond over a creature a quest's step counts. Each
 * is drawn once into a small picture (again when the interface's look changes) and stamped every frame with a slow bob
 * and breath.
 */
import { currentThemeVersion } from '../ui/theme';

export type MarkKind = 'quest' | 'turnin' | 'progress' | 'hunt';

/** The stamp's size in screen pixels (the picture is drawn at twice that, for sharp edges on dense screens). */
const SIZE = 48;
const RES = 2;
const stamps = new Map<MarkKind, HTMLCanvasElement>();
let drawnFor = -1;

const FONT = '700 30px Cinzel, Georgia, serif';

function draw(kind: MarkKind): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = c.height = SIZE * RES;
  const g = c.getContext('2d')!;
  g.scale(RES, RES);
  const mid = SIZE / 2;
  if (kind === 'progress') {
    // A small speech bubble with three dots, in the world's panel and metal (its interface's colors).
    const css = getComputedStyle(document.documentElement);
    const v = (name: string, fallback: string) => css.getPropertyValue(name).trim() || fallback;
    const w = 26, h = 18, x = mid - w / 2, y = mid - h / 2 - 2;
    g.beginPath();
    g.roundRect(x, y, w, h, 7);
    g.moveTo(mid - 4, y + h);
    g.lineTo(mid - 6, y + h + 6);
    g.lineTo(mid + 2, y + h);
    g.closePath();
    g.lineJoin = 'round';
    g.lineWidth = 4;
    g.strokeStyle = 'rgba(8, 6, 4, 0.7)';
    g.stroke();
    g.fillStyle = v('--panel-solid', '#17131d');
    g.fill();
    g.lineWidth = 1.5;
    g.strokeStyle = v('--gold', '#d9b56a');
    g.stroke();
    g.fillStyle = v('--gold-2', '#f1d898');
    for (const dx of [-6, 0, 6]) {
      g.beginPath();
      g.arc(mid + dx, y + h / 2, 1.9, 0, Math.PI * 2);
      g.fill();
    }
    return c;
  }
  // A soft warm glow behind it, so it reads on dark and bright ground alike without a heavy rim.
  const halo = g.createRadialGradient(mid, mid, 0, mid, mid, mid * 0.62);
  halo.addColorStop(0, 'rgba(255, 210, 110, 0.34)');
  halo.addColorStop(1, 'rgba(255, 190, 80, 0)');
  g.fillStyle = halo;
  g.fillRect(0, 0, SIZE, SIZE);
  // Gold, lighter at the top, like the interface's metal; a fine dark edge and a hairline of deeper gold inside it.
  const metal = (top: number, bottom: number) => {
    const fill = g.createLinearGradient(0, top, 0, bottom);
    fill.addColorStop(0, '#fff2c4');
    fill.addColorStop(0.5, '#f4c44e');
    fill.addColorStop(1, '#c98a24');
    return fill;
  };
  g.lineJoin = 'round';
  if (kind === 'hunt') {
    // A small diamond, a quieter cousin of the "!".
    const r = 8;
    g.beginPath();
    g.moveTo(mid, mid - r);
    g.lineTo(mid + r * 0.7, mid);
    g.lineTo(mid, mid + r);
    g.lineTo(mid - r * 0.7, mid);
    g.closePath();
    g.lineWidth = 3;
    g.strokeStyle = 'rgba(30, 16, 4, 0.8)';
    g.stroke();
    g.fillStyle = metal(mid - r, mid + r);
    g.fill();
    g.lineWidth = 1;
    g.strokeStyle = 'rgba(176, 112, 24, 0.9)';
    g.stroke();
    return c;
  }
  const glyph = kind === 'quest' ? '!' : '?';
  g.font = FONT;
  g.textAlign = 'center';
  g.textBaseline = 'middle';
  const y = mid + 1;
  g.lineWidth = 3.5;
  g.strokeStyle = 'rgba(30, 16, 4, 0.82)';
  g.strokeText(glyph, mid, y);
  g.fillStyle = metal(mid - 12, mid + 12);
  g.fillText(glyph, mid, y);
  g.lineWidth = 0.8;
  g.strokeStyle = 'rgba(176, 112, 24, 0.9)';
  g.strokeText(glyph, mid, y);
  return c;
}

function stamp(kind: MarkKind): HTMLCanvasElement {
  // A new look of the interface draws them all again.
  if (currentThemeVersion() !== drawnFor) {
    stamps.clear();
    drawnFor = currentThemeVersion();
  }
  const have = stamps.get(kind);
  if (have) return have;
  const c = draw(kind);
  // Keep it only once the display font is in, so the mark is not stuck in the fallback face.
  if (kind === 'progress' || kind === 'hunt' || document.fonts?.check(FONT)) stamps.set(kind, c);
  return c;
}

/** A steady phase for something's bob, from its id. */
export function seedOf(id: string): number {
  let h = 0;
  for (let i = 0; i < id.length; i++) h = (h * 31 + id.charCodeAt(i)) | 0;
  return (h % 628) / 100;
}

/**
 * Draws a mark centered at (x, y) in the current transform, `size` units across; `t` is the view's clock (seconds)
 * and `seed` keeps neighboring marks from bobbing in step.
 */
export function drawMark(ctx: CanvasRenderingContext2D, kind: MarkKind, x: number, y: number, t: number, seed = 0, size = SIZE) {
  const bob = Math.sin(t * 2.4 + seed) * size * 0.05;
  const breath = kind === 'progress' ? 1 : 1 + Math.sin(t * 2.4 + seed + 1.2) * 0.03;
  const s = size * breath;
  ctx.drawImage(stamp(kind), x - s / 2, y - s / 2 + bob, s, s);
}
