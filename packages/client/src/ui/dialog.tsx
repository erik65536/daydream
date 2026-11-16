/** The conversation with a person: what was said, the replies offered, and the field to say or do anything. */
import { useEffect, useRef, useState } from 'react';
import { knownSkills } from '@daydream/shared';
import { client, useGame } from '../net/game';
import { Portrait, pressable, tip, usePanelSound } from './common';
import { isTouch } from '../input/pointer';
import { Composer } from './composer';
import { Typed } from './spoken';
import { Icon } from './svgicons';

export function DialogWindow() {
  const { dialog, player, world } = useGame((s) => ({ dialog: s.dialog, player: s.player, world: s.world }));
  const c = client();
  usePanelSound(!!dialog);
  const [text, setText] = useState('');
  const [give, setGive] = useState('');
  const [gold, setGold] = useState(0);
  const [skill, setSkill] = useState('');
  const [offer, setOffer] = useState(false);
  const msgsRef = useRef<HTMLDivElement>(null);
  const inputRef = useRef<HTMLTextAreaElement>(null);
  // Lines that arrived while the window was open type themselves out (a line that grows keeps typing).
  const seen = useRef(0);
  const fresh = useRef(new Set<number>());
  // The newest line stays in view while it types itself out and the replies appear under it, unless the player has
  // scrolled up to read; a new line brings the view back down. A line taller than the view is shown from its start.
  const stick = useRef(true);
  const hasDialog = !!dialog;
  useEffect(() => {
    const el = msgsRef.current;
    if (!el) return;
    const toEnd = () => {
      if (!stick.current) return;
      const last = [...el.querySelectorAll<HTMLElement>('.msg')].pop();
      if (last && last.offsetHeight > el.clientHeight - 32) el.scrollTop = last.offsetTop - 12;
      else el.scrollTop = el.scrollHeight;
    };
    const onScroll = () => (stick.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48);
    el.addEventListener('scroll', onScroll);
    el.addEventListener('settle', toEnd);
    const mo = new MutationObserver(toEnd);
    mo.observe(el, { childList: true, subtree: true, characterData: true });
    const ro = new ResizeObserver(toEnd);
    ro.observe(el);
    toEnd();
    return () => {
      el.removeEventListener('scroll', onScroll);
      el.removeEventListener('settle', toEnd);
      mo.disconnect();
      ro.disconnect();
    };
  }, [hasDialog, dialog?.npcId]);
  useEffect(() => {
    stick.current = true;
    msgsRef.current?.dispatchEvent(new Event('settle'));
  }, [dialog?.messages.length, dialog?.thinking]);
  // The field is ready for typing, except on touch screens, where focusing it would cover half the screen with a keyboard.
  useEffect(() => {
    if (!isTouch()) inputRef.current?.focus();
  }, [dialog?.npcId, dialog?.thinking]);
  useEffect(() => {
    seen.current = 0;
    fresh.current.clear();
  }, [dialog?.npcId]);
  const leader = player?.party.find((x) => x.id === player.leaderId) ?? player?.party[0];
  if (!dialog || !player || !world || !leader) return null;
  const r = world.ruleset;
  const send = (t?: string) => {
    const msg = (t ?? text).trim();
    if (!msg && !give && !gold && !skill) return;
    c.send({ t: 'talk', text: msg, giveItemId: give || undefined, giveGold: gold || undefined, useSkillId: skill || undefined });
    setText('');
    setGive('');
    setGold(0);
    setSkill('');
    setOffer(false);
  };
  const close = () => c.send({ t: 'end_dialog' });
  const actives = knownSkills(r, leader).filter((id) => id !== r.basicAttackId);
  const lastNpc = dialog.messages.map((m) => m.speaker).lastIndexOf('npc');
  for (let i = seen.current; i < dialog.messages.length; i++) fresh.current.add(i);
  seen.current = dialog.messages.length;
  // While the newest line is being written, it is the sign of life (not the thinking dots).
  const writing = dialog.messages[dialog.messages.length - 1]?.pending;
  const giveItem = give ? player.inventory.find((i) => i.id === give) : undefined;
  const offering = [giveItem && c.itemName(giveItem), gold ? `${gold} ${r.terminology.currency}` : '', skill && c.skillName(skill)].filter(Boolean).join(' · ');
  return (
    <div className="window panel ornate dialog" onMouseDown={(e) => e.stopPropagation()}>
      <span className="corner tl" />
      <span className="corner tr" />
      <span className="corner bl" />
      <span className="corner br" />
      <div className="dlg-side">
        <div className="dlg-portrait">
          <Portrait size={150} full sprite={c.assetUrl(dialog.sprite, 'figure')} />
        </div>
        <div className="dlg-who">
          <div className="display gold dlg-name">{dialog.npcName}</div>
          <div className="serif muted dlg-title">{dialog.npcTitle}</div>
        </div>
        <div className="spacer" />
        {dialog.canTrade && <button className="btn sm" disabled={dialog.thinking || dialog.ended} onClick={() => c.send({ t: 'request_trade' })}>Trade</button>}
        <button className="btn sm ghost" onClick={close} {...tip('Leave (Esc), or just walk away')}>Leave</button>
      </div>
      <div className="dlg-main">
        <button className="btn ghost sm close-x dlg-close" onClick={close} aria-label="Leave" {...tip('Leave (Esc), or just walk away')}><Icon name="close" size={16} color="currentColor" /></button>
        <div className="msgs" ref={msgsRef}>
          {dialog.messages.map((m, i) => (
            <div key={i} className={`msg ${m.speaker}`}>
              {m.speaker === 'npc' && (
                <span className="who">
                  {dialog.npcName.split(' ')[0]}
                </span>
              )}
              {m.speaker === 'player' && m.userId && m.userId !== c.state.userId && <span className="who" style={{ color: c.colorOf(m.userId) }}>{m.name}</span>}
              {m.speaker === 'npc' ? <Typed text={m.text} lines={m.lines} voiced={m.voiced} pending={m.pending} unvoiced={m.unvoiced} animate={i === lastNpc && fresh.current.has(i)} /> : m.text}
            </div>
          ))}
          {dialog.thinking && !writing && (
            <div className="thinking">
              <span /><span /><span />
            </div>
          )}
        </div>
        <div className="compose">
          {!dialog.thinking && !dialog.ended && dialog.suggestions.length > 0 && (
            <ol className="replies">
              {dialog.suggestions.map((s) => (
                <li key={s} {...pressable(() => (s === 'Farewell.' ? close() : send(s)))}>{s}</li>
              ))}
            </ol>
          )}
          {offer && (
            <div className="attach">
              <select className="input" aria-label="Give an item" value={give} onChange={(e) => setGive(e.target.value)}>
                <option value="">Give an item…</option>
                {player.inventory.map((i) => (
                  <option key={i.id} value={i.id}>{c.itemName(i)}{i.qty > 1 ? ` ×${i.qty}` : ''}</option>
                ))}
              </select>
              <input className="input" type="number" aria-label={`Give ${r.terminology.currency}`} min={0} max={player.gold} style={{ width: 90 }} value={gold || ''} placeholder={r.terminology.currency} onChange={(e) => setGold(Math.max(0, Math.min(player.gold, Number(e.target.value))))} />
              <select className="input" aria-label="Use a skill" value={skill} onChange={(e) => setSkill(e.target.value)}>
                <option value="">Use a skill…</option>
                {actives.map((s) => (
                  <option key={s} value={s}>{c.skillName(s)}</option>
                ))}
              </select>
            </div>
          )}
          <Composer
            value={text}
            onChange={setText}
            onSend={send}
            inputRef={inputRef}
            disabled={dialog.thinking || dialog.ended}
            placeholder={dialog.ended ? 'The conversation is over.' : `Say or do anything… (${leader.name})`}
            onEscape={close}
            // The player speaks: the person stops talking over them.
            onListen={() => c.skipLines(dialog.messages.flatMap((m) => m.lines ?? []).map((l) => l.id))}
            before={
              <button className={`btn ghost sm offer ${offer || offering ? 'on' : ''}`} onClick={() => setOffer((v) => !v)} {...tip('Offer an item, money, or a skill along with your words')}>
                {offering || 'Offer…'}
              </button>
            }
          />
        </div>
      </div>
    </div>
  );
}
