/**
 * The player's Settings: sound (a master volume, and one each for the interface, effects, music, ambience, and
 * voices) and controls (vibration). Shown in the game's menu and on its own page outside the game; saved to the
 * account (settings.ts). Every sound has one volume, 0% being off.
 * Works with the mouse, the keyboard (Tab, arrows on a slider), and a controller (the focus ring; left and right move a
 * slider).
 */
import { useId } from 'react';
import { updateSettings, useSettings } from '../settings';
import { Window, centered } from './common';
import { canVibrate } from '../input/pointer';

/** One setting: its name and what it does on the left, its control on the right (below the name on a phone). */
function Row({ label, hint, htmlFor, wide, children }: { label: string; hint?: string; htmlFor?: string; wide?: boolean; children: React.ReactNode }) {
  return (
    <div className={`set-row ${wide ? 'wide' : ''}`}>
      <div className="set-text">
        <label htmlFor={htmlFor} className="set-label">{label}</label>
        {hint && <div className="set-hint">{hint}</div>}
      </div>
      <div className="set-ctl">{children}</div>
    </div>
  );
}

function Slider({ label, value, onChange, hint }: { label: string; value: number; onChange: (v: number) => void; hint?: string }) {
  const id = useId();
  const pct = Math.round(value * 100);
  return (
    <Row label={label} hint={hint} htmlFor={id} wide>
      <input
        id={id}
        type="range"
        className="slider"
        min={0}
        max={100}
        step={5}
        value={pct}
        style={{ '--fill': `${pct}%` } as React.CSSProperties}
        onChange={(e) => onChange(Number(e.target.value) / 100)}
        onKeyDown={(e) => e.stopPropagation()}
      />
      <span className="set-value">{pct ? `${pct}%` : 'Off'}</span>
    </Row>
  );
}

export function SettingsPanel() {
  const { sound, controls } = useSettings();
  const set = (patch: Partial<typeof sound>) => updateSettings((s) => ({ ...s, sound: { ...s.sound, ...patch } }));
  const setControls = (patch: Partial<typeof controls>) => updateSettings((s) => ({ ...s, controls: { ...s.controls, ...patch } }));
  return (
    <div className="settings">
      <section>
        <div className="set-head">Sound</div>
        <div className="set-card">
          <Slider label="Master volume" value={sound.master} onChange={(master) => set({ master })} />
          <Slider label="Interface" value={sound.interface} onChange={(v) => set({ interface: v })} hint="Taps, windows, refusals, and other small feedback." />
          <Slider label="Effects" value={sound.effects} onChange={(effects) => set({ effects })} hint="Fights, spells, rewards, and quests." />
          <Slider label="Music" value={sound.music} onChange={(music) => set({ music })} hint="Each world's themes, arrivals, and battles." />
          <Slider label="Ambience" value={sound.ambience} onChange={(ambience) => set({ ambience })} hint="The steady sound of each place." />
          <Slider label="Voices" value={sound.voices} onChange={(voices) => set({ voices })} hint="People and the narrator speaking. The words are always shown too." />
        </div>
      </section>
      <section>
        <div className="set-head">Controls</div>
        <div className="set-card">
          <Slider label="Vibration" value={controls.vibration} onChange={(vibration) => setControls({ vibration })}
            hint={canVibrate() ? 'Taps tick by touch; your turn, a hurt hero, or a wall buzz. Controllers rumble too.' : 'Controllers rumble when your turn comes, a hero is hurt, or you walk into a wall. This device cannot vibrate from a web page.'} />
        </div>
      </section>
      <div className="set-foot">Saved to your account, on every device you play on.</div>
    </div>
  );
}

export function SettingsWindow({ onClose }: { onClose: () => void }) {
  return (
    <Window title="Settings" onClose={onClose} className="settings-window" style={centered(440, '14%')}>
      <div className="panel-body">
        <SettingsPanel />
      </div>
    </Window>
  );
}
