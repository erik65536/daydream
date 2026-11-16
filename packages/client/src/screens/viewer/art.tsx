/** Every picture of the world, by kind: how each was asked for, how it scored, and what it is of. */
import { useMemo, useState } from 'react';
import type { AssetRecord } from '@daydream/shared';
import { ClipPreview } from '../../ui/clips';
import { AssetFacts, Ref, href, picture, useView } from './core';

const GROUPS: { id: string; label: string; test: (k: string) => boolean }[] = [
  { id: 'places', label: 'Places', test: (k) => k.startsWith('place_') },
  { id: 'heroes', label: 'Heroes', test: (k) => k.startsWith('spr_hero_') && !k.includes('@') },
  { id: 'people', label: 'People', test: (k) => k.startsWith('spr_npc_') && !k.includes('@') },
  { id: 'creatures', label: 'Creatures', test: (k) => (k.startsWith('spr_mon_') || k.startsWith('spr_boss_')) && !k.includes('@') },
  { id: 'things', label: 'Things on maps', test: (k) => k.startsWith('obj_') },
  { id: 'items', label: 'Items', test: (k) => k.startsWith('icon_') },
  { id: 'mist', label: 'Mist', test: (k) => k.startsWith('mist_') },
  { id: 'sheets', label: 'Animation sheets', test: (k) => k.includes('@') },
];
const groupOf = (k: string) => GROUPS.find((g) => g.test(k))?.id ?? 'other';

const STATES = [['all', 'All'], ['failed', 'Not painted'], ['low', 'Low art check'], ['tries', 'Several tries']] as const;

export function Art({ sel }: { sel?: string }) {
  const { w } = useView();
  const all = useMemo(() => Object.values(w.assets).sort((a, b) => a.key.localeCompare(b.key)), [w]);
  const [group, setGroup] = useState(sel ? groupOf(sel) : 'places');
  const [state, setState] = useState<(typeof STATES)[number][0]>('all');
  const [q, setQ] = useState('');
  const groups = [...GROUPS, { id: 'other', label: 'Other', test: () => false }].map((g) => ({ ...g, n: all.filter((a) => groupOf(a.key) === g.id).length })).filter((g) => g.n);
  const shown = all.filter((a) => {
    if (groupOf(a.key) !== group) return false;
    if (q && !`${a.key} ${a.prompt} ${a.imagePrompt ?? ''}`.toLowerCase().includes(q.toLowerCase())) return false;
    if (state === 'failed') return a.status !== 'ok';
    if (state === 'low') return a.status === 'ok' && (a.score ?? 10) < 6;
    if (state === 'tries') return (a.attempts ?? 1) > 1;
    return true;
  });
  const chosen = sel ? w.assets[sel] : undefined;
  return (
    <div className="col vw-page" style={{ gap: 12 }}>
      {chosen && <Chosen rec={chosen} />}
      <nav className="vw-tabs" aria-label="Kinds of picture">
        {groups.map((g) => <button key={g.id} className={`vw-tab ${group === g.id ? 'on' : ''}`} onClick={() => setGroup(g.id)}>{g.label} <span className="vw-count">{g.n}</span></button>)}
      </nav>
      <div className="row wrap" style={{ gap: 8 }}>
        <div className="seg">{STATES.map(([id, l]) => <button key={id} className={`btn sm ${state === id ? 'primary' : 'ghost'}`} onClick={() => setState(id)}>{l}</button>)}</div>
        <input className="input" type="search" style={{ maxWidth: 260 }} placeholder="Search the prompts" aria-label="Search the prompts" value={q} onChange={(e) => setQ(e.target.value)} />
        <span className="small dim">{shown.length} shown</span>
      </div>
      <div className={`vw-gallery ${group === 'places' || group === 'sheets' ? 'wide' : ''}`}>
        {shown.map((a) => {
          const src = picture(w, a.key, group === 'places' || group === 'sheets' ? 512 : 256);
          return (
            <a key={a.key} className={`vw-tile ${a.key === sel ? 'on' : ''} ${a.status !== 'ok' ? 'bad' : ''}`} href={href(w, 'art', a.key)}>
              <span className={`vw-tile-img ${a.kind === 'texture' ? 'cover' : ''}`}>{src ? <img src={src} alt="" loading="lazy" /> : <span className="tiny dim">{a.status}</span>}</span>
              <span className="vw-tile-key">{a.key}</span>
              {a.score !== undefined && a.score < 6 && <span className="vw-tile-flag">{a.score.toFixed(1)}</span>}
            </a>
          );
        })}
      </div>
      {!shown.length && <div className="small dim">Nothing here.</div>}
    </div>
  );
}

/** What a picture is of, by its key. */
function OwnerLink({ k }: { k: string }) {
  const { w } = useView();
  const base = k.split('@')[0]!;
  const npc = w.npcs.find((n) => base === `spr_npc_${n.id}`);
  if (npc) return <Ref to="people" id={npc.id}>{npc.name}</Ref>;
  const boss = w.bosses.find((b) => base === `spr_boss_${b.id}`);
  if (boss) return <Ref to="creatures" id={boss.id}>{boss.name}</Ref>;
  const fam = w.families.find((f) => base.startsWith(`spr_mon_${f.id}_`));
  if (fam) return <Ref to="creatures" id={fam.id} part={`m${base.split('_').pop()}`}>{fam.members[Number(base.split('_').pop())]?.name ?? fam.name}</Ref>;
  const zone = w.zones.find((z) => z.painting?.image === k || z.look.mist === k);
  if (zone) return <Ref to="places" id={zone.id}>{zone.name}</Ref>;
  const item = w.ruleset?.items.find((i) => k === `icon_${i.id}`);
  if (item) return <Ref to="rules" id="items" part={item.id}>{item.name}</Ref>;
  const cls = w.ruleset?.classes.find((c) => base.startsWith(`spr_hero_${c.id}_`));
  if (cls) return <Ref to="rules" id="classes" part={cls.id}>{cls.name}</Ref>;
  return null;
}

function Chosen({ rec }: { rec: AssetRecord }) {
  const { w, v } = useView();
  const src = picture(w, rec.key);
  const m = v.motion[rec.key];
  return (
    <section className="panel panel-body vw-chosen">
      <div className={`vw-chosen-img ${rec.kind === 'texture' ? 'cover' : ''}`}>{src ? <a href={src} target="_blank" rel="noreferrer"><img src={src} alt="" /></a> : <span className="dim">Not painted</span>}</div>
      <div className="col" style={{ gap: 8, minWidth: 0 }}>
        <div className="row wrap" style={{ gap: 8 }}>
          <code className="small grow">{rec.key}</code>
          <OwnerLink k={rec.key} />
        </div>
        <AssetFacts rec={rec} />
        {m && <div className="tiny dim">Animation: {m.state}{m.error ? ` (${m.error})` : ''}</div>}
        {rec.anim && m?.state === 'animated' && <ClipPreview w={w} k={rec.key} anim={rec.anim} />}
      </div>
    </section>
  );
}
