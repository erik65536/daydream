import { describe, expect, it } from 'vitest';
import { Endpointer, LONGEST_MS, NOTHING_SAID_MS, PAUSE_MS } from '../src/endpointer';

const ROOM = 0.0015;
/** Feeds loudness readings every 50 ms; returns when it said the utterance was over (or null). */
function run(level: (t: number) => number, until = 40000, setup?: (ep: Endpointer) => void): number | null {
  const ep = new Endpointer();
  setup?.(ep);
  for (let t = 0; t <= until; t += 50) if (ep.hear(level(t), t)) return t;
  return null;
}
/** Speech: syllables of varying loudness with short dips between them, at `loud` RMS. */
const speech = (t: number, loud: number) => (Math.floor(t / 50) % 5 === 4 ? ROOM * 1.5 : loud * (0.6 + 0.4 * Math.abs(Math.sin(t / 37))));

describe('endpointer', () => {
  it('keeps listening to softer words after a loud start, when speech begins the moment the microphone opens', () => {
    // Loud for 2 s, a 1 s breath, then 3 s at a third of the loudness, then the room.
    const level = (t: number) => (t < 2000 ? speech(t, 0.08) : t < 3000 ? ROOM : t < 6000 ? speech(t, 0.025) : ROOM);
    const end = run(level)!;
    expect(end).toBeGreaterThan(6000 + PAUSE_MS - 100);
    expect(end).toBeLessThan(6000 + PAUSE_MS + 200);
  });

  it('ends after a pause when speech starts after a moment of quiet', () => {
    const level = (t: number) => (t > 600 && t < 2500 ? speech(t, 0.05) : ROOM);
    expect(run(level)).toBeGreaterThan(2500 + PAUSE_MS - 100);
  });

  it('gives up when nothing is said, and stops at the longest utterance', () => {
    expect(run(() => ROOM)).toBe(NOTHING_SAID_MS + 50);
    expect(run((t) => speech(t, 0.05))).toBe(LONGEST_MS + 50);
  });

  it('does not end on a pause while held', () => {
    const level = (t: number) => (t < 1500 ? speech(t, 0.05) : ROOM);
    expect(run(level, 20000, (ep) => (ep.held = true))).toBeNull();
  });
});
