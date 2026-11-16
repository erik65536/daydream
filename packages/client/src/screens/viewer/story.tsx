/**
 * The story: how it is told (the opening, each arc's closing, the ending), its arcs and their quests step by step,
 * the side quests of each town, and the lore found written in the wilds and dungeons.
 */
import { questSteps, type QuestDef, type QuestObjective } from '@daydream/shared';
import { Bullets, Field, Rest, Ref, Said, Split, Tags, Thing, useNames, useView, type ListEntry } from './core';

export function Story({ sel }: { sel?: string }) {
  const { w } = useView();
  const n = useNames();
  const side = w.quests.filter((q) => !q.main);
  const townOf = (q: QuestDef) => q.zoneId ?? w.npcs.find((x) => x.id === q.giverNpcId)?.zoneId ?? '';
  const towns = [...new Set(side.map(townOf))];
  const entries: ListEntry[] = [
    { id: 'telling', title: 'How it is told', sub: 'opening and ending' },
    ...w.arcs.flatMap((a) => [
      { id: `arc${a.index}`, title: a.title, sub: `arc ${a.index + 1}`, group: a.index === 0 ? 'The story' : undefined },
      ...w.quests.filter((q) => q.main && q.arcIndex === a.index).sort((x, y) => x.level - y.level).map((q) => ({ id: q.id, title: <span className="vw-indent">{q.title}</span>, sub: <span className="vw-indent">level {q.level}{q.id === w.finalQuestId ? ', the last' : ''}</span> })),
    ]),
    ...towns.flatMap((t) => side.filter((q) => townOf(q) === t).map((q, i) => ({ id: q.id, title: q.title, sub: `level ${q.level}`, group: i === 0 ? `Side quests in ${n.zone(t) || 'the world'}` : undefined }))),
    ...w.lore.map((l, i) => ({ id: l.id, title: l.title, group: i === 0 ? 'Lore' : undefined })),
  ];
  const chosen = sel ?? 'telling';
  const quest = w.quests.find((q) => q.id === chosen);
  const arc = w.arcs.find((a) => `arc${a.index}` === chosen);
  const lore = w.lore.find((l) => l.id === chosen);
  return (
    <Split section="story" entries={entries} sel={sel}>
      {quest ? <Quest q={quest} /> : arc ? (
        <div className="col" style={{ gap: 12 }}>
          <h2 className="h2">{arc.title}</h2>
          <div className="small dim">Arc {arc.index + 1}</div>
          <Field label="When it closes">{arc.revelation} <Said speaker="narrator" text={arc.revelation} /></Field>
          <Field label="Its quests">
            <ol className="vw-bullets">{arc.questIds.map((id) => { const q = w.quests.find((x) => x.id === id); return <li key={id}><Ref to="story" id={id}>{q?.title ?? id}</Ref>{q && <div className="small muted">{q.summary}</div>}</li>; })}</ol>
          </Field>
          <Rest obj={arc} known={['index', 'title', 'revelation', 'questIds']} />
        </div>
      ) : lore ? (
        <div className="col" style={{ gap: 12 }}>
          <h2 className="h2">{lore.title}</h2>
          {lore.arcIndex !== undefined && <div className="small dim">Arc {lore.arcIndex + 1}</div>}
          <p className="vw-prose">{lore.text} <Said speaker="narrator" text={lore.text} /></p>
          <Field label="Found at">{w.zones.flatMap((z) => z.features.filter((f) => f.loreId === lore.id).map((f) => <Ref key={f.id} to="places" id={z.id} part={f.id}>{f.name ?? 'a note'} in {z.name}</Ref>))}</Field>
        </div>
      ) : (
        <div className="col" style={{ gap: 12 }}>
          <h2 className="h2">How it is told</h2>
          <Field label="The pitch">{w.concept.pitch}</Field>
          <Field label="The opening">{w.concept.intro} <Said speaker="narrator" text={w.concept.intro} /></Field>
          <Field label="The ending">{w.ending} <Said speaker="narrator" text={w.ending} /></Field>
          <Field label="The narrator’s voice">{w.concept.narratorVoice}</Field>
        </div>
      )}
    </Split>
  );
}

const OBJECTIVE: Record<string, string> = { talk: 'Talk', kill: 'Fight', kill_unique: 'Defeat', collect: 'Find', deliver: 'Bring', persuade: 'Persuade' };

function Quest({ q }: { q: QuestDef }) {
  const { w } = useView();
  const steps = questSteps(q);
  return (
    <div className="col" style={{ gap: 12 }}>
      <h2 className="h2">{q.title}</h2>
      <Tags items={[q.main ? `story, arc ${(q.arcIndex ?? 0) + 1}` : 'side quest', `level ${q.level}`, q.autoStart && 'starts by itself', q.id === w.finalQuestId && 'the last quest']} />
      <p className="vw-prose">{q.summary}</p>
      <div className="vw-grid2">
        <Field label="Given by">{q.giverNpcId && <Thing id={q.giverNpcId} />}</Field>
        <Field label="Where">{q.zoneId && <Thing id={q.zoneId} />}</Field>
        <Field label="After">{q.prerequisites.map((p, i) => <span key={p}>{i ? ', ' : ''}<Thing id={p} /></span>)}</Field>
      </div>
      <Field label="Steps">
        <ol className="vw-steps">
          {steps.map((ways, i) => (
            <li key={i}>
              {ways.map((way, j) => (
                <div key={j} className={ways.length > 1 ? 'vw-way' : ''}>
                  {ways.length > 1 && <div className="tiny dim">{j === 0 ? 'one way' : 'or another way'}</div>}
                  {way.map((o) => <Objective key={o.id} o={o} />)}
                </div>
              ))}
            </li>
          ))}
        </ol>
      </Field>
      <Field label="Rewards">{[q.rewards.xp && `${q.rewards.xp} experience`, q.rewards.gold && `${q.rewards.gold} ${w.ruleset?.economy.currency ?? 'gold'}`].filter(Boolean).join(', ')}{q.rewards.items.map((i) => <span key={i}>, <Thing id={i} /></span>)}</Field>
      <Rest obj={q} known={['id', 'title', 'summary', 'main', 'arcIndex', 'level', 'giverNpcId', 'zoneId', 'objectives', 'rewards', 'prerequisites', 'autoStart']} />
    </div>
  );
}

function Objective({ o }: { o: QuestObjective }) {
  const targets = [o.npcId, o.targetId, o.familyId, o.zoneId, o.itemUniqueId].filter((x): x is string => !!x);
  return (
    <div className="vw-objective">
      <div>{o.description}</div>
      <div className="tiny muted">
        <span className="dim">{OBJECTIVE[o.type] ?? o.type}: </span>
        {targets.map((t, i) => <span key={t}>{i ? ' · ' : ''}<Thing id={t} /></span>)}
        {o.count && o.count > 1 ? ` · ×${o.count}` : ''}
        {o.hidden ? ' · shown later' : ''}
      </div>
      <Bullets items={o.agree ? [`Agrees to: ${o.agree}`] : []} />
    </div>
  );
}
