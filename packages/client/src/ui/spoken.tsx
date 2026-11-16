/** Spoken text on screen: words that keep pace with the voice reading them, and the mark of a line that was not voiced. */
import { useEffect, useRef, useState } from 'react';
import type { SpokenLine } from '@daydream/shared';
import { client } from '../net/game';
import { sound } from '../sound';
import { tip } from './common';
import { Icon } from './svgicons';

/** Text that is not voiced types itself out in about this long (and never slower than TYPE_CPS); a voice speaks about SPEAK_CPS. */
const TYPE_MS = 1400;
const TYPE_CPS = 45;
const SPEAK_CPS = 14;

/**
 * How much of a voiced text to show: each line's words appear as they are heard. A line that is over (heard, skipped
 * or dropped) shows in full; words not yet in a line show once the text is finished (they were not said).
 */
function heardChars(text: string, lines: SpokenLine[], pending: boolean): number {
  let from = 0;
  for (const l of lines) {
    const chars = l.to - from;
    if (sound.pending(l.id)) {
      const p = sound.progress(l.id);
      if (!p) return from;
      const frac = p.complete && p.total > 0 ? p.seconds / p.total : Math.min(0.98, p.seconds / Math.max(0.5, chars / SPEAK_CPS));
      return from + Math.floor(chars * frac);
    }
    from = l.to;
  }
  return pending ? from : text.length;
}

/**
 * Reveals the newest line progressively, like a reply being spoken, while it is written (`pending`) and after. When
 * it is voiced for this player (`voiced`, with their voices on), the words keep pace with the voice, as subtitles do;
 * otherwise they type themselves out. Clicking shows it all (and stops the voice).
 */
export function Typed({ text, lines, animate, voiced, pending, unvoiced }: { text: string; lines?: SpokenLine[]; animate: boolean; voiced?: boolean; pending?: boolean; unvoiced?: boolean }) {
  const [n, setN] = useState(animate ? 0 : text.length);
  const [all, setAll] = useState(!animate);
  // The loop reads the latest text, lines, and state (they change while it runs).
  const now = useRef({ text, lines, pending });
  now.current = { text, lines, pending };
  const shown = useRef(animate ? 0 : text.length);
  useEffect(() => {
    if (all || !animate) {
      shown.current = now.current.text.length;
      return setN(shown.current);
    }
    const listen = !!voiced && sound.audible('voices') && sound.unlocked;
    let raf = 0;
    let last = performance.now();
    const frame = (t: number) => {
      const { text: txt, lines: ls = [], pending: more } = now.current;
      const target = listen ? heardChars(txt, ls, !!more) : shown.current + (Math.max(TYPE_CPS, txt.length / (TYPE_MS / 1000)) * (t - last)) / 1000;
      last = t;
      shown.current = Math.min(txt.length, Math.max(shown.current, target));
      setN(Math.floor(shown.current));
      if (more || shown.current < txt.length) raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);
    return () => cancelAnimationFrame(raf);
  }, [animate, all, voiced, pending]);
  const showAll = () => {
    setAll(true);
    if (lines?.length) client().skipLines(lines.map((l) => l.id));
  };
  const upTo = all || !animate ? text.length : n;
  const rest = upTo < text.length || (pending && !all);
  return (
    <span onClick={rest ? showAll : undefined}>
      {text.slice(0, upTo)}
      {rest && <span className="caret" />}
      {/* The words still to come hold their place, so the text does not reflow or grow its box as it appears. */}
      {upTo < text.length && <span className="typed-rest" aria-hidden>{text.slice(upTo)}</span>}
      {!rest && unvoiced && <UnvoicedMark />}
    </span>
  );
}

/** A quiet mark on a line that could not be voiced. */
function UnvoicedMark() {
  return (
    <span className="unvoiced" tabIndex={0} role="img" aria-label="Could not be voiced" {...tip('Could not be voiced')}>
      <Icon name="muted" size={14} color="currentColor" />
    </span>
  );
}
