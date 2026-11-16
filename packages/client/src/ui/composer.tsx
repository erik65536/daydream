/**
 * Where the player speaks in a conversation: a text field whose round button is the microphone while the field is
 * empty and Send once something is written (as in messaging apps), so speaking is always one press away.
 *
 * Speaking: a press listens until the player pauses; holding the button listens until it is let go (push to talk).
 * While listening the field becomes a quiet strip: a meter that moves with the voice, the words as they are heard
 * (where the recognizer gives them), Cancel, and Done. Then, briefly, "Understanding…"; then the words are said.
 * Anything that goes wrong is a calm line above the field, never a pop-up.
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { voiceIn } from '../voice';
import { Icon } from './svgicons';
import { tip } from './common';
import { Glyph } from './pad';

type Phase = { kind: 'idle' } | { kind: 'listening'; heard: string } | { kind: 'understanding' };

/** A press of the microphone held at least this long is push to talk (letting go finishes). */
const HOLD_MS = 400;

export function Composer({ value, onChange, onSend, disabled, placeholder, inputRef, onListen, onEscape, before }: {
  value: string;
  onChange: (text: string) => void;
  /** Say this (or what is in the field). */
  onSend: (text?: string) => void;
  disabled?: boolean;
  placeholder: string;
  inputRef?: React.RefObject<HTMLTextAreaElement | null>;
  /** The player starts speaking (whoever is talking stops, so they are not talked over). */
  onListen?: () => void;
  onEscape?: () => void;
  /** Controls before the field (what to offer along with the words). */
  before?: ReactNode;
}) {
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [note, setNote] = useState<{ text: string; bad: boolean } | null>(null);
  const meter = useRef<HTMLDivElement>(null);
  const cancelled = useRef(false);
  const donePressed = useRef(false);
  const canSpeak = voiceIn.available();
  const live = phase.kind !== 'idle';

  useEffect(() => () => voiceIn.cancel(), []);
  useEffect(() => {
    if (!note) return;
    const t = setTimeout(() => setNote(null), 7000);
    return () => clearTimeout(t);
  }, [note]);
  // While listening, Escape (or a controller's B) cancels and Enter finishes, before the game sees them.
  useEffect(() => {
    if (!live) return;
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') cancel();
      else if (e.key === 'Enter' || e.key === ' ') voiceIn.finish();
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    window.addEventListener('keydown', key, true);
    return () => window.removeEventListener('keydown', key, true);
  }, [live]);

  const listen = async () => {
    onListen?.();
    setNote(null);
    cancelled.current = false;
    donePressed.current = false;
    setPhase({ kind: 'listening', heard: '' });
    try {
      const said = (await voiceIn.listen({
        partial: (heard) => setPhase((p) => (p.kind === 'listening' ? { ...p, heard } : p)),
        level: (l) => meter.current?.style.setProperty('--lv', l.toFixed(3)),
        understanding: () => setPhase({ kind: 'understanding' }),
      })).trim();
      setPhase({ kind: 'idle' });
      if (cancelled.current) return;
      if (said) onSend(said);
      else setNote({ text: 'Nothing was heard. Press the microphone and speak, then pause.', bad: false });
    } catch (e) {
      setPhase({ kind: 'idle' });
      if (!cancelled.current) setNote({ text: (e as Error).message, bad: true });
    }
  };
  const cancel = () => {
    cancelled.current = true;
    voiceIn.cancel();
    setPhase({ kind: 'idle' });
  };

  const typed = value.trim().length > 0;
  const mic = canSpeak && !typed;
  return (
    <div className="composer">
      {note && (
        <div className={`voice-note ${note.bad ? 'bad' : ''}`} role="status">
          <Icon name="mic" size={14} color="currentColor" />
          <span>{note.text}</span>
          <button className="btn sm ghost" onClick={() => setNote(null)}>OK</button>
        </div>
      )}
      {live ? (
        // Its own element (key): the press on the microphone must not end as a click on Done, which takes its place.
        <div key="listening" className="say listening" aria-live="polite">
          <button className="btn ghost round" aria-label="Cancel" onClick={cancel} {...tip('Cancel (Esc)')}>
            <Icon name="close" size={16} color="currentColor" />
          </button>
          <div className={`voice-field ${phase.kind}`}>
            <div ref={meter} className={`meter ${voiceIn.live() ? 'calm' : ''}`} aria-hidden>
              <i /><i /><i /><i /><i />
            </div>
            <span className="heard">
              {phase.kind === 'understanding' ? 'Understanding…' : phase.heard || 'Listening…'}
            </span>
          </div>
          <button
            {...tip('Done (Enter)')}
            className="btn primary round"
            aria-label="Done"
            disabled={phase.kind === 'understanding'}
            // Only a press that starts here finishes (a finger's tap on the microphone can end as a click here), or a
            // keyboard or controller press.
            onPointerDown={() => (donePressed.current = true)}
            onClick={(e) => (e.detail === 0 || donePressed.current) && voiceIn.finish()}
          >
            <Icon name="check" size={18} color="currentColor" />
            <span className="pad-hint pad-corner"><Glyph b="Y" /></span>
          </button>
        </div>
      ) : (
        <div key="typing" className="say">
          {before}
          <textarea
            ref={inputRef}
            className="input"
            rows={1}
            enterKeyHint="send"
            placeholder={placeholder}
            value={value}
            disabled={disabled}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={(e) => {
              e.stopPropagation();
              if (e.key === 'Enter' && !e.shiftKey) {
                e.preventDefault();
                onSend();
              }
              if (e.key === 'Escape') onEscape?.();
            }}
          />
          {mic ? (
            <button
              // Hover help first: the press below is the microphone's own (a hold is push to talk, not help).
              {...tip(<div><b>Speak</b><div className="tsub">Press, speak, then pause. Or hold while you talk.</div></div>)}
              className="btn primary round mic"
              aria-label="Speak"
              disabled={disabled}
              onPointerDown={(e) => {
                if (e.button !== 0 || phase.kind !== 'idle') return;
                // Listening starts on the press. Held past HOLD_MS it is push to talk: a pause no longer ends it, and
                // letting go (wherever the pointer is then) does.
                const at = performance.now();
                const held = setTimeout(() => voiceIn.hold(), HOLD_MS);
                const up = new AbortController();
                const release = () => {
                  up.abort();
                  clearTimeout(held);
                  if (performance.now() - at > HOLD_MS) voiceIn.finish();
                };
                window.addEventListener('pointerup', release, { capture: true, signal: up.signal });
                window.addEventListener('pointercancel', release, { capture: true, signal: up.signal });
                void listen();
              }}
              // Keyboard and controller presses (a click with no pointer behind it).
              onClick={(e) => e.detail === 0 && phase.kind === 'idle' && void listen()}
            >
              <Icon name="mic" size={18} color="currentColor" />
              <span className="pad-hint pad-corner"><Glyph b="Y" /></span>
            </button>
          ) : (
            <button {...tip('Say it (Enter)')} className="btn primary round" aria-label="Say it" disabled={disabled} onPointerDown={(e) => e.preventDefault()} onClick={() => onSend()}>
              <Icon name="send" size={17} color="currentColor" />
            </button>
          )}
        </div>
      )}
    </div>
  );
}
