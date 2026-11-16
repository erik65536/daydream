/**
 * The party display in the top-left corner: the player's own heroes as full frames (portrait with the level on an
 * experience ring, the fight chip, name, Health and statuses), then one compact row per other player in their color:
 * their heroes as small portraits with a sliver of Health and their statuses, their name, where they are, and a way to
 * follow or join them. Whose turn it is glows, the downed are grayed, and those far away are dimmed.
 *
 * Details show on hover, on a finger's tap (long-press where a tap already does something), and under the controller's
 * focus ring: View puts the ring on the party (input/gamepad.ts).
 */
import { rx, talentPoints, xpForLevel, type ActiveStatus, type CharacterState, type EntityView, type RosterEntry, type RosterHero } from '@daydream/shared';
import type { ReactNode } from 'react';
import { client, useGame } from '../net/game';
import { statusLook, statusName } from '../rules';
import { drawShapeIcon } from '../render/fx';
import { Bar, CanvasDraw, Portrait, holdTip, tip } from './common';
import { Icon } from './svgicons';
import { Glyph } from './pad';

export function PartyFrames() {
  const { player, world, focused } = useGame((s) => ({ player: s.player, world: s.world, focused: s.partyFocus, v: s.version }));
  if (!player || !world) return null;
  return (
    <div className={`party ${focused ? 'pad-nav' : ''}`} data-hud>
      {player.party.map((ch) => <HeroFrame key={ch.id} ch={ch} />)}
      <Friends />
      {focused && <div className="party-hint"><Glyph b="B" /> back</div>}
    </div>
  );
}

/** One of the player's own heroes. A click (or tap) picks them; the chip on the portrait says who decides their turns. */
function HeroFrame({ ch }: { ch: CharacterState }) {
  const { combat, selected } = useGame((s) => ({ combat: s.combat, selected: s.selectedCharId }));
  const c = client();
  const r = c.r;
  const ix = rx(r);
  const terms = r.terminology;
  const stats = c.charStats(ch);
  const statuses = c.state.entities.get(ch.id)?.statuses ?? ch.statuses;
  const acting = !!combat?.actingIds.includes(ch.id);
  const xpLo = xpForLevel(r, ch.level), xpHi = xpForLevel(r, ch.level + 1);
  const maxed = ch.level >= r.progression.maxLevel;
  const xpPct = maxed ? 100 : Math.max(0, Math.min(100, ((ch.xp - xpLo) / Math.max(1, xpHi - xpLo)) * 100));
  return (
    <div
      className={`pf-hero ${selected === ch.id ? 'sel' : ''} ${acting ? 'acting' : ''} ${ch.downed ? 'down' : ''}`}
      data-pad
      onClick={() => {
        c.update({ selectedCharId: ch.id });
        c.lookHome();
        if (!combat) c.send({ t: 'set_leader', charId: ch.id });
      }}
      {...tip(
        <div>
          <div className="tname gold">{ch.name}</div>
          <div className="tsub">{terms.level} {ch.level} {ix.kin.get(ch.kinId)?.name} {ix.cls.get(ch.classId)?.name}{ch.ai ? ' · fights on their own' : ''}</div>
          <div className="tline">{r.health.name} {Math.round(ch.hp)}/{stats.maxHp}{ch.downed ? ' · downed' : ''}</div>
          <div className="tsub">{maxed ? `Maximum ${terms.level.toLowerCase()}` : `${terms.xp} ${ch.xp}/${xpHi}`}</div>
          {ch.treePoints > 0 && <div className="tsub" style={{ color: 'var(--gold-2)' }}>{talentPoints(r, ch.treePoints)} to spend (K)</div>}
        </div>,
      )}
    >
      <button
        type="button"
        className={`aichip ${ch.ai ? 'on' : ''}`}
        aria-pressed={!!ch.ai}
        aria-label={ch.ai ? `${ch.name} fights on their own` : `You command ${ch.name}`}
        {...tip(<div><div className="tname">{ch.ai ? `${ch.name} fights on their own` : `You command ${ch.name}`}</div><div className="tsub">{ch.ai ? 'Click to command them in fights yourself.' : 'Click to let them fight on their own. Out of fights they follow you either way.'}</div></div>)}
        onClick={(e) => {
          e.stopPropagation();
          c.send({ t: 'set_ai', charId: ch.id, ai: !ch.ai });
        }}
      >
        <Icon name="own" size={13} color="currentColor" />
      </button>
      {/* The level sits on a ring around the portrait that fills with experience toward the next. */}
      <div className="pf-face">
        <div className="portrait"><Portrait size={48} sprite={c.assetUrl(ch.sprite, 'figure')} /></div>
        <svg className="xpring" viewBox="0 0 40 40" aria-hidden="true">
          <circle className="track" cx="20" cy="20" r="18.5" pathLength={100} />
          <circle className="fill" cx="20" cy="20" r="18.5" pathLength={100} strokeDasharray={`${xpPct} 100`} />
        </svg>
        <span className={`plvl ${maxed ? 'max' : ''}`} aria-label={`${terms.level} ${ch.level}`}>{ch.level}</span>
      </div>
      <div className="pf-body">
        <div className="pf-name">
          <span className="nm">{ch.name}</span>
          {ch.treePoints > 0 && <span className="pts">+{ch.treePoints}</span>}
        </div>
        <Health hp={ch.hp} max={stats.maxHp} downed={ch.downed} numbers />
        {statuses.length > 0 && <StatusChips statuses={statuses} />}
      </div>
    </div>
  );
}

/** A Health bar in the world's color: the numbers over it on the player's own frames, "Downed" when it is empty. */
function Health({ hp, max, downed, numbers }: { hp: number; max: number; downed?: boolean; numbers?: boolean }) {
  const color = client().r.health.color;
  const fill = `linear-gradient(90deg, color-mix(in srgb, ${color} 55%, #000), ${color})`;
  const label = downed ? 'Downed' : numbers ? `${Math.round(hp)} / ${Math.round(max)}` : undefined;
  return <Bar value={downed ? 0 : hp} max={max} color={fill} label={label} />;
}

/** What a status is and does, with the turns it has left. */
function StatusTip({ st }: { st: ActiveStatus }) {
  const def = rx(client().r).status.get(st.id);
  const color = def?.color ?? statusLook(st.id).colors[0]!;
  return (
    <div className="pf-tipstatus">
      <StatusIcon id={st.id} size={14} />
      <div>
        <div className="tname" style={{ color }}>{statusName(st.id)} <span className="dim">· {Math.ceil(st.turns)} turn{Math.ceil(st.turns) === 1 ? '' : 's'}</span></div>
        {def?.description && <div className="tsub">{def.description}</div>}
      </div>
    </div>
  );
}

function StatusIcon({ id, size }: { id: string; size: number }) {
  const look = statusLook(id);
  return <CanvasDraw size={size} draw={(ctx, s) => drawShapeIcon(ctx, look.shapes[0]!, look.colors[0]!, s)} deps={[id, look.shapes[0], look.colors[0]]} />;
}

/** Harmful statuses first: they are the ones to act on. */
function byHarm(statuses: ActiveStatus[]): ActiveStatus[] {
  const ix = rx(client().r);
  return [...statuses].sort((a, b) => Number(!!ix.status.get(b.id)?.harmful) - Number(!!ix.status.get(a.id)?.harmful));
}

/**
 * Lasting states: a chip per status with its own shape in its colors and the turns left; a harmful one has a red
 * foot. A tap shows what it does (and does not pick the hero under it).
 */
function StatusChips({ statuses }: { statuses: ActiveStatus[] }) {
  const ix = rx(client().r);
  const list = byHarm(statuses);
  return (
    <div className="pstats">
      {list.slice(0, 6).map((st) => {
        const def = ix.status.get(st.id);
        const color = def?.color ?? statusLook(st.id).colors[0]!;
        return (
          <span key={st.id} className={`pstat ${def?.harmful ? 'bad' : 'good'}`} style={{ '--sc': color } as React.CSSProperties} data-pad {...tapTip(<StatusTip st={st} />)}>
            <StatusIcon id={st.id} size={14} />
            <span className="turns">{Math.ceil(st.turns)}</span>
          </span>
        );
      })}
      {list.length > 6 && <span className="pstat more" data-pad {...tapTip(<div>{list.slice(6).map((st) => <StatusTip key={st.id} st={st} />)}</div>)}>+{list.length - 6}</span>}
    </div>
  );
}

/** Hover help that a tap also shows, for things a tap does nothing else with. */
function tapTip(content: ReactNode) {
  return {
    ...tip(content),
    onClick: (e: React.MouseEvent<HTMLElement>) => {
      if ((e.nativeEvent as PointerEvent).pointerType !== 'touch') return;
      e.stopPropagation();
      holdTip(e.currentTarget, content);
    },
  };
}

/** The other players in the game now (or dropped out a moment ago, their heroes still here), those close by first. */
function Friends() {
  const { roster, userId, zone, combat, following } = useGame((s) => ({ roster: s.roster, userId: s.userId, zone: s.zone?.id, combat: s.combat, following: s.player?.following ?? null }));
  const others = roster.filter((p) => p.userId !== userId && (p.online || p.away));
  if (!others.length) return null;
  const sorted = [...others].sort((a, b) => Number(a.zoneId !== zone) - Number(b.zoneId !== zone));
  return (
    <div className="friends">
      {sorted.map((p) => <FriendRow key={p.userId} p={p} here={p.zoneId === zone} inFight={!!combat} followed={following === p.userId} />)}
    </div>
  );
}

/**
 * Another player: their name and where they are on one line, their heroes under it. Close by they can be followed;
 * elsewhere joined (neither in a fight). While followed, the button says so and stops it. Dropped out, the row dims.
 */
function FriendRow({ p, here, inFight, followed }: { p: RosterEntry; here: boolean; inFight: boolean; followed: boolean }) {
  const c = client();
  const place = c.state.world?.zones.find((z) => z.id === p.zoneId)?.name ?? 'somewhere';
  const where = p.away ? 'dropped out' : here ? (p.fighting ? 'fighting here' : 'here') : p.fighting ? `fighting in ${place}` : place;
  const action = followed ? 'following' : p.away ? null : here ? 'follow' : 'join';
  const blocked = action !== 'following' && (inFight || (action === 'join' && p.fighting));
  const help = {
    following: `Following ${p.name}, into other places too, and after fights. Click to stop; going anywhere yourself stops it as well.`,
    follow: `Walk after ${p.name}`,
    join: p.fighting ? `${p.name} is in a fight: go there to join it` : `Go to ${p.name} in ${place}`,
  };
  const send = { following: { t: 'follow', userId: null }, follow: { t: 'follow', userId: p.userId }, join: { t: 'join_friend', userId: p.userId } } as const;
  return (
    <div className={`pf-friend ${here ? 'here' : 'far'} ${p.away ? 'away' : ''}`} style={{ '--pc': p.color } as React.CSSProperties}>
      <div className="pf-line">
        <div
          className="pf-who"
          {...tapTip(
            <div>
              <div className="tname" style={{ color: p.color }}>{p.name}</div>
              <div className="tsub">{where[0]!.toUpperCase() + where.slice(1)}{p.away ? ': their heroes fight on their own for a minute' : ''}</div>
            </div>,
          )}
        >
          <span className="nm">{p.name}</span>
          {p.fighting && <Icon name="fight" size={11} color="#ff9a7a" />}
          <span className="where">{where}</span>
        </div>
        {action && (
          <button className={action === 'following' ? 'pf-go on' : 'pf-go'} aria-pressed={action === 'join' ? undefined : action === 'following'} disabled={blocked} onClick={() => c.send(send[action])} {...tip(help[action])}>
            {action === 'following' ? 'Following' : action === 'follow' ? 'Follow' : 'Join'}
          </button>
        )}
      </div>
      <div className="pf-minis">
        {p.heroes.map((h) => <FriendHero key={h.id} hero={h} owner={p} live={here ? (c.state.entities.get(h.id) as EntityView | undefined) : undefined} />)}
      </div>
    </div>
  );
}

/** A friend's hero: portrait ringed in their color, a sliver of Health under it, their worst statuses on its shoulder. */
function FriendHero({ hero, owner, live }: { hero: RosterHero; owner: RosterEntry; live?: EntityView }) {
  const { acting: actingIds } = useGame((s) => ({ acting: [...(s.combat?.actingIds ?? []), ...s.watched.flatMap((f) => f.actingIds)].join() }));
  const c = client();
  const r = c.r;
  // In the same place the hero's own entity is live; elsewhere the roster tells (once a second).
  const hp = live?.hp ?? hero.hp, maxHp = live?.maxHp ?? hero.maxHp, statuses = byHarm(live?.statuses ?? hero.statuses);
  const downed = live ? !!live.downed || live.hp <= 0 : !!hero.downed;
  const ai = live ? !!live.ai : !!hero.ai;
  const acting = actingIds.split(',').includes(hero.id);
  const ix = rx(r);
  return (
    <div
      className={`pf-mini ${acting ? 'acting' : ''} ${downed ? 'down' : ''}`}
      data-pad
      {...tapTip(
        <div>
          <div className="tname" style={{ color: owner.color }}>{hero.name}</div>
          <div className="tsub">{r.terminology.level} {hero.level} · {owner.name}’s hero{ai ? ' · fights on their own' : ''}</div>
          <div className="tline">{r.health.name} {Math.ceil(hp)}/{Math.round(maxHp)}{downed ? ' · downed' : ''}</div>
          {statuses.map((st) => <StatusTip key={st.id} st={st} />)}
        </div>,
      )}
    >
      <div className="face"><Portrait size={34} sprite={c.assetUrl(hero.sprite, 'figure')} /></div>
      <div className="hp"><div style={{ width: `${downed ? 0 : Math.max(0, Math.min(100, (hp / Math.max(1, maxHp)) * 100))}%`, background: r.health.color }} /></div>
      {statuses.length > 0 && (
        <div className="sts">
          {statuses.slice(0, 2).map((st) => (
            <span key={st.id} className={`st ${ix.status.get(st.id)?.harmful ? 'bad' : ''}`}><StatusIcon id={st.id} size={10} /></span>
          ))}
          {statuses.length > 2 && <span className="st more">+{statuses.length - 2}</span>}
        </div>
      )}
    </div>
  );
}
