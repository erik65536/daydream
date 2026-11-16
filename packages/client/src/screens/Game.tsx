import { useEffect, useRef, useState } from 'react';
import { rx } from '@daydream/shared';
import type { Me } from '../api';
import { GameClient, setClient, clearClient, useGame, client } from '../net/game';
import { Renderer, type HoverInfo } from '../render/renderer';
import { ActionBar, ChatLine, ChatLog, Narration, SceneInvites, SystemBar, Toasts, TopRight, TurnBar, startSkill } from '../ui/hud';
import { PartyFrames } from '../ui/party';
import { SettingsWindow } from '../ui/settings';
import { DialogWindow } from '../ui/dialog';
import { InventoryWindow, LootWindow, StorageWindow, TradeWindow } from '../ui/inventory';
import { CharacterWindow, SkillsWindow } from '../ui/talents';
import { MapWindow, QuestWindow } from '../ui/quests';
import { CraftWindow } from '../ui/craft';
import { HelpWindow, MenuWindow } from '../ui/menu';
import { CodexWindow } from '../ui/codex';
import { hasCrafting, hideTip } from '../ui/common';
import { navigate } from '../App';
import { applyWorldTheme } from '../ui/theme';
import { PadInput } from '../input/gamepad';
import { TouchInput } from '../input/touch';
import { gameHaptics } from '../input/haptics';
import { gameSounds } from '../gamesounds';
import { Glyph, PadPrompt, PadWheel } from '../ui/pad';
import { DevPanel } from '../ui/dev';
import { keepAwake } from '../platform';

export function GameScreen({ me, adventureId }: { me: Me; adventureId: string }) {
  const [gc, setGc] = useState<GameClient | null>(null);
  useEffect(() => {
    const c = new GameClient(adventureId);
    setClient(c);
    (window as unknown as { __gd?: GameClient }).__gd = c; // debugging handle
    c.connect();
    setGc(c);
    return () => {
      c.close();
      clearClient(c);
      const w = window as unknown as { __gd?: GameClient };
      if (w.__gd === c) delete w.__gd;
    };
  }, [adventureId]);
  if (!gc) return null;
  return <GameView key={adventureId} me={me} />;
}

/** Admins get the developer options. */
let devMode = false;

function handleClick(r: Renderer, info: HoverInfo, button: number, ev?: MouseEvent) {
  const c = client();
  const st = c.state;
  hideTip();
  if (st.narrations.length) return;
  if (button === 2) {
    if (st.targeting) c.update({ targeting: null });
    return;
  }
  if (button !== 0) return;
  // Developer teleport (the server ignores it from anyone but an admin).
  if ((ev?.ctrlKey || r.tapTeleport) && devMode && info.point && st.zone && !info.entityId) return c.send({ t: 'dev', action: 'goto', zoneId: st.zone.id, x: info.point.x, y: info.point.y });
  const charId = st.selectedCharId ?? st.player?.leaderId;
  if (!charId) return;
  // In a fight, orders go to the player's own heroes on their turn; between turns a click only chooses a hero.
  const waiting = !!st.combat && !c.isMyTurn();
  const tgt = st.targeting;
  if (tgt && waiting) return void c.update({ targeting: null });
  if (tgt) {
    const point = info.point ?? undefined;
    const targetId = info.entityId;
    if (tgt.skillId) {
      const s = rx(c.r).skill.get(tgt.skillId);
      const needsEntity = s?.targeting === 'enemy' || s?.targeting === 'ally';
      if (needsEntity && !targetId) return c.toast('Choose a target.', 'bad');
      else c.send({ t: 'use_skill', charId: tgt.charId, skillId: tgt.skillId, targetId, x: point?.x, y: point?.y });
    } else if (tgt.itemId) c.send({ t: 'use_item', charId: tgt.charId, itemId: tgt.itemId, targetId, x: point?.x, y: point?.y });
    c.update({ targeting: null });
    return;
  }
  if (info.entityId) {
    const e = st.entities.get(info.entityId);
    if (!e) return;
    if (e.ownerUserId === st.userId) {
      c.update({ selectedCharId: e.id });
      if (!st.combat) c.send({ t: 'set_leader', charId: e.id });
      return;
    }
    if (e.hostile && !e.dead) {
      if (!waiting) c.send({ t: 'use_skill', charId: st.combat ? c.myActor()! : charId, skillId: c.r.basicAttackId, targetId: e.id });
      return;
    }
    if (e.kind === 'npc' && !st.combat) {
      c.send({ t: 'interact', targetId: e.id, charId });
      return;
    }
  }
  if ((info.featureId || info.lootId) && !st.combat) {
    // Click takes everything; shift-click opens the container to pick items.
    c.send({ t: 'interact', targetId: (info.lootId ?? info.featureId)!, charId, inspect: !!ev?.shiftKey });
    return;
  }
  if (!info.point) return;
  if (st.combat) return void (waiting || c.send({ t: 'move', x: info.point.x, y: info.point.y }));
  // Out of a fight a click on a wall or water walks to the nearest spot one can stand on, where the marker showed.
  const to = r.walkTarget(info.point);
  if (!to) return;
  c.send({ t: 'move', x: to.x, y: to.y, charId });
  r.markDestination(to);
}

/** A finger's long-press: the renderer shows who or what it is; a chest or pile opens to pick from. */
function inspect(info: HoverInfo) {
  const c = client();
  const st = c.state;
  hideTip();
  const charId = st.selectedCharId ?? st.player?.leaderId;
  if (st.narrations.length || st.targeting || st.combat || !charId) return;
  const id = info.lootId ?? info.featureId;
  const f = info.featureId ? st.zone?.features.find((x) => x.id === info.featureId) : undefined;
  if (info.lootId || f?.kind === 'chest') c.send({ t: 'interact', targetId: id!, charId, inspect: true });
}

function GameView({ me }: { me: Me }) {
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const rendererRef = useRef<Renderer | null>(null);
  const { status, error, errorCode, panel, dialog, trade, loot, targeting, world, combat, inputMode } = useGame((s) => ({ status: s.status, error: s.error, errorCode: s.errorCode, panel: s.panel, dialog: s.dialog, trade: s.trade, loot: s.loot, targeting: s.targeting, world: s.world, combat: s.combat, inputMode: s.inputMode }));
  const [note, setNote] = useState<{ x: number; y: number; text: string; ok: boolean; confirm?: boolean } | null>(null);
  const touchRef = useRef<TouchInput | null>(null);
  const [dev, setDev] = useState(false);
  const [hudHidden, setHudHidden] = useState(false);
  const [chatting, setChatting] = useState(false);
  const c = client();
  devMode = me.isAdmin;
  // No heroes yet, no room for this party, or no longer allowed in: the adventure's page says what to do.
  useEffect(() => {
    // A world deleted under the player: back to the worlds, which say why.
    if (errorCode) navigate(errorCode === 'heroes' ? `#/adventure/${c.adventureId}/heroes` : `#/${errorCode === 'gone' ? '' : `adventure/${c.adventureId}`}?why=${encodeURIComponent(error ?? '')}`);
  }, [errorCode]);

  useEffect(() => {
    const r = new Renderer(canvasRef.current!, c);
    rendererRef.current = r;
    (window as unknown as { __gdView?: Renderer }).__gdView = r; // debugging handle
    r.onClick = (info, button, ev) => handleClick(r, info, button, ev);
    const pad = new PadInput(r, c, (info, button) => handleClick(r, info, button));
    const touch = new TouchInput(canvasRef.current!, r, c, (info, button) => handleClick(r, info, button), (info) => inspect(info));
    touchRef.current = touch;
    const offHaptics = gameHaptics(c, r);
    const offSounds = gameSounds(c, r);
    // What the skills and menus cover at the bottom of the view, for the camera (see Renderer.framed).
    const view = canvasRef.current!;
    const measure = () => {
      const bar = document.querySelector('.bottomrow > .actionbar');
      r.hudBottom = bar ? Math.max(0, view.getBoundingClientRect().bottom - bar.getBoundingClientRect().top + 8) : 0;
    };
    const watch = new ResizeObserver(measure);
    watch.observe(view);
    const bar = document.querySelector('.bottomrow');
    if (bar) for (const el of bar.children) watch.observe(el);
    const noteTimer = setInterval(() => {
      const n = r.cursorNote;
      r.cursorNote = null;
      setNote(n ? { x: r.hover.screenX, y: r.hover.screenY, ...n, confirm: n.ok && touch.awaitingConfirm } : null);
    }, 80);
    return () => {
      clearInterval(noteTimer);
      watch.disconnect();
      offHaptics();
      offSounds();
      touch.destroy();
      pad.destroy();
      r.destroy();
      const w = window as unknown as { __gdView?: Renderer };
      if (w.__gdView === r) delete w.__gdView;
    };
  }, []);

  // A walk planned by touch is forgotten when the turn or the fight changes.
  const turnKey = combat ? `${combat.round}:${combat.actingIds.join()}` : '';
  useEffect(() => touchRef.current?.reset(), [turnKey]);

  useEffect(() => keepAwake(), []);

  // The UI takes its colors and typefaces from the world.
  useEffect(() => applyWorldTheme(world), [world?.id]);

  // In a fight the arrow keys (or WASD) slide the view, to find and reach foes beyond the screen.
  useEffect(() => {
    const PAN: Record<string, [number, number]> = { arrowleft: [-1, 0], a: [-1, 0], arrowright: [1, 0], d: [1, 0], arrowup: [0, -1], w: [0, -1], arrowdown: [0, 1], s: [0, 1] };
    const held = new Set<string>();
    const apply = () => {
      const r = rendererRef.current;
      if (!r) return;
      let x = 0, y = 0;
      for (const k of held) (x += PAN[k]![0]), (y += PAN[k]![1]);
      r.panSpeed = { x: Math.sign(x) * 800, y: Math.sign(y) * 800 };
    };
    const down = (e: KeyboardEvent) => {
      const k = e.key.toLowerCase();
      const t = e.target as HTMLElement;
      if (!PAN[k] || !c.state.combat || c.state.panel || c.state.dialog || t?.tagName === 'INPUT' || t?.tagName === 'TEXTAREA') return;
      e.preventDefault();
      held.add(k);
      apply();
    };
    const up = (e: KeyboardEvent) => held.delete(e.key.toLowerCase()) && apply();
    const blur = () => (held.clear(), apply());
    window.addEventListener('keydown', down);
    window.addEventListener('keyup', up);
    window.addEventListener('blur', blur);
    return () => {
      window.removeEventListener('keydown', down);
      window.removeEventListener('keyup', up);
      window.removeEventListener('blur', blur);
    };
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const st = c.state;
      if (e.isTrusted && st.inputMode === 'pad') c.update({ inputMode: 'mouse' });
      if ((e.target as HTMLElement)?.tagName === 'INPUT' || (e.target as HTMLElement)?.tagName === 'TEXTAREA') return;
      const k = e.key.toLowerCase();
      if (k === '`' && me.isAdmin) return setDev((v) => !v);
      const toggle = (p: NonNullable<typeof st.panel>) => c.update({ panel: st.panel === p ? null : p });
      if (k === 'escape') {
        if (st.partyFocus) return c.update({ partyFocus: false });
        if (st.historyOpen) return c.update({ historyOpen: false });
        if (st.narrations.length) return c.dismissNarration();
        if (st.targeting) return c.update({ targeting: null });
        if (st.loot) return c.send({ t: 'close_loot' });
        // A shop stands open over its conversation: Escape closes the shop first, as its own close button does.
        if (st.trade) return c.send({ t: 'end_trade' });
        if (st.dialog) return c.send({ t: 'end_dialog' });
        if (st.panel) return c.update({ panel: null });
        return c.update({ panel: 'menu' });
      }
      // Enter and Space on a focused button (reached with Tab, or a card's own) press that button, and nothing else.
      const onButton = (k === 'enter' || k === ' ') && !!(e.target as HTMLElement)?.closest?.('button, a[href], select, [role="button"], [role="tab"]');
      if (st.narrations.length) {
        if ((k === 'enter' || k === ' ') && !onButton) c.dismissNarration();
        return;
      }
      if (onButton) return;
      if (/^[0-9]$/.test(k)) {
        // The skill keys are the game's, not a window's: nothing is cast from under a shop, a chest or the pack.
        if (st.dialog || st.trade || st.loot || st.panel) return;
        const idx = k === '0' ? 9 : Number(k) - 1;
        // In a fight, the hero acting now (none between the player's turns); otherwise the one chosen.
        const ch = st.combat ? st.player?.party.find((p) => p.id === c.myActor()) : c.selectedHero();
        const sk = ch?.hotbar[idx];
        if (ch && sk) startSkill(ch.id, sk);
        return;
      }
      if (k === 'enter') {
        e.preventDefault();
        return setChatting(true);
      }
      if (k === ' ' && st.combat && c.isMyTurn()) {
        e.preventDefault();
        c.send({ t: 'end_turn', charId: c.myActor() });
        return;
      }
      if (k === 'tab' && st.player?.party.length) {
        e.preventDefault();
        const party = st.player.party;
        const i = party.findIndex((p) => p.id === st.selectedCharId);
        const next = party[(i + 1) % party.length]!;
        c.update({ selectedCharId: next.id });
        if (!st.combat) c.send({ t: 'set_leader', charId: next.id });
        return;
      }
      if (st.dialog) return;
      if (k === 'i') toggle('inventory');
      else if (k === 'c') toggle('character');
      else if (k === 'k') toggle('skills');
      else if (k === 'j' || k === 'l' || k === 'q') toggle('quests');
      else if (k === 'm') toggle('map');
      else if (k === 'b' && st.world && hasCrafting(st.world.ruleset)) toggle('craft');
      else if (k === 'x') toggle('codex');
      else if (k === 'h' || k === '?') toggle('help');
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  const close = () => c.update({ panel: null });
  return (
    <div
      className={`game ${targeting ? 'targeting' : ''} ${inputMode === 'pad' ? 'pad' : inputMode === 'touch' ? 'touch' : ''} ${hudHidden ? 'hud-hidden' : ''} ${combat ? 'in-combat' : ''}`}
      // A button pressed with the mouse or a finger does not keep the keyboard: Space and Enter stay the game's keys.
      onClick={(e) => e.detail > 0 && (e.target as HTMLElement).closest<HTMLElement>('button, [tabindex="0"]')?.blur()}
      onContextMenu={(e) => {
        // The game uses right-click; keep the browser menu only for text fields.
        const tag = (e.target as HTMLElement).tagName;
        if (tag !== 'INPUT' && tag !== 'TEXTAREA') e.preventDefault();
      }}
    >
      <canvas ref={canvasRef} className="view" />
      {/* Per-world color grading over the scene (below the HUD). */}
      <div className="grade" aria-hidden><i className="grain" /></div>
      <div className="hud">
        <PartyFrames />
        <TopRight open={(p) => c.update({ panel: panel === p ? null : p })} />
        <TurnBar />
        <div className="bottomrow">
          <ChatLog chatting={chatting} />
          <ActionBar />
          <SystemBar open={(p) => c.update({ panel: panel === p ? null : p })} onChat={() => setChatting(true)} />
        </div>
        <SceneInvites />
        <ChatLine open={chatting} onClose={() => setChatting(false)} />
        <Toasts />
        {targeting && (
          <div className="aim-banner">
            <span>{targeting.skillId ? <>Choose a target for <b>{c.skillName(targeting.skillId)}</b></> : 'Choose where to use it'}</span>
            <span className="aim-how">{inputMode === 'pad' ? <>A to use · <Glyph b="B" /> cancel</> : inputMode === 'touch' ? 'Tap, or drag and lift' : 'Right-click cancels'}</span>
            <button className="btn sm ghost" onClick={() => c.update({ targeting: null })}>Cancel</button>
          </div>
        )}
        {panel === 'inventory' && <InventoryWindow onClose={close} />}
        {panel === 'character' && <CharacterWindow onClose={close} />}
        {panel === 'skills' && <SkillsWindow onClose={close} />}
        {panel === 'quests' && <QuestWindow onClose={close} />}
        {panel === 'map' && <MapWindow onClose={close} />}
        {panel === 'craft' && <CraftWindow onClose={close} />}
        {panel === 'storage' && <StorageWindow onClose={close} />}
        {panel === 'menu' && <MenuWindow onClose={close} onHelp={() => c.update({ panel: 'help' })} onCodex={() => c.update({ panel: 'codex' })} onSettings={() => c.update({ panel: 'settings' })} onDev={me.isAdmin ? () => (setDev(true), c.update({ panel: null })) : undefined} />}
        {panel === 'settings' && <SettingsWindow onClose={close} />}
        {panel === 'help' && <HelpWindow onClose={close} />}
        {panel === 'codex' && <CodexWindow onClose={close} />}
        {trade && <TradeWindow />}
        {(trade || panel === 'storage') && <InventoryWindow onClose={trade ? () => c.send({ t: 'end_trade' }) : close} />}
        {dialog && !trade && <DialogWindow />}
        {loot && <LootWindow />}
        <Narration />
        <PadPrompt />
        <PadWheel />
        {note && (
          <div className={`cursor-note ${note.ok ? '' : 'bad'} ${inputMode === 'touch' ? 'above' : ''}`} style={{ left: note.x, top: note.y }}>
            {note.text}
            {note.confirm && <span className="confirm">Tap again to walk</span>}
          </div>
        )}
        {dev && <DevPanel renderer={rendererRef.current} hudHidden={hudHidden} setHudHidden={setHudHidden} onClose={() => setDev(false)} />}
      </div>
      {status !== 'connected' && (
        <div className="connection">
          {status === 'connecting' ? <div className="spinner" /> : <div className="display gold" style={{ fontSize: 20 }}>{error ?? 'Disconnected'}</div>}
          {status !== 'connecting' && (
            <div className="row">
              <button className="btn" onClick={() => location.reload()}>Reconnect</button>
              <button className="btn ghost" onClick={() => navigate(`#/adventure/${c.adventureId}`)}>Back to the adventure</button>
            </div>
          )}
          <span className="dim small">{me.displayName}</span>
        </div>
      )}
    </div>
  );
}
