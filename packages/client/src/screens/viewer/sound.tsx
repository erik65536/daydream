/**
 * The world's sounds and voices (docs/sound.md, docs/voices.md): every sound a world of its make should have, by what
 * it is for, each take playable, and the ones it lacks (the game plays its own stand-in for some); then every voice.
 */
import type { ReactNode } from 'react';
import { MOMENTS } from '@daydream/shared';
import { Ref, SoundTakes, Voice, useScrollTo, useView } from './core';

export function Sound({ sel }: { sel?: string }) {
  const { w, v } = useView();
  useScrollTo(sel);
  const types = w.ruleset?.damageTypes ?? [];
  const groups: { title: string; hint?: string; rows: [string, ReactNode][] }[] = [
    {
      title: 'Music',
      rows: [
        ['theme', 'The theme'],
        ['defeat', 'Defeat'],
        ...w.zones.map((z): [string, ReactNode] => [`place:${z.id}`, <>Arriving in <Ref to="places" id={z.id}>{z.name}</Ref></>]),
        ...w.bosses.filter((b) => !b.member).map((b): [string, ReactNode] => [`boss:${b.id}`, <>Fighting <Ref to="creatures" id={b.id}>{b.name}</Ref></>]),
      ],
    },
    { title: 'Places', rows: w.zones.map((z) => [`ambience:${z.id}`, <>Around <Ref to="places" id={z.id}>{z.name}</Ref></>]) },
    { title: 'Fights', rows: types.flatMap((t) => (['cast', 'hit', 'heavy'] as const).map((k): [string, ReactNode] => [`${k}:${t.id}`, `${t.name}: ${{ cast: 'a skill', hit: 'a hit', heavy: 'a heavy hit' }[k]}`])) },
    { title: 'Creatures', rows: w.families.flatMap((f) => (['cry', 'death'] as const).map((k): [string, ReactNode] => [`${k}:${f.id}`, <><Ref to="creatures" id={f.id}>{f.name}</Ref>: {k === 'cry' ? 'a fight begins' : 'one falls'}</>])) },
    { title: 'Moments', hint: 'The same moments in every world, made from what this one is made of; one it lacks is played from the game’s own.', rows: Object.keys(MOMENTS).map((k) => [k, k.replace(/_/g, ' ')]) },
  ];
  const listed = new Set(groups.flatMap((g) => g.rows.map(([k]) => k)));
  const other = Object.keys(w.sounds ?? {}).filter((k) => !listed.has(k));
  if (other.length) groups.push({ title: 'Other', rows: other.map((k) => [k, k]) });
  const speakers = [...w.npcs.map((p) => ({ id: p.id, name: <Ref to="people" id={p.id}>{p.name}</Ref>, voice: p.voice })), ...w.bosses.map((b) => ({ id: b.id, name: <Ref to="creatures" id={b.id}>{b.name}</Ref>, voice: b.voice })), { id: 'narrator', name: <>The narrator</>, voice: w.concept.narratorVoice }];
  const made = Object.keys(w.sounds ?? {}).length;
  return (
    <div className="col vw-page" style={{ gap: 14 }}>
      <p className="small muted">{made} sounds and {v.voiceClips.length} voices made, {v.spoken.length} lines spoken before play.</p>
      {groups.map((g) => (
        <section key={g.title} className="panel panel-body col" style={{ gap: 6 }}>
          <h3 className="vw-h3">{g.title}</h3>
          {g.hint && <p className="hint">{g.hint}</p>}
          {g.rows.map(([k, label]) => (
            <div key={k} id={`vw-${k}`} className={`vw-sound ${w.sounds?.[k] ? '' : 'missing'}`}>
              <span className="grow small">{label}</span>
              <code className="tiny dim">{k}</code>
              {w.sounds?.[k] ? <SoundTakes k={k} /> : <span className="tiny dim">not made</span>}
            </div>
          ))}
        </section>
      ))}
      <section className="panel panel-body col" style={{ gap: 10 }}>
        <h3 className="vw-h3">Voices</h3>
        {speakers.map((s) => (
          <div key={s.id} id={`vw-${s.id}`} className="vw-voice">
            <div className="small" style={{ minWidth: 150 }}>{s.name}</div>
            <div className="grow"><Voice speaker={s.id} description={s.voice} /></div>
          </div>
        ))}
      </section>
    </div>
  );
}
