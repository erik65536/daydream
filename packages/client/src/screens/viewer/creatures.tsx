/** The creatures: each family and its members, where they live, and how they sound; the bosses and named foes. */
import { useState } from 'react';
import { FIGHTER_LOOK, type BossDef, type MonsterFamily } from '@daydream/shared';
import { ClipPreview } from '../../ui/clips';
import { Bullets, Field, Pic, Rest, Said, SoundTakes, Split, Tags, Thing, Voice, picture, useNames, useScrollTo, useView, type ListEntry } from './core';

const monsterSprite = (familyId: string, i: number) => `spr_mon_${familyId}_${i}`;

export function Creatures({ sel, part }: { sel?: string; part?: string }) {
  const { w } = useView();
  const entries: ListEntry[] = [
    ...w.families.map((f, i) => ({ id: f.id, title: f.name, sub: `${f.members.length} kinds`, pic: picture(w, f.members[0]?.asset, 256) ?? '', group: i === 0 ? 'Families' : undefined })),
    ...w.bosses.map((b, i) => ({ id: b.id, title: b.name, sub: `${b.member ? 'named foe' : 'boss'} · level ${b.level}`, pic: picture(w, b.asset ?? w.families.find((f) => f.id === b.familyId)?.members.find((m) => m.name === b.member)?.asset, 256) ?? '', group: i === 0 ? 'Bosses and named foes' : undefined })),
  ];
  const id = sel ?? entries[0]?.id;
  const family = w.families.find((f) => f.id === id);
  const boss = w.bosses.find((b) => b.id === id);
  return (
    <Split section="creatures" entries={entries} sel={sel}>
      {family ? <Family key={family.id} f={family} part={part} /> : boss ? <Boss key={boss.id} b={boss} /> : null}
    </Split>
  );
}

function Family({ f, part }: { f: MonsterFamily; part?: string }) {
  const { w } = useView();
  const n = useNames();
  useScrollTo(part);
  const homes = w.zones.filter((z) => z.familyIds.includes(f.id));
  const foes = w.bosses.filter((b) => b.familyId === f.id);
  const quests = w.quests.filter((q) => q.objectives.some((o) => o.familyId === f.id));
  return (
    <div className="col" style={{ gap: 14 }}>
      <h2 className="h2">{f.name}</h2>
      <p className="vw-prose">{f.description}</p>
      <div className="vw-grid2">
        <Field label="Lives in">{homes.map((z, i) => <span key={z.id}>{i ? ', ' : ''}<Thing id={z.id} /></span>)}</Field>
        <Field label="Sounds">
          <div className="col" style={{ gap: 4 }}>
            <span className="row" style={{ gap: 8 }}><span className="small dim" style={{ width: 50 }}>cry</span><SoundTakes k={`cry:${f.id}`} /></span>
            <span className="row" style={{ gap: 8 }}><span className="small dim" style={{ width: 50 }}>death</span><SoundTakes k={`death:${f.id}`} /></span>
          </div>
        </Field>
        <Field label="Named foes and bosses">{foes.map((b, i) => <span key={b.id}>{i ? ', ' : ''}<Thing id={b.id} /></span>)}</Field>
        <Field label="Fought in">{quests.map((q, i) => <span key={q.id}>{i ? ', ' : ''}<Thing id={q.id} /></span>)}</Field>
      </div>
      <div className="vw-cards">
        {f.members.map((m, i) => (
          <div key={i} id={`vw-m${i}`} className="vw-card col" style={{ gap: 8 }}>
            <div className="row" style={{ gap: 10, alignItems: 'flex-start' }}>
              <Pic k={m.asset ?? monsterSprite(f.id, i)} size={96} label={m.name} />
              <div className="grow col" style={{ gap: 4 }}>
                <div className="vw-card-title">{m.name}</div>
                <div className="tiny dim">{FIGHTER_LOOK[m.fighter]?.name ?? m.fighter}, fights as {n.cls(m.classId)}</div>
                <div className="small muted">{m.description}</div>
              </div>
            </div>
            <Field label="Looks">{m.appearance}</Field>
            <Motion k={m.asset ?? monsterSprite(f.id, i)} />
          </div>
        ))}
      </div>
      <Rest obj={f} known={['id', 'name', 'description', 'members']} />
    </div>
  );
}

function Boss({ b }: { b: BossDef }) {
  const { w } = useView();
  const n = useNames();
  const look = b.member ? w.families.find((f) => f.id === b.familyId)?.members.find((m) => m.name === b.member)?.asset : (b.asset ?? `spr_boss_${b.id}`);
  const where = w.zones.filter((z) => z.spawns.some((s) => s.bossId === b.id));
  const quests = w.quests.filter((q) => q.objectives.some((o) => o.targetId === b.id));
  return (
    <div className="col" style={{ gap: 14 }}>
      <div className="row wrap" style={{ gap: 16, alignItems: 'flex-start' }}>
        <Pic k={look} size={180} width={512} label={b.name} />
        <div className="grow col" style={{ gap: 8, minWidth: 220 }}>
          <h2 className="h2">{b.name}</h2>
          <Tags items={[b.member ? `named foe, one of the ${b.member}` : 'boss', `level ${b.level}`, FIGHTER_LOOK[b.fighter]?.name ?? b.fighter, `fights as ${b.classIds.map(n.cls).join(' and ')}`]} />
          <div className="small">Of <Thing id={b.familyId} />, in <Thing id={b.zoneId} />{where.length && !where.some((z) => z.id === b.zoneId) ? <> (placed in {where.map((z) => z.name).join(', ')})</> : null}</div>
          <Voice speaker={b.id} description={b.voice} />
        </div>
      </div>
      <p className="vw-prose">{b.description}</p>
      <div className="vw-grid2">
        <Field label="Looks">{b.appearance}</Field>
        <Field label="Says as the fight begins">{b.taunt && <>{b.taunt} <Said speaker={b.id} text={b.taunt} /></>}</Field>
        <Field label="Drops"><Bullets items={b.drops.map((d) => <Thing key={d} id={d} />)} /></Field>
        <Field label="Fought in">{quests.map((q, i) => <span key={q.id}>{i ? ', ' : ''}<Thing id={q.id} /></span>)}</Field>
        {!b.member && <Field label="Battle music"><SoundTakes k={`boss:${b.id}`} /></Field>}
      </div>
      {!b.member && <Motion k={look} />}
      <Rest obj={b} known={['id', 'name', 'description', 'familyId', 'fighter', 'classIds', 'level', 'zoneId', 'appearance', 'member', 'drops', 'asset', 'taunt', 'voice']} />
    </div>
  );
}

/** An actor's animation, played on asking (each preview draws every frame while it is open). */
function Motion({ k }: { k?: string }) {
  const { w, v } = useView();
  const [open, setOpen] = useState(false);
  const rec = k ? w.assets[k] : undefined;
  const m = k ? v.motion[k] : undefined;
  if (!k || !m || m.state === 'off') return null;
  if (m.state !== 'animated' || !rec?.anim) return <div className="tiny dim">Animation: {m.state}{m.error ? ` (${m.error})` : ''}</div>;
  return open ? <ClipPreview w={w} k={k} anim={rec.anim} /> : <button className="btn sm ghost" style={{ alignSelf: 'flex-start' }} onClick={() => setOpen(true)}>Play its animation</button>;
}
