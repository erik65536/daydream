/**
 * What lies over the place: the ground the party has uncovered and the fog over the rest, the mist past the
 * painting's edge (see mist.ts), night and gloom with the lights carried through them, and the weather.
 */
import { NAV_CELL, SIGHT_RADIUS, fogSize, type Vec2 } from '@daydream/shared';
import type { ZoneData } from '../net/game';
import { hexToRgb, mix, rgb, type RGB } from './color';
import { loadImage } from './sprites';
import { Mist, type MistFrame } from './mist';
import { dimAt, eyesOf, heroesOf } from './sight';
import { M, pic, type View } from './view';
import type { Figures } from './figures';

export class Sky {
  private v: View;
  private figures: Figures;

  constructor(v: View, figures: Figures) {
    this.v = v;
    this.figures = figures;
  }

  lightCanvas = document.createElement('canvas');
  fogCanvas = document.createElement('canvas');
  mist = new Mist();
  weather: { x: number; y: number; z: number; s: number; p: number }[] = [];
  private lastExplore = '';

  /** The party sees the ground around it (the server keeps the same memory; this shows it at once). */
  updateExplored(z: ZoneData, lp: Vec2) {
    const st = this.v.client.state;
    if (!st.explored) return;
    // Everyone's heroes uncover the shared map: it is looked at again when any of them reaches another square meter.
    const heroes = [...st.entities.values()].filter((e) => e.kind === 'character').map((e) => this.v.client.entityPos(e));
    const key = `${st.zoneVersion}:${heroes.map((p) => `${Math.round(p.x)},${Math.round(p.y)}`).join(';')}`;
    if (key === this.lastExplore) return;
    this.lastExplore = key;
    const { w, h } = fogSize(z);
    const r = SIGHT_RADIUS;
    for (const p of heroes) {
      const px = Math.round(p.x), py = Math.round(p.y);
      for (let y = Math.max(0, py - r); y <= Math.min(h - 1, py + r); y++)
        for (let x = Math.max(0, px - r); x <= Math.min(w - 1, px + r); x++) if (Math.hypot(x - px, y - py) <= r) st.explored.set(y * w + x);
    }
  }

  /**
   * How dark it is beyond the party's light. The painting carries the place's own light, so this only deepens it:
   * night and dusk under the open sky, and a dim place's gloom indoors.
   */
  private daylight(z: ZoneData): { darkness: number; tint: RGB } {
    if (!z.look.outdoor) return { darkness: Math.max(0, 0.8 - z.look.ambient) * 0.75, tint: hexToRgb(z.look.fogColor) };
    const h = (this.v.client.clockMinute() % 1440) / 60;
    // 0 at noon, 1 at midnight, smooth dawn/dusk.
    const night = h < 5 ? 1 : h < 7.5 ? 1 - (h - 5) / 2.5 : h < 18 ? 0 : h < 20.5 ? (h - 18) / 2.5 : 1;
    const dusk = h > 17 && h < 20.5 ? Math.sin(((h - 17) / 3.5) * Math.PI) : h > 5 && h < 8 ? Math.sin(((h - 5) / 3) * Math.PI) * 0.7 : 0;
    // Dusk and dawn are a soft amber shading into the night's blue (a strong red read as a red cast on the world).
    return { darkness: night * 0.62 + dusk * 0.1, tint: mix([10, 16, 48], [96, 70, 44], dusk * 0.7) };
  }

  drawLighting(z: ZoneData) {
    const { darkness, tint } = this.daylight(z);
    if (darkness < 0.02) return;
    const st = this.v.client.state;
    const lc = this.lightCanvas;
    const l = lc.getContext('2d')!;
    l.setTransform(1, 0, 0, 1, 0, 0);
    l.globalCompositeOperation = 'source-over';
    l.clearRect(0, 0, lc.width, lc.height);
    l.fillStyle = rgb(tint, darkness);
    l.fillRect(0, 0, lc.width, lc.height);
    l.globalCompositeOperation = 'destination-out';
    const hole = (x: number, y: number, meters: number, strength = 1, flicker = 0) => {
      const s = this.v.groundToScreen(x, y, 20);
      const r = meters * M * 0.7 * this.v.zoom * (1 + flicker);
      const g = l.createRadialGradient(s.x / 2, s.y / 2, 0, s.x / 2, s.y / 2, r / 2);
      g.addColorStop(0, `rgba(0,0,0,${strength})`);
      g.addColorStop(0.55, `rgba(0,0,0,${strength * 0.6})`);
      g.addColorStop(1, 'rgba(0,0,0,0)');
      l.fillStyle = g;
      l.fillRect(s.x / 2 - r / 2, s.y / 2 - r / 2, r, r);
    };
    const glows: { x: number; y: number; r: number; color: string }[] = [];
    for (const e of st.entities.values()) {
      const p = this.v.client.entityPos(e);
      // Every player's heroes carry a light, on every screen.
      if (e.kind === 'character') hole(p.x, p.y, 7.5, 1);
      else if (e.bossId) hole(p.x, p.y, 3, 0.6);
    }
    for (const f of z.features) {
      // What is worth finding keeps a little light in the dark: the waypoint, what a quest step needs (a thing to look
      // at, a find not yet taken), an unread note, a stash.
      const fs = st.features.get(f.id);
      if (f.kind === 'waypoint' || this.v.client.questThing(f) || ((f.kind === 'lore' || f.hidden) && !fs?.opened)) {
        hole(f.x, f.y, f.kind === 'lore' ? 1.6 : 3, 0.7);
        glows.push({ x: f.x, y: f.y, r: 1.4, color: f.kind === 'waypoint' ? z.look.lightColor : '#ffe090' });
      }
    }
    let lit = 0;
    for (const p of this.v.fx.particles) if (p.glow && (p.kind === 'flash' || p.size > 7) && lit++ < 40) hole(p.x, p.y, p.kind === 'flash' ? 2 : 0.8, p.kind === 'flash' ? 0.7 : 0.3);
    for (const pr of this.v.fx.projectiles) {
      const f = Math.min(1, pr.t / pr.dur);
      hole(pr.x0 + (pr.x1 - pr.x0) * f, pr.y0 + (pr.y1 - pr.y0) * f, 2.5, 0.8);
    }
    this.v.setScreenTransform();
    const ctx = this.v.ctx;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(lc, 0, 0, this.v.W, this.v.H);
    ctx.save();
    ctx.globalCompositeOperation = 'lighter';
    for (const g of glows) {
      const s = this.v.groundToScreen(g.x, g.y, 30);
      const r = g.r * M * 0.7 * this.v.zoom;
      const gr = ctx.createRadialGradient(s.x, s.y, 0, s.x, s.y, r);
      gr.addColorStop(0, g.color + '55');
      gr.addColorStop(1, g.color + '00');
      ctx.fillStyle = gr;
      ctx.fillRect(s.x - r, s.y - r, r * 2, r * 2);
    }
    ctx.restore();
  }

  /** Fog of war per square meter for the mist: unexplored (0/255) and remembered-but-unseen (dim) bytes. */
  fogBytes: { key: string; data: Uint8Array; w: number; h: number } | null = null;

  /** The fog of war of each square meter in view: unexplored, or how dim remembered ground is (a veil once out of sight). */
  private visibleFog(w: number, h: number, write: (x: number, y: number, unseen: boolean, dim: number) => void) {
    const st = this.v.client.state;
    // What is seen from: every player's heroes and, in a fight, everyone in it (see sight.ts).
    const party = eyesOf(st.entities.values(), !!st.combat).map((e) => this.v.client.entityPos(e));
    const view = [this.v.screenToGround(0, 0), this.v.screenToGround(this.v.W, 0), this.v.screenToGround(0, this.v.H), this.v.screenToGround(this.v.W, this.v.H)];
    const x0 = Math.max(0, Math.floor(Math.min(...view.map((v) => v.x))) - 3), x1 = Math.min(w - 1, Math.ceil(Math.max(...view.map((v) => v.x))) + 3);
    const y0 = Math.max(0, Math.floor(Math.min(...view.map((v) => v.y))) - 3), y1 = Math.min(h - 1, Math.ceil(Math.max(...view.map((v) => v.y))) + 3);
    for (let y = y0; y <= y1; y++)
      for (let x = x0; x <= x1; x++) {
        if (!st.explored!.get(y * w + x)) {
          write(x, y, true, 0);
          continue;
        }
        let d = 99;
        for (const p of party) d = Math.min(d, Math.hypot(p.x - x, p.y - y));
        write(x, y, false, dimAt(d));
      }
  }

  /** This frame's mist (see mist.ts), shared by its two passes. */
  private mistFrame: MistFrame | null = null;

  /**
   * Per square meter for the mist (null where there is no fog of war): unexplored, how much of it no one can walk
   * (set once per place: the edge's veil lies thickest there), and remembered-but-unseen.
   */
  private fogOfWar(z: ZoneData): { data: Uint8Array; w: number; h: number } | null {
    if (!this.v.client.state.explored) return null;
    const { w, h } = fogSize(z);
    const key = `${this.v.zoneKey}:${w}x${h}`;
    if (this.fogBytes?.key !== key) {
      const data = new Uint8Array(w * h * 4);
      const nav = z.walk, per = Math.round(1 / NAV_CELL);
      for (let y = 0; y < h; y++)
        for (let x = 0; x < w; x++) {
          let open = 0;
          for (let j = 0; j < per; j++) for (let i = 0; i < per; i++) if (nav.walkableCell(x * per + i, y * per + j)) open++;
          data.set([255, Math.round(255 * (1 - open / (per * per))), 0, 0], (y * w + x) * 4);
        }
      this.fogBytes = { key, data, w, h };
    }
    const data = this.fogBytes.data;
    for (let i = 3; i < data.length; i += 4) data[i] = 0;
    this.visibleFog(w, h, (x, y, unseen, dim) => {
      data[(y * w + x) * 4] = unseen ? 255 : 0;
      data[(y * w + x) * 4 + 3] = Math.round(dim * 255);
    });
    return this.fogBytes;
  }

  /**
   * One pass of the place's mist (see mist.ts) onto the view: the ground past the painting's edge (before the
   * figures), or the air (fog of war and the veil along the edge, over everything). The frame is set up by the first.
   */
  drawMist(z: ZoneData, pass: 'ground' | 'air') {
    if (!z.painting) return;
    if (pass === 'ground') {
      const st = this.v.client.state;
      const p = z.look.painted;
      const level = p?.level ?? z.look.ambient * 0.55;
      // The thin mist takes the place's shadow color, its wisps the place's light, dimmer in darker places.
      const key = hexToRgb(p?.light ?? z.look.lightColor), km = Math.max(1, ...key);
      const c = pic(this.v.camX, this.v.camY);
      this.mistFrame = {
        W: this.v.W, H: this.v.H, camX: c.x, camY: c.y, zoom: this.v.zoom, t: this.v.t, fog: this.fogOfWar(z),
        rect: [-z.painting.ox, -z.painting.oy, z.painting.width - z.painting.ox, z.painting.height - z.painting.oy],
        base: hexToRgb(z.look.fogColor),
        tint: key.map((v) => Math.min(255, (0.7 + (0.3 * v) / km) * (0.55 + level * 0.8) * 255)) as RGB,
        tile: z.look.mist ? loadImage(this.v.client.assetUrl(z.look.mist)) : null,
        party: heroesOf(st.entities.values(), st.userId).map((e) => {
          const a = this.figures.anims.get(e.id);
          return pic(a?.px ?? e.x, a?.py ?? e.y);
        }),
      };
    }
    const f = this.mistFrame;
    if (!f) return;
    if (!this.mist.ok) return pass === 'air' ? this.drawPlainFog(z, f.fog) : undefined;
    const out = this.mist.render(f, pass);
    if (!out) return;
    this.v.ctx.save();
    this.v.setScreenTransform();
    this.v.ctx.imageSmoothingEnabled = true;
    this.v.ctx.drawImage(out, 0, 0, this.v.W, this.v.H);
    this.v.ctx.restore();
  }

  /** The plain fog's picture, a pixel per square meter, kept from frame to frame. */
  private plainFog: { canvas: HTMLCanvasElement; img: ImageData } | null = null;

  /** Without WebGL: the fog of war as a plain veil in the place's fog color (no mist, no edge). */
  private drawPlainFog(z: ZoneData, fog: { data: Uint8Array; w: number; h: number } | null) {
    if (!fog) return;
    const { w, h } = fog;
    let plain = this.plainFog;
    if (!plain || plain.img.width !== w || plain.img.height !== h) {
      const made = document.createElement('canvas');
      [made.width, made.height] = [w, h];
      plain = this.plainFog = { canvas: made, img: made.getContext('2d')!.createImageData(w, h) };
    }
    const { canvas, img } = plain;
    const [r, g, b] = hexToRgb(z.look.fogColor);
    for (let i = 0; i < w * h; i++) {
      img.data[i * 4] = r * 0.35;
      img.data[i * 4 + 1] = g * 0.35;
      img.data[i * 4 + 2] = b * 0.35;
      img.data[i * 4 + 3] = fog.data[i * 4]! || fog.data[i * 4 + 3]!;
    }
    canvas.getContext('2d')!.putImageData(img, 0, 0);
    const fc = this.fogCanvas;
    const f = fc.getContext('2d')!;
    f.setTransform(1, 0, 0, 1, 0, 0);
    f.clearRect(0, 0, fc.width, fc.height);
    const sc = fc.width / this.v.W;
    const o = this.v.groundToScreen(0, 0);
    const k = this.v.zoom * sc;
    // Square meter (x, y) maps to screen (x·M, y·M); pixel corners sit half a meter before the centers.
    f.setTransform(M * k, 0, 0, M * k, o.x * sc, o.y * sc);
    f.imageSmoothingEnabled = true;
    f.drawImage(canvas, -0.5, -0.5);
    this.v.setScreenTransform();
    this.v.ctx.drawImage(fc, 0, 0, this.v.W, this.v.H);
  }

  drawWeather(dt: number, z: ZoneData) {
    const kind = z.look.weather;
    // No rain or snow under a roof (dust, ash, spores, and embers can drift indoors).
    if (kind === 'none' || (!z.look.outdoor && (kind === 'rain' || kind === 'snow'))) return;
    const ctx = this.v.ctx;
    this.v.setScreenTransform();
    const target = kind === 'rain' ? 160 : kind === 'snow' ? 120 : kind === 'fireflies' ? 26 : 50;
    while (this.weather.length < target) this.weather.push({ x: Math.random() * this.v.W, y: Math.random() * this.v.H, z: Math.random(), s: Math.random(), p: Math.random() * 10 });
    const night = this.daylight(z).darkness;
    for (const d of this.weather) {
      d.p += dt;
      switch (kind) {
        case 'rain':
          d.y += dt * (600 + d.s * 300);
          d.x -= dt * 120;
          ctx.strokeStyle = `rgba(190,210,255,${0.25 + d.s * 0.25})`;
          ctx.lineWidth = 1;
          ctx.beginPath();
          ctx.moveTo(d.x, d.y);
          ctx.lineTo(d.x - 4, d.y + 14);
          ctx.stroke();
          break;
        case 'snow':
          d.y += dt * (30 + d.s * 40);
          d.x += Math.sin(d.p + d.s * 6) * dt * 20;
          ctx.fillStyle = `rgba(255,255,255,${0.5 + d.s * 0.4})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 1 + d.s * 2, 0, Math.PI * 2);
          ctx.fill();
          break;
        case 'fireflies': {
          d.x += Math.sin(d.p * 0.7 + d.s * 9) * dt * 18;
          d.y += Math.cos(d.p * 0.5 + d.s * 7) * dt * 14;
          const a = (0.25 + Math.sin(d.p * 2.5 + d.s * 10) * 0.25 + 0.25) * (0.3 + night);
          const g = ctx.createRadialGradient(d.x, d.y, 0, d.x, d.y, 6);
          g.addColorStop(0, `rgba(220,255,140,${a})`);
          g.addColorStop(1, 'rgba(220,255,140,0)');
          ctx.fillStyle = g;
          ctx.fillRect(d.x - 6, d.y - 6, 12, 12);
          break;
        }
        case 'embers':
          d.y -= dt * (30 + d.s * 50);
          d.x += Math.sin(d.p + d.s * 5) * dt * 15;
          ctx.fillStyle = `rgba(255,${120 + d.s * 80},40,${0.5 + Math.sin(d.p * 4) * 0.3})`;
          ctx.fillRect(d.x, d.y, 2, 2);
          break;
        default: {
          // dust, ash, spores
          d.y += dt * (kind === 'ash' ? 20 : 6) * (0.5 + d.s);
          d.x += Math.sin(d.p * 0.4 + d.s * 8) * dt * 8;
          const c = kind === 'spores' ? '180,255,200' : kind === 'ash' ? '200,200,200' : '255,240,210';
          ctx.fillStyle = `rgba(${c},${0.15 + d.s * 0.25})`;
          ctx.beginPath();
          ctx.arc(d.x, d.y, 0.8 + d.s * 1.4, 0, Math.PI * 2);
          ctx.fill();
        }
      }
      if (d.y > this.v.H + 20) { d.y = -10; d.x = Math.random() * this.v.W; }
      if (d.y < -20) { d.y = this.v.H + 10; d.x = Math.random() * this.v.W; }
      if (d.x < -20) d.x = this.v.W + 10;
      if (d.x > this.v.W + 20) d.x = -10;
    }
  }
}
