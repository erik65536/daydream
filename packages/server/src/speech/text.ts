/**
 * Text as it is spoken (docs/voices.md, "Speaking a line at play time"): what was never meant to be said aloud is
 * left out, and a reply is cut into sentences, each one line, with very short ones joined to the next so the voice
 * does not stop and start on "Ah." or "Well.".
 */

/**
 * The words of a line as they should be heard: no stage directions or markup. (A person's own name before their words
 * is taken off where the reply is written, `sanitizeSpeech`: here "Listen: the bridge is out." keeps its start.)
 */
export function spokenText(text: string): string {
  return text
    .replace(/<[^>]*>/g, ' ')
    .replace(/\*[^*]*\*/g, ' ')
    .replace(/\[[^\]]*\]/g, ' ')
    .replace(/\((?:[^()]*)\)/g, (m) => (/^\((?:sighs?|laughs?|pauses?|smiles?|grins?|whispers?|shrugs?|nods?|frowns?|chuckles?|coughs?)\b/i.test(m) ? ' ' : m))
    .replace(/[_~`#]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/ ([,.;:!?…])/g, '$1')
    .trim();
}

/** Whether there is anything left to say (letters or digits). */
export function sayable(text: string): boolean {
  return /[\p{L}\p{N}]/u.test(text);
}

/** A sentence shorter than this joins the next one. */
const SHORT = 18;

/** A sentence of a text, and where it ends in it (the index after its last character). */
export interface Sentence {
  text: string;
  end: number;
}

/**
 * Cuts text that grows (a streamed reply) into sentences. `push` takes the text so far and returns the sentences it
 * finished; `end` returns what is left. A sentence ends at . ! ? or … followed by a space (and any closing quote).
 */
export class SentenceSplitter {
  /** How far the text has been cut, and the start of a short sentence held to join the next. */
  private taken = 0;
  private held: number | null = null;

  push(textSoFar: string): Sentence[] {
    const out: Sentence[] = [];
    const re = /[.!?…]+["'”’)]*\s+/g;
    re.lastIndex = this.taken;
    let m: RegExpExecArray | null;
    while ((m = re.exec(textSoFar))) {
      const end = m.index + m[0].length;
      this.add(textSoFar, end, out);
    }
    return out;
  }

  end(textSoFar: string): Sentence[] {
    const out = this.push(textSoFar);
    if (textSoFar.slice(this.held ?? this.taken).trim()) out.push({ text: textSoFar.slice(this.held ?? this.taken).trim(), end: textSoFar.trimEnd().length });
    this.held = null;
    this.taken = textSoFar.length;
    return out;
  }

  private add(text: string, end: number, out: Sentence[]) {
    const from = this.held ?? this.taken;
    this.taken = end;
    const s = text.slice(from, end).trim();
    if (!s) return;
    if (s.length < SHORT) this.held = from;
    else {
      this.held = null;
      out.push({ text: s, end: from + text.slice(from, end).trimEnd().length });
    }
  }
}

/** All the sentences of a finished text. */
export function sentences(text: string): Sentence[] {
  return new SentenceSplitter().end(text);
}
