/**
 * The places: each one's painted map, to zoom and pan with a mouse, a finger, or the keys, with where people can walk
 * and everything placed in it marked; and all the rest of it: its look and sounds, how it was painted, its lore,
 * buildings, people, creatures, things, and ways out.
 */
import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { NAV_CELL, Nav, groundToPicture, type FeatureDef, type SpawnDef, type ZoneDef } from '@daydream/shared';
import { Bullets, Field, Pic, Rest, Ref, SoundTakes, Split, Tags, Thing, picture, useView, type ListEntry } from './core';

const KINDS = [['town', 'Towns'], ['wilderness', 'Wilds'], ['dungeon', 'Dungeons']] as const;

export function Places({ sel, part }: { sel?: string; part?: string }) {
  const { w } = useView();
  const entries: ListEntry[] = KINDS.flatMap(([kind, label]) =>
    w.zones.filter((z) => z.kind === kind).sort((a, b) => a.levelRange[0] - b.levelRange[0]).map((z, i) => ({
      id: z.id,
      title: z.name,
      sub: `level ${z.levelRange.join('–')} · ${z.tiles.join(' × ')} tiles`,
      pic: z.painting ? picture(w, z.painting.image, 256) ?? '' : '',
      group: i === 0 ? label : undefined,
    })),
  );
  const z = w.zones.find((x) => x.id === (sel ?? entries[0]?.id));
  return (
    <Split section="places" entries={entries} sel={sel}>
      {z && <Place key={z.id} z={z} part={part} />}
    </Split>
  );
}

function Place({ z, part }: { z: ZoneDef; part?: string }) {
  const { w } = useView();
  const people = w.npcs.filter((x) => x.zoneId === z.id);
  const quests = w.quests.filter((q) => q.zoneId === z.id || q.objectives.some((o) => o.zoneId === z.id));
  const groups = [...new Set(z.spawns.map((s) => s.groupId))];
  const member = (familyId: string, i: number) => w.families.find((f) => f.id === familyId)?.members[i]?.name ?? 'a creature';
  return (
    <div className="col" style={{ gap: 14 }}>
      <div>
        <h2 className="h2">{z.name}</h2>
        <Tags items={[z.kind, `level ${z.levelRange.join('–')}`, `${z.tiles.join(' × ')} tiles`, z.painting && `${Math.round(z.width)} × ${Math.round(z.height)} m`, z.indoor && 'indoors', z.id === w.startZoneId && 'where it starts', `region ${z.regionIndex + 1}`]} />
      </div>
      <p className="vw-prose">{z.description}</p>
      <PlaceMap z={z} focus={part} />
      <div className="vw-grid2">
        <Field label="Hidden lore (for the people here)">{z.lore}</Field>
        <Field label="Sounds">
          <div className="col" style={{ gap: 4 }}>
            <span className="row" style={{ gap: 8 }}><span className="small dim" style={{ width: 70 }}>ambience</span><SoundTakes k={`ambience:${z.id}`} /></span>
            <span className="row" style={{ gap: 8 }}><span className="small dim" style={{ width: 70 }}>arrival</span><SoundTakes k={`place:${z.id}`} /></span>
          </div>
        </Field>
        <Field label="Look">
          <div className="small">
            {z.look.outdoor ? 'Under the open sky' : 'No sky'}, light {Math.round(z.look.ambient * 100)}% <span className="swatch" style={{ background: z.look.lightColor }} />, fog <span className="swatch" style={{ background: z.look.fogColor }} />, weather {z.look.weather}
            {z.look.painted && <> · painted light <span className="swatch" style={{ background: z.look.painted.light }} /> shade <span className="swatch" style={{ background: z.look.painted.shade }} /> {Math.round(z.look.painted.level * 100)}%</>}
          </div>
          {z.look.mist && <div className="row" style={{ gap: 8, marginTop: 6 }}><Pic k={z.look.mist} size={56} label="Mist" /><span className="tiny dim">mist</span></div>}
        </Field>
        <Field label="Ways to">{z.links.map((l, i) => <span key={l}>{i ? ', ' : ''}<Thing id={l} /></span>)}</Field>
        <Field label="Buildings">{z.buildings?.length ? <Bullets items={z.buildings.map((b) => <span key={b.id}><b>{b.name}</b>: {b.purpose} (kept by <Thing id={b.npcId} />)</span>)} /> : undefined}</Field>
        <Field label="People here">
          {people.length ? <div className="vw-faces">{people.map((p) => <Ref key={p.id} to="people" id={p.id} className="vw-face"><img src={picture(w, p.asset, 256)} alt="" /><span>{p.name}</span></Ref>)}</div> : undefined}
        </Field>
        {(groups.length > 0 || z.familyIds.length > 0) && (
          <Field label="Creatures here">
            {groups.length ? (
              <Bullets items={groups.map((g) => {
                const ss = z.spawns.filter((s) => s.groupId === g);
                const boss = ss.find((s) => s.bossId)?.bossId;
                return <span key={g}>{boss && <><Thing id={boss} />{' with '}</>}{ss.filter((s) => !s.bossId).map((s) => member(s.familyId, s.member)).join(', ') || 'no one'} <span className="dim">level {Math.min(...ss.map((s) => s.level))}–{Math.max(...ss.map((s) => s.level))}</span></span>;
              })} />
            ) : <span className="small dim">None placed.</span>}
            {z.familyIds.length > 0 && <div className="tiny" style={{ marginTop: 4 }}>Families: {z.familyIds.map((f, i) => <span key={f}>{i ? ', ' : ''}<Thing id={f} /></span>)}</div>}
          </Field>
        )}
        <Field label="Quests here">{quests.length ? <Bullets items={quests.map((q) => <Thing key={q.id} id={q.id} />)} /> : undefined}</Field>
      </div>
      <Field label="How it was painted">{z.design && <div className="col" style={{ gap: 4 }}><div className="small">{z.design.layout}</div><div className="small dim">{z.design.style}</div></div>}</Field>
      <Field label="Things placed here">
        {z.features.length ? (
          <div className="vw-cards">
            {z.features.map((f) => <Feature key={f.id} f={f} />)}
          </div>
        ) : undefined}
      </Field>
      <Rest obj={z} known={['id', 'name', 'kind', 'description', 'regionIndex', 'levelRange', 'look', 'tiles', 'width', 'height', 'painting', 'nav', 'design', 'features', 'spawns', 'indoor', 'mapPos', 'links', 'entry', 'buildings', 'lore', 'familyIds']} />
    </div>
  );
}

const MARK: Record<string, string> = { exit: '#7fd0ff', chest: '#ffd24a', sign: '#e8dcc0', lore: '#c0c0ff', craft_station: '#ffb070', storage: '#d0a0ff', waypoint: '#7fffd4', object: '#ffe28c' };
const FEATURE: Record<string, string> = { exit: 'Way out', chest: 'Chest', sign: 'Sign', lore: 'Writing', craft_station: 'Crafting station', storage: 'Storage', waypoint: 'Waypoint', object: 'Thing' };

/** One thing placed in a place: what it is and what it holds or says. */
function Feature({ f }: { f: FeatureDef }) {
  const { w } = useView();
  const tellers = w.npcs.filter((n) => n.secrets.some((s) => s.leadsTo === f.id));
  const lore = f.loreId ? w.lore.find((l) => l.id === f.loreId) : undefined;
  return (
    <div id={`vw-${f.id}`} className="vw-card">
      <div className="vw-card-title"><span className="swatch round" style={{ background: MARK[f.kind] ?? '#fff' }} />{FEATURE[f.kind] ?? f.kind}{f.name ? `: ${f.name}` : ''}</div>
      {f.targetZoneId && <div className="small">to <Thing id={f.targetZoneId} /></div>}
      {f.text && <div className="small muted">{f.text}</div>}
      {lore && <div className="small"><Ref to="story" id={lore.id}>{lore.title}</Ref></div>}
      {f.items?.length ? <div className="small">holds {f.items.map((i, k) => <span key={k}>{k ? ', ' : ''}<Thing id={i} /></span>)}</div> : null}
      {f.lootTier !== undefined && <div className="tiny dim">loot tier {f.lootTier}</div>}
      {f.hidden && <div className="tiny">A stash, shown once {tellers.length ? tellers.map((t, i) => <span key={t.id}>{i ? ' or ' : ''}<Thing id={t.id} /></span>) : 'someone'} tells of it</div>}
    </div>
  );
}

// ------------------------------------------------------------------------------------ the map

interface Mark {
  id: string;
  x: number;
  y: number;
  color: string;
  pic?: string;
  big?: boolean;
  dashed?: boolean;
  label: string;
  info: ReactNode;
}

interface View {
  x: number;
  y: number;
  s: number;
}

/** The place's painting to zoom and pan, with where people walk and what is placed in it. */
function PlaceMap({ z, focus }: { z: ZoneDef; focus?: string }) {
  const { w } = useView();
  const p = z.painting;
  const box = useRef<HTMLDivElement>(null);
  const [view, setView] = useState<View | null>(null);
  const [walk, setWalk] = useState(false);
  const [marks, setMarks] = useState(true);
  const [picked, setPicked] = useState<string | undefined>(focus);
  const fitted = useRef(true);
  const member = (familyId: string, i: number) => w.families.find((f) => f.id === familyId)?.members[i];

  // Where people can walk (green) and what blocks sight (blue), one pixel a cell, as the game's developer view.
  const walkPlan = useMemo(() => {
    if (!z.nav || !p) return null;
    const nav = new Nav(z.nav);
    const c = document.createElement('canvas');
    [c.width, c.height] = [nav.cols, nav.rows];
    const g = c.getContext('2d')!, img = g.createImageData(nav.cols, nav.rows);
    for (let y = 0; y < nav.rows; y++)
      for (let x = 0; x < nav.cols; x++) {
        const ok = nav.walkableCell(x, y), sight = nav.seeThroughCell(x, y);
        if (!ok && sight) continue;
        img.data.set(ok ? [60, 220, 90, 110] : [60, 110, 255, 110], (y * nav.cols + x) * 4);
      }
    g.putImageData(img, 0, 0);
    const a = groundToPicture(0, 0, p.ox, p.oy), b = groundToPicture(nav.cols * NAV_CELL, nav.rows * NAV_CELL, p.ox, p.oy);
    return { url: c.toDataURL(), left: a.x, top: a.y, width: b.x - a.x, height: b.y - a.y };
  }, [z, p]);

  const all = useMemo((): Mark[] => {
    if (!p) return [];
    // Who a creature stands with: its pack's boss or named foe, or how many they are.
    const packOf = (s: SpawnDef) => {
      const pack = z.spawns.filter((x) => x.groupId === s.groupId);
      const lead = pack.find((x) => x.bossId && x.id !== s.id)?.bossId;
      return lead ? `with ${w.bosses.find((b) => b.id === lead)?.name ?? lead}` : pack.length > 1 ? `one of a pack of ${pack.length}` : 'alone';
    };
    const at = (x: number, y: number) => groundToPicture(x, y, p.ox, p.oy);
    return [
      ...z.features.map((f) => ({ id: f.id, ...at(f.x, f.y), color: MARK[f.kind] ?? '#fff', dashed: f.hidden, label: `${FEATURE[f.kind] ?? f.kind}${f.name ? `: ${f.name}` : ''}`, info: <Feature f={f} /> })),
      ...w.npcs.filter((n) => n.zoneId === z.id).map((n) => ({ id: n.id, ...at(n.x, n.y), color: '#ffffff', pic: picture(w, n.asset, 256), label: `${n.name}, ${n.title}`, info: <div className="small"><Ref to="people" id={n.id}>{n.name}</Ref>, {n.title} <span className="dim">({n.role}{n.wanders ? ', wanders' : ''})</span></div> })),
      ...z.spawns.map((s) => {
        const m = member(s.familyId, s.member);
        const boss = s.bossId ? w.bosses.find((b) => b.id === s.bossId) : undefined;
        return {
          id: s.id, ...at(s.x, s.y), color: boss ? '#ff3a2a' : '#e06a5a', big: !!boss, pic: picture(w, boss && !boss.member ? boss.asset : m?.asset, 256),
          label: `${boss?.name ?? m?.name ?? 'creature'} (level ${s.level})`,
          info: <div className="small">{boss ? <Ref to="creatures" id={boss.id}>{boss.name}</Ref> : <Ref to="creatures" id={s.familyId}>{m?.name ?? 'a creature'}</Ref>}, level {s.level} <span className="dim">{packOf(s)}</span></div>,
        };
      }),
    ];
  }, [w, z, p]);

  const fit = () => {
    const el = box.current;
    if (!el || !p) return;
    const s = Math.min(el.clientWidth / p.width, el.clientHeight / p.height);
    fitted.current = true;
    setView({ s, x: (el.clientWidth - p.width * s) / 2, y: (el.clientHeight - p.height * s) / 2 });
  };
  /** Zoom by a factor about a point of the box. */
  const zoom = (k: number, cx?: number, cy?: number) =>
    setView((v) => {
      const el = box.current;
      if (!v || !el || !p) return v;
      const min = Math.min(el.clientWidth / p.width, el.clientHeight / p.height) * 0.6;
      const s = Math.min(4, Math.max(min, v.s * k));
      const [px, py] = [cx ?? el.clientWidth / 2, cy ?? el.clientHeight / 2];
      fitted.current = false;
      return { s, x: px - ((px - v.x) * s) / v.s, y: py - ((py - v.y) * s) / v.s };
    });
  const pan = (dx: number, dy: number) => {
    fitted.current = false;
    setView((v) => v && { ...v, x: v.x + dx, y: v.y + dy });
  };

  // Fit when the place opens and whenever the box changes size (unless zoomed in by hand); a mark named in the address is centered.
  useEffect(() => {
    fit();
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(() => fitted.current && fit());
    ro.observe(el);
    return () => ro.disconnect();
  }, [z.id]);
  useEffect(() => {
    const m = all.find((x) => x.id === focus);
    const el = box.current;
    if (!m || !el) return;
    setPicked(m.id);
    fitted.current = false;
    const s = Math.max(1, view?.s ?? 1);
    setView({ s, x: el.clientWidth / 2 - m.x * s, y: el.clientHeight / 2 - m.y * s });
  }, [focus, all]);

  // The wheel zooms (a listener that may cancel the page's scroll).
  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const wheel = (e: WheelEvent) => {
      e.preventDefault();
      const r = el.getBoundingClientRect();
      zoom(Math.exp(-e.deltaY * 0.0015), e.clientX - r.left, e.clientY - r.top);
    };
    el.addEventListener('wheel', wheel, { passive: false });
    return () => el.removeEventListener('wheel', wheel);
  }, [z.id]);

  // Dragging pans, two fingers pinch. A press that does not move is a click (on a mark, it picks it).
  const pointers = useRef(new Map<number, { x: number; y: number }>());
  const dragged = useRef(false);
  const onDown = (e: React.PointerEvent) => {
    pointers.current.set(e.pointerId, { x: e.clientX, y: e.clientY });
    if (pointers.current.size === 1) dragged.current = false;
  };
  const onMove = (e: React.PointerEvent) => {
    const ps = pointers.current;
    const was = ps.get(e.pointerId);
    if (!was) return;
    const now = { x: e.clientX, y: e.clientY };
    if (!dragged.current && Math.hypot(now.x - was.x, now.y - was.y) < 5 && ps.size === 1) return;
    if (!dragged.current) {
      dragged.current = true;
      box.current?.setPointerCapture(e.pointerId);
    }
    if (ps.size === 2) {
      const other = [...ps.entries()].find(([id]) => id !== e.pointerId)![1];
      const r = box.current!.getBoundingClientRect();
      const k = Math.hypot(now.x - other.x, now.y - other.y) / Math.max(1, Math.hypot(was.x - other.x, was.y - other.y));
      zoom(k, (now.x + other.x) / 2 - r.left, (now.y + other.y) / 2 - r.top);
      pan((now.x - was.x) / 2, (now.y - was.y) / 2);
    } else pan(now.x - was.x, now.y - was.y);
    ps.set(e.pointerId, now);
  };
  const onUp = (e: React.PointerEvent) => void pointers.current.delete(e.pointerId);

  if (!p) return <div className="small dim">This place has not been painted.</div>;
  const chosen = all.find((m) => m.id === picked);
  return (
    <div className="col" style={{ gap: 8 }}>
      <div
        ref={box}
        className="vw-map"
        style={{ aspectRatio: `${p.width} / ${p.height}` }}
        tabIndex={0}
        aria-label={`Map of ${z.name}: drag or use the arrow keys to move, the wheel, pinch, or + and − to zoom, 0 to fit`}
        onPointerDown={onDown}
        onPointerMove={onMove}
        onPointerUp={onUp}
        onPointerCancel={onUp}
        onClickCapture={(e) => dragged.current && (e.stopPropagation(), e.preventDefault())}
        onKeyDown={(e) => {
          const step = 80;
          const keys: Record<string, () => void> = { ArrowLeft: () => pan(step, 0), ArrowRight: () => pan(-step, 0), ArrowUp: () => pan(0, step), ArrowDown: () => pan(0, -step), '+': () => zoom(1.25), '=': () => zoom(1.25), '-': () => zoom(0.8), '0': fit };
          if (keys[e.key]) (e.preventDefault(), keys[e.key]!());
        }}
      >
        {view && (
          <div className="vw-map-layer" style={{ width: p.width, height: p.height, transform: `translate(${view.x}px, ${view.y}px) scale(${view.s})`, '--inv': 1 / view.s } as React.CSSProperties}>
            <img src={picture(w, p.image)} alt="" draggable={false} />
            {walk && walkPlan && <img className="vw-walk" src={walkPlan.url} alt="" draggable={false} style={{ left: walkPlan.left, top: walkPlan.top, width: walkPlan.width, height: walkPlan.height }} />}
            {marks && all.map((m) => (
              <button
                key={m.id}
                className={`vw-mark ${m.big ? 'big' : ''} ${m.dashed ? 'dashed' : ''} ${picked === m.id ? 'on' : ''}`}
                style={{ left: m.x, top: m.y, '--c': m.color } as React.CSSProperties}
                onClick={() => setPicked(m.id === picked ? undefined : m.id)}
                aria-label={m.label}
                title={m.label}
              >
                {m.pic && <img src={m.pic} alt="" draggable={false} />}
              </button>
            ))}
          </div>
        )}
        <div className="vw-map-tools" onPointerDown={(e) => e.stopPropagation()}>
          <button className="btn sm" onClick={() => zoom(1.4)} aria-label="Zoom in">+</button>
          <button className="btn sm" onClick={() => zoom(1 / 1.4)} aria-label="Zoom out">−</button>
          <button className="btn sm" onClick={fit}>Fit</button>
        </div>
      </div>
      <div className="row wrap" style={{ gap: 14 }}>
        <label className="small row" style={{ gap: 6, cursor: 'pointer' }}><input type="checkbox" checked={marks} onChange={(e) => setMarks(e.target.checked)} /> Marks</label>
        {walkPlan && <label className="small row" style={{ gap: 6, cursor: 'pointer' }} title="Green: people can walk here. Blue: blocks sight."><input type="checkbox" checked={walk} onChange={(e) => setWalk(e.target.checked)} /> Walkable ground</label>}
        <span className="tiny dim grow">{marks ? 'Tap a mark to see who or what stands there.' : ''}</span>
      </div>
      {chosen && <div className="vw-picked panel panel-body">{chosen.info}</div>}
    </div>
  );
}
