/** The game menu (settings, a copy of the adventure, the difficulty, the way out) and the list of controls. */
import { useEffect, useState } from 'react';
import { DIFFICULTIES } from '@daydream/shared';
import { client, useGame } from '../net/game';
import { Tab, Tabs, Window, centered, plural } from './common';
import { isTouch } from '../input/pointer';
import { canFullscreen, canInstall, install, isFullscreen, isStandalone, toggleFullscreen } from '../platform';
import { navigate } from '../App';
import { Icon } from './svgicons';
import { Glyph } from './pad';

export function MenuWindow({ onClose, onHelp, onCodex, onSettings, onDev }: { onClose: () => void; onHelp: () => void; onCodex: () => void; onSettings: () => void; onDev?: () => void }) {
  const { player, isOwner, adventureName, world, savedCopy } = useGame((s) => ({ player: s.player, isOwner: s.isOwner, adventureName: s.adventureName, world: s.world, savedCopy: s.savedCopy }));
  const c = client();
  const [name, setName] = useState('');
  const [copying, setCopying] = useState(false);
  // A copy saved while the menu was closed is old news by the time it opens again.
  useEffect(() => () => c.update({ savedCopy: undefined }), []);
  const [full, setFull] = useState(isFullscreen());
  useEffect(() => {
    const on = () => setFull(isFullscreen());
    document.addEventListener('fullscreenchange', on);
    return () => document.removeEventListener('fullscreenchange', on);
  }, []);
  if (!player || !world) return null;
  const r = world.ruleset;
  return (
    <Window title={adventureName ?? 'Menu'} onClose={onClose} className="menu-window" style={centered(400, '12%')}>
      <div className="panel-body col menu-body">
        <div className="menu-rows">
          <MenuRow icon="settings" label="Settings" onClick={onSettings} />
          <MenuRow icon="help" label="Controls" onClick={onHelp} />
          <MenuRow icon="codex" label="Codex" onClick={onCodex} />
          {canFullscreen() && <MenuRow icon="fullscreen" label={full ? 'Leave full screen' : 'Full screen'} onClick={() => void toggleFullscreen()} />}
          {canInstall() && <MenuRow icon="fullscreen" label="Install the game" onClick={() => void install()} />}
          <MenuRow icon="copy" label="Save a copy" open={copying} onClick={() => setCopying((v) => !v)} />
          {copying && (
            <div className="menu-copy">
              <div className="row">
                <input className="input grow" placeholder="Name the copy" aria-label="Name the copy" value={name} onChange={(e) => setName(e.target.value)} onKeyDown={(e) => e.stopPropagation()} />
                <button className="btn" disabled={!name.trim()} onClick={() => { c.send({ t: 'save_copy', name }); setName(''); }}>Save</button>
              </div>
              <div className="hint" role="status">{savedCopy ? `Saved “${savedCopy.name}”. The copy is its own adventure on the world page, starting from this moment.` : 'A copy is a separate adventure that carries on from this moment; this one continues here. Progress is always kept as you play.'}</div>
            </div>
          )}
          {onDev && <MenuRow icon="dev" label="Developer tools" onClick={onDev} />}
        </div>
        {isTouch() && !isStandalone() && !canInstall() && /iPhone|iPad|iPod/.test(navigator.userAgent) && (
          <div className="hint">To play full screen on this device, choose Share, then Add to Home Screen, and open Daydream from there.</div>
        )}
        <div>
          <div className="set-head">Difficulty</div>
          <div className="pick-seg" role="radiogroup" aria-label="Difficulty">
            {DIFFICULTIES.map((d) => (
              <button key={d} role="radio" aria-checked={player.difficulty === d} className={player.difficulty === d ? 'on' : ''} disabled={!isOwner} onClick={() => c.send({ t: 'set_difficulty', difficulty: d })}>{r.difficulty[d].name}</button>
            ))}
          </div>
          <div className="hint" style={{ marginTop: 6 }}>{isOwner ? 'Changes your foes at once, in a fight too. See the codex for details.' : 'Only the owner of this adventure can change it.'}</div>
        </div>
        <button className="menu-leave" onClick={() => navigate(`#/world/${world.id}`)}><Icon name="leave" size={16} color="currentColor" />Leave world</button>
      </div>
    </Window>
  );
}

/** One line of the game menu: an icon, what it opens, and a chevron (turned down while its part is open). */
function MenuRow({ icon, label, onClick, open }: { icon: Parameters<typeof Icon>[0]['name']; label: string; onClick: () => void; open?: boolean }) {
  return (
    <button className={`menu-row ${open ? 'open' : ''}`} onClick={onClick} aria-expanded={open}>
      <Icon name={icon} size={17} />
      <span className="grow">{label}</span>
      <span className="chev"><Icon name="chevron" size={14} color="currentColor" /></span>
    </button>
  );
}

/** Keys drawn as keycaps, a controller's buttons as their colored glyphs, and everything else (mouse, sticks) as words. */
const KEYCAPS = new Set(['Space', 'Enter', 'Tab', 'Esc', 'Shift', 'WASD', 'Arrows']);
const PAD_BUTTONS = new Set(['A', 'B', 'X', 'Y', 'LB', 'RB', 'LT', 'RT', 'Menu']);
function Keys({ text, pad }: { text: string; pad: boolean }) {
  return (
    <>
      {text.split(/\s+/).map((w, i) => {
        if (/^[·+/–]$/.test(w)) return <span key={i} className="ctl-sep">{w}</span>;
        if (pad && PAD_BUTTONS.has(w)) return <Glyph key={i} b={w as Parameters<typeof Glyph>[0]['b']} />;
        if (!pad && (KEYCAPS.has(w) || /^[A-Z0-9?]$/.test(w))) return <kbd key={i}>{w}</kbd>;
        return <span key={i} className="ctl-word">{w}</span>;
      })}
    </>
  );
}

export function HelpWindow({ onClose }: { onClose: () => void }) {
  const { world, inputMode } = useGame((s) => ({ world: s.world, inputMode: s.inputMode }));
  const [way, setWay] = useState<'touch' | 'mouse' | 'pad'>(inputMode);
  const r = world?.ruleset;
  const t = r?.terminology;
  const rows: Record<typeof way, [string, string][]> = {
    touch: [
      ['Tap ground', 'Walk there'],
      ['Drag on the ground', 'Walk with a stick under your finger while you hold it'],
      ['Tap someone', 'Talk, or attack a foe'],
      ['Tap a thing', 'Use it: ways out, chests, signs, and notes'],
      ['Hold on a chest or pile', 'Open it and choose items'],
      ['Hold on anything', 'See what it is'],
      ['Tap a skill', 'Ready it, then tap a target (or drag to aim and lift)'],
      ['In a fight', 'Tap the ground to see the path and its cost, then tap again to walk'],
      ['Pinch', 'Zoom; in a fight, move two fingers together to look around'],
      ['Drag to an edge', 'In a fight, while aiming or planning: the view slides that way'],
      ['Tap a hero', 'Lead with them (in a fight, command them and bring the view back)'],
    ],
    mouse: [
      ['Left click ground', 'Walk there (in a fight: the hero acting walks)'],
      ['Left click person', 'Talk'],
      ['Left click foe', 'Attack (walks into range first)'],
      ['Left click object', 'Use: ways out, chests, signs, and notes'],
      ['Left click loot / chest', 'Take everything (and nearby drops)'],
      ['Shift + click loot / chest', 'Open it and choose items'],
      ['1 – 0', 'Ready a skill, then click a target'],
      ['Right click / Esc', 'Cancel targeting · close windows'],
      ['Space', 'End turn'],
      ['Enter', 'Chat with the other players'],
      ['I · C · K · M', 'Pack · Character · Talents · Map'],
      ['J / L / Q', 'Quests'],
      ['B · X', 'Crafting · Codex'],
      ['H / ?', 'This list'],
      ['Mouse wheel', 'Zoom'],
      ['Arrows · WASD · screen edge', 'In a fight, look around (or drag with the middle button); click a hero to come back'],
      ['Tab', 'Choose the next hero'],
    ],
    pad: [
      ['Left stick', 'Walk; in a fight, or while aiming a skill or item, move the cursor (the view follows it)'],
      ['A', 'Act on what is shown: talk, open, use, attack, walk there'],
      ['X', 'Attack the nearest foe · in windows, an item’s actions'],
      ['LB · RB', 'Choose another target nearby · switch tabs'],
      ['Hold RT', 'Skill wheel: point with a stick, let go to choose'],
      ['Hold LT', 'Menu wheel: windows, and who fights on their own'],
      ['Y', 'End turn · open the quests'],
      ['B', 'Back, cancel, flee in a fight'],
      ['D-pad', 'Map (up) · pack (down) · switch hero (left, right)'],
      ['Right stick', 'Zoom · scroll windows'],
      ['View', 'The party: move between everyone’s Health and statuses (B to leave)'],
      ['Menu', 'The game menu'],
    ],
  };
  return (
    <Window title="Controls" onClose={onClose} style={centered(540, '14%')}>
      <Tabs>
        {(['touch', 'mouse', 'pad'] as const).map((w) => (
          <Tab key={w} on={way === w} onPress={() => setWay(w)}>{{ touch: 'Touch', mouse: 'Keyboard and mouse', pad: 'Controller' }[w]}</Tab>
        ))}
      </Tabs>
      <div className="panel-body">
        <div className="ctl-list">
          {rows[way].map(([k, v]) => (
            <div key={k} className="ctl-row"><div className="ctl-keys"><Keys text={k} pad={way === 'pad'} /></div><div className="ctl-what">{v}</div></div>
          ))}
        </div>
        <p className="hint" style={{ marginTop: 10 }}>
          Fights are turn-based: each turn grants {t?.actionPoints ?? 'action points'}, and moving and acting spend them. The codex explains the rules of this world.
        </p>
        <p className="hint">You can say anything to anyone, typed or spoken. People remember what you tell them, react to gifts and skills, and may change your {plural(t?.quest ?? 'quest').toLowerCase()} in response.</p>
      </div>
    </Window>
  );
}
