/**
 * The moonlit night behind the screens before a world is entered: a painting that breathes, mist drifting across it,
 * stars, a few far lanterns rising, fireflies over the water, and now and then a falling star. Everything marked
 * with data-depth on the page drifts a little against the pointer, the far layers least.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { api, assetUrl, VERSION, type Me } from '../api';
import { ADMIN_PAGES, navigate } from '../App';
import { setPagesMuted, usePagesMuted } from '../settings';
import { Icon } from './svgicons';
import { usePanelSound } from './common';
import { tell } from './ask';

export type Scene = 'lake' | 'sky' | 'clouds';
const PLATE: Record<Scene, string> = { lake: '/moon/lake.jpg', sky: '/moon/sky.jpg', clouds: '/moon/night.jpg' };

/** How much of the night is out (stars, lanterns, fireflies): 1 normally; a world being dreamed raises it as it forms. */
export interface NightLevel { current: number }

function Night({ scene, level, sceneryRef }: { scene: Scene; level?: NightLevel; sceneryRef?: React.Ref<HTMLDivElement> }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  useEffect(() => {
    const cv = canvas.current!;
    const cx = cv.getContext('2d')!;
    const dpr = Math.min(devicePixelRatio, 2);
    const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
    let W = 0, H = 0;
    const fit = () => { W = cv.width = innerWidth * dpr; H = cv.height = innerHeight * dpr; };
    fit();
    addEventListener('resize', fit);
    const small = innerWidth < 640;
    const stars = Array.from({ length: small ? 50 : 110 }, () => ({ x: Math.random(), y: Math.random() * 0.42, s: Math.random(), p: Math.random() * 9 }));

    // Lanterns are kept small and few, and the far ones are drawn softer, as if out of focus, so they belong to the
    // painting instead of sitting on it. Each sprite is drawn once at three focus levels and scaled from there.
    const FOCUS = [0, 1.2, 2.6];
    const sprites = [1, 2, 3].map((i) => {
      const img = new Image(), out: { levels: HTMLCanvasElement[] | null } = { levels: null };
      img.onload = () => {
        out.levels = FOCUS.map((b) => {
          const c = document.createElement('canvas'), h = 72, w = Math.ceil((h * img.width) / img.height), pad = 8;
          c.width = w + pad * 2;
          c.height = h + pad * 2;
          const g = c.getContext('2d')!;
          g.filter = b ? `blur(${b}px)` : 'none';
          g.drawImage(img, pad, pad, w, h);
          return c;
        });
      };
      img.src = `/moon/lantern${i}.png`;
      return out;
    });
    type Lantern = { x: number; y: number; z: number; spr: (typeof sprites)[number]; p: number };
    // Near lanterns keep out of the middle column, where the words and the forms are.
    const lanternX = (z: number) => { let x = Math.random(); if (z > 0.35 && Math.abs(x - 0.5) < 0.2) x += x < 0.5 ? -0.22 : 0.22; return Math.min(0.98, Math.max(0.02, x)); };
    const lantern = (z: number, y = 1.05 + Math.random() * 0.4): Lantern => ({ x: lanternX(z), y, z, spr: sprites[(Math.random() * 3) | 0]!, p: Math.random() * 9 });
    const lanterns = Array.from({ length: small ? 10 : 18 }, () => lantern(Math.random() ** 1.6, Math.random() * 1.1)).sort((a, b) => a.z - b.z);
    // Fireflies: specks that wander low over the water and the shore, glowing now and then. A new one starts in a dark
    // spell (q between π and 2π), so none lights up out of nothing.
    const fly = (dark = false) => ({ x: Math.random(), y: 0.52 + Math.random() * 0.46, p: Math.random() * 20, q: dark ? Math.PI * (1 + Math.random()) : Math.random() * 20, k: 0.5 + Math.random(), z: Math.random() });
    const flies = Array.from({ length: small ? 18 : 36 }, () => fly());

    const target = { x: 0, y: 0 }, cur = { x: 0, y: 0 };
    const move = (e: PointerEvent) => { target.x = e.clientX / innerWidth - 0.5; target.y = e.clientY / innerHeight - 0.5; };
    addEventListener('pointermove', move);

    let shoot: { x: number; y: number; a: number; dir: number; t: number } | null = null;
    let nextShoot = performance.now() + 3000, last = performance.now(), raf = 0;
    const frame = (now: number) => {
      const dt = Math.min(50, now - last) / 1000;
      last = now;
      const nightLevel = level?.current ?? 1;
      // Ease slowly: the far layers lag, nothing snaps.
      cur.x += (target.x - cur.x) * Math.min(1, dt * 1.6);
      cur.y += (target.y - cur.y) * Math.min(1, dt * 1.6);
      for (const el of document.querySelectorAll<HTMLElement>('[data-depth]')) {
        const d = +el.dataset.depth!;
        el.style.translate = `${(-cur.x * d * 1.35).toFixed(2)}px ${(-cur.y * d * 0.8).toFixed(2)}px`;
      }
      cx.clearRect(0, 0, W, H);
      for (const s of stars) {
        s.p += dt * (0.6 + s.s);
        cx.fillStyle = `rgba(235,232,255,${(0.18 + 0.5 * Math.max(0, Math.sin(s.p)) ** 3) * nightLevel})`;
        cx.beginPath();
        cx.arc((s.x - cur.x * 0.006) * W, (s.y - cur.y * 0.004) * H, (0.5 + s.s * 0.9) * dpr, 0, 7);
        cx.fill();
      }
      lanterns.forEach((l, li) => {
        if (li / lanterns.length > nightLevel - 0.15) return;
        l.p += dt;
        l.y -= dt * (0.004 + l.z * 0.014);
        l.x += Math.sin(l.p * 0.45 + l.z * 7) * dt * 0.0016;
        if (l.y < -0.08) Object.assign(l, lantern(l.z));
        const levels = l.spr.levels;
        if (!levels) return;
        const size = (9 + l.z * 30) * dpr;
        const px = (l.x - cur.x * l.z * 0.028) * W, py = (l.y - cur.y * l.z * 0.016) * H;
        const flick = 0.85 + 0.15 * Math.sin(l.p * 6.1 + l.z * 11) * Math.sin(l.p * 2.3);
        const fade = Math.min(1, (1.05 - l.y) * 4) * Math.min(1, (l.y + 0.06) * 5);
        cx.globalCompositeOperation = 'lighter';
        const g = cx.createRadialGradient(px, py + size * 0.15, 0, px, py + size * 0.15, size * 2.2);
        g.addColorStop(0, `rgba(255,172,90,${0.22 * flick * fade * (0.5 + l.z)})`);
        g.addColorStop(1, 'rgba(255,150,60,0)');
        cx.fillStyle = g;
        cx.fillRect(px - size * 2.2, py - size * 2, size * 4.4, size * 4.4);
        cx.globalCompositeOperation = 'source-over';
        const lvl = levels[l.z > 0.6 ? 0 : l.z > 0.25 ? 1 : 2]!, scale = size / 72;
        cx.globalAlpha = fade * (0.45 + 0.55 * l.z) * flick;
        cx.drawImage(lvl, px - (lvl.width * scale) / 2, py - (lvl.height * scale) / 2, lvl.width * scale, lvl.height * scale);
        cx.globalAlpha = 1;
      });
      // Now and then a star falls: a short bright streak across the upper sky.
      if (!shoot && now > nextShoot) shoot = { x: 0.15 + Math.random() * 0.7, y: 0.04 + Math.random() * 0.22, a: 0.35 + Math.random() * 0.3, dir: Math.random() < 0.5 ? -1 : 1, t: 0 };
      if (shoot) {
        shoot.t += dt / 0.9;
        const e = shoot.t, k = Math.sin(Math.PI * Math.min(1, e));
        const hx = (shoot.x + shoot.dir * Math.cos(shoot.a) * 0.16 * e) * W, hy = (shoot.y + Math.sin(shoot.a) * 0.16 * e) * H;
        const len = 90 * dpr * k, tx = hx - shoot.dir * Math.cos(shoot.a) * len, ty = hy - Math.sin(shoot.a) * len;
        const g = cx.createLinearGradient(tx, ty, hx, hy);
        g.addColorStop(0, 'rgba(255,255,255,0)');
        g.addColorStop(1, `rgba(255,248,230,${0.9 * k * nightLevel})`);
        cx.strokeStyle = g;
        cx.lineWidth = 1.4 * dpr;
        cx.lineCap = 'round';
        cx.beginPath();
        cx.moveTo(tx, ty);
        cx.lineTo(hx, hy);
        cx.stroke();
        if (e >= 1) { shoot = null; nextShoot = now + 9000 + Math.random() * 16000; }
      }
      cx.globalCompositeOperation = 'lighter';
      flies.forEach((f, fi) => {
        if (fi / flies.length > nightLevel - 0.3) return;
        f.p += dt * 0.35 * f.k;
        f.q += dt * (0.5 + f.k * 0.4);
        f.x += (Math.sin(f.p * 1.3) + Math.sin(f.p * 0.7 + 2)) * dt * 0.006;
        f.y += (Math.cos(f.p * 1.1) + Math.sin(f.p * 0.5)) * dt * 0.004;
        // Long dark spells, a slow swell of light. One that has wandered off is moved only while it is dark.
        const glow = Math.max(0, Math.sin(f.q)) ** 3;
        if (glow < 0.02) {
          if (f.x < -0.02 || f.x > 1.02 || f.y < 0.45 || f.y > 1.02) Object.assign(f, fly(true));
          return;
        }
        const px = (f.x - cur.x * (0.01 + f.z * 0.02)) * W, py = (f.y - cur.y * (0.006 + f.z * 0.01)) * H, r = (5 + f.z * 7) * dpr;
        const g = cx.createRadialGradient(px, py, 0, px, py, r);
        g.addColorStop(0, `rgba(255,246,190,${0.9 * glow})`);
        g.addColorStop(0.18, `rgba(240,225,130,${0.5 * glow})`);
        g.addColorStop(1, 'rgba(220,200,100,0)');
        cx.fillStyle = g;
        cx.fillRect(px - r, py - r, r * 2, r * 2);
      });
      cx.globalCompositeOperation = 'source-over';
      if (!still) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => {
      cancelAnimationFrame(raf);
      removeEventListener('resize', fit);
      removeEventListener('pointermove', move);
    };
  }, [level]);
  return (
    <div className="m-night" aria-hidden="true">
      <div ref={sceneryRef} className="m-scenery">
        <div className={`m-layer m-plate${scene === 'lake' ? ' lake' : ''}`} data-depth="8" style={{ backgroundImage: `url(${PLATE[scene]})` }} />
        <div className="m-layer m-mist one" data-depth="14" />
        <div className="m-layer m-mist two" data-depth="22" />
      </div>
      <canvas ref={canvas} className="m-stars" />
      <div className="m-vignette" />
    </div>
  );
}

/** The ripple that makes the title's reflection on the lake waver. */
function Ripple() {
  return (
    <svg width="0" height="0" style={{ position: 'absolute' }} aria-hidden="true">
      <filter id="m-ripple" x="-5%" y="-20%" width="110%" height="140%">
        <feTurbulence type="fractalNoise" baseFrequency="0.012 0.09" numOctaves={2} seed={3} result="n">
          <animate attributeName="baseFrequency" dur="14s" values="0.012 0.09;0.016 0.11;0.012 0.09" repeatCount="indefinite" />
        </feTurbulence>
        <feDisplacementMap in="SourceGraphic" in2="n" scale={10} />
      </filter>
    </svg>
  );
}

/** A moonlit screen: the night, the top bar (unless signing in), and the page itself. */
export function MoonScreen({ scene, me, back, level, sceneryRef, children }: { scene: Scene; me?: Me; back?: { label: string; to: string }; level?: NightLevel; sceneryRef?: React.Ref<HTMLDivElement>; children: ReactNode }) {
  // One screen can follow another in the same night, so a new page starts at its top.
  const root = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const top = () => root.current?.scrollTo(0, 0);
    addEventListener('hashchange', top);
    return () => removeEventListener('hashchange', top);
  }, []);
  return (
    <div ref={root} className="m-root">
      <Ripple />
      <Night scene={scene} level={level} sceneryRef={sceneryRef} />
      {me ? <MoonTop me={me} back={back} /> : <MuteButton corner />}
      {children}
    </div>
  );
}

/**
 * A working page (your account, users, models, the GPU, the world viewer) under the same night: the game's own
 * panels, buttons, and fields, dressed to match (.m-tools in moon.css).
 */
export function ToolPage({ me, back = { label: 'Worlds', to: '#/' }, className = '', style, children }: { me: Me; back?: { label: string; to: string }; className?: string; style?: React.CSSProperties; children: ReactNode }) {
  return (
    <MoonScreen scene="clouds" me={me} back={back}>
      <main className={`page-inner m-tools ${className}`} style={style}>{children}</main>
    </MoonScreen>
  );
}

/** Silences the pages outside the game on this device, or brings their sound back; remembered there (settings.ts). */
function MuteButton({ corner }: { corner?: boolean }) {
  const muted = usePagesMuted();
  const label = muted ? 'Turn sound on' : 'Mute sound';
  return (
    <button type="button" className={`m-mute${corner ? ' corner' : ''}${muted ? ' off' : ''}`} aria-pressed={muted} aria-label={label} title={label} onClick={() => setPagesMuted(!muted)}>
      <Icon name={muted ? 'muted' : 'sound'} size={20} color="currentColor" />
    </button>
  );
}

/**
 * The bar along the top: the wordmark (home), where a page belongs, sound, and the account menu, which also holds
 * the administrators' pages for administrators.
 */
function MoonTop({ me, back }: { me: Me; back?: { label: string; to: string } }) {
  const [open, setOpen] = useState(false);
  const who = useRef<HTMLButtonElement>(null), menu = useRef<HTMLDivElement>(null);
  usePanelSound(open);
  useEffect(() => {
    if (!open) return;
    const close = () => setOpen(false);
    const t = setTimeout(() => addEventListener('click', close), 0);
    return () => { clearTimeout(t); removeEventListener('click', close); };
  }, [open]);
  const go = (to: string) => () => navigate(to);
  const here = location.hash.replace(/^#\/?/, '').split(/[/?]/)[0];
  /**
   * Arrows move between the items, Escape closes the menu and gives the focus back to its button. Focus never
   * scrolls the page: its sky is wider than the screen, and a browser would slide the whole page sideways.
   */
  const keys = (e: React.KeyboardEvent) => {
    const items = [...(menu.current?.querySelectorAll<HTMLButtonElement>('[role=menuitem]') ?? [])];
    const i = items.indexOf(document.activeElement as HTMLButtonElement);
    const to = e.key === 'ArrowDown' ? (i + 1) % items.length : e.key === 'ArrowUp' ? (i - 1 + items.length) % items.length : e.key === 'Home' ? 0 : e.key === 'End' ? items.length - 1 : -1;
    if (to >= 0) {
      e.preventDefault();
      items[to]?.focus({ preventScroll: true });
    } else if (e.key === 'Escape') {
      setOpen(false);
      who.current?.focus({ preventScroll: true });
    }
  };
  const item = (page: string, label: string) => (
    <button key={page} role="menuitem" aria-current={here === page ? 'page' : undefined} onClick={go(`#/${page}`)}>{label}</button>
  );
  return (
    <header className="m-top">
      <div className="m-wordmark" role="link" tabIndex={0} onClick={go('#/')} onKeyDown={(e) => e.key === 'Enter' && navigate('#/')}>Daydream</div>
      {/* The wordmark leads home; a page deeper than one step shows where it belongs as a breadcrumb. */}
      {back && back.to !== '#/' && (
        <>
          <span className="crumb-sep" aria-hidden>/</span>
          <button className="back" onClick={go(back.to)}>{back.label}</button>
        </>
      )}
      <div className="spacer" />
      <MuteButton />
      <button ref={who} className="m-who" aria-haspopup="menu" aria-expanded={open} onClick={() => setOpen((o) => !o)} onKeyDown={(e) => {
        if (e.key === 'ArrowDown' && !open) {
          e.preventDefault();
          setOpen(true);
          requestAnimationFrame(() => menu.current?.querySelector<HTMLButtonElement>('[role=menuitem]')?.focus({ preventScroll: true }));
        }
      }}>
        <span>{me.displayName}</span>
        <span className="face">{me.displayName.trim()[0]?.toUpperCase() ?? '?'}</span>
      </button>
      {open && (
        <div ref={menu} className="m-panel m-menu" role="menu" aria-label="Account" onKeyDown={keys}>
          {item('account', 'Your account')}
          {item('settings', 'Settings')}
          {me.isAdmin && (
            <div role="group" aria-labelledby="m-menu-admin" className="group">
              <div id="m-menu-admin" className="label">Administration</div>
              {ADMIN_PAGES.map((p) => item(p.page, p.label))}
            </div>
          )}
          <hr />
          <button role="menuitem" onClick={() => api.logout().then(() => { location.hash = '#/'; location.reload(); }, (e) => void tell((e as Error).message))}>Sign out</button>
          <div className="version">Daydream {VERSION}</div>
        </div>
      )}
    </header>
  );
}

interface BubbleArt { worldId: string; scene?: string; figures: string[] }

/**
 * A world in a glass bubble: its first place inside and some of its people in front, shifting against each other
 * under the pointer. Without art yet, mist turns inside it; while it is being dreamed, light gathers from below.
 */
export function Bubble({ art, tint, size, progress, label, onClick, className = '' }: { art?: BubbleArt; tint?: string; size?: string; progress?: number; label?: string; onClick?: () => void; className?: string }) {
  const scene = useRef<HTMLDivElement>(null), figs = useRef<HTMLDivElement>(null);
  const url = (f: string) => assetUrl(art!.worldId, f);
  const painted = !!art?.scene;
  const tilt = (e: React.PointerEvent<HTMLElement>) => {
    const r = e.currentTarget.getBoundingClientRect(), dx = (e.clientX - r.left) / r.width - 0.5, dy = (e.clientY - r.top) / r.height - 0.5;
    if (scene.current) scene.current.style.transform = `translate(${-dx * 14}px, ${-dy * 10}px) scale(1.06)`;
    if (figs.current) figs.current.style.transform = `translate(${dx * 8}px, ${dy * 3}px)`;
  };
  const rest = () => {
    if (scene.current) scene.current.style.transform = '';
    if (figs.current) figs.current.style.transform = '';
  };
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag
      className={`m-bubble${painted ? '' : ' empty'} ${className}`}
      style={{ ...(size ? { '--size': size } : {}), ...(tint ? { '--tint': tint } : {}), ...(progress !== undefined ? { '--p': `${Math.round(progress * 100)}%` } : {}) } as React.CSSProperties}
      onClick={onClick}
      onPointerMove={painted ? tilt : undefined}
      onPointerLeave={painted ? rest : undefined}
      aria-label={label}
    >
      <div className="inside">
        {painted ? (
          <>
            <div ref={scene} className="scene" style={{ backgroundImage: `url(${url(art!.scene!)})` }} />
            <div ref={figs} className="figs">{art!.figures.slice(0, 3).map((f) => <img key={f} src={url(f)} alt="" />)}</div>
          </>
        ) : (
          <>
            <div className="swirl" />
            <div className="swirl b" />
            {progress !== undefined ? <div className="fill" /> : <div className="spark"><span /></div>}
          </>
        )}
      </div>
      <div className="rim" />
      <div className="glass" />
    </Tag>
  );
}

/**
 * The bubble a new world begins in: a small sky of its own, a moonlit horizon behind two banks of cloud that drift
 * apart, and above them the seed of light the world grows from, with motes circling it. On hover or focus the clouds
 * part and the horizon brightens; while the world is being written (`brewing`), the light beats faster. Everything
 * moves by transform and opacity alone, so phones keep up.
 */
export function NewWorldBubble({ label, onClick, size, brewing }: { label?: string; onClick?: () => void; size?: string; brewing?: boolean }) {
  const Tag = onClick ? 'button' : 'div';
  return (
    <Tag className={`m-bubble m-seedling${onClick ? '' : ' still'}${brewing ? ' brewing' : ''}`} style={size ? ({ '--size': size } as React.CSSProperties) : undefined} onClick={onClick} aria-label={label}>
      <div className="inside m-sky">
        <DreamSky />
      </div>
      <div className="rim" />
      <div className="glass" />
    </Tag>
  );
}

/**
 * The small sky inside a dream's glass, in the night's colors: a moonlit horizon (`.glow`) behind two banks of
 * cloud drifting at different speeds, and above them the gold seed of light a world grows from, with motes circling
 * it. The new-world bubble holds it, and so does the dream of a world being made (screens/Dreaming.tsx). Its
 * container is `.m-sky` and sets `--size` (moon.css).
 */
export function DreamSky() {
  return (
    <>
      <div className="glow" />
      <div className="seed" aria-hidden="true">
        <span className="halo" />
        <span className="star" />
        <span className="motes"><i /><i /><i /></span>
      </div>
      <div className="bank far"><i /></div>
      <div className="bank near"><i /></div>
    </>
  );
}

/** A world floating in the sky: it bobs, drifts against the pointer, and carries its caption under it. */
export function Floater({ i, children, caption }: { i: number; children: ReactNode; caption?: ReactNode }) {
  return (
    <div className="m-float" data-depth={6 + (i % 3) * 5}>
      <div className="m-bob" style={{ '--dur': `${6 + ((i * 1.7) % 4)}s`, '--delay': `-${(i * 2.3) % 5}s` } as React.CSSProperties}>{children}</div>
      {caption}
    </div>
  );
}

/** Small line drawings in gold. */
const SIGILS: Record<string, string> = {
  map: '<path d="M3 6l6-2 6 2 6-2v14l-6 2-6-2-6 2zM9 4v14M15 6v14"/>',
  person: '<circle cx="12" cy="8" r="4"/><path d="M4 21c0-4 4-7 8-7s8 3 8 7"/>',
  pencil: '<path d="M4 20l1-5L16 4l4 4L9 19zM14 6l4 4"/>',
  dice: '<rect x="4" y="4" width="16" height="16" rx="3"/><circle cx="9" cy="9" r="1"/><circle cx="15" cy="15" r="1"/><circle cx="15" cy="9" r="1"/><circle cx="9" cy="15" r="1"/>',
  cross: '<path d="M6 6l12 12M18 6 6 18"/>',
  star: '<path d="M12 3l2.6 5.6 6.1.7-4.5 4.2 1.2 6L12 16.6 6.6 19.5l1.2-6-4.5-4.2 6.1-.7z"/>',
  link: '<path d="M10 14a4 4 0 0 0 5.7 0l3-3a4 4 0 0 0-5.7-5.7l-1.2 1.2M14 10a4 4 0 0 0-5.7 0l-3 3a4 4 0 0 0 5.7 5.7l1.2-1.2"/>',
  plus: '<path d="M12 5v14M5 12h14"/>',
  hourglass: '<path d="M6 3h12M6 21h12M7 3c0 5 10 6 10 9s-10 4-10 9M17 3c0 5-10 6-10 9s10 4 10 9"/>',
  quill: '<path d="M20 3C11 4 6 10 5 20M20 3c-1 6-5 10-11 11M9 14l-3 1"/>',
  claw: '<path d="M6 19c1.5-5 1-9 4-14M11 20c1-5 1.5-9 4.5-15M16 20.5c.5-4.5 2-8 5-11.5"/>',
  gem: '<path d="M7 4h10l4 5-9 11L3 9zM3 9h18M10 4l-1 5 3 11 3-11-1-5"/>',
  scales: '<path d="M12 4v16M8 20h8M5 7h14M7 7l-3 7a3 3 0 0 0 6 0zM17 7l-3 7a3 3 0 0 0 6 0z"/>',
  voice: '<path d="M4 10v4M8 7v10M12 4v16M16 8v8M20 11v2"/>',
  note: '<path d="M9 18V6l11-3v12M9 18a3 3 0 1 1-6 0 3 3 0 0 1 6 0zM20 15a3 3 0 1 1-6 0 3 3 0 0 1 6 0z"/>',
};
export function Sigil({ name, className = 'm-sigil', size }: { name: keyof typeof SIGILS | string; className?: string; size?: number }) {
  return <svg className={className} viewBox="0 0 24 24" width={size} height={size} dangerouslySetInnerHTML={{ __html: SIGILS[name] ?? '' }} />;
}

/** A choice on or off, with what it means beneath its name; `mine` marks one the owner set by hand. */
export function Toggle({ label, hint, on, mine, onChange }: { label: string; hint: string; on: boolean; mine?: boolean; onChange: (v: boolean) => void }) {
  return (
    <button type="button" role="switch" aria-checked={on} className={`m-toggle${on ? ' on' : ''}`} onClick={() => onChange(!on)}>
      <span className="text">
        <b>{label}{mine && <span className="mine">your choice</span>}</b>
        <span>{hint}</span>
      </span>
      <span className="knob" aria-hidden="true"><i /></span>
    </button>
  );
}
