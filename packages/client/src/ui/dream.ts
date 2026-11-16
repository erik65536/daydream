/**
 * The sky round a world being dreamed. Each build is shown in one of a few looks, picked once per world, and more can
 * join the list:
 * - lanterns: a lantern festival. Everything made sets a paper lantern rising out of the dream; over the hours of a
 *   build the sky fills with hundreds of them in depth and warms.
 * - galaxy: the dream is the core of a galaxy. Dust gathers into spiral arms as the world is made; each place painted
 *   ignites a knot of light on an arm, each person a new star; the whole disc turns, inner stars faster.
 * Both follow the cursor a little, and touching the dream stirs them.
 */

export type DreamLook = 'lanterns' | 'galaxy';
const DREAM_LOOKS: DreamLook[] = ['lanterns', 'galaxy'];

/** A world's look, the same every time its page is opened. */
export function lookFor(worldId: string): DreamLook {
  let h = 0;
  for (const ch of worldId) h = (h * 31 + ch.charCodeAt(0)) | 0;
  return DREAM_LOOKS[Math.abs(h) % DREAM_LOOKS.length]!;
}

/** How far the build is: overall progress, and how many places and people are made of how many. */
export interface DreamState {
  p: number;
  places: number;
  placesTotal: number;
  people: number;
  peopleTotal: number;
  ready: boolean;
}

interface DreamParts {
  look: DreamLook;
  /** The page, for the cursor's parallax variables (--mx, --my). */
  page: HTMLElement;
  /** The dream itself: where it is on screen, and what is touched. */
  orb: HTMLElement;
  /** Full-screen canvases: behind everything, and (for the galaxy) the half in front of the dream. */
  back: HTMLCanvasElement;
  front: HTMLCanvasElement;
  /** The world's four colors. */
  palette: string[];
  state: () => DreamState;
}

/** How many people are shown (each a star or a lantern), whatever the world's count. */
const PEOPLE = 31;
/** Each place's size, in turn (they differ, as places do). */
const PLACE_SIZES = [34, 22, 40, 18, 30, 26, 44, 20, 32];

const clamp = (x: number) => Math.min(1, Math.max(0, x));
const seeded = (n: number) => () => {
  n |= 0;
  n = (n + 0x6d2b79f5) | 0;
  let t = Math.imul(n ^ (n >>> 15), 1 | n);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};
const glow = (g: CanvasRenderingContext2D, x: number, y: number, r: number, color: string, a: number) => {
  if (r <= 0 || a <= 0) return;
  const h = g.createRadialGradient(x, y, 0, x, y, r);
  h.addColorStop(0, color);
  h.addColorStop(1, color.slice(0, 7) + '00');
  g.globalAlpha = a;
  g.fillStyle = h;
  g.beginPath();
  g.arc(x, y, r, 0, 7);
  g.fill();
};

/** Start the sky; returns a function that stops it. */
export function startDream(parts: DreamParts): () => void {
  const { look, page, orb, back, front, palette } = parts;
  const dpr = Math.min(devicePixelRatio, 2);
  const first = parts.state();
  const placeCount = Math.min(16, Math.max(1, first.placesTotal || 9));

  // The cursor: where it is on screen, and how far from the middle (eased, for parallax).
  const pointer = { sx: -1e9, sy: -1e9, mx: 0, my: 0, ex: 0, ey: 0 };
  const move = (e: PointerEvent) => {
    pointer.sx = e.clientX * dpr;
    pointer.sy = e.clientY * dpr;
    pointer.mx = (e.clientX / innerWidth) * 2 - 1;
    pointer.my = (e.clientY / innerHeight) * 2 - 1;
  };
  addEventListener('pointermove', move);
  // Touching the dream stirs everything round it.
  let kick = 0;
  const touch = () => { kick = 1; onTouch?.(); };
  let onTouch: (() => void) | undefined;
  orb.addEventListener('pointerdown', touch);

  const fit = (c: HTMLCanvasElement) => {
    const w = Math.round(innerWidth * dpr), h = Math.round(innerHeight * dpr);
    if (c.width !== w || c.height !== h) { c.width = w; c.height = h; }
  };
  // Where the dream is on the screen, in canvas pixels: its center and diameter.
  const dreamAt = () => {
    const r = orb.getBoundingClientRect();
    return { cx: (r.left + r.width / 2) * dpr, cy: (r.top + r.height / 2) * dpr, d: r.width * dpr };
  };
  // Counts ease toward the build's, so a place or a person arriving is a moment, not a jump.
  const shown = { places: first.places, people: (first.people / Math.max(1, first.peopleTotal)) * PEOPLE };
  let settle = first.ready ? 1 : 0;

  const draw = look === 'galaxy' ? galaxy() : lanterns();
  let last = performance.now(), raf = 0;
  const frame = (now: number) => {
    const dt = Math.min(50, now - last) / 1000;
    last = now;
    const s = parts.state();
    shown.places += (s.places - shown.places) * Math.min(1, dt * 1.5);
    shown.people += ((s.people / Math.max(1, s.peopleTotal)) * PEOPLE - shown.people) * Math.min(1, dt * 1.5);
    settle += ((s.ready ? 1 : 0) - settle) * Math.min(1, dt * 0.8);
    pointer.ex += (pointer.mx - pointer.ex) * Math.min(1, dt * 2);
    pointer.ey += (pointer.my - pointer.ey) * Math.min(1, dt * 2);
    page.style.setProperty('--mx', pointer.ex.toFixed(3));
    page.style.setProperty('--my', pointer.ey.toFixed(3));
    kick = Math.max(0, kick - dt * 0.9);
    draw(dt, now, s);
    raf = requestAnimationFrame(frame);
  };
  raf = requestAnimationFrame(frame);
  return () => {
    cancelAnimationFrame(raf);
    removeEventListener('pointermove', move);
    orb.removeEventListener('pointerdown', touch);
  };

  // ------------------------------------------------------------------ lanterns
  function lanterns() {
    const rnd = seeded(11);
    // Lanterns are drawn once into small sprites (by color, shape, focus, and halo) and then only scaled.
    const sprites = new Map<string, HTMLCanvasElement>();
    const sprite = (color: string, shape: number, blur: number, haze: number) => {
      const key = `${color}${shape}${blur}${haze}`;
      const had = sprites.get(key);
      if (had) return had;
      const c = document.createElement('canvas');
      c.width = 160;
      c.height = 200;
      const g = c.getContext('2d')!, x = 80, y = 100, s = 26;
      if (blur) g.filter = `blur(${blur}px)`;
      const hx = (v: number) => Math.round(v * haze).toString(16).padStart(2, '0');
      const halo = g.createRadialGradient(x, y + 10, 0, x, y + 10, 78);
      halo.addColorStop(0, color + hx(0x88));
      halo.addColorStop(0.35, color + hx(0x30));
      halo.addColorStop(1, color + '00');
      g.fillStyle = halo;
      g.fillRect(0, 0, 160, 200);
      const body = g.createRadialGradient(x, y + s * 0.8, s * 0.1, x, y, s * 1.5);
      body.addColorStop(0, '#fffcee');
      body.addColorStop(0.45, '#ffdc8a');
      body.addColorStop(1, '#e0802e');
      const outline = () => {
        g.beginPath();
        if (shape === 1) g.roundRect(x - s * 0.62, y - s * 1.25, s * 1.24, s * 2.4, s * 0.25);
        else if (shape === 2) g.ellipse(x, y, s * 0.98, s * 1.05, 0, 0, 7);
        else {
          g.moveTo(x - s * 0.62, y - s);
          g.lineTo(x + s * 0.62, y - s);
          g.quadraticCurveTo(x + s * 1.05, y, x + s * 0.78, y + s * 0.95);
          g.lineTo(x - s * 0.78, y + s * 0.95);
          g.quadraticCurveTo(x - s * 1.05, y, x - s * 0.62, y - s);
        }
      };
      g.fillStyle = body;
      outline();
      g.fill();
      // Paper ribs, the dark rim at the top, and the flame seen through the opening below.
      g.save();
      outline();
      g.clip();
      g.strokeStyle = 'rgba(120,50,20,.22)';
      g.lineWidth = 1.4;
      for (const k of [-0.55, -0.2, 0.2, 0.55]) {
        g.beginPath();
        g.moveTo(x + k * s * 0.9, y - s * 1.3);
        g.quadraticCurveTo(x + k * s * 1.35, y, x + k * s, y + s * 1.3);
        g.stroke();
      }
      g.fillStyle = 'rgba(70,25,10,.55)';
      g.fillRect(x - s * 1.2, y - s * (shape === 1 ? 1.28 : shape === 2 ? 1.08 : 1.04), s * 2.4, s * 0.16);
      g.restore();
      const flame = g.createRadialGradient(x, y + s * 0.62, 0, x, y + s * 0.62, s * 0.4);
      flame.addColorStop(0, '#ffffff');
      flame.addColorStop(0.4, '#fff1b8');
      flame.addColorStop(1, 'rgba(255,200,120,0)');
      g.fillStyle = flame;
      g.beginPath();
      g.arc(x, y + s * 0.62, s * 0.4, 0, 7);
      g.fill();
      sprites.set(key, c);
      return c;
    };
    const lantern = (g: CanvasRenderingContext2D, x: number, y: number, size: number, color: string, shape: number, blur: number, a: number, haze = 1) => {
      const sp = sprite(color, shape, blur, haze), w = (size * 2 * 160) / 52;
      g.globalAlpha = a;
      g.drawImage(sp, x - w / 2, y - (w * 100) / 160, w, (w * 200) / 160);
    };

    // The world's own lanterns: a few gold ones for the rules and the story, one for each place (large, in its
    // colors) and each person (small). Each is lit when its thing is made.
    interface Lamp { born: (s: DreamState) => boolean; size: number; color: string; shape: number; tx: number; ty: number; ph: number; sway: number; t0?: number; burst?: boolean; wish?: boolean }
    const lamps: Lamp[] = [];
    const add = (born: Lamp['born'], size: number, color: string) => {
      let tx = rnd();
      const ty0 = rnd();
      // They keep clear of the middle, where the title and the dream are.
      if (Math.abs(tx - 0.5) < (ty0 < 0.4 ? 0.3 : 0.14)) tx += tx < 0.5 ? -0.3 : 0.3;
      lamps.push({ born, size, color, shape: Math.floor(rnd() * 3), tx: Math.min(0.98, Math.max(0.02, tx)), ty: 0.08 + Math.pow(ty0, 1.3) * 0.52, ph: rnd() * 7, sway: 0.5 + rnd() });
    };
    for (let i = 0; i < 7; i++) { const at = [0.01, 0.02, 0.03, 0.04, 0.06, 0.08, 0.1][i]!; add((s) => s.p >= at, i < 4 ? 9 : 11, '#f1c27b'); }
    for (let i = 0; i < placeCount; i++) add(() => shown.places > i + 0.5, 18 + ((PLACE_SIZES[i % 9]! - 28) * 0.4), palette[i % 4]!);
    for (let i = 0; i < PEOPLE; i++) add(() => shown.people > i + 0.5, 7 + rnd() * 3, '#ffb060');
    // The festival itself: hundreds of lanterns in depth, rising off the cloud sea into the sky and away, shrinking as
    // they go; there are more of them as the world grows, until the sky is full.
    const SWARM = 900;
    // A lantern comes up from just under the cloud sea's edge, fading in as it clears it (`shown`, also as the swarm
    // grows to include it), so none appears out of nothing.
    interface Far { z: number; x: number; y: number; v: number; ph: number; shape: number; shown: number }
    const respawn = (o: Far, anywhere: boolean) => {
      o.z = 1.2 + Math.pow(rnd(), 0.6) * 28;
      o.x = (rnd() - 0.5) * 3.4 * o.z;
      o.y = anywhere ? rnd() * o.z * 1.6 : -(0.15 + 0.1 * rnd()) * o.z;
      o.shown = 0;
      o.v = 0.012 + rnd() * 0.03;
      o.ph = rnd() * 7;
      o.shape = Math.floor(rnd() * 3);
      return o;
    };
    const swarm = Array.from({ length: SWARM }, () => respawn({} as Far, true));
    const sparks: { x: number; y: number; vx: number; vy: number; life: number; age: number; c: string; s: number }[] = [];
    let warm = 0, firstFrame = true;
    const burst = (x: number, y: number, color: string, n: number) => {
      warm = 1;
      for (let k = 0; k < n; k++) {
        const a = -Math.PI / 2 + (rnd() - 0.5) * 2.4, v = (40 + rnd() * 110) * dpr;
        sparks.push({ x, y, vx: Math.cos(a) * v, vy: Math.sin(a) * v, life: 1.2 + rnd() * 1.8, age: 0, c: rnd() < 0.5 ? '#ffd08a' : color, s: (0.8 + rnd() * 1.2) * dpr });
      }
    };
    // Touching the dream lets one go just for you.
    const wishes: Lamp[] = [];
    onTouch = () => {
      if (wishes.length < 40) wishes.push({ born: () => true, wish: true, size: 12, color: palette[wishes.length % 4]!, shape: wishes.length % 3, tx: rnd(), ty: 0.08 + rnd() * 0.4, ph: rnd() * 7, sway: 1, t0: performance.now() });
    };

    return (dt: number, now: number, st: DreamState) => {
      fit(back);
      const g = back.getContext('2d')!, { cx, cy, d } = dreamAt(), W = back.width, H = back.height, k = H / (900 * dpr), fade = 1 - 0.2 * settle;
      g.clearRect(0, 0, W, H);
      const gust = Math.sin(now / 9000) * 0.7 + Math.sin(now / 3700) * 0.3;
      let made = 0;
      const all = [...lamps, ...wishes].flatMap((l) => {
        if (!l.born(st)) { l.t0 = undefined; l.burst = false; return []; }
        // A thing made since the page opened rises with a flourish; one already made on load is simply there.
        l.t0 ??= firstFrame ? -1e9 : now;
        const age = now - l.t0;
        made++;
        if (!l.burst) { l.burst = true; if (age < 1000) burst(cx, cy - d * 0.3, l.color, l.size > 14 ? 40 : 14); }
        // Rising: out of the top of the dream, swaying, slowing as it reaches its place; then a gentle bob.
        const e = 1 - Math.pow(1 - Math.min(1, age / 12000), 3), depth = 1 - l.ty;
        const tx = l.tx * W + pointer.ex * 30 * depth * dpr, ty = l.ty * H + pointer.ey * 14 * depth * dpr;
        const x0 = cx, y0 = cy - d * 0.3;
        const x = x0 + (tx - x0) * e + (Math.sin((now / 1700) * l.sway + l.ph) * 8 + gust * 14 * depth) * dpr * (0.3 + e);
        const y = y0 + (ty - y0) * e + Math.sin(now / 1300 + l.ph) * 4 * dpr;
        const rising = e < 0.98;
        if (rising && Math.random() < dt * 14) sparks.push({ x, y: y + l.size * dpr * 0.8, vx: (Math.random() - 0.5) * 12 * dpr, vy: 10 * dpr, life: 1 + Math.random(), age: 0, c: '#ffc070', s: 0.9 * dpr });
        return [{ l, x, y, rising, s: l.size * dpr * k * (0.55 + 0.6 * depth) * (1.2 - 0.2 * e), a: Math.min(1, age / 500) * fade * (0.62 + 0.38 * depth), blur: rising ? 0 : depth < 0.55 ? 2 : 0 }];
      }).sort((a, b) => a.s - b.s);
      const fill = made / (lamps.length || 1);
      // As it fills, the night turns amber with their light, from the top down.
      const amber = g.createLinearGradient(0, 0, 0, H * 0.8);
      amber.addColorStop(0, `rgba(120,50,20,${0.14 * fill * fade})`);
      amber.addColorStop(0.7, `rgba(255,150,60,${0.03 * fill * fade})`);
      amber.addColorStop(1, 'rgba(255,150,60,0)');
      g.globalAlpha = 1;
      g.fillStyle = amber;
      g.fillRect(0, 0, W, H * 0.8);
      const live = Math.round(SWARM * Math.pow(clamp(st.p * 1.05), 1.6)), f3 = H * 0.55, hz = H * 0.78;
      const far: [Far, number, number][] = [];
      for (let i = live; i < SWARM && swarm[i]!.shown; i++) swarm[i]!.shown = 0;
      for (let i = 0; i < live; i++) {
        const o = swarm[i]!;
        o.y += o.v * dt * (1 + kick * 3);
        o.shown = Math.min(1, o.shown + dt / 1.5, Math.max(0, (o.y / o.z + 0.15) / 0.1));
        const x = W / 2 + (o.x / o.z) * f3 + ((gust * 6 * dpr) / o.z) * 10 + (pointer.ex * 40 * dpr) / o.z, y = hz - (o.y / o.z) * f3 + Math.sin(now / 1500 + o.ph) * 2 * dpr;
        if (y < -40 * dpr || x < -60 * dpr || x > W + 60 * dpr) { respawn(o, false); continue; }
        far.push([o, x, y]);
      }
      far.sort((a, b) => b[0].z - a[0].z);
      for (const [o, x, y] of far) lantern(g, x, y, (34 * dpr * k) / o.z, '#ffb060', o.shape, o.z < 3 ? 2 : 0, Math.min(0.8, 1.4 - o.z / 22) * o.shown * fade * (0.85 + 0.15 * Math.sin(now / 200 + o.ph * 9)), 0.3);
      // The festival warms the night: a glow on the cloud sea below and a halo round the dream, flaring at each launch.
      warm = Math.max(0, warm - dt * 0.8);
      const sea = g.createLinearGradient(0, H * 0.45, 0, H);
      sea.addColorStop(0, 'rgba(255,170,90,0)');
      sea.addColorStop(1, `rgba(255,150,70,${(0.03 + 0.12 * fill) * fade})`);
      g.globalAlpha = 1;
      g.fillStyle = sea;
      g.fillRect(0, H * 0.45, W, H * 0.55);
      g.globalCompositeOperation = 'lighter';
      glow(g, cx, cy, d * (0.85 + 0.3 * warm), '#ffb468', (0.06 + 0.12 * fill + 0.4 * warm) * fade);
      // Each lantern at rest lends a little warm light to the sky round it; together they light it.
      for (const o of all) if (!o.rising) glow(g, o.x, o.y, o.s * 6, o.l.color + '40', 0.22 * o.a);
      g.globalCompositeOperation = 'source-over';
      for (const o of all) lantern(g, o.x, o.y, o.s, o.l.color, o.l.shape, o.blur, o.a * (0.86 + 0.14 * Math.sin(now / 90 + o.l.ph * 9) * Math.sin(now / 230 + o.l.ph)));
      // Sparks: from each launch, behind each rising lantern, and loose ones rising off the clouds as it fills.
      if (Math.random() < dt * (1 + 10 * fill)) sparks.push({ x: Math.random() * W, y: H * (0.7 + Math.random() * 0.3), vx: 0, vy: -(14 + Math.random() * 20) * dpr, life: 4 + Math.random() * 4, age: 0, c: '#ffcf8a', s: (0.6 + Math.random()) * dpr });
      g.globalCompositeOperation = 'lighter';
      for (let i = sparks.length - 1; i >= 0; i--) {
        const sp = sparks[i]!;
        sp.age += dt;
        if (sp.age > sp.life || sparks.length > 500) { sparks.splice(i, 1); continue; }
        sp.vx *= 1 - dt * 1.2;
        sp.vy = sp.vy * (1 - dt * 1.2) - 18 * dpr * dt;
        sp.x += (sp.vx + gust * 6 * dpr) * dt;
        sp.y += sp.vy * dt;
        const a = (1 - sp.age / sp.life) * (0.6 + 0.4 * Math.sin(sp.age * 20 + i)) * fade;
        glow(g, sp.x, sp.y, sp.s * 5, sp.c + 'cc', a * 0.6);
        g.globalAlpha = a;
        g.fillStyle = '#fff6e0';
        g.fillRect(sp.x - sp.s / 2, sp.y - sp.s / 2, sp.s, sp.s);
      }
      g.globalCompositeOperation = 'source-over';
      g.globalAlpha = 1;
      firstFrame = false;
    };
  }

  // ------------------------------------------------------------------ galaxy
  function galaxy() {
    const ARMS = 3, stars: number[][] = [];
    const gauss = () => (Math.random() + Math.random() + Math.random() - 1.5) / 1.5;
    const mixc = (a: number[], b: number[], t: number) => a.map((v, k) => v + (b[k]! - v) * t);
    const hex = (h: string) => [1, 3, 5].map((k) => parseInt(h.slice(k, k + 2), 16) / 255);
    const PAL = palette.map(hex), WARM = [1, 0.93, 0.8];
    const armAngle = (arm: number, r: number) => (arm / ARMS) * Math.PI * 2 + Math.log(r / 0.08) * 1.9;
    // Stars: most along the arms, some in a smooth disc; they appear over the whole build.
    for (let i = 0; i < 12000; i++) {
      const r = 0.07 + Math.pow(Math.random(), 0.75) * 0.95, inArm = Math.random() < 0.72, arm = i % ARMS;
      const th = inArm ? armAngle(arm, r) + gauss() * (0.42 - 0.18 * r) : Math.random() * 7;
      const col = mixc(WARM, PAL[(arm + (r > 0.6 ? 1 : 0)) % 4]!, Math.min(1, r * 1.3) * (0.4 + Math.random() * 0.5));
      stars.push([r + gauss() * 0.03, th, 0.8 + Math.random() * 1.8, 0.02 + Math.pow(Math.random(), 1.4) * 0.86, 0, ...col]);
    }
    // Dust and glowing gas along the arms, in the world's colors, arriving with the rules and story and thickening.
    for (let i = 0; i < 420; i++) {
      const r = 0.12 + Math.random() * 0.85, arm = i % ARMS;
      stars.push([r, armAngle(arm, r) + gauss() * 0.22, 50 + Math.random() * 90, 0.02 + Math.random() * 0.3, 1, ...PAL[(arm + i) % 4]!]);
    }
    // A knot of light for every place, out along the arms, igniting as it is painted (its birth is its number).
    for (let i = 0; i < placeCount; i++) {
      const r = 0.28 + (i / Math.max(1, placeCount - 1)) * 0.62, arm = i % ARMS;
      stars.push([r, armAngle(arm, r), PLACE_SIZES[i % 9]! + 2, i, 2, ...PAL[i % 4]!]);
    }
    // A new star for every person.
    for (let i = 0; i < PEOPLE; i++) {
      const r = 0.15 + Math.random() * 0.8, arm = i % ARMS;
      stars.push([r, armAngle(arm, r) + gauss() * 0.25, 9 + Math.random() * 5, i, 3, ...WARM]);
    }
    const data = new Float32Array(stars.flat());
    const VS = `attribute float aR, aTh, aSize, aBirth, aKind; attribute vec3 aCol;
      uniform float uT, uP, uPlaces, uPeople, uFront, uTiltY, uTiltX, uDpr, uFade; uniform vec2 uR2, uCtr;
      varying vec3 vCol; varying float vA, vKind, vSeed;
      void main() {
        float th = aTh + uT * .09 / (aR + .12);
        vec2 d = vec2(cos(th), sin(th)) * aR;
        // Stars and dust come with the build's progress; places and people with their own counts.
        float made = aKind > 2.5 ? uPeople : uPlaces;
        float on = aKind > 1.5 ? smoothstep(aBirth + .2, aBirth + .5, made) : smoothstep(aBirth, aBirth + .025, uP);
        float keep = uFront > .5 ? step(0., d.y) : step(d.y, 0.);
        vec2 s = vec2(d.x + d.y * uTiltX, d.y * uTiltY);
        gl_Position = vec4(uCtr + vec2(s.x * uR2.x, -s.y * uR2.y), 0., 1.);
        // A place or a person flares as it ignites, then settles.
        float flare = aKind > 1.5 ? 1. + 2.5 * exp(-max(made - aBirth - .5, 0.) * 6.) : 1.;
        gl_PointSize = aSize * uDpr * on * keep * flare * (aKind < .5 ? .9 + .35 * d.y : 1.);
        vCol = aCol; vKind = aKind; vSeed = aTh * 13.7 + aR * 91.;
        vA = on * uFade * (aKind < .5 ? .55 + .45 * smoothstep(.9, .1, aR) : 1.);
      }`;
    const FS = `precision highp float; uniform float uT; varying vec3 vCol; varying float vA, vKind, vSeed;
      void main() {
        vec2 c = gl_PointCoord * 2. - 1.; float d2 = dot(c, c);
        float a;
        if (vKind < .5) a = exp(-d2 * 4.) * (.8 + .3 * sin(uT * 2. + vSeed)) * 1.3;
        else if (vKind < 1.5) a = exp(-d2 * 3.5) * .085;
        else if (vKind < 2.5) { a = exp(-d2 * 9.) + exp(-d2 * 1.8) * .35 + .5 * max(0., 1. - abs(c.x) * 14.) * exp(-c.y * c.y * 2.) + .5 * max(0., 1. - abs(c.y) * 14.) * exp(-c.x * c.x * 2.);
          a *= .8 + .2 * sin(uT * 1.5 + vSeed); }
        else a = exp(-d2 * 7.) + .4 * max(0., 1. - abs(c.x) * 10.) * exp(-c.y * c.y * 5.) + .4 * max(0., 1. - abs(c.y) * 10.) * exp(-c.x * c.x * 5.);
        vec3 col = vKind > 1.5 ? mix(vCol, vec3(1.), exp(-d2 * 14.)) : vCol;
        a *= vA;
        gl_FragColor = vec4(col * a, a);
      }`;
    const UNIFORMS = ['uT', 'uP', 'uPlaces', 'uPeople', 'uFront', 'uTiltY', 'uTiltX', 'uDpr', 'uFade', 'uR2', 'uCtr'] as const;
    // The half of the disc behind the dream, then the half in front of it.
    const setup = (canvas: HTMLCanvasElement) => {
      const gl = canvas.getContext('webgl', { premultipliedAlpha: true, alpha: true, antialias: true });
      if (!gl) return null;
      const sh = (t: number, src: string) => {
        const s = gl.createShader(t)!;
        gl.shaderSource(s, src);
        gl.compileShader(s);
        if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) console.error('[dream]', gl.getShaderInfoLog(s));
        return s;
      };
      const pr = gl.createProgram()!;
      gl.attachShader(pr, sh(gl.VERTEX_SHADER, VS));
      gl.attachShader(pr, sh(gl.FRAGMENT_SHADER, FS));
      gl.linkProgram(pr);
      if (!gl.getProgramParameter(pr, gl.LINK_STATUS)) console.error('[dream]', gl.getProgramInfoLog(pr));
      gl.useProgram(pr);
      gl.bindBuffer(gl.ARRAY_BUFFER, gl.createBuffer());
      gl.bufferData(gl.ARRAY_BUFFER, data, gl.STATIC_DRAW);
      const stride = 8 * 4;
      ([['aR', 1, 0], ['aTh', 1, 1], ['aSize', 1, 2], ['aBirth', 1, 3], ['aKind', 1, 4], ['aCol', 3, 5]] as const).forEach(([n, size, off]) => {
        const loc = gl.getAttribLocation(pr, n);
        gl.enableVertexAttribArray(loc);
        gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, off * 4);
      });
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
      const U = Object.fromEntries(UNIFORMS.map((n) => [n, gl.getUniformLocation(pr, n)])) as Record<(typeof UNIFORMS)[number], WebGLUniformLocation | null>;
      return { gl, U };
    };
    const targets = [back, front].map((c) => ({ c, g: setup(c) }));
    let gt = 0;
    return (dt: number, _now: number, st: DreamState) => {
      gt += dt * (1 + kick * 6);
      const at = dreamAt();
      targets.forEach(({ c, g }, mode) => {
        fit(c);
        if (!g) return;
        const { gl, U } = g;
        gl.viewport(0, 0, c.width, c.height);
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        const R = Math.min(c.width * (c.width < c.height ? 0.5 : 0.36), c.height * 0.66) * (1 + 0.15 * settle);
        gl.uniform2f(U.uCtr, (at.cx / c.width) * 2 - 1, 1 - (at.cy / c.height) * 2);
        gl.uniform1f(U.uT, gt);
        gl.uniform1f(U.uP, st.ready ? 1 : st.p);
        gl.uniform1f(U.uPlaces, shown.places);
        gl.uniform1f(U.uPeople, shown.people);
        gl.uniform1f(U.uFront, mode);
        gl.uniform1f(U.uDpr, dpr * Math.min(1.3, Math.max(0.3, R / (600 * dpr))));
        gl.uniform1f(U.uTiltY, 0.4 + 0.14 * pointer.ey);
        gl.uniform1f(U.uTiltX, -0.18 * pointer.ex);
        gl.uniform1f(U.uFade, (mode ? 0.75 : 1) * (1 - 0.55 * settle));
        gl.uniform2f(U.uR2, (2 * R) / c.width, (2 * R) / c.height);
        gl.drawArrays(gl.POINTS, 0, data.length / 8);
      });
    };
  }
}
