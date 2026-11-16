/**
 * The mouse (and a pen) on the game view: it hovers and clicks, turns its wheel to zoom, and in a fight moves the
 * view, dragged with the middle button or resting at the screen's edge. Fingers are read by touch.ts.
 */
import type { GameClient } from '../net/game';
import type { Renderer } from '../render/renderer';
import { edgePush } from './pointer';

/** How near the screen's edge (pixels) a resting mouse slides the view in a fight, and how fast at most. */
const EDGE = 16, EDGE_SPEED = 900;

export class MouseInput {
  /** A mouse dragging the view with its middle button (in a fight), and where it last was. */
  dragging: { x: number; y: number } | null = null;
  /** The view sliding because the mouse rests at the screen's edge in a fight (screen pixels a second). */
  edge = { x: 0, y: 0 };
  private canvas: HTMLCanvasElement;
  private r: Renderer;
  private c: GameClient;

  constructor(canvas: HTMLCanvasElement, r: Renderer, c: GameClient) {
    this.canvas = canvas;
    this.r = r;
    this.c = c;
    canvas.addEventListener('pointermove', this.onMove);
    canvas.addEventListener('pointerdown', this.onDown);
    canvas.addEventListener('pointerleave', this.onLeave);
    canvas.addEventListener('pointerup', this.onUp);
    canvas.addEventListener('pointercancel', this.onCancel);
    canvas.addEventListener('contextmenu', this.onMenu);
    canvas.addEventListener('wheel', this.onWheel, { passive: false });
  }

  destroy() {
    this.canvas.removeEventListener('pointermove', this.onMove);
    this.canvas.removeEventListener('pointerdown', this.onDown);
    this.canvas.removeEventListener('pointerleave', this.onLeave);
    this.canvas.removeEventListener('pointerup', this.onUp);
    this.canvas.removeEventListener('pointercancel', this.onCancel);
    this.canvas.removeEventListener('contextmenu', this.onMenu);
    this.canvas.removeEventListener('wheel', this.onWheel);
  }

  // Mice (and pens) hover and click here; fingers are read by input/touch.ts.
  private onMove = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    if (this.r.padHover || this.c.state.inputMode !== 'mouse') {
      this.r.padHover = null;
      this.c.update({ inputMode: 'mouse' });
    }
    const r = this.canvas.getBoundingClientRect();
    const x = e.clientX - r.left, y = e.clientY - r.top;
    if (this.dragging) {
      this.r.panBy(this.dragging.x - x, this.dragging.y - y);
      this.dragging = { x, y };
    }
    // In a fight, resting the mouse on an edge of the screen slides the view that way, faster the closer it is.
    this.edge = this.c.state.combat && !this.dragging ? { x: edgePush(x, r.width, EDGE) * EDGE_SPEED, y: edgePush(y, r.height, EDGE) * EDGE_SPEED } : { x: 0, y: 0 };
    this.r.hover = this.r.pickAt(x, y);
  };

  private onDown = (e: PointerEvent) => {
    if (e.pointerType === 'touch') return;
    const r = this.canvas.getBoundingClientRect();
    if (e.button === 1 && this.c.state.combat) {
      e.preventDefault();
      this.canvas.setPointerCapture(e.pointerId);
      this.dragging = { x: e.clientX - r.left, y: e.clientY - r.top };
      return;
    }
    this.r.onClick?.(this.r.pickAt(e.clientX - r.left, e.clientY - r.top), e.button, e);
  };

  private onUp = (e: PointerEvent) => {
    if (e.button === 1) this.dragging = null;
  };

  private onCancel = () => void (this.dragging = null);

  private onMenu = (e: Event) => e.preventDefault();

  private onLeave = (e: PointerEvent) => {
    this.edge = { x: 0, y: 0 };
    if (e.pointerType !== 'touch' && !this.r.padHover) this.r.hover = { point: null, screenX: this.r.hover.screenX, screenY: this.r.hover.screenY };
  };

  private onWheel = (e: WheelEvent) => {
    e.preventDefault();
    this.r.zoomBy(e.deltaY > 0 ? 0.9 : 1.1);
  };
}
