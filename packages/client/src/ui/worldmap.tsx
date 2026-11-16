/**
 * The world map: a painted chart of the world. The land (each place's territory filled with its own ground art,
 * inked borders and coast) is built once per world, off the game's thread (worldchart.ts); each time the map opens,
 * what the party knows is laid over it: places only heard of faded, roads between known places, fog over the rest.
 * Markers and labels sit on top as SVG, so they stay sharp and clickable.
 */
import { useEffect, useRef, useState } from 'react';
import type { ClientWorld, PlayerView } from '@daydream/shared';
import { client } from '../net/game';
import { isTouch } from '../input/pointer';
import { MAP_H, MAP_W, buildChart, fbm, hash, mapPos, maskOf, seedOf, type ChartBase, type ChartInput } from './worldchart';

export { MAP_W, MAP_H };

type Zone = ClientWorld['zones'][number];

const pos = (z: { mapPos: { x: number; y: number } }) => mapPos(z.mapPos);

// ---------------------------------------------------------------------------- the land, once per world

/** Lands built or being built, by world and paintings (a repainted place builds it again). */
const bases = new Map<string, Promise<ChartBase | null>>();
let worker: Worker | null | undefined;
let nextJob = 0;
const jobs = new Map<number, (base: ChartBase | null) => void>();

function landOf(world: ClientWorld): Promise<ChartBase | null> {
  const c = client();
  const dpr = Math.min(2, window.devicePixelRatio || 1);
  const places = world.zones.map((z) => {
    const url = c.assetUrl(z.painting?.image);
    // The chart needs a few hundred pixels of each place, not the painting thousands across.
    return { at: z.mapPos, painting: url ? new URL(`${url}?w=512`, location.href).href : undefined };
  });
  const key = `${world.id}|${dpr}|${places.map((p) => p.painting ?? '').join(',')}`;
  let base = bases.get(key);
  if (!base) {
    base = build({ seed: seedOf(world.id), places, dpr });
    bases.set(key, base);
    if (bases.size > 3) bases.delete(bases.keys().next().value!);
  }
  return base;
}

/** In a worker where the browser has one with OffscreenCanvas; here otherwise (the same code, one stall). */
function build(input: ChartInput): Promise<ChartBase | null> {
  if (typeof OffscreenCanvas === 'undefined') return Promise.resolve(null);
  if (worker === undefined) {
    try {
      worker = new Worker(new URL('./worldchart.worker.ts', import.meta.url), { type: 'module' });
      worker.onmessage = (e: MessageEvent<{ id: number; base?: ChartBase }>) => {
        jobs.get(e.data.id)?.(e.data.base ?? null);
        jobs.delete(e.data.id);
      };
    } catch {
      worker = null;
    }
  }
  if (!worker) return buildChart(input).catch(() => null);
  const id = nextJob++;
  return new Promise((res) => {
    jobs.set(id, res);
    worker!.postMessage({ id, input });
  });
}

// ---------------------------------------------------------------------------- what the party knows

/** A gentle curve between two places (bent the same way every time). */
function roadPath(a: { x: number; y: number }, b: { x: number; y: number }, key: string) {
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2;
  const dx = b.x - a.x, dy = b.y - a.y, len = Math.hypot(dx, dy) || 1;
  const bend = (hash(seedOf(key), 3, 9) - 0.5) * len * 0.35;
  return { cx: mx - (dy / len) * bend, cy: my + (dx / len) * bend };
}

/** Draw the chart for what the party knows over the world's land: a few draws, quick enough for every opening. */
function compose(view: HTMLCanvasElement, base: ChartBase, zones: Zone[], player: PlayerView) {
  const known = (z: Zone) => player.knownZones.includes(z.id);
  const visited = (z: Zone) => player.visitedZones.includes(z.id);
  view.width = base.land.width;
  view.height = base.land.height;
  const ctx = view.getContext('2d')!;
  ctx.setTransform(view.width / MAP_W, 0, 0, view.height / MAP_H, 0, 0);
  ctx.imageSmoothingEnabled = true;
  ctx.drawImage(base.land, 0, 0, MAP_W, MAP_H);

  // Places heard of but not yet visited: the faded land, cut to their territories.
  const hearsay = new Set(zones.map((z, i) => (known(z) && !visited(z) ? i : -1)).filter((i) => i >= 0));
  if (hearsay.size) {
    const cut = new OffscreenCanvas(view.width, view.height);
    const cc = cut.getContext('2d')!;
    cc.drawImage(base.faded, 0, 0);
    cc.globalCompositeOperation = 'destination-in';
    cc.imageSmoothingEnabled = true;
    cc.drawImage(maskOf(base, (o) => hearsay.has(o)), 0, 0, cut.width, cut.height);
    ctx.drawImage(cut, 0, 0, MAP_W, MAP_H);
  }

  // Roads between places the party knows; walked ones bolder.
  const byId = new Map(zones.map((z) => [z.id, z]));
  ctx.lineCap = 'round';
  for (const z of zones)
    for (const l of z.links) {
      const o = byId.get(l);
      if (!o || z.id > l || !(known(z) && known(o))) continue;
      const a = pos(z), b = pos(o), { cx, cy } = roadPath(a, b, z.id + l);
      const walked = visited(z) && visited(o);
      ctx.beginPath();
      ctx.moveTo(a.x, a.y);
      ctx.quadraticCurveTo(cx, cy, b.x, b.y);
      ctx.strokeStyle = 'rgba(10, 8, 6, 0.75)';
      ctx.lineWidth = walked ? 5 : 3;
      ctx.setLineDash([]);
      ctx.stroke();
      ctx.strokeStyle = walked ? 'rgba(232, 208, 160, 0.85)' : 'rgba(232, 208, 160, 0.35)';
      ctx.lineWidth = walked ? 1.6 : 1.2;
      ctx.setLineDash(walked ? [7, 5] : [2, 6]);
      ctx.stroke();
    }
  ctx.setLineDash([]);

  // Fog over places not yet heard of: soft clouds, so the shape of the world is a promise, not a spoiler. Drawn small
  // and scaled up, which softens it like a wide blur.
  const hidden = new Set(zones.map((z, i) => (known(z) ? -1 : i)).filter((i) => i >= 0));
  if (hidden.size) {
    const fd = new ImageData(base.gw, base.gh);
    for (let k = 0; k < base.owner.length; k++) {
      if (!hidden.has(base.owner[k]!)) continue;
      const v = 10 + fbm((k % base.gw) / 14, Math.floor(k / base.gw) / 14, 777) * 16;
      fd.data.set([v, v, v, 235], k * 4);
    }
    const fog = new OffscreenCanvas(base.gw, base.gh);
    fog.getContext('2d')!.putImageData(fd, 0, 0);
    const soft = new OffscreenCanvas(Math.ceil(base.gw / 5), Math.ceil(base.gh / 5));
    const sc = soft.getContext('2d')!;
    sc.imageSmoothingEnabled = true;
    sc.imageSmoothingQuality = 'high';
    sc.drawImage(fog, 0, 0, soft.width, soft.height);
    ctx.drawImage(soft, 0, 0, MAP_W, MAP_H);
    ctx.drawImage(soft, 0, 0, MAP_W, MAP_H);
  }

  // Vignette and frame.
  const vig = ctx.createRadialGradient(MAP_W / 2, MAP_H / 2, MAP_H * 0.35, MAP_W / 2, MAP_H / 2, MAP_W * 0.62);
  vig.addColorStop(0, 'rgba(0,0,0,0)');
  vig.addColorStop(1, 'rgba(0,0,0,0.55)');
  ctx.fillStyle = vig;
  ctx.fillRect(0, 0, MAP_W, MAP_H);
  ctx.lineWidth = 1;
  ctx.strokeStyle = 'rgba(220, 200, 160, 0.28)';
  ctx.strokeRect(8.5, 8.5, MAP_W - 17, MAP_H - 17);
  ctx.strokeStyle = 'rgba(220, 200, 160, 0.12)';
  ctx.strokeRect(13.5, 13.5, MAP_W - 27, MAP_H - 27);
}

// ---------------------------------------------------------------------------- markers

function Glyph({ kind, size }: { kind: Zone['kind']; size: number }) {
  const s = size;
  if (kind === 'town')
    return <path d={`M${-s} ${s * 0.7} V${-s * 0.1} L0 ${-s} L${s} ${-s * 0.1} V${s * 0.7} Z M${-s * 0.3} ${s * 0.7} V${s * 0.15} H${s * 0.3} V${s * 0.7}`} />;
  if (kind === 'dungeon')
    return <path d={`M${-s} ${s * 0.8} V${-s * 0.1} A${s} ${s} 0 0 1 ${s} ${-s * 0.1} V${s * 0.8} H${s * 0.45} V${s * 0.05} A${s * 0.45} ${s * 0.45} 0 0 0 ${-s * 0.45} ${s * 0.05} V${s * 0.8} Z`} />;
  return <path d={`M${-s * 1.1} ${s * 0.75} L${-s * 0.35} ${-s * 0.55} L${s * 0.05} ${s * 0.1} L${s * 0.45} ${-s * 0.85} L${s * 1.15} ${s * 0.75} Z`} />;
}

export function WorldMapView({ world, player, here, canTravelTo, onTravel, terms }: {
  world: ClientWorld;
  player: PlayerView;
  here: string;
  canTravelTo: (zoneId: string) => boolean;
  onTravel: (zoneId: string) => void;
  terms: { town: string; dungeon: string; wilderness: string; level: string };
}) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const zones = world.zones;
  const [hover, setHover] = useState<Zone | null>(null);
  // A finger has no hover: the first tap on a place shows its card, a second tap on it travels.
  const [picked, setPicked] = useState<string | null>(null);
  const press = (z: Zone) => {
    if (isTouch() && picked !== z.id) return (setPicked(z.id), setHover(z));
    if (canTravelTo(z.id)) onTravel(z.id);
  };
  const knownKey = `${player.knownZones.join(',')}|${player.visitedZones.join(',')}`;
  useEffect(() => {
    let live = true;
    void landOf(world).then((base) => live && base && canvas.current && compose(canvas.current, base, zones, player));
    return () => void (live = false);
    // Drawn again only when what the party knows changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [world, zones, knownKey]);
  // Where the map is wider than its window (a phone), it opens centered on where the party is.
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => {
    const el = box.current, scroller = el?.parentElement, z = zones.find((q) => q.id === here);
    if (!el || !scroller || !z || scroller.scrollWidth <= scroller.clientWidth) return;
    const k = el.clientWidth / MAP_W, p = pos(z);
    scroller.scrollTo({ left: p.x * k - scroller.clientWidth / 2, top: p.y * k - scroller.clientHeight / 2 });
  }, [here, zones]);
  const known = zones.filter((z) => player.knownZones.includes(z.id));
  const levels = (z: Zone) => `${terms.level} ${z.levelRange[0]}${z.levelRange[1] !== z.levelRange[0] ? `–${z.levelRange[1]}` : ''}`;
  return (
    <div className="wmap" ref={box} style={{ maxWidth: MAP_W, aspectRatio: `${MAP_W} / ${MAP_H}` }} onClick={(e) => (e.target as Element).tagName === 'svg' && (setPicked(null), setHover(null))}>
      <canvas ref={canvas} />
      <svg viewBox={`0 0 ${MAP_W} ${MAP_H}`} className="wmap-marks">
        {known.map((z) => {
          const p = pos(z);
          const visited = player.visitedZones.includes(z.id);
          const isHere = z.id === here;
          const wp = z.kind === 'town' && player.waypoints.some((w) => w.zoneId === z.id);
          const travel = canTravelTo(z.id);
          const size = z.kind === 'town' ? 8 : 7;
          return (
            <g key={z.id} transform={`translate(${p.x} ${p.y})`} className={`wmark ${visited ? 'visited' : ''} ${travel ? 'travel' : ''}`}
              onMouseEnter={() => !isTouch() && setHover(z)} onMouseLeave={() => !isTouch() && setHover(null)} onClick={() => press(z)}>
              <circle r={18} fill="transparent" />
              {isHere && <circle r={15} className="here-ring" />}
              {wp && <circle r={12.5} className="wp-ring" />}
              <g className={`glyph g-${z.kind}`}><Glyph kind={z.kind} size={size} /></g>
              <text y={size + 17} textAnchor="middle" className="wname">{z.name}</text>
              <text y={size + 30} textAnchor="middle" className="wsub">{levels(z)}</text>
            </g>
          );
        })}
      </svg>
      {hover && (
        <div className="wmap-card" style={{ left: `${(Math.min(MAP_W - 260, pos(hover).x + 22) / MAP_W) * 100}%`, top: `${(Math.max(12, Math.min(MAP_H - 120, pos(hover).y - 30)) / MAP_H) * 100}%` }}>
          <div className="wc-name">{hover.name}</div>
          <div className="wc-sub">{hover.kind === 'town' ? terms.town : hover.kind === 'dungeon' ? terms.dungeon : terms.wilderness} · {levels(hover)}{hover.id === here ? ' · you are here' : ''}</div>
          {player.visitedZones.includes(hover.id) ? <div className="wc-desc">{hover.description}</div> : <div className="wc-desc dim">Known only by word of mouth.</div>}
          {canTravelTo(hover.id) && <div className="wc-act">{isTouch() ? 'Tap again to travel' : 'Click to travel'}</div>}
        </div>
      )}
    </div>
  );
}
