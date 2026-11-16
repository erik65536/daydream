/**
 * The world viewer (administrators only): everything a world holds, read-only. A sidebar of sections (chips on a
 * phone) and a search over every thing in the world; the address names the section, the thing, and a part of it, so
 * links between things, Back, and shared links all work. The data is one request (server: worldview.ts).
 */
import { useEffect, useMemo, useRef, useState } from 'react';
import { api, type Me, type WorldView } from '../../api';
import { ToolPage } from '../../ui/night';
import { navigate } from '../../App';
import { DeleteWorld } from '../WorldPage';
import { href, Lightbox, useView, ViewCtx, type Section } from './core';
import { search, searchIndex } from './search';
import { Overview } from './overview';
import { Build } from './build';
import { Rules } from './rules';
import { Story } from './story';
import { Places } from './places';
import { People } from './people';
import { Creatures } from './creatures';
import { Art } from './art';
import { Sound } from './sound';
import './viewer.css';

const SECTIONS: { id: Section; label: string; count?: (v: WorldView) => number }[] = [
  { id: 'overview', label: 'Overview' },
  { id: 'build', label: 'Build', count: (v) => v.records.length },
  { id: 'rules', label: 'Rules' },
  { id: 'story', label: 'Story', count: (v) => v.world.quests.length },
  { id: 'places', label: 'Places', count: (v) => v.world.zones.length },
  { id: 'people', label: 'People', count: (v) => v.world.npcs.length },
  { id: 'creatures', label: 'Creatures', count: (v) => v.world.families.reduce((n, f) => n + f.members.length, 0) + v.world.bosses.length },
  { id: 'art', label: 'Pictures', count: (v) => Object.values(v.world.assets).filter((a) => a.kind !== 'sheet').length },
  { id: 'sound', label: 'Sound', count: (v) => Object.keys(v.world.sounds ?? {}).length + v.voiceClips.length },
];

export function Viewer({ me, worldId, path }: { me: Me; worldId: string; path: string[] }) {
  const [v, setV] = useState<WorldView | null>(null);
  const [error, setError] = useState('');
  useEffect(() => {
    api.worldView(worldId).then(setV, (e) => setError((e as Error).message));
  }, [worldId]);
  const section = (SECTIONS.some((s) => s.id === path[0]) ? path[0] : 'overview') as Section;
  const [id, part] = [path[1], path[2]].map((x) => (x ? decodeURIComponent(x) : undefined));
  // On a phone the sections are a row of chips: the current one is brought into view.
  const chips = useRef<HTMLElement>(null);
  useEffect(() => {
    chips.current?.querySelector('.on')?.scrollIntoView({ inline: 'center', block: 'nearest' });
  }, [section, !!v]);

  if (!v) return <ToolPage me={me} back={{ label: 'World', to: `#/world/${worldId}` }}>{error ? <div className="error-text">{error}</div> : <div className="spinner" />}</ToolPage>;
  const w = v.world;
  return (
    <ViewCtx.Provider value={{ v, w }}>
      <ToolPage me={me} back={{ label: w.concept.title, to: `#/world/${w.id}` }} className="vw">
        <header className="vw-head">
          <div className="grow">
            <div className="label">World viewer</div>
            <h1 className="h1">{w.concept.title}</h1>
          </div>
          <DeleteWorld worldId={w.id} />
        </header>
        <div className="vw-shell">
          <aside className="vw-side">
            <Search />
            <nav ref={chips} className="vw-sections" aria-label="Sections">
              {SECTIONS.map((s) => (
                <a key={s.id} href={href(w, s.id)} className={`vw-section ${section === s.id ? 'on' : ''}`} aria-current={section === s.id ? 'page' : undefined}>
                  <span>{s.label}</span>
                  {s.count && <span className="vw-count">{s.count(v)}</span>}
                </a>
              ))}
            </nav>
          </aside>
          <main className="vw-main">
            {section === 'overview' && <Overview />}
            {section === 'build' && <Build sel={id} />}
            {section === 'rules' && <Rules sub={id} part={part} />}
            {section === 'story' && <Story sel={id} />}
            {section === 'places' && <Places sel={id} part={part} />}
            {section === 'people' && <People sel={id} />}
            {section === 'creatures' && <Creatures sel={id} part={part} />}
            {section === 'art' && <Art sel={id} />}
            {section === 'sound' && <Sound sel={id} />}
          </main>
        </div>
        <Lightbox />
      </ToolPage>
    </ViewCtx.Provider>
  );
}

/** A search over everything in the world; the arrow keys move through what it finds, Enter opens it. */
function Search() {
  const { w } = useView();
  const index = useMemo(() => searchIndex(w), [w]);
  const [q, setQ] = useState('');
  const [at, setAt] = useState(0);
  const box = useRef<HTMLDivElement>(null);
  const hits = useMemo(() => search(index, q), [index, q]);
  useEffect(() => setAt(0), [q]);
  // A click elsewhere closes the results.
  useEffect(() => {
    if (!q) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && setQ('');
    addEventListener('pointerdown', away);
    return () => removeEventListener('pointerdown', away);
  }, [q]);
  const go = (i: number) => {
    const f = hits[i];
    if (!f) return;
    navigate(href(w, f.section, f.id, f.part));
    setQ('');
  };
  return (
    <div className="vw-search" ref={box}>
      <input
        className="input"
        type="search"
        placeholder="Search the world"
        aria-label="Search the world"
        value={q}
        onChange={(e) => setQ(e.target.value)}
        onKeyDown={(e) => {
          if (e.key === 'ArrowDown') (e.preventDefault(), setAt((a) => Math.min(hits.length - 1, a + 1)));
          else if (e.key === 'ArrowUp') (e.preventDefault(), setAt((a) => Math.max(0, a - 1)));
          else if (e.key === 'Enter') go(at);
          else if (e.key === 'Escape') setQ('');
        }}
      />
      {q.trim() && (
        <div className="vw-hits panel" role="listbox">
          {hits.map((f, i) => (
            <a key={`${f.section}/${f.id}/${f.part}/${i}`} role="option" aria-selected={i === at} className={`vw-hit ${i === at ? 'on' : ''}`} href={href(w, f.section, f.id, f.part)} onClick={() => setQ('')}>
              <span className="vw-hit-title">{f.title}</span>
              <span className="vw-hit-kind">{f.kind}</span>
            </a>
          ))}
          {!hits.length && <div className="small dim" style={{ padding: '8px 10px' }}>Nothing matches.</div>}
        </div>
      )}
    </div>
  );
}
