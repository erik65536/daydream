/**
 * When a spoken utterance has ended, from the microphone's loudness alone (no audio leaves the browser for this).
 *
 * Speech is judged against the room's quiet, which differs a lot between microphones and noise suppression. The
 * quiet is followed rather than measured once: it falls at once to any quieter moment (the gaps between words are
 * nearly as quiet as the room) and rises only slowly, so a player who starts talking the moment the microphone opens
 * does not teach it that their voice is the room, and softer words later in the sentence still count as speech.
 */

/** How long a pause ends an utterance. Long enough for a breath or a moment's thought mid-sentence. */
export const PAUSE_MS = 1500;
/** Give up when nothing has been said by then. */
export const NOTHING_SAID_MS = 8000;
/** The longest utterance. */
export const LONGEST_MS = 30000;

/** Below this loudness (RMS) nothing counts as speech, however quiet the room. */
const MIN_SPEECH = 0.003;
/** Speech is this many times louder than the room's quiet. */
const ABOVE_QUIET = 2.5;
/** How quickly the quiet level falls to a quieter moment and rises to a louder one, per reading. */
const FALL = 0.5;
const RISE = 0.002;

export class Endpointer {
  /** The room's quiet (RMS), or -1 before the first reading. */
  quiet = -1;
  /** Whether speech has been heard. */
  spoke = false;
  /** While held (push to talk), only letting go or the longest time ends it, not a pause. */
  held = false;
  private started = 0;
  private lastSpeech = 0;

  /** One loudness reading (RMS of a short window) at `now` ms; true when the utterance is over. */
  hear(level: number, now: number): boolean {
    if (this.quiet < 0) {
      this.quiet = level;
      this.started = this.lastSpeech = now;
    } else this.quiet += (level - this.quiet) * (level < this.quiet ? FALL : RISE);
    if (level > Math.max(MIN_SPEECH, this.quiet * ABOVE_QUIET)) {
      this.spoke = true;
      this.lastSpeech = now;
    }
    if (now - this.started > LONGEST_MS) return true;
    if (this.held) return false;
    return this.spoke ? now - this.lastSpeech > PAUSE_MS : now - this.started > NOTHING_SAID_MS;
  }
}
