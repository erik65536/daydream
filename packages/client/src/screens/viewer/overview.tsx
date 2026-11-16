/** The world at a glance: what its owner asked for, what the build made of it, what it holds, and what it took. */
import { Field, Plain, Ref, SoundTakes, Tags, Voice, date, minutes, thousands, usd, useView, type Section } from './core';
import { KIND, sumTallies } from './build';

export function Overview() {
  const { v, w } = useView();
  const c = w.concept;
  const r = w.ruleset;
  const total = sumTallies(v.records.map((m) => m.total));
  const ms = v.records.reduce((n, m) => n + m.activeMs, 0);
  const counts: [string, number, Section][] = [
    ['places', w.zones.length, 'places'],
    ['people', w.npcs.length, 'people'],
    ['quests', w.quests.length, 'story'],
    ['creatures', w.families.reduce((n, f) => n + f.members.length, 0), 'creatures'],
    ['bosses', w.bosses.filter((b) => !b.member).length, 'creatures'],
    ['pictures', Object.values(w.assets).filter((a) => a.kind !== 'sheet' && a.status === 'ok').length, 'art'],
    ['sounds', Object.keys(w.sounds ?? {}).length, 'sound'],
    ['voices', v.voiceClips.length, 'sound'],
  ];
  return (
    <div className="col vw-page" style={{ gap: 18 }}>
      {v.job && (
        <div className="panel panel-body row">
          <div className="spinner" style={{ width: 16, height: 16 }} />
          <span className="grow">{KIND[v.job.kind] ?? v.job.kind} is {v.job.status}: {v.job.step} ({Math.round(v.job.progress * 100)}%)</span>
        </div>
      )}
      <section className="panel panel-body col" style={{ gap: 14 }}>
        <p className="lede" style={{ margin: 0 }}>{c.pitch}</p>
        <div className="small muted">{c.tone}</div>
        <Tags items={[c.genre, `${w.input.size} world`, `${w.input.length} story`, `level ${w.maxLevel || r?.progression.maxLevel}`, w.status, w.public ? 'public' : 'private']} />
        <div className="vw-counts">
          {counts.map(([label, n, to]) => (
            <Ref key={label} to={to} className="vw-countbox"><b>{n}</b><span>{label}</span></Ref>
          ))}
        </div>
        <div className="vw-grid2">
          <Field label="Owner">{w.ownerName}</Field>
          <Field label="Made">{date(w.createdAt)}{w.updatedAt !== w.createdAt ? `; saved ${date(w.updatedAt)}` : ''}</Field>
          <Field label="Adventures">{v.adventures.count ? `${v.adventures.count} by ${v.adventures.players} ${v.adventures.players === 1 ? 'player' : 'players'}` : 'none yet'}</Field>
          <Field label="Starts in"><Ref to="places" id={w.startZoneId}>{w.zones.find((z) => z.id === w.startZoneId)?.name}</Ref></Field>
          <Field label="Build">
            <Ref to="build">{minutes(ms)} of work, {usd(total.usd)}, {thousands((total.input ?? 0) + (total.output ?? 0))} tokens, {total.images ?? 0} pictures, {minutes(total.gpuMs)} of GPU</Ref>
          </Field>
          <Field label="Id"><code>{w.id}</code></Field>
        </div>
        {w.sounds?.theme && <Field label="Theme"><SoundTakes k="theme" /></Field>}
      </section>

      <section className="panel panel-body col" style={{ gap: 12 }}>
        <h2 className="h2">What the owner asked for</h2>
        <Field label="Theme">{w.input.theme}</Field>
        {(w.input.prompts ?? []).map((p, i) => <Field key={i} label={`Prompt about ${p.topic}`}>{p.text}</Field>)}
        <div className="vw-grid2">
          <Field label="Size and length">{w.input.size}, {w.input.length}</Field>
          <Field label="Talking">level {w.input.communication}</Field>
          <Field label="Animation">{w.input.animate ? 'painted animations' : 'still pictures'}</Field>
        </div>
        {w.input.rules && Object.keys(w.input.rules).length > 0 && <Field label="Rule choices"><Plain value={w.input.rules} /></Field>}
        <Field label="How people talk (the owner’s style)">{c.speech || 'plainly (no style asked for)'}</Field>
      </section>

      <section className="panel panel-body col" style={{ gap: 12 }}>
        <h2 className="h2">Look and voice</h2>
        <Field label="Art style">{c.artStyle}</Field>
        <Field label="Palette">
          <div className="row wrap" style={{ gap: 12 }}>
            {Object.entries(c.palette).map(([k, x]) => <span key={k} className="small"><span className="swatch" style={{ background: x }} />{k} {x}</span>)}
          </div>
        </Field>
        {r?.ui && <Field label="Interface"><Plain value={r.ui} /></Field>}
        <Field label="Narrator"><Voice speaker="narrator" description={c.narratorVoice} /></Field>
        <Field label="Opening">{c.intro}</Field>
      </section>
    </div>
  );
}
