/** The quest log with the journal, and the map of the world. */
import { useMemo, useState } from 'react';
import { currentWays, passedBy, questSteps, type ClientWorld, type PlayerView, type QuestDef, type QuestObjective, type QuestProgress } from '@daydream/shared';
import { client, useGame } from '../net/game';
import { Tab, Tabs, Window, centered, docked, plural, pressable } from './common';
import { MAP_W, WorldMapView } from './worldmap';
import { objectiveWhere, trackedQuest } from './tracker';
import { ask } from './ask';

/** How a quest that is over is marked in the list. */
const ENDED = { completed: 'done', failed: 'failed' } as const;

/**
 * A quest's steps, one after another: a step's other ways are shown after "or", a way not taken fades once another
 * did it, and a step still to come that is kept secret shows as one line of "???", whatever its ways.
 */
function QuestSteps({ world, player, d, p }: { world: ClientWorld; player: PlayerView; d: QuestDef; p: QuestProgress }) {
  const steps = questSteps(d);
  const active = p.status === 'active';
  const now = currentWays(d, p)[0];
  const nowAt = active && now ? steps.findIndex((ways) => ways.some((w) => w.includes(now))) : -1;
  const line = (o: QuestObjective, i: number, or: boolean) => {
    const st = p.objectives[o.id];
    const hidden = o.hidden && nowAt >= 0 && i > nowAt;
    const passed = passedBy(d, p, o);
    const where = !hidden && !st?.done && !passed && active ? objectiveWhere(world, player, o) : undefined;
    return (
      <div key={o.id} className={`obj ${st?.done ? 'done' : ''} ${hidden ? 'hidden' : ''} ${passed ? 'passed' : ''}`}>
        <span className="chk">{st?.done ? '✓' : ''}</span>
        <span>{or && <span className="muted small">or </span>}{hidden ? '???' : o.description}{!hidden && (o.count ?? 1) > 1 ? ` (${st?.progress ?? 0}/${o.count})` : ''}{where && <span className="muted small"> · {where}</span>}</span>
      </div>
    );
  };
  return (
    <>
      {steps.flatMap((ways, i) => (nowAt >= 0 && i > nowAt && ways[0]![0]!.hidden ? [line(ways[0]![0]!, i, false)] : ways.flatMap((w, k) => w.map((o, j) => line(o, i, k > 0 && j === 0)))))}
    </>
  );
}

export function QuestWindow({ onClose }: { onClose: () => void }) {
  const { player, world } = useGame((s) => ({ player: s.player, world: s.world }));
  const c = client();
  const [sel, setSel] = useState<string | null>(null);
  const [tab, setTab] = useState<'quests' | 'journal'>('quests');
  const quests = useMemo(() => {
    if (!player) return [];
    return Object.values(player.quests).map((p) => ({ p, d: player.questDefs[p.questId]! })).filter((x) => x.d);
  }, [player]);
  if (!player || !world) return null;
  const t = world.ruleset.terminology;
  const active = quests.filter((q) => q.p.status === 'active');
  const main = active.filter((q) => q.d.main);
  const side = active.filter((q) => !q.d.main);
  const done = quests.filter((q) => q.p.status !== 'active');
  const cur = quests.find((q) => q.d.id === sel) ?? main[0] ?? side[0] ?? done[0];
  const row = (q: (typeof quests)[number]) => (
    <div key={q.d.id} className={`quest ${cur?.d.id === q.d.id ? 'on' : ''}`} {...pressable(() => setSel(q.d.id))}>
      <div className="qt">{trackedQuest(player)?.id === q.d.id && <span className="pin-dot" title="Tracked" />}{q.d.title}</div>
      <div className="tiny muted">{q.d.main && q.d.arcIndex !== undefined ? world.arcs[q.d.arcIndex]?.title : t.level + ' ' + q.d.level}{q.p.status !== 'active' ? ` · ${ENDED[q.p.status]}` : ''}</div>
    </div>
  );
  return (
    <Window title={`${t.quest} log`} onClose={onClose} style={{ ...docked(760), height: 'min(640px, calc(100% - 160px))' }}>
      <Tabs>
        <Tab on={tab === 'quests'} onPress={() => setTab('quests')}>{plural(t.quest)}</Tab>
        <Tab on={tab === 'journal'} onPress={() => setTab('journal')}>Journal</Tab>
      </Tabs>
      {tab === 'journal' ? (
        <div className="panel-body scroll" style={{ flex: 1 }}>
          {[...player.journal].reverse().map((j, i) => (
            <div key={i} className="row" style={{ alignItems: 'flex-start', padding: '5px 0', borderBottom: '1px solid rgba(255,255,255,.04)' }}>
              <span className="tiny dim" style={{ width: 56, flex: 'none' }}>Day {j.day}</span>
              <span className={j.kind === 'story' ? 'serif' : 'small'} style={j.kind === 'story' ? { fontSize: 15, color: 'var(--gold-2)' } : undefined}>{j.text}</span>
            </div>
          ))}
        </div>
      ) : (
        <div className="row" style={{ alignItems: 'stretch', flex: 1, minHeight: 0 }}>
          <div className="scroll" style={{ width: 260, borderRight: '1px solid var(--line)', padding: 8 }}>
            {main.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>Main story</div>}
            {main.map(row)}
            {side.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>{plural(t.quest)}</div>}
            {side.map(row)}
            {done.length > 0 && <div className="label" style={{ padding: '6px 10px' }}>Finished</div>}
            {done.map(row)}
            {!quests.length && <div className="muted small" style={{ padding: 10 }}>No {plural(t.quest).toLowerCase()} yet. Talk to people.</div>}
          </div>
          <div className="grow scroll panel-body">
            {cur && (
              <div className="col" style={{ gap: 8 }}>
                <div className="display gold" style={{ fontSize: 20 }}>{cur.d.title}</div>
                {cur.d.main && cur.d.arcIndex !== undefined && <div className="tiny muted" style={{ letterSpacing: '.12em', textTransform: 'uppercase' }}>{world.arcs[cur.d.arcIndex]?.title}</div>}
                <div className="serif" style={{ fontSize: 17, lineHeight: 1.5 }}>{cur.d.summary}</div>
                <div className="ornament" />
                <QuestSteps world={world} player={player} d={cur.d} p={cur.p} />
                <div className="small muted" style={{ marginTop: 6 }}>Reward: {cur.d.rewards.xp} {t.xp}, {cur.d.rewards.gold} {t.currency}{cur.d.rewards.items.length ? ', and an item' : ''}</div>
                <div className="ornament" />
                {cur.p.log.slice(-8).map((l, i) => (
                  <div key={i} className="tiny dim">Day {l.day}: {l.text}</div>
                ))}
                {cur.p.status === 'active' && (
                  <div className="row" style={{ gap: 6 }}>
                    {trackedQuest(player)?.id === cur.d.id
                      ? <button className="btn sm" onClick={() => c.send({ t: 'pin_quest', questId: '' })}>Stop tracking</button>
                      : <button className="btn sm primary" onClick={() => c.send({ t: 'pin_quest', questId: cur.d.id })}>Track</button>}
                    {!cur.d.main && <button className="btn sm ghost" onClick={() => void ask(`Abandon this ${t.quest.toLowerCase()}?`, { danger: true }).then((ok) => void (ok && c.send({ t: 'abandon_quest', questId: cur.d.id })))}>Abandon</button>}
                  </div>
                )}
              </div>
            )}
          </div>
        </div>
      )}
    </Window>
  );
}

export function MapWindow({ onClose }: { onClose: () => void }) {
  const { player, world, zone } = useGame((s) => ({ player: s.player, world: s.world, zone: s.zone }));
  const c = client();
  if (!player || !world || !zone) return null;
  const t = world.ruleset.terminology;
  const outer = zone.id;
  const leader = c.leaderEntity();
  const nearWaypoint = zone.features.some((f) => f.kind === 'waypoint' && leader && Math.hypot(f.x - leader.x, f.y - leader.y) < 3);
  const canTravelTo = (id: string) => nearWaypoint && id !== outer && world.zones.find((z) => z.id === id)?.kind === 'town' && player.waypoints.some((w) => w.zoneId === id);
  return (
    <Window title={world.concept.title} onClose={onClose} className="map-window" style={centered(MAP_W + 26, 60, 24)}>
      <div className="panel-body" style={{ padding: 12 }}>
        <WorldMapView world={world} player={player} here={outer} canTravelTo={canTravelTo} onTravel={(id) => (c.send({ t: 'fast_travel', zoneId: id }), onClose())}
          terms={{ town: t.town, dungeon: t.dungeon, wilderness: t.wilderness, level: t.level }} />
        {world.ruleset.systems.fastTravel && <div className="hint" style={{ marginTop: 8 }}>{nearWaypoint ? 'Choose a place with a waypoint ring to travel there.' : `Stand by a waypoint in a ${t.town.toLowerCase()} to travel between visited ${plural(t.town).toLowerCase()}.`}</div>}
      </div>
    </Window>
  );
}
