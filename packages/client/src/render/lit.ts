/**
 * Putting a painted figure or object into the place: lit like the ground it stands on (see light.ts), over a contact
 * shadow at its feet.
 */
import type { FigureLight } from './light';
import { SHADOW_FLAT } from './fx';
import { M, type View } from './view';

export class Lit {
  private v: View;

  constructor(v: View) {
    this.v = v;
  }

  /** Where a figure is drawn, and then lit, before it goes onto the view. */
  private scratch = [document.createElement('canvas'), document.createElement('canvas')] as const;

  /** Developer option: light figures like the place (off: drawn as painted or rendered). */
  figureLight = true;

  /**
   * A soft contact shadow on the ground under a figure (at the current origin, its feet): a body `r` meters across
   * as an ellipse flattened as the figures' camera sees the ground, a dark core under the feet and a wider
   * penumbra, in the place's own shadow color.
   */
  contactShadow(r: number, l: FigureLight) {
    const ctx = this.v.ctx, R = r * M * 1.25;
    this.atFeet(R, () => {
      const g = ctx.createRadialGradient(0, 0, 0, 0, 0, R);
      g.addColorStop(0, `rgba(${l.shadow},${l.shadowAlpha})`);
      g.addColorStop(0.45, `rgba(${l.shadow},${l.shadowAlpha * 0.7})`);
      g.addColorStop(1, `rgba(${l.shadow},0)`);
      ctx.fillStyle = g;
      ctx.fill();
    });
  }

  /**
   * Something flat on the ground under a figure (at the current origin, its feet): a circle of `r` picture px, as the
   * figures' camera sees the ground, which `paint` fills or strokes.
   */
  atFeet(r: number, paint: () => void) {
    const ctx = this.v.ctx;
    ctx.save();
    ctx.scale(1, SHADOW_FLAT);
    ctx.beginPath();
    ctx.arc(0, 0, r, 0, Math.PI * 2);
    paint();
    ctx.restore();
  }

  /**
   * Draw a figure lit like the place (see light.ts): `draw` paints it once at the current origin (its feet) into a
   * scratch canvas; a copy is tinted from the key light at its top to the ground's bounce at its feet, cut back to
   * its shape, washed with the light from the upper left, and put on the view (keeping the caller's alpha and glow). `w` x `h` (picture
   * px) bounds the figure above its feet, and it reaches `under` below them (default a little). The tint spans `tall`
   * above the feet (default `h`), or about a third of it for a figure `lying` down.
   */
  drawLit(w: number, h: number, l: FigureLight, draw: (g: CanvasRenderingContext2D) => void, lying = false, under?: number, tall = h, hit?: { flash: number; flashColor: string }) {
    const ctx = this.v.ctx;
    if (!this.figureLight) return draw(ctx);
    const T = ctx.getTransform();
    const k = T.a;
    const top = h, below = under ?? h * 0.12;
    const bx = Math.floor(T.e - (w / 2) * k), by = Math.floor(T.f - top * k);
    const bw = Math.ceil(w * k) + 2, bh = Math.ceil((top + below) * k) + 2;
    if (bw * bh > 4e6) return draw(ctx);
    const [fig, lit] = this.scratch;
    for (const c of this.scratch) if (c.width < bw || c.height < bh) [c.width, c.height] = [Math.max(c.width, bw), Math.max(c.height, bh)];
    const f = fig.getContext('2d')!, g = lit.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, bw, bh);
    f.setTransform(T.a, T.b, T.c, T.d, T.e - bx, T.f - by);
    f.globalAlpha = 1;
    f.imageSmoothingQuality = 'high';
    draw(f);
    // Key light at the head to ground bounce at the feet (multiply), cut back to the figure's own shape.
    const feet = T.f - by, head = feet - (lying ? tall * 0.3 : tall) * k;
    const grad = g.createLinearGradient(0, head, 0, feet);
    grad.addColorStop(0, l.top);
    grad.addColorStop(0.55, l.top);
    grad.addColorStop(1, l.bottom);
    g.globalCompositeOperation = 'source-over';
    g.clearRect(0, 0, bw, bh);
    g.drawImage(fig, 0, 0, bw, bh, 0, 0, bw, bh);
    g.globalCompositeOperation = 'multiply';
    g.fillStyle = grad;
    g.fillRect(0, 0, bw, bh);
    g.globalCompositeOperation = 'destination-in';
    g.drawImage(fig, 0, 0, bw, bh, 0, 0, bw, bh);
    const wash = g.createLinearGradient(0, 0, bw * 0.6, bh * 0.4);
    wash.addColorStop(0, l.wash);
    wash.addColorStop(1, 'rgba(0,0,0,0)');
    g.globalCompositeOperation = 'source-atop';
    g.fillStyle = wash;
    g.fillRect(0, 0, bw, bh);
    // Struck: the figure flashes toward white in the color of the blow, for a moment.
    if (hit && hit.flash > 0) {
      g.globalAlpha = hit.flash * 0.6;
      g.fillStyle = hit.flashColor;
      g.fillRect(0, 0, bw, bh);
      g.globalAlpha = 1;
    }
    g.globalCompositeOperation = 'source-over';
    ctx.save();
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.drawImage(lit, 0, 0, bw, bh, bx, by, bw, bh);
    ctx.restore();
  }
}
