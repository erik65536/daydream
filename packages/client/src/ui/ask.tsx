import { useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { usePanelSound } from './common';

/**
 * The game's own questions and notices, in place of the browser's: a small night panel over a dimmed page. Enter says
 * yes (or presses the button it is on), Escape says no. Each call opens its own dialog and resolves when it is answered.
 */
interface AskOptions {
  title?: string;
  /** The yes button's words (default "OK"). */
  yes?: string;
  /** The no button's words (default "Cancel"); null for a notice with one button. */
  no?: string | null;
  /** Losing something: the yes button is red. */
  danger?: boolean;
  /** Ask for a line of text (a name to type, say). */
  input?: { placeholder?: string };
}

function open<T>(text: string, o: AskOptions, done: (yes: boolean, typed: string) => T): Promise<T> {
  return new Promise((resolve) => {
    const host = document.createElement('div');
    document.body.appendChild(host);
    const root = createRoot(host);
    const close = (yes: boolean, typed: string) => {
      root.unmount();
      host.remove();
      resolve(done(yes, typed));
    };
    root.render(<Dialog text={text} o={o} close={close} />);
  });
}

/** Ask before doing something; resolves true for yes. */
export const ask = (text: string, o: AskOptions = {}) => open(text, o, (yes) => yes);
/** Tell the player something (an error, a result). */
export const tell = (text: string, title?: string) => open(text, { title, no: null }, () => undefined);
/** Ask for a line of text; resolves null when canceled. */
export const askText = (text: string, o: AskOptions = {}) => open(text, { ...o, input: o.input ?? {} }, (yes, typed) => (yes ? typed : null));

function Dialog({ text, o, close }: { text: string; o: AskOptions; close: (yes: boolean, typed: string) => void }) {
  const [typed, setTyped] = useState('');
  const first = useRef<HTMLButtonElement | HTMLInputElement | null>(null);
  // Losing something starts on the way out: a stray Enter keeps it.
  const focusNo = !!o.danger && !o.input && o.no !== null;
  usePanelSound(true);
  useEffect(() => {
    first.current?.focus();
    const key = (e: KeyboardEvent) => {
      if (e.key === 'Escape') close(false, '');
      // Enter on a button presses that button (Cancel too); anywhere else it says yes.
      else if (e.key === 'Enter' && !(document.activeElement instanceof HTMLButtonElement)) close(true, (document.querySelector('.m-ask input') as HTMLInputElement | null)?.value ?? '');
      else return;
      e.preventDefault();
      e.stopPropagation();
    };
    addEventListener('keydown', key, true);
    return () => removeEventListener('keydown', key, true);
  }, []);
  return (
    <div className="m-root m-ask" onClick={() => o.no !== null && close(false, '')}>
      <div className="m-panel pad" role="alertdialog" aria-modal="true" aria-label={o.title ?? text} onClick={(e) => e.stopPropagation()}>
        {o.title && <h3>{o.title}</h3>}
        <p>{text}</p>
        {o.input && <input ref={(el) => void (first.current = el)} className="m-well" value={typed} placeholder={o.input.placeholder} onChange={(e) => setTyped(e.target.value)} />}
        <div className="btns">
          {o.no !== null && <button ref={focusNo ? (el) => void (first.current = el) : undefined} className="m-quiet" onClick={() => close(false, '')}>{o.no ?? 'Cancel'}</button>}
          <button ref={o.input || focusNo ? undefined : (el) => void (first.current = el)} className={o.danger ? 'm-quiet m-sure' : 'm-lantern'} onClick={() => close(true, typed)}>{o.yes ?? 'OK'}</button>
        </div>
      </div>
    </div>
  );
}
