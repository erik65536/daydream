import { readable } from './theme';
import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { PX_PER_METER, fogSize, listing, outsideFights, rx, skillAp, skillRank, type EntityView } from '@daydream/shared';
import { client, tryClient, useGame, type Panel as AnyPanel } from '../net/game';
import { QuestTracker } from './tracker';
import { Glyph } from './pad';
import { Portrait, SkillIcon, SkillTooltip, hasCrafting, pressable, tip } from './common';
import { Icon } from './svgicons';
import { Typed } from './spoken';
import { loadImage } from '../render/sprites';

function Minimap({ onOpen }: { onOpen: () => void }) {
  const ref = useRef<HTMLCanvasElement>(null);
  const zoneVersion = useGame((s) => s.zoneVersion);
  useEffect(() => {
    const draw = () => {
      const cv = ref.current;
      const c = tryClient();
      if (!c) return;
      const z = c.state.zone;
      const explored = c.state.explored;
      const img = z?.painting ? loadImage(c.assetUrl(z.painting.image)) : null;
      if (!cv || !z?.painting || !explored || !img) return;
      const S = 200;
      cv.width = S * 2;
      cv.height = S * 2;
      const ctx = cv.getContext('2d')!;
      ctx.setTransform(2, 0, 0, 2, 0, 0);
      // Transparent: a light sketch of the place over the world, fading out at the edges.
      ctx.clearRect(0, 0, S, S);
      const leader = c.leaderEntity();
      const lp = leader ? c.entityPos(leader) : { x: z.width / 2, y: z.height / 2 };
      // The painting itself, small, showing only the ground the party has seen.
      const scale = 3.2;
      const k = scale / PX_PER_METER;
      const cx = S / 2, cy = S / 2;
      const mapP = (x: number, y: number) => ({ x: cx + (x - lp.x) * scale, y: cy + (y - lp.y) * scale });
      const o = mapP(0, 0);
      ctx.globalAlpha = 0.85;
      const px = o.x - z.painting.ox * k, py = o.y - z.painting.oy * k, pw = z.painting.width * k, ph = z.painting.height * k;
      ctx.drawImage(img, px, py, pw, ph);
      ctx.globalAlpha = 1;
      // The painting's edge fades out, as it sinks into the game view's mist (over about three meters here).
      ctx.save();
      ctx.globalCompositeOperation = 'destination-out';
      const F = 3 * scale;
      for (const [x0, y0, x1, y1, rx, ry, rw, rh] of [
        [px, 0, px + F, 0, px, py, F, ph], [px + pw, 0, px + pw - F, 0, px + pw - F, py, F, ph],
        [0, py, 0, py + F, px, py, pw, F], [0, py + ph, 0, py + ph - F, px, py + ph - F, pw, F],
      ] as const) {
        const g = ctx.createLinearGradient(x0, y0, x1, y1);
        g.addColorStop(0, 'rgba(0,0,0,1)');
        g.addColorStop(1, 'rgba(0,0,0,0)');
        ctx.fillStyle = g;
        ctx.fillRect(rx, ry, rw, rh);
      }
      ctx.restore();
      const fog = fogSize(z);
      const mask = document.createElement('canvas');
      mask.width = fog.w;
      mask.height = fog.h;
      const md = mask.getContext('2d')!.createImageData(fog.w, fog.h);
      for (let i = 0; i < fog.w * fog.h; i++) if (explored.get(i)) md.data[i * 4 + 3] = 255;
      mask.getContext('2d')!.putImageData(md, 0, 0);
      ctx.save();
      ctx.globalCompositeOperation = 'destination-in';
      // Square meter (x, y) sits at mapP(x, y): the mask's pixels are meters.
      ctx.setTransform(2 * scale, 0, 0, 2 * scale, 2 * o.x, 2 * o.y);
      ctx.imageSmoothingEnabled = true;
      ctx.drawImage(mask, -0.5, -0.5);
      ctx.restore();
      // Ways out, the waypoint, and what a quest step needs (in the quest yellow of the people with one).
      for (const f of z.features) {
        if (!c.seen(f.x, f.y)) continue;
        const quest = c.questThing(f);
        if (f.kind !== 'exit' && f.kind !== 'waypoint' && !quest) continue;
        const p = mapP(f.x, f.y);
        ctx.fillStyle = quest ? '#ffd24a' : f.kind === 'waypoint' ? '#8fd8ff' : '#ffe08a';
        ctx.beginPath();
        ctx.arc(p.x, p.y, quest ? 3.2 : 2.5, 0, Math.PI * 2);
        ctx.fill();
        if (quest) {
          ctx.strokeStyle = 'rgba(30,20,0,0.85)';
          ctx.lineWidth = 1.2;
          ctx.stroke();
        }
      }
      for (const e of c.state.entities.values()) {
        if (e.dead) continue;
        const ep = c.entityPos(e);
        if (!c.seen(ep.x, ep.y)) continue;
        const p = mapP(ep.x, ep.y);
        ctx.fillStyle = e.ownerUserId === c.state.userId ? '#7fd0ff' : e.hostile ? '#ff5a4a' : e.kind === 'character' ? '#9fe0a0' : c.state.player?.npcMarkers[e.id] ? '#ffd24a' : '#e0d0b0';
        ctx.beginPath();
        ctx.arc(p.x, p.y, e.ownerUserId === c.state.userId ? 3 : 2.2, 0, Math.PI * 2);
        ctx.fill();
      }
      // Where you are: a ring at the center.
      ctx.strokeStyle = 'rgba(255,255,255,0.9)';
      ctx.lineWidth = 1.2;
      ctx.beginPath();
      ctx.arc(cx, cy, 5.5, 0, Math.PI * 2);
      ctx.stroke();
      // Soft circular edge.
      const fade = ctx.createRadialGradient(cx, cy, S * 0.3, cx, cy, S * 0.5);
      fade.addColorStop(0, 'rgba(0,0,0,1)');
      fade.addColorStop(1, 'rgba(0,0,0,0)');
      ctx.globalCompositeOperation = 'destination-in';
      ctx.fillStyle = fade;
      ctx.fillRect(0, 0, S, S);
      ctx.globalCompositeOperation = 'source-over';
    };
    draw();
    const t = setInterval(draw, 400);
    return () => clearInterval(t);
  }, [zoneVersion]);
  return (
    <div className="minimap" data-hud {...pressable(onOpen)} aria-label="Map" {...tip(<div><b>Map</b> <kbd>M</kbd></div>)}>
      <canvas ref={ref} />
    </div>
  );
}

/** A window the HUD's buttons open. */
type Panel = NonNullable<AnyPanel>;

export function TopRight({ open }: { open: (p: Panel) => void }) {
  const { zone, clockAt, paused } = useGame((s) => ({ zone: s.zone, clockAt: s.clock?.minute, paused: s.clock?.paused }));
  const [, force] = useState(0);
  useEffect(() => {
    const t = setInterval(() => force((x) => x + 1), 1000);
    return () => clearInterval(t);
  }, []);
  const m = client().clockMinute();
  const day = Math.floor(m / 1440) + 1;
  const h = Math.floor((m % 1440) / 60), mm = Math.floor(m % 60);
  void clockAt;
  return (
    <div className="topright">
      <div className="map-head">
        <div className="zone-name">{zone?.name}</div>
        <div className="clock">
          Day {day} · {String(h).padStart(2, '0')}:{String(mm).padStart(2, '0')}
          {paused ? ' · paused' : ''}
        </div>
      </div>
      <Minimap onOpen={() => open('map')} />
      <QuestTracker onOpen={() => open('quests')} />
    </div>
  );
}

/** The game's menus, as a slim bar in the bottom-right corner beside the action bar. */
export function SystemBar({ open, onChat }: { open: (p: Panel) => void; onChat: () => void }) {
  const { world, player, others } = useGame((s) => ({ world: s.world, player: s.player, others: s.roster.filter((p) => p.userId !== s.userId).length }));
  const points = player?.party.reduce((s, c) => s + c.treePoints, 0) ?? 0;
  const r = world?.ruleset;
  const crafting = !!r && hasCrafting(r);
  const btn = (p: Exclude<Panel, 'storage' | 'settings'>, label: string, k: string, badge?: number) => (
    <button className={`btn sb-${p}`} aria-label={label} aria-keyshortcuts={k === 'Esc' ? 'Escape' : k} onClick={() => open(p)} {...tip(<div><b>{label}</b> <kbd>{k}</kbd></div>)}>
      <Icon name={p} />
      {badge ? <span className="points">{badge}</span> : null}
    </button>
  );
  return (
    <div className="systembar">
      {btn('character', 'Character', 'C')}
      {btn('inventory', 'Pack', 'I')}
      {btn('skills', 'Talents', 'K', points)}
      {btn('quests', `${r?.terminology.quest ?? 'Quest'} log`, 'J')}
      {crafting && btn('craft', 'Crafting', 'B')}
      {btn('codex', 'Codex', 'X')}
      {btn('map', 'Map', 'M')}
      {others > 0 && (
        <button className="btn sb-chat" aria-label="Talk to everyone" aria-keyshortcuts="Enter" onClick={onChat} {...tip(<div><b>Talk to everyone</b> <kbd>Enter</kbd></div>)}>
          <Icon name="chat" />
        </button>
      )}
      {btn('menu', 'Menu', 'Esc')}
    </div>
  );
}

export function startSkill(charId: string, skillId: string) {
  const c = client();
  const s = rx(c.r).skill.get(skillId);
  if (!s) return;
  if (s.targeting === 'self') {
    c.send({ t: 'use_skill', charId, skillId });
    c.update({ targeting: null });
    return;
  }
  const cur = c.state.targeting;
  if (cur?.skillId === skillId && cur.charId === charId) c.update({ targeting: null });
  else c.update({ targeting: { charId, skillId } });
}

/** The last seconds of a turn with a limit (several players in the fight) counted down. */
const LAST_SECONDS = 10;

/** The seconds left of the turn once its last ones have come; null before then, and in a fight without a limit. */
function useLastSeconds(): number | null {
  const { limit, started } = useGame((s) => ({ limit: s.combat?.turnLimit, started: s.combat?.turnStartedAt }));
  const [, tick] = useState(0);
  useEffect(() => {
    if (!limit) return;
    const t = setInterval(() => tick((x) => x + 1), 250);
    return () => clearInterval(t);
  }, [limit, started]);
  if (!limit || started === undefined) return null;
  const left = Math.ceil(limit - (client().serverNow() - started) / 1000);
  return left <= LAST_SECONDS ? Math.max(0, left) : null;
}

export function ActionBar() {
  const { player, combat, targeting, world } = useGame((s) => ({ player: s.player, combat: s.combat, targeting: s.targeting, world: s.world }));
  const c = client();
  const secs = useLastSeconds();
  if (!player || !world) return null;
  const r = world.ruleset;
  const ix = rx(r);
  const terms = r.terminology;
  const ch = c.selectedHero();
  if (!ch) return null;
  const order = combat?.order.find((o) => o.id === ch.id);
  const myTurn = c.isMyTurn() && c.myActor() === ch.id;
  const stats = c.charStats(ch);
  const ap = order?.ap ?? 0;
  const tsk = targeting?.skillId ? ix.skill.get(targeting.skillId) : undefined;
  const hover = tsk ? skillAp(tsk, stats) : 0;
  const slots = Array.from({ length: 10 }, (_, i) => ch.hotbar[i] ?? null);
  const pips = Math.max(stats.apMax, ap);
  // A turn only ends when the player says so (fleeing and looking around cost nothing); once nothing is left to
  // spend, the button says it is time.
  const spent = myTurn && !!order && ap <= 0 && order.movementLeft < 1;
  // With several of the player's heroes in one turn, each ends their own: the button says whose.
  const several = c.myActors().length > 1;
  // Friends' heroes whose turns come with this one act at the same time.
  const along = combat ? combat.order.filter((o) => combat.actingIds.includes(o.id) && o.ownerUserId !== c.state.userId && o.team === 'players') : [];
  return (
    <div className="actionbar" data-hud>
      {combat && order && (
        <div className="turn-strip">
          <div className="pips" {...tip(<div><b>{terms.actionPoints}</b>: {ap} / {stats.apMax}<div className="tsub">+{stats.apPerTurn} each turn. Moving costs 1 per {stats.move.toFixed(1)} tiles.</div></div>)}>
            {Array.from({ length: pips }, (_, i) => (
              <div key={i} className={`pip ${i < ap ? (myTurn && i >= ap - hover ? 'spend' : 'on') : ''}`} />
            ))}
          </div>
          {myTurn ? (
            <>
              <button className={`end-turn ${spent ? 'ready' : ''}`} onClick={() => c.send({ t: 'end_turn', charId: c.myActor() })}>{several ? `End ${ch.name}’s turn` : 'End turn'}{secs !== null && <span className="secs" role="timer" aria-label={`${secs} seconds left`}>{secs}</span>}<span className="key-hint">Space</span><span className="pad-hint"><Glyph b="Y" /></span></button>
              <button className="flee" onClick={() => c.send({ t: 'flee' })} {...tip('Call the retreat when no foe is near: everyone on your side leaves the fight together.')}>Flee<span className="pad-hint"><Glyph b="B" /></span></button>
              {along.length > 0 && <span className="together" {...tip('Turns that come one after another are taken together: you and they act at the same time.')}>with {listing(along.map((o) => o.name))}</span>}
            </>
          ) : (
            <span className="waiting">{listing(combat.order.filter((o) => combat.actingIds.includes(o.id)).map((o) => o.name))}’s turn…</span>
          )}
        </div>
      )}
      <div className="slots">
        <span className="pad-hint"><Glyph b="RT" /></span>
        {slots.map((id, i) => {
          const s = id ? ix.skill.get(id) : undefined;
          if (!id || !s) return <div key={i} className="slot na empty"><span className="key">{(i + 1) % 10}</span></div>;
          const cd = ch.cooldowns[id] ?? 0;
          const sap = skillAp(s, stats);
          const lacking = combat && order && sap > ap;
          // Out of fights the bar is for helpful skills, and an attack on a foe opens a fight with it; a skill with
          // nothing to do until a fight rests faded.
          const role = outsideFights(r, s);
          const resting = !combat && role === 'none';
          const when = combat ? '' : { help: '', opener: 'On a foe, starts a fight with this as your first move.', none: 'Only in a fight.' }[role];
          return (
            <div
              key={i}
              className={`slot ${targeting?.skillId === id && targeting.charId === ch.id ? 'on' : ''} ${cd > 0 ? 'cd' : ''} ${lacking ? 'na' : ''} ${resting ? 'resting' : ''}`}
              style={cd > 0 ? ({ '--cdf': Math.min(1, cd / Math.max(1, s.cooldown)) } as React.CSSProperties) : undefined}
              onClick={() => (!combat || c.isMyTurn()) && startSkill(ch.id, id)}
              {...tip(<div><SkillTooltip id={id} r={r} stats={stats} cooldown={cd} rank={skillRank(r, ch, id)} />{when && <div className="tsub" style={{ marginTop: 6 }}>{when}</div>}</div>)}
            >
              <span className="key">{(i + 1) % 10}</span>
              <SkillIcon id={id} />
              {cd > 0 && <span className="cdn">{cd}</span>}
              {combat && <span className="ap">{sap}</span>}
            </div>
          );
        })}
      </div>
    </div>
  );
}

/**
 * The order of a fight's turns, from whoever acts now: their portrait large with their name under it, those still to
 * act this round after them, then a mark for the next round, and those who acted already. Each portrait is ringed in
 * its side's color (the player's own heroes in their player color) with a sliver of Health under it; the downed are
 * grayed. Floating over the world without a panel, like the rest of the HUD.
 */
export function TurnBar() {
  const { combat, entities, userId } = useGame((s) => ({ combat: s.combat, entities: s.entities, userId: s.userId, v: s.version }));
  const c = client();
  if (!combat) return null;
  const order = combat.order.filter((o) => !(entities.get(o.id) as EntityView | undefined)?.dead);
  const first = Math.max(0, order.findIndex((o) => combat.actingIds.includes(o.id)));
  const now = order.slice(first), next = order.slice(0, first);
  const actingNow = now.filter((o) => combat.actingIds.includes(o.id));
  const shared = actingNow.length > 1;
  const cell = (o: (typeof order)[number]) => {
    const e = entities.get(o.id) as EntityView | undefined;
    // Downed allies stay in the order (they can be revived); unseen combatants get a placeholder.
    const downed = !!e && e.hp <= 0;
    // Everyone acting now is drawn large and named: heroes whose turns come together act at the same time.
    const acting = combat.actingIds.includes(o.id);
    const mine = o.ownerUserId === userId;
    const ring = o.team === 'enemies' || !o.ownerUserId ? undefined : c.colorOf(o.ownerUserId);
    return (
      <div
        key={o.id}
        className={`tp ${o.team} ${acting ? 'active lead' : ''} ${downed ? 'dead' : ''}`}
        style={ring ? ({ '--ring': ring } as React.CSSProperties) : undefined}
        {...tip(<div><b>{o.name}</b>{e ? <div className="tsub">{Math.ceil(e.hp)}/{Math.round(e.maxHp)} · {mine ? 'yours' : o.team === 'players' ? 'ally' : 'foe'}</div> : <div className="tsub">out of sight</div>}</div>)}
      >
        <div className="tp-face">{e ? <Portrait size={acting ? 46 : 36} sprite={c.assetUrl(e.sprite, 'figure')} /> : <span className="tp-unseen">{o.name.slice(0, 1)}</span>}</div>
        {e && <div className="tp-hp"><div style={{ width: `${Math.max(0, Math.min(100, (e.hp / Math.max(1, e.maxHp)) * 100))}%` }} /></div>}
        {acting && <div className="tp-name">{o.name}</div>}
      </div>
    );
  };
  return (
    <div className="turnbar" data-hud aria-label={`Round ${combat.round}`}>
      <div className="tb-round"><span>Round</span><b>{combat.round}</b></div>
      <div className={`tb-now ${shared ? 'shared' : ''}`}>{actingNow.map(cell)}</div>
      {now.slice(actingNow.length).map(cell)}
      {next.length > 0 && <div className="tb-next" aria-label={`Round ${combat.round + 1}`}><span>{combat.round + 1}</span></div>}
      {next.map(cell)}
    </div>
  );
}

/** A friend talking with someone close by: a note to listen in (and speak) without being pulled into it. */
export function SceneInvites() {
  const { scenes, userId, dialog, roster } = useGame((s) => ({ scenes: s.scenes, userId: s.userId, dialog: s.dialog, roster: s.roster }));
  const c = client();
  const lead = c.leaderEntity();
  const near = scenes.filter((sc) => {
    if (sc.userIds.includes(userId ?? '') || dialog?.npcId === sc.npcId) return false;
    const npc = c.state.entities.get(sc.npcId);
    if (!npc || !lead) return false;
    const a = c.entityPos(npc), b = c.entityPos(lead);
    return Math.hypot(a.x - b.x, a.y - b.y) < 14;
  });
  if (!near.length) return null;
  return (
    <div className="scene-invites">
      {near.map((sc) => {
        const who = sc.userIds.map((u, i) => <b key={u} style={{ color: c.colorOf(u) }}>{sc.heroes[i] || roster.find((r) => r.userId === u)?.name}</b>);
        return (
          <div key={sc.npcId} className="scene-invite">
            <span>{who.reduce<React.ReactNode[]>((acc, x, i) => (i ? [...acc, i === who.length - 1 ? ' and ' : ', ', x] : [x]), [])} {who.length > 1 ? 'are' : 'is'} talking to {sc.npcName}</span>
            <button className="btn sm" onClick={() => c.send({ t: 'listen', npcId: sc.npcId })}>Listen</button>
          </div>
        );
      })}
    </div>
  );
}

/** Chat: Enter (or the speech button) opens a line to everyone in the adventure; what is said also shows over the speaker's hero. */
export function ChatLine({ open, onClose }: { open: boolean; onClose: () => void }) {
  const [text, setText] = useState('');
  const ref = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (open) ref.current?.focus();
  }, [open]);
  if (!open) return null;
  const send = () => {
    if (text.trim()) client().send({ t: 'chat', text: text.trim() });
    setText('');
    onClose();
  };
  return (
    <div className="chatline" onMouseDown={(e) => e.stopPropagation()}>
      <input
        ref={ref}
        className="input"
        value={text}
        maxLength={300}
        enterKeyHint="send"
        placeholder="Say something to everyone…"
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          e.stopPropagation();
          if (e.key === 'Escape') onClose();
          if (e.key === 'Enter') send();
          // The history stands open above the line while writing: Page Up and Down read back through it.
          if (e.key === 'PageUp' || e.key === 'PageDown') {
            const h = document.querySelector('.log-history');
            h?.scrollBy({ top: (e.key === 'PageUp' ? -0.8 : 0.8) * h.clientHeight });
          }
        }}
        onBlur={onClose}
      />
      {/* Pressing the button keeps the field focused, so the line is not closed before it is sent. */}
      <button className="btn primary icon-btn" aria-label="Send" onPointerDown={(e) => e.preventDefault()} onClick={send}>
        <Icon name="send" size={16} color="currentColor" />
      </button>
    </div>
  );
}

export function Toasts() {
  const toasts = useGame((s) => s.toasts);
  return (
    <div className="toasts">
      {toasts.map((t) => (
        <div key={t.id} className={`toast ${t.kind}`}>{t.text}</div>
      ))}
    </div>
  );
}

/** How long a mouse rests on the log's lines before the history opens (passing over them on the way to the ground does not). */
const HISTORY_HOVER_MS = 350;

/**
 * Chat and what happened nearby, at the bottom left. The last lines sit quietly over the game and let clicks through
 * everywhere but on their own words. Resting the mouse on them, tapping them, writing a line (Enter), or choosing Chat
 * on the controller's menu wheel opens the whole history, to scroll with the wheel, a finger, Page Up and Down, or the
 * right stick. Reading back keeps its place while lines come in, with a quiet cue that leads back down to them.
 */
export function ChatLog({ chatting }: { chatting: boolean }) {
  const { log, chat, pinned, pad } = useGame((s) => ({ log: s.log, chat: s.chat, pinned: s.historyOpen, pad: s.inputMode === 'pad' }));
  const c = client();
  const items = useMemo(
    () => [...log.map((l) => ({ at: l.at, text: l.text, color: l.color })), ...chat.map((m) => ({ at: m.at, text: `${m.from}: ${m.text}`, color: c.colorOf(m.userId) }))].sort((a, b) => a.at - b.at),
    [log, chat],
  );
  const [hover, setHover] = useState(false);
  const open = items.length > 0 && (hover || pinned || chatting);
  const cell = useRef<HTMLDivElement>(null), box = useRef<HTMLDivElement>(null), hoverTimer = useRef(0);
  const atEnd = useRef(true), last = useRef('');
  const [unread, setUnread] = useState(0);
  const [over, setOver] = useState<{ left: number; lift: number; width: number } | null>(null);

  const toEnd = () => {
    if (box.current) box.current.scrollTop = box.current.scrollHeight;
    atEnd.current = true;
    setUnread(0);
  };
  // Opening starts at the newest line; while writing, the history stands on the line being written where they would meet.
  useLayoutEffect(() => {
    if (!open) return;
    toEnd();
    const line = chatting ? document.querySelector('.chatline')?.getBoundingClientRect() : null, at = cell.current?.getBoundingClientRect();
    setOver(line && at && line.top < at.bottom && line.left < at.right ? { left: line.left - at.left, lift: at.bottom - line.top + 6, width: line.width } : null);
  }, [open, chatting]);
  // New lines: followed when reading the newest, counted in the cue when reading back.
  useLayoutEffect(() => {
    const key = (l?: (typeof items)[number]) => (l ? `${l.at}|${l.text}` : '');
    const seen = items.findLastIndex((l) => key(l) === last.current);
    const fresh = items.length - 1 - seen;
    last.current = key(items.at(-1));
    if (!open || !fresh) return;
    if (atEnd.current) toEnd();
    else setUnread((n) => n + fresh);
  }, [items]);
  // Opened by a tap or the controller, it stays open until a touch or click elsewhere (or Escape, or B).
  useEffect(() => {
    if (!pinned) return;
    const away = (e: PointerEvent) => !box.current?.contains(e.target as Node) && c.update({ historyOpen: false });
    addEventListener('pointerdown', away, true);
    return () => removeEventListener('pointerdown', away, true);
  }, [pinned]);
  useEffect(() => () => clearTimeout(hoverTimer.current), []);

  const line = (l: (typeof items)[number], i: number) => <div key={i} style={{ color: readable(l.color) }}>{l.text}</div>;
  return (
    <div ref={cell} className={`log${open ? ' open' : ''}`}>
      <div
        className="log-recent"
        onPointerEnter={(e) => e.pointerType === 'mouse' && (hoverTimer.current = window.setTimeout(() => setHover(true), HISTORY_HOVER_MS))}
        onPointerLeave={() => clearTimeout(hoverTimer.current)}
        onClick={() => c.update({ historyOpen: true })}
      >
        {items.slice(-12).map(line)}
      </div>
      {open && (
        <div
          ref={box}
          className={`log-history panel${over ? ' over-line' : ''}`}
          style={over ? ({ '--left': `${over.left}px`, '--lift': `${over.lift}px`, '--width': `${over.width}px` } as React.CSSProperties) : undefined}
          role="log"
          aria-label="Chat and what happened"
          onMouseDown={(e) => e.stopPropagation()}
          onPointerLeave={(e) => e.pointerType === 'mouse' && setHover(false)}
          onScroll={(e) => {
            const b = e.currentTarget;
            atEnd.current = b.scrollTop + b.clientHeight >= b.scrollHeight - 4;
            if (atEnd.current && unread) setUnread(0);
          }}
        >
          {items.map(line)}
          {unread > 0 && (
            <button className="log-new" onClick={toEnd}>
              {unread === 1 ? 'A new line' : `${unread} new lines`} <Icon name="chevron" size={12} color="currentColor" />
            </button>
          )}
          {pad && <div className="log-hint"><Glyph b="B" /> Close</div>}
        </div>
      )}
    </div>
  );
}

export function Narration() {
  const n = useGame((s) => s.narrations[0]);
  const unvoiced = useGame((s) => !!s.narrations[0]?.lines?.some((l) => s.unvoiced.has(l.id)));
  const c = client();
  if (!n) return null;
  const close = () => c.dismissNarration();
  return (
    <div className="narration-wrap" onMouseDown={(e) => e.stopPropagation()} onClick={close}>
      <div className="narration panel" onClick={(e) => e.stopPropagation()}>
        <div className="tiny dim" style={{ letterSpacing: '.2em', textTransform: 'uppercase', marginBottom: 6 }}>{n.style === 'arc' ? 'Revelation' : n.style === 'ending' ? 'Epilogue' : n.style === 'intro' ? 'Prologue' : ''}</div>
        <h2>{n.title}</h2>
        <p><Typed key={n.id} text={n.text} lines={n.lines} voiced={n.voiced} pending={n.pending} animate unvoiced={unvoiced} /></p>
        <button className="btn primary" autoFocus onClick={close}>{n.style === 'intro' ? 'Begin' : 'Continue'}</button>
      </div>
    </div>
  );
}

