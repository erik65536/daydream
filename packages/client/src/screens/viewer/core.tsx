/**
 * The world viewer's shared pieces: the world in context, links between its things, pictures, sound, and a plain
 * rendering of any field the viewer does not lay out itself (so data added to worlds later still shows).
 */
import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';
import type { AssetRecord, WorldDefinition } from '@daydream/shared';
import { assetUrl, type WorldView } from '../../api';

export type Section = 'overview' | 'build' | 'rules' | 'story' | 'places' | 'people' | 'creatures' | 'art' | 'sound';

interface Viewing {
  v: WorldView;
  w: WorldDefinition;
}
export const ViewCtx = createContext<Viewing>(null as never);
export const useView = () => useContext(ViewCtx);

/** The address of a section, a thing in it, and a part of that thing to scroll to. */
export const href = (w: { id: string }, section: Section, id?: string, part?: string) =>
  `#/world/${w.id}/view/${section}${id ? `/${encodeURIComponent(id)}` : ''}${part ? `/${encodeURIComponent(part)}` : ''}`;

/** A link to another thing of the world, by its name. */
export function Ref({ to, id, part, children, className = '' }: { to: Section; id?: string; part?: string; children: ReactNode; className?: string }) {
  const { w } = useView();
  return <a className={`vw-ref ${className}`} href={href(w, to, id, part)}>{children}</a>;
}

// ------------------------------------------------------------------------------------ names of things

export function useNames() {
  const { w } = useView();
  return {
    zone: (id?: string) => w.zones.find((z) => z.id === id)?.name ?? id ?? '',
    npc: (id?: string) => w.npcs.find((n) => n.id === id)?.name ?? w.bosses.find((b) => b.id === id)?.name ?? id ?? '',
    quest: (id?: string) => w.quests.find((q) => q.id === id)?.title ?? id ?? '',
    family: (id?: string) => w.families.find((f) => f.id === id)?.name ?? id ?? '',
    cls: (id?: string) => w.ruleset?.classes.find((c) => c.id === id)?.name ?? id ?? '',
    item: (id: string) => w.uniqueItems[id]?.name ?? w.ruleset?.items.find((b) => b.id === id)?.name ?? (id.startsWith('slot:') ? `a piece of ${id.split(':')[1]} gear` : id),
  };
}

/** A link to whichever person, boss, place, quest, family, or item an id names. */
export function Thing({ id }: { id: string }) {
  const { w } = useView();
  const n = useNames();
  if (w.npcs.some((x) => x.id === id)) return <Ref to="people" id={id}>{n.npc(id)}</Ref>;
  if (w.bosses.some((x) => x.id === id)) return <Ref to="creatures" id={id}>{n.npc(id)}</Ref>;
  if (w.zones.some((x) => x.id === id)) return <Ref to="places" id={id}>{n.zone(id)}</Ref>;
  if (w.quests.some((x) => x.id === id)) return <Ref to="story" id={id}>{n.quest(id)}</Ref>;
  if (w.families.some((x) => x.id === id)) return <Ref to="creatures" id={id}>{n.family(id)}</Ref>;
  if (w.uniqueItems[id] || w.ruleset?.items.some((b) => b.id === id)) return <Ref to="rules" id="items" part={id}>{n.item(id)}</Ref>;
  return <>{id}</>;
}

// ------------------------------------------------------------------------------------ pictures

/** An asset's painted file, if it has one. */
export const fileOf = (w: WorldDefinition, key?: string): string | undefined => {
  const a = key ? w.assets[key] : undefined;
  return a?.status === 'ok' && a.file ? a.file : undefined;
};

/** An asset's picture URL, at a thumbnail width or whole. */
export function picture(w: WorldDefinition, key: string | undefined, width?: 256 | 512): string | undefined {
  const f = fileOf(w, key);
  if (!f) return undefined;
  return `${assetUrl(w.id, f)}${width && /\.(png|webp)$/.test(f) ? `?w=${width}` : ''}`;
}

/** A picture of an asset, framed; opens whole in the lightbox. */
export function Pic({ k, size = 96, width = 256, cover, label }: { k?: string; size?: number; width?: 256 | 512; cover?: boolean; label?: string }) {
  const { w } = useView();
  const src = picture(w, k, width);
  const rec = k ? w.assets[k] : undefined;
  return (
    <button className={`vw-pic ${cover ? 'cover' : ''}`} style={{ width: size, height: size }} disabled={!src} onClick={() => k && openLightbox(k)} aria-label={label ?? (k ? `Open ${k}` : 'No picture')}>
      {src ? <img src={src} alt="" loading="lazy" /> : <span className="tiny dim">{rec?.status === 'failed' ? 'failed' : 'no picture'}</span>}
    </button>
  );
}

// ------------------------------------------------------------------------------------ the lightbox

let showLightbox: (k: string | null) => void = () => {};
const openLightbox = (k: string) => showLightbox(k);

/** One picture whole, with everything about how it was made. */
export function Lightbox() {
  const { w, v } = useView();
  const [k, setK] = useState<string | null>(null);
  useEffect(() => {
    showLightbox = setK;
    return () => void (showLightbox = () => {});
  }, []);
  useEffect(() => {
    if (!k) return;
    const key = (e: KeyboardEvent) => e.key === 'Escape' && setK(null);
    addEventListener('keydown', key);
    return () => removeEventListener('keydown', key);
  }, [k]);
  if (!k) return null;
  const rec = w.assets[k];
  const src = picture(w, k);
  // At the screen's root, above its top bar (the page itself is a layer beneath it).
  return createPortal(
    <div className="vw-lightbox" role="dialog" aria-label={k} onClick={() => setK(null)}>
      <div className="vw-lb-body panel" onClick={(e) => e.stopPropagation()}>
        <div className={`vw-lb-img ${rec?.kind === 'texture' ? 'cover' : ''}`}>{src ? <img src={src} alt="" /> : <span className="dim">Not painted</span>}</div>
        <div className="vw-lb-info">
          <div className="row">
            <code className="small grow">{k}</code>
            <button className="btn sm ghost" onClick={() => setK(null)} aria-label="Close">Close</button>
          </div>
          {rec && <AssetFacts rec={rec} />}
          {rec?.anim && v.motion[k] && <div className="tiny dim">Animation: {v.motion[k]!.state}{v.motion[k]!.error ? ` (${v.motion[k]!.error})` : ''}</div>}
        </div>
      </div>
    </div>,
    document.querySelector('.m-root') ?? document.body,
  );
}

export function AssetFacts({ rec }: { rec: AssetRecord }) {
  return (
    <div className="col" style={{ gap: 8 }}>
      <div className="row wrap" style={{ gap: 6 }}>
        <span className="badge">{rec.kind}</span>
        <span className={`badge ${rec.status === 'ok' ? 'gray' : 'red'}`}>{rec.status}</span>
        {rec.score !== undefined && <span className={`badge ${rec.score >= 6 ? 'gray' : 'red'}`}>art check {rec.score.toFixed(1)}</span>}
        {rec.attempts !== undefined && <span className="badge gray">{rec.attempts} {rec.attempts === 1 ? 'try' : 'tries'}</span>}
        {rec.width && rec.height && <span className="badge gray">{rec.width} × {rec.height}</span>}
        {rec.view && <span className="badge gray">{rec.view} view</span>}
        {rec.backdrop && <span className="badge gray">{rec.backdrop} backdrop</span>}
      </div>
      {rec.error && <div className="small bad">{rec.error}</div>}
      <Field label="Brief">{rec.prompt}</Field>
      {rec.imagePrompt && <Field label="Image prompt">{rec.imagePrompt}</Field>}
    </div>
  );
}

// ------------------------------------------------------------------------------------ sound

/** One sound at a time across the viewer: starting another stops the last. */
let playing: { audio: HTMLAudioElement; stop: () => void } | null = null;

/** A play button for a sound, or for several played in turn; `then` loops after them (a music loop after its intro). */
export function Play({ src, label, then }: { src: string | string[]; label?: string; then?: string }) {
  const [on, setOn] = useState(false);
  const mine = useRef<HTMLAudioElement | null>(null);
  // Leaving the page stops its sound.
  useEffect(() => () => void (playing && playing.audio === mine.current && playing.stop()), []);
  const toggle = () => {
    if (on) return playing?.stop();
    playing?.stop();
    const queue = [...(Array.isArray(src) ? src : [src]), ...(then ? [then] : [])];
    const audio = new Audio(queue.shift());
    mine.current = audio;
    const stop = () => {
      audio.pause();
      setOn(false);
      if (playing?.audio === audio) playing = null;
    };
    audio.onended = () => {
      const next = queue.shift();
      if (!next) return stop();
      audio.src = next;
      audio.loop = !!then && !queue.length;
      void audio.play().catch(stop);
    };
    audio.onerror = stop;
    playing = { audio, stop };
    setOn(true);
    void audio.play().catch(stop);
  };
  return (
    <button className={`vw-play ${on ? 'on' : ''}`} onClick={toggle} aria-label={`${on ? 'Stop' : 'Play'}${label ? ` ${label}` : ''}`} title={label}>
      <span aria-hidden>{on ? '■' : '▶'}</span>
      {label && <span className="vw-play-label">{label}</span>}
    </button>
  );
}

const plainWords = (s: string) => s.toLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();

/** A text as its speaker says it: the lines spoken for it at build time, played in turn (nothing when none were). */
export function Said({ speaker, text }: { speaker: string; text?: string }) {
  const { w, v } = useView();
  if (!text) return null;
  const all = plainWords(text);
  const lines = v.spoken.filter((l) => l.speakerId === speaker && all.includes(plainWords(l.text)));
  if (!lines.length) return null;
  lines.sort((a, b) => all.indexOf(plainWords(a.text)) - all.indexOf(plainWords(b.text)));
  return <Play src={lines.map((l) => speechUrl(w, l.file))} label="hear it" />;
}

/** A world sound's takes, each playable (a loop with its intro first). */
export function SoundTakes({ k }: { k: string }) {
  const { w } = useView();
  const s = w.sounds?.[k];
  if (!s?.files.length) return <span className="tiny dim">none</span>;
  const url = (f: string) => `/api/worlds/${w.id}/sounds/${f}`;
  return (
    <span className="row wrap" style={{ gap: 4 }}>
      {s.files.map((f, i) => <Play key={f} src={url(s.intro && i === 0 ? s.intro : f)} then={s.intro && i === 0 ? url(f) : undefined} label={s.files.length > 1 ? `take ${i + 1}` : undefined} />)}
    </span>
  );
}

const voiceUrl = (w: { id: string }, speaker: string) => `/api/admin/worlds/${w.id}/voices/${speaker}.wav`;
const speechUrl = (w: { id: string }, file: string) => `/api/admin/worlds/${w.id}/speech/${file}`;

/** A speaker's voice: their reference clip and every line spoken for them at build time. */
export function Voice({ speaker, description }: { speaker: string; description?: string }) {
  const { w, v } = useView();
  const lines = v.spoken.filter((l) => l.speakerId === speaker);
  const clip = v.voiceClips.includes(speaker);
  return (
    <div className="col" style={{ gap: 6 }}>
      <div className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
        {clip ? <Play src={voiceUrl(w, speaker)} label="voice" /> : <span className="badge gray">no voice made</span>}
        {description && <div className="small muted grow">{description}</div>}
      </div>
      {lines.length > 0 && (
        <details className="vw-fold">
          <summary>{lines.length} {lines.length === 1 ? 'line' : 'lines'} spoken before play</summary>
          <div className="col" style={{ gap: 4, marginTop: 6 }}>
            {lines.map((l) => (
              <div key={l.file} className="row" style={{ gap: 8, alignItems: 'flex-start' }}>
                <Play src={speechUrl(w, l.file)} />
                <span className="small">{l.text}</span>
              </div>
            ))}
          </div>
        </details>
      )}
    </div>
  );
}

// ------------------------------------------------------------------------------------ layout

/** A labeled piece of text; nothing when it is empty. */
export function Field({ label, children, wide }: { label: string; children: ReactNode; wide?: boolean }) {
  if (children === undefined || children === null || children === '' || (Array.isArray(children) && !children.length)) return null;
  return (
    <div className={`vw-field ${wide ? 'wide' : ''}`}>
      <div className="label">{label}</div>
      <div className="vw-value">{children}</div>
    </div>
  );
}

/** A list of short texts as bullets; nothing when empty. */
export function Bullets({ items }: { items: ReactNode[] | undefined }) {
  if (!items?.length) return null;
  return <ul className="vw-bullets">{items.map((x, i) => <li key={i}>{x}</li>)}</ul>;
}

/** A heading inside a detail. */
export const Sub = ({ children, aside }: { children: ReactNode; aside?: ReactNode }) => (
  <div className="vw-sub">
    <h3>{children}</h3>
    {aside}
  </div>
);

/** Badges in a row. */
export const Tags = ({ items }: { items: (ReactNode | false | undefined | null)[] }) => <div className="row wrap" style={{ gap: 6 }}>{items.filter(Boolean).map((x, i) => <span key={i} className="badge gray">{x}</span>)}</div>;

/** "someKey" as "Some key". */
const words = (k: string) => k.replace(/([a-z])([A-Z])/g, '$1 $2').replace(/_/g, ' ').replace(/^./, (c) => c.toUpperCase());

/** Any value, plainly: texts, numbers, lists, and nested objects. */
export function Plain({ value }: { value: unknown }): ReactNode {
  if (value === null || value === undefined || value === '') return <span className="dim">none</span>;
  if (typeof value === 'boolean') return value ? 'yes' : 'no';
  if (typeof value === 'number') return Number.isInteger(value) ? value : value.toFixed(3);
  if (typeof value === 'string') return /^#[0-9a-f]{6}$/i.test(value) ? <span><span className="swatch" style={{ background: value }} />{value}</span> : value;
  if (Array.isArray(value)) {
    if (!value.length) return <span className="dim">none</span>;
    if (value.every((x) => typeof x !== 'object' || x === null)) return <Bullets items={value.map((x, i) => <Plain key={i} value={x} />)} />;
    return <div className="col" style={{ gap: 6 }}>{value.map((x, i) => <div key={i} className="vw-plain-card"><Plain value={x} /></div>)}</div>;
  }
  return (
    <div className="vw-plain">
      {Object.entries(value as Record<string, unknown>).map(([k, x]) => (
        <div key={k} className="vw-plain-row">
          <span className="label">{words(k)}</span>
          <span><Plain value={x} /></span>
        </div>
      ))}
    </div>
  );
}

/** The fields of a thing that its page does not lay out (data added to worlds later), and its raw data. */
export function Rest({ obj, known }: { obj: object; known: string[] }) {
  const rest = Object.entries(obj).filter(([k, x]) => !known.includes(k) && x !== undefined);
  return (
    <>
      {rest.length > 0 && (
        <div className="col" style={{ gap: 8 }}>
          {rest.map(([k, x]) => <Field key={k} label={words(k)}><Plain value={x} /></Field>)}
        </div>
      )}
      <details className="vw-fold vw-raw">
        <summary>Raw data</summary>
        <pre>{JSON.stringify(obj, null, 2)}</pre>
      </details>
    </>
  );
}

/** Whether the screen is wide enough for a list beside its detail. */
function useWide(): boolean {
  const q = '(min-width: 900px)';
  const [wide, setWide] = useState(() => matchMedia(q).matches);
  useEffect(() => {
    const m = matchMedia(q);
    const on = () => setWide(m.matches);
    m.addEventListener('change', on);
    return () => m.removeEventListener('change', on);
  }, []);
  return wide;
}

export interface ListEntry {
  id: string;
  title: ReactNode;
  sub?: ReactNode;
  pic?: string;
  badge?: ReactNode;
  /** A heading above this entry (a group starts). */
  group?: string;
}

/**
 * A list beside the chosen thing. On a phone the list shows until a thing is chosen, then the thing alone, with a
 * way back to the list.
 */
export function Split({ section, entries, sel, children, filter }: { section: Section; entries: ListEntry[]; sel?: string; children: ReactNode; filter?: ReactNode }) {
  const { w } = useView();
  const wide = useWide();
  const open = !!sel;
  return (
    <div className={`vw-split ${open ? 'open' : ''}`}>
      {(wide || !open) && (
        <nav className="vw-list" aria-label="List">
          {filter}
          {entries.map((e) => (
            <div key={e.id}>
              {e.group && <div className="vw-group label">{e.group}</div>}
              <a className={`vw-item ${e.id === sel ? 'on' : ''}`} href={href(w, section, e.id)} aria-current={e.id === sel ? 'true' : undefined}>
                {e.pic !== undefined && <span className="vw-item-pic">{e.pic ? <img src={e.pic} alt="" loading="lazy" /> : null}</span>}
                <span className="grow">
                  <span className="vw-item-title">{e.title}</span>
                  {e.sub && <span className="vw-item-sub">{e.sub}</span>}
                </span>
                {e.badge}
              </a>
            </div>
          ))}
          {!entries.length && <div className="small dim" style={{ padding: 8 }}>Nothing here.</div>}
        </nav>
      )}
      {(wide || open) && (
        <div className="vw-detail">
          {!wide && <a className="vw-back" href={href(w, section)}>‹ All</a>}
          {children}
        </div>
      )}
    </div>
  );
}

/** Scroll a part of the page into view and mark it, when the address names one. */
export function useScrollTo(part?: string) {
  useEffect(() => {
    if (!part) return;
    let t = 0;
    // A frame later: the page scrolls to its top on every change of address (MoonScreen), after this has run.
    const f = requestAnimationFrame(() => {
      const el = document.getElementById(`vw-${part}`);
      if (!el) return;
      el.scrollIntoView({ block: 'center' });
      el.classList.add('vw-flash');
      t = window.setTimeout(() => el.classList.remove('vw-flash'), 1600);
    });
    return () => (cancelAnimationFrame(f), clearTimeout(t));
  }, [part]);
}

// ------------------------------------------------------------------------------------ numbers

export { usd } from '../../ui/format';
export const minutes = (ms = 0) => (ms < 60_000 ? `${Math.round(ms / 1000)} s` : ms < 3_600_000 ? `${(ms / 60_000).toFixed(1)} min` : `${(ms / 3_600_000).toFixed(2)} h`);
export const thousands = (n = 0) => (n >= 1e6 ? `${(n / 1e6).toFixed(2)} M` : n >= 1e4 ? `${Math.round(n / 1e3)} k` : n.toLocaleString('en-US'));
export const date = (t: number) => new Date(t).toLocaleString('en-US', { dateStyle: 'medium', timeStyle: 'short' });
