/** The people: who each one is, their inner life and secrets, how they talk and sound, and what they do in the story. */
import { useState } from 'react';
import type { NpcDef } from '@daydream/shared';
import { ClipPreview } from '../../ui/clips';
import { Bullets, Field, Pic, Ref, Rest, Said, Split, Tags, Thing, Voice, picture, useNames, useView, type ListEntry } from './core';

export function People({ sel }: { sel?: string }) {
  const { w } = useView();
  const n = useNames();
  const [q, setQ] = useState('');
  const towns = [...new Set(w.npcs.map((x) => x.zoneId))];
  const shown = (x: NpcDef) => !q || `${x.name} ${x.title} ${x.role}`.toLowerCase().includes(q.toLowerCase());
  const entries: ListEntry[] = towns.flatMap((t) =>
    w.npcs.filter((x) => x.zoneId === t && shown(x)).map((x, i) => ({
      id: x.id,
      title: x.name,
      sub: x.title,
      pic: picture(w, x.asset, 256) ?? '',
      badge: x.essential ? <span className="badge">story</span> : undefined,
      group: i === 0 ? n.zone(t) : undefined,
    })),
  );
  const p = w.npcs.find((x) => x.id === (sel ?? w.npcs[0]?.id));
  return (
    <Split section="people" entries={entries} sel={sel} filter={<input className="input vw-filter" type="search" placeholder="Filter people" aria-label="Filter people" value={q} onChange={(e) => setQ(e.target.value)} />}>
      {p && <Person key={p.id} p={p} />}
    </Split>
  );
}

function Person({ p }: { p: NpcDef }) {
  const { w, v } = useView();
  const key = `spr_npc_${p.id}`;
  const rec = w.assets[key];
  const quests = w.quests.filter((q) => p.questIds.includes(q.id) || q.giverNpcId === p.id || q.objectives.some((o) => o.npcId === p.id || o.targetId === p.id));
  const keeps = w.zones.flatMap((z) => (z.buildings ?? []).filter((b) => b.npcId === p.id).map((b) => ({ z, b })));
  const stash = (fid?: string) => (fid ? w.zones.flatMap((z) => z.features.filter((f) => f.id === fid).map((f) => ({ z, f })))[0] : undefined);
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
        <Pic k={key} size={180} width={512} label={p.name} />
        {rec?.anim && v.motion[key]?.state === 'animated' && <ClipPreview w={w} k={key} anim={rec.anim} />}
        <div className="grow col" style={{ gap: 8, minWidth: 220 }}>
          <div>
            <h2 className="h2">{p.name}</h2>
            <div className="lede" style={{ fontSize: 16 }}>{p.title}</div>
          </div>
          <Tags items={[`${p.role}${p.merchantKind ? `, sells ${p.merchantKind}` : ''}`, `level ${p.level}`, p.pronouns, p.essential && 'in the story', p.wanders && 'wanders', p.faction]} />
          <div className="small">Lives in <Thing id={p.zoneId} />{keeps.map(({ b }) => <span key={b.id}>, keeps {b.name}</span>)}</div>
          {v.motion[key] && v.motion[key]!.state !== 'animated' && <div className="tiny dim">Animation: {v.motion[key]!.state}{v.motion[key]!.error ? ` (${v.motion[key]!.error})` : ''}</div>}
          <Voice speaker={p.id} description={p.voice} />
        </div>
      </div>
      <div className="vw-grid2">
        <Field label="Looks">{p.appearance}</Field>
        <Field label="Personality">{p.personality}</Field>
        <Field label="How they talk">{p.manner}</Field>
        <Field label="Wants">{p.want}</Field>
      </div>
      <Field label="Past">{p.backstory}</Field>
      <Field label="Their days"><Bullets items={p.life} /></Field>
      <div className="vw-grid2">
        <Field label="Won over by"><Bullets items={p.values.likes} /></Field>
        <Field label="Cannot stand"><Bullets items={p.values.dislikes} /></Field>
      </div>
      <Field label="What they think of others"><Bullets items={p.opinions.map((o) => <span key={o.npcId}><Thing id={o.npcId} />: {o.text}</span>)} /></Field>
      <Field label="What they know"><Bullets items={p.knowledge} /></Field>
      <Field label="Secrets">
        <Bullets items={p.secrets.map((s, i) => {
          const at = stash(s.leadsTo);
          return (
            <span key={i}>
              {s.text} <span className="dim">Tells when: {s.tellsWhen}.</span>
              {at && <> Leads to <Ref to="places" id={at.z.id} part={at.f.id}>{at.f.name ?? 'a stash'} in {at.z.name}</Ref>.</>}
            </span>
          );
        })} />
      </Field>
      <Field label="Greeting">{p.greeting} <Said speaker={p.id} text={p.greeting} /></Field>
      {p.returning && (
        <Field label="Meeting again">
          <Bullets items={(['warm', 'plain', 'cold'] as const).map((k) => <span key={k}><span className="dim">{k}:</span> {p.returning![k]} <Said speaker={p.id} text={p.returning![k]} /></span>)} />
        </Field>
      )}
      <Field label="Said in passing"><Bullets items={p.barks.map((b, i) => <span key={i}>{b} <Said speaker={p.id} text={b} /></span>)} /></Field>
      <Field label="In quests"><Bullets items={quests.map((q) => <span key={q.id}><Thing id={q.id} />{q.giverNpcId === p.id ? ' (gives it)' : ''}</span>)} /></Field>
      <Field label="Talks with (news travels along these)">{p.relations?.map((r, i) => <span key={r}>{i ? ', ' : ''}<Thing id={r} /></span>)}</Field>
      <Rest obj={p} known={['id', 'name', 'title', 'role', 'merchantKind', 'zoneId', 'x', 'y', 'pronouns', 'personality', 'appearance', 'backstory', 'want', 'life', 'manner', 'values', 'opinions', 'knowledge', 'secrets', 'voice', 'greeting', 'returning', 'barks', 'level', 'essential', 'questIds', 'relations', 'faction', 'asset', 'wanders']} />
    </div>
  );
}
