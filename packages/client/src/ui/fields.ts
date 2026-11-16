/**
 * Telling people what is wrong with what they typed, as they type it. A problem shows at once, except one that may only
 * mean the field is not finished (empty, too short), which waits until the field is left or the form is sent. A form
 * is never silently disabled: sending it with a problem shows every problem and moves to the first.
 */
import { useState } from 'react';

/** What is wrong with a field, if anything (a Check from @daydream/shared fits). */
export interface FieldState {
  problem?: string;
  unfinished?: boolean;
}

export function useReveal() {
  const [tried, setTried] = useState(false);
  const [left, setLeft] = useState<ReadonlySet<string>>(new Set());
  return {
    /** The problem to show under a field now, if any. */
    shown: (key: string, f: FieldState) => (f.problem && (!f.unfinished || tried || left.has(key)) ? f.problem : undefined),
    /** For the field's onBlur. */
    leave: (key: string) => () => setLeft((s) => (s.has(key) ? s : new Set(s).add(key))),
    /** Before sending: true when nothing is wrong; else every problem shows and the first field marked invalid gets the focus. */
    ready: (fields: FieldState[]) => {
      if (fields.every((f) => !f.problem)) return true;
      setTried(true);
      requestAnimationFrame(() => document.querySelector<HTMLElement>('[aria-invalid="true"]')?.focus());
      return false;
    },
    /** After a form is sent and cleared. */
    reset: () => {
      setTried(false);
      setLeft(new Set());
    },
  };
}
