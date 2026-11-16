/**
 * Developer options for admins (toggle with the ` key), to test any part of the game without playing up to it: the
 * party (level, points, gold, items, healing, god mode), creatures (spawn, defeat, bring back), quests and the story
 * (start, finish, reset, jump to a stage), places (go anywhere, see the whole map, the clock), and the view (far zoom,
 * walkable ground, a clean picture without the HUD). Ctrl+click teleports the party. Every button is a
 * `window.__gd.dev(...)` command, so scripts can do the same; the server refuses them from anyone else.
 */
import { useEffect, useState } from 'react';
import type { DevCommand, DevInfo } from '@daydream/shared';
import { client, useGame } from '../net/game';
import type { Renderer } from '../render/renderer';

type Tab = 'party' | 'creatures' | 'quests' | 'places' | 'view';
const TABS: [Tab, string][] = [['party', 'Party'], ['creatures', 'Creatures'], ['quests', 'Quests'], ['places', 'Places'], ['view', 'View']];

export function DevPanel({ renderer, hudHidden, setHudHidden, onClose }: { renderer: Renderer | null; hudHidden: boolean; setHudHidden: (v: boolean) => void; onClose: () => void }) {
  const c = client();
  const { world, zone, player, clock } = useGame((s) => ({ world: s.world, zone: s.zone, player: s.player, clock: s.clock }));
  const [tab, setTab] = useState<Tab>('party');
  const [result, setResult] = useState<{ ok: boolean; text: string } | null>(null);
  const [info, setInfo] = useState<DevInfo | null>(null);
  const run = async (cmd: DevCommand) => {
    const r = await c.dev(cmd);
    setResult(r);
    // What the server knows (quests, toggles) is fetched again after anything that may change it.
    if (cmd.action !== 'info' && cmd.action !== 'reload') setInfo((await c.dev({ action: 'info' })).info ?? null);
    return r;
  };
  useEffect(() => {
    void c.dev({ action: 'info' }).then((r) => setInfo(r.info ?? null));
  }, [c]);
  if (!world || !player) return null;
  return (
    <div className="dev-panel">
      <div className="row" style={{ justifyContent: 'space-between' }}>
        <b>Developer</b>
        <button className="btn sm ghost" aria-label="Close" onClick={onClose}>×</button>
      </div>
      <div className="dev-tabs">
        {TABS.map(([id, label]) => (
          <button key={id} className={`chip ${tab === id ? 'on' : ''}`} onClick={() => setTab(id)}>{label}</button>
        ))}
      </div>
      {tab === 'party' && <PartyTab run={run} info={info} />}
      {tab === 'creatures' && <CreaturesTab run={run} info={info} />}
      {tab === 'quests' && <QuestsTab run={run} info={info} />}
      {tab === 'places' && <PlacesTab run={run} zoneId={zone?.id} day={clock?.day} hour={clock?.hour} />}
      {tab === 'view' && <ViewTab renderer={renderer} hudHidden={hudHidden} setHudHidden={setHudHidden} run={run} />}
      {result && <div className={`dev-result ${result.ok ? '' : 'bad'}`}>{result.text}</div>}
      <div className="dim small">` or the game menu opens this panel · Ctrl+click teleports</div>
    </div>
  );
}

type Run = (cmd: DevCommand) => Promise<{ ok: boolean; text: string }>;

/** A number box and a button that sends it. */
function NumberAction({ label, value, onRun, min, max }: { label: string; value: number; onRun: (n: number) => void; min?: number; max?: number }) {
  const [v, setV] = useState(String(value));
  return (
    <div className="dev-line">
      <input className="input dev-num" type="number" min={min} max={max} value={v} onChange={(e) => setV(e.target.value)} onKeyDown={(e) => e.key === 'Enter' && onRun(Number(v))} />
      <button className="btn sm" onClick={() => onRun(Number(v))}>{label}</button>
    </div>
  );
}

function PartyTab({ run, info }: { run: Run; info: DevInfo | null }) {
  const c = client();
  const { player, world } = useGame((s) => ({ player: s.player!, world: s.world! }));
  const r = c.r;
  const [who, setWho] = useState('');
  const [q, setQ] = useState('');
  const charId = who || undefined;
  const lead = player.party.find((p) => p.id === player.leaderId) ?? player.party[0]!;
  const items = [
    ...Object.values(world.uniqueItems).map((u) => ({ id: u.id, name: u.name, kind: 'unique' })),
    ...r.items.map((i) => ({ id: i.id, name: i.name, kind: i.category })),
  ].filter((i) => q && i.name.toLowerCase().includes(q.toLowerCase())).slice(0, 30);
  return (
    <>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => run({ action: 'heal' })}>Full heal</button>
        <button className="btn sm" onClick={() => run({ action: 'god', on: !info?.god })}>{info?.god ? 'God mode ✓' : 'God mode'}</button>
        <button className="btn sm" onClick={() => run({ action: 'peace', on: !info?.peace })}>{info?.peace ? 'Peaceful ✓' : 'Peaceful'}</button>
      </div>
      <select className="input" value={who} onChange={(e) => setWho(e.target.value)}>
        <option value="">The whole party</option>
        {player.party.map((p) => <option key={p.id} value={p.id}>{p.name} ({r.terminology.level} {p.level}, {p.treePoints} points)</option>)}
      </select>
      <NumberAction label={`Set ${r.terminology.level.toLowerCase()}`} value={lead.level} min={1} max={r.progression.maxLevel} onRun={(level) => run({ action: 'level', level, charId })} />
      <NumberAction label="Add talent points" value={5} onRun={(amount) => run({ action: 'points', amount, charId })} />
      <NumberAction label={`Add ${r.terminology.xp}`} value={500} onRun={(amount) => run({ action: 'xp', amount })} />
      <NumberAction label={`Add ${r.terminology.currency.toLowerCase()} (${player.gold})`} value={1000} onRun={(amount) => run({ action: 'gold', amount })} />
      <input className="input" placeholder="Find an item to add…" value={q} onChange={(e) => setQ(e.target.value)} />
      {items.length > 0 && (
        <div className="dev-list">
          {items.map((i) => (
            <button key={i.id} className="dev-zone" onClick={() => run({ action: 'item', ref: i.id })}>
              {i.name} <span className="dim">{i.kind}</span>
            </button>
          ))}
        </div>
      )}
    </>
  );
}

function CreaturesTab({ run, info }: { run: Run; info: DevInfo | null }) {
  const { world, zone } = useGame((s) => ({ world: s.world!, zone: s.zone }));
  const [level, setLevel] = useState('');
  const lv = level ? Number(level) : undefined;
  const here = new Set(zone?.familyIds ?? []);
  const families = [...world.families].sort((a, b) => Number(here.has(b.id)) - Number(here.has(a.id)));
  return (
    <>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn sm" title="Defeat the creatures fighting the party, or those near it" onClick={() => run({ action: 'kill' })}>Defeat nearby</button>
        <button className="btn sm" onClick={() => run({ action: 'kill', all: true })}>Defeat all here</button>
        <button className="btn sm" title="Every creature of this place comes back, bosses too" onClick={() => run({ action: 'respawn' })}>Bring back</button>
        <button className="btn sm" title="Every kind of combat effect on the figures near the hero, with captions (on this screen only); again to stop" onClick={() => void client().fxReel()}>Effects reel</button>
      </div>
      <div className="dev-line">
        <input className="input dev-num" type="number" placeholder="level" value={level} onChange={(e) => setLevel(e.target.value)} />
        <span className="dim">spawn level (blank: the place's)</span>
      </div>
      <div className="dev-list">
        {families.map((f) => (
          <div key={f.id} className="dev-family">
            <span>{f.name}{here.has(f.id) && <span className="dim"> · here</span>}</span>
            <span className="row wrap" style={{ gap: 3 }}>
              {f.members.map((m, i) => (
                <button key={i} className="chip" title={`${m.name}: a ${m.fighter}`} onClick={() => run({ action: 'spawn', familyId: f.id, member: i, level: lv })}>{m.name}</button>
              ))}
              <button className="chip" onClick={() => run({ action: 'spawn', familyId: f.id, count: 4, level: lv })}>pack</button>
            </span>
          </div>
        ))}
        {(info?.bosses ?? []).map((b) => (
          <button key={b.id} className="dev-zone" onClick={() => run({ action: 'spawn', bossId: b.id, level: lv })}>
            {b.name} <span className="dim">boss of {world.zones.find((z) => z.id === b.zoneId)?.name}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function QuestsTab({ run, info }: { run: Run; info: DevInfo | null }) {
  const [side, setSide] = useState(false);
  if (!info) return <div className="dim">Loading…</div>;
  const list = info.quests.filter((q) => q.main !== side);
  return (
    <>
      <div className="row" style={{ gap: 4 }}>
        <button className={`chip ${!side ? 'on' : ''}`} onClick={() => setSide(false)}>Story</button>
        <button className={`chip ${side ? 'on' : ''}`} onClick={() => setSide(true)}>Side quests</button>
      </div>
      <div className="dev-list">
        {list.map((q) => (
          <div key={q.id} className={`dev-quest ${q.status ?? ''}`}>
            <div>
              {q.arcIndex !== undefined && <span className="dim">{q.arcIndex + 1}· </span>}
              {q.title} <span className="dim">{q.status ?? 'not begun'}</span>
            </div>
            {q.current && <div className="dim small">→ {q.current}</div>}
            <div className="row wrap" style={{ gap: 3 }}>
              {q.main && <button className="chip" title="Every story quest before this done, this one started" onClick={() => run({ action: 'story', questId: q.id })}>jump here</button>}
              {!q.status && <button className="chip" onClick={() => run({ action: 'quest', questId: q.id, op: 'start' })}>start</button>}
              {q.status === 'active' && <button className="chip" onClick={() => run({ action: 'quest', questId: q.id, op: 'advance' })}>next step</button>}
              {(!q.status || q.status === 'active') && <button className="chip" onClick={() => run({ action: 'quest', questId: q.id, op: 'complete' })}>complete</button>}
              {!q.main && q.status === 'active' && <button className="chip" onClick={() => run({ action: 'quest', questId: q.id, op: 'fail' })}>fail</button>}
              {q.status && <button className="chip" onClick={() => run({ action: 'quest', questId: q.id, op: 'reset' })}>reset</button>}
            </div>
          </div>
        ))}
      </div>
    </>
  );
}

function PlacesTab({ run, zoneId, day, hour }: { run: Run; zoneId?: string; day?: number; hour?: number }) {
  const { world } = useGame((s) => ({ world: s.world! }));
  const [q, setQ] = useState('');
  const list = world.zones.filter((z) => !q || z.name.toLowerCase().includes(q.toLowerCase()));
  return (
    <>
      <div className="row wrap" style={{ gap: 4 }}>
        <button className="btn sm" onClick={() => run({ action: 'reveal' })}>Reveal map</button>
        {[6, 12, 18, 0].map((h) => (
          <button key={h} className="btn sm" title={`Day ${day ?? 1}, ${h}:00`} onClick={() => run({ action: 'time', hour: h })}>{['Dawn', 'Noon', 'Dusk', 'Midnight'][[6, 12, 18, 0].indexOf(h)]}</button>
        ))}
      </div>
      <NumberAction label={`Go to day (now ${day ?? 1}, ${hour ?? 0}:00)`} value={(day ?? 1) + 1} min={1} onRun={(d) => run({ action: 'time', day: d })} />
      <input className="input" placeholder="Find a place…" value={q} onChange={(e) => setQ(e.target.value)} />
      <div className="dev-list">
        {list.map((z) => (
          <button key={z.id} className={`dev-zone ${z.id === zoneId ? 'on' : ''}`} onClick={() => run({ action: 'goto', zoneId: z.id })}>
            {z.name} <span className="dim">{z.kind}</span>
          </button>
        ))}
      </div>
    </>
  );
}

function ViewTab({ renderer, hudHidden, setHudHidden, run }: { renderer: Renderer | null; hudHidden: boolean; setHudHidden: (v: boolean) => void; run: Run }) {
  const [, redraw] = useState(0);
  const flip = (fn: (r: Renderer) => void) => () => {
    if (!renderer) return;
    fn(renderer);
    redraw((n) => n + 1);
  };
  const mark = (on: boolean | undefined, label: string) => (on ? `${label} ✓` : label);
  return (
    <div className="row wrap" style={{ gap: 4 }}>
      <button className="btn sm" onClick={() => setHudHidden(!hudHidden)}>{hudHidden ? 'Show HUD' : 'Hide HUD'}</button>
      <button className="btn sm" onClick={flip((r) => (r.devZoom = !r.devZoom))}>{mark(renderer?.devZoom, 'Far zoom')}</button>
      <button className="btn sm" title="A click or tap on the ground moves the party there at once (Ctrl+click always does)" onClick={flip((r) => (r.tapTeleport = !r.tapTeleport))}>{mark(renderer?.tapTeleport, 'Tap to teleport')}</button>
      <button className="btn sm" title="Show where people can walk (green) and what blocks sight (blue)" onClick={flip((r) => (r.showWalk = !r.showWalk))}>{mark(renderer?.showWalk, 'Walkable')}</button>
      <button className="btn sm" title="Tint characters and creatures with the place's light (off: as painted or rendered)" onClick={flip((r) => (r.figureLight = !r.figureLight))}>{mark(renderer?.figureLight, 'Figure light')}</button>
      <button className="btn sm" title="Load the world again from disk (after a place was painted again)" onClick={() => run({ action: 'reload' })}>Reload world</button>
    </div>
  );
}
