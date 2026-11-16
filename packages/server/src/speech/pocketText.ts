/**
 * Pocket TTS's text front end, ported from pocket-tts 4.0.1 (models/text_chunking.py) so the game speaks without
 * Python: the tokenizer (a Unigram model with byte fallback, as both its tokenizer kinds are), the clean-up of a line
 * into the form the model was trained on, and the split of a long line into chunks of whole sentences. The export
 * (speech/pocket_export.py) records how pocket-tts itself splits and tokenizes a set of texts, and
 * `src/cli/pocketcheck.ts` compares.
 */

export interface TextOptions {
  padShortInputs: boolean;
  removeSemicolons: boolean;
  terminalPunctuation: boolean;
  capitalize: boolean;
  replace: Record<string, string> | null;
}

const SPACE = '▁';
/** Below the lowest piece: a character no piece covers (then spelled as its UTF-8 bytes). */
const UNK_PENALTY = 10;

/** The tokenizer.json of an export: [piece, score, kind] by id. */
export interface Vocabulary {
  pieces: [string, number, 'normal' | 'byte' | 'control'][];
}

export class Tokenizer {
  /** Normal pieces by their text, and the longest in code points. */
  private ids = new Map<string, { id: number; score: number }>();
  private longest = 1;
  private bytes: number[] = new Array(256);
  private byteValue = new Map<number, number>();
  private unkScore: number;
  private texts: string[];

  constructor(vocab: Vocabulary) {
    let min = Infinity;
    this.texts = vocab.pieces.map(([p]) => p);
    vocab.pieces.forEach(([piece, score, kind], id) => {
      if (kind === 'normal') {
        this.ids.set(piece, { id, score });
        this.longest = Math.max(this.longest, [...piece].length);
        min = Math.min(min, score);
      } else if (kind === 'byte') {
        const b = parseInt(piece.slice(3, 5), 16);
        this.bytes[b] = id;
        this.byteValue.set(id, b);
      }
    });
    this.unkScore = min - UNK_PENALTY;
  }

  /** A ▁ before the text and in place of every space, each word (from one ▁ to the next) cut into its best pieces. */
  encode(text: string): number[] {
    const out: number[] = [];
    for (const word of (SPACE + text.replaceAll(' ', SPACE)).split(/(?=▁)/)) this.viterbi([...word], out);
    return out;
  }

  /** The highest-scoring split of one word into pieces; a character no piece covers is spelled in bytes. */
  private viterbi(chars: string[], out: number[]) {
    const n = chars.length;
    const best = new Float64Array(n + 1).fill(-Infinity);
    const from = new Int32Array(n + 1);
    const piece = new Int32Array(n + 1);
    best[0] = 0;
    for (let i = 0; i < n; i++) {
      if (best[i] === -Infinity) continue;
      let single = false;
      let s = '';
      for (let j = i; j < Math.min(n, i + this.longest); j++) {
        s += chars[j];
        const p = this.ids.get(s);
        if (!p) continue;
        if (j === i) single = true;
        const score = best[i]! + p.score;
        if (score > best[j + 1]!) {
          best[j + 1] = score;
          from[j + 1] = i;
          piece[j + 1] = p.id;
        }
      }
      if (!single && best[i]! + this.unkScore > best[i + 1]!) {
        best[i + 1] = best[i]! + this.unkScore;
        from[i + 1] = i;
        piece[i + 1] = -1;
      }
    }
    const path: number[] = [];
    for (let end = n; end > 0; end = from[end]!) {
      if (piece[end] !== -1) path.push(piece[end]!);
      else for (const b of [...Buffer.from(chars[end - 1]!, 'utf8')].reverse()) path.push(this.bytes[b]!);
    }
    for (let i = path.length - 1; i >= 0; i--) out.push(path[i]!);
  }

  /** The text of the tokens: ▁ back to spaces less the first, bytes joined as UTF-8, control pieces left out. */
  decode(tokens: number[]): string {
    let text = '';
    let run: number[] = [];
    const flush = () => {
      if (run.length) text += Buffer.from(run).toString('utf8');
      run = [];
    };
    for (const t of tokens) {
      const b = this.byteValue.get(t);
      if (b !== undefined) run.push(b);
      else {
        flush();
        if (this.ids.has(this.texts[t]!)) text += this.texts[t]!.replaceAll(SPACE, ' ');
      }
    }
    flush();
    return text.startsWith(' ') ? text.slice(1) : text;
  }
}

const TERMINAL = '.!?…';
const WEAK = ',;:-–—';
const CLOSERS = '"\'”’)]»';
const words = (s: string) => s.split(/\s+/).filter(Boolean);
const rstrip = (s: string, chars: string) => {
  let end = s.length;
  while (end > 0 && chars.includes(s[end - 1]!)) end--;
  return s.slice(0, end);
};

/** The line as the model was trained on it, and a guess at the frames to speak after the end is heard. */
export function prepareTextPrompt(input: string, o: TextOptions): { text: string; framesAfterEos: number } {
  let text = input.trim();
  if (o.replace) {
    text = words([...text].map((c) => o.replace![c] ?? c).join('')).join(' ');
    // Deleted quotes leave '"Hi?", she said' as 'Hi?, she said': keep the sentence mark only.
    text = text.replace(/([.!?…])\s*[,;:]/gu, '$1');
  }
  if (!text) throw new Error('Text prompt cannot be empty');
  text = text.replaceAll('\n', ' ').replaceAll('\r', ' ').replaceAll('  ', ' ');
  if (o.removeSemicolons) text = text.replaceAll(';', ',');
  const framesAfterEos = words(text).length <= 4 ? 3 : 1;
  if (o.capitalize) {
    const first = String.fromCodePoint(text.codePointAt(0)!);
    text = first.toUpperCase() + text.slice(first.length);
  }
  if (o.terminalPunctuation) {
    const core = rstrip(text, CLOSERS + ' ');
    const closers = text.slice(core.length).trim();
    if (core && !TERMINAL.includes(core.at(-1)!)) text = WEAK.includes(core.at(-1)!) ? rstrip(core, WEAK + ' ') + '.' + closers : text + '.';
  }
  if (o.padShortInputs && words(text).length < 5) text = ' '.repeat(8) + text;
  return { text, framesAfterEos };
}

/** Where segments start: after a run of `marks` tokens (with `tok`, never inside a decimal such as 3.5). */
function boundaries(tokens: number[], marks: Set<number>, tok?: Tokenizer): number[] {
  const out = [0];
  let afterMark = false;
  tokens.forEach((t, i) => {
    if (marks.has(t)) return void (afterMark = true);
    if (afterMark && !(tok && /\p{Nd}\.$/u.test(tok.decode(tokens.slice(0, i))) && /^\p{Nd}/u.test(tok.decode(tokens.slice(i))))) out.push(i);
    afterMark = false;
  });
  return [...out, tokens.length];
}

const segments = (tokens: number[], bounds: number[], tok: Tokenizer) =>
  bounds.slice(1).map((end, i) => ({ n: end - bounds[i]!, text: tok.decode(tokens.slice(bounds[i], end)) }));

/** Whole sentences grouped into chunks of at most `maxTokens`; a longer sentence is split on , ; and :. */
export function splitIntoBestSentences(tok: Tokenizer, input: string, maxTokens: number, o: TextOptions): string[] {
  const text = prepareTextPrompt(input, o).text.trim();
  const tokens = tok.encode(text);
  const sentences = segments(tokens, boundaries(tokens, new Set(tok.encode('.!...?').slice(1)), tok), tok);
  const commas = new Set(tok.encode(',;:').slice(1));
  const parts = sentences.flatMap((s) => {
    if (s.n <= maxTokens) return [s];
    const sub = tok.encode(s.text.trim());
    const split = segments(sub, boundaries(sub, commas), tok);
    return split.length > 1 ? split : [s];
  });
  const chunks: string[] = [];
  let current = '';
  let count = 0;
  for (const { n, text: sentence } of parts) {
    if (current && count + n > maxTokens) {
      chunks.push(current.trim());
      current = sentence;
      count = n;
    } else {
      current = current ? current + ' ' + sentence : sentence;
      count += n;
    }
  }
  return current ? [...chunks, current.trim()] : chunks;
}
