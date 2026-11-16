/**
 * Speaking instead of typing: the server's transcription model when it has one, else the browser's own speech
 * recognition. (People's own voices come from the server: see sound.ts.)
 *
 * One utterance at a time: `listen` records until the speaker pauses (or `finish` is called), then turns it into
 * text; `cancel` drops it; `hold` means the speaker is holding the button down, so only letting go ends it. While it
 * runs it reports how loud the microphone is (to draw it), what has been understood so far where the recognizer says,
 * and when it has stopped listening and is working out the words.
 */

import { Endpointer } from './endpointer';

export interface Listening {
  /** Words understood so far (the browser's recognizer only). */
  partial?(text: string): void;
  /** How loud the microphone is now, 0 (the room's quiet) to 1, about 20 times a second. */
  level?(level: number): void;
  /** Listening has ended and the words are being worked out. */
  understanding?(): void;
}

interface VoiceIn {
  available(): boolean;
  /** Listen for one utterance; resolves with what was said ('' when nothing was understood or it was canceled). */
  listen(on?: Listening): Promise<string>;
  /** Stop listening and use what was heard. */
  finish(): void;
  /** Push to talk: the speaker is holding the button, so a pause does not end the utterance; `finish` does. */
  hold(): void;
  /** Stop and forget what was heard. */
  cancel(): void;
}

/** What went wrong, said calmly enough to show in the conversation. */
class VoiceError extends Error {}

type Recognition = { lang: string; interimResults: boolean; continuous: boolean; start(): void; stop(): void; abort(): void; onresult: ((e: { results: ArrayLike<ArrayLike<{ transcript: string }> & { isFinal: boolean }> }) => void) | null; onend: (() => void) | null; onerror: ((e: { error?: string }) => void) | null };

/** The browser's speech recognition (Chrome, Edge, and Safari; it may send audio to the browser maker's service). */
class BrowserVoiceIn implements VoiceIn {
  private rec: Recognition | null = null;
  private dropped = false;
  private ctor(): (new () => Recognition) | undefined {
    const w = window as unknown as { SpeechRecognition?: new () => Recognition; webkitSpeechRecognition?: new () => Recognition };
    return w.SpeechRecognition ?? w.webkitSpeechRecognition;
  }
  available() {
    return typeof window !== 'undefined' && !!this.ctor();
  }
  listen(on: Listening = {}): Promise<string> {
    const C = this.ctor();
    if (!C) return Promise.resolve('');
    this.cancel();
    this.dropped = false;
    return new Promise((done, fail) => {
      const rec = new C();
      this.rec = rec;
      rec.lang = navigator.language || 'en-US';
      rec.interimResults = true;
      rec.continuous = false;
      let text = '';
      rec.onresult = (e) => {
        text = Array.from(e.results).map((r) => r[0]!.transcript).join(' ').trim();
        on.partial?.(text);
      };
      rec.onend = () => {
        this.rec = null;
        done(this.dropped ? '' : text);
      };
      rec.onerror = (e) => {
        this.rec = null;
        if (this.dropped || e.error === 'aborted' || e.error === 'no-speech') return done(this.dropped ? '' : text);
        if (e.error === 'not-allowed') fail(new VoiceError('The microphone is blocked. Allow it for this site to speak.'));
        else if (e.error === 'audio-capture') fail(new VoiceError('No microphone was found.'));
        else fail(new VoiceError("This browser's speech recognition is not working here. Type instead, or try another browser."));
      };
      rec.start();
    });
  }
  finish() {
    this.rec?.stop();
  }
  /** The browser's recognizer decides for itself when the speaker has finished. */
  hold() {}
  cancel() {
    this.dropped = true;
    this.rec?.abort();
    this.rec = null;
  }
}

/** How long the microphone keeps recording after the speaker presses Done or lets go: the last syllable is often
 * still being said, and still on its way through the browser's audio path. */
const TAIL_MS = 400;

/**
 * Speech to text on the server (a transcription model): records one utterance with the microphone, stops after
 * a pause (see endpointer.ts) or when finished, and sends it to be transcribed. Works in any browser with a microphone.
 */
class ServerVoiceIn implements VoiceIn {
  private end: ((keep: boolean) => void) | null = null;
  private abort: AbortController | null = null;
  private holding = false;
  /**
   * Asked for before the microphone was open (while the browser asks permission, or the server is first asked whether
   * it has a speech model): done as soon as it is, so a cancel never leaves the microphone on.
   */
  private early: 'finish' | 'cancel' | null = null;
  private opening = false;
  /** Whether the server has a speech model (null until asked). */
  enabled: boolean | null = null;
  async probe(): Promise<boolean> {
    if (this.enabled === null) {
      const v = await fetch('/api/voice', { credentials: 'include' }).then((r) => (r.ok ? r.json() : null)).catch(() => null);
      if (v) this.enabled = !!(v as { speechInput?: boolean }).speechInput;
    }
    return !!this.enabled;
  }
  available() {
    return this.enabled !== false && typeof navigator !== 'undefined' && !!navigator.mediaDevices?.getUserMedia && typeof MediaRecorder !== 'undefined';
  }
  /** A new utterance is about to be listened for: whatever is asked of it from now on is kept until it can be done. */
  begin() {
    this.cancel();
    this.holding = false;
    this.early = null;
    this.opening = true;
  }
  /** Canceled before the microphone was open. */
  dropped() {
    return this.early === 'cancel';
  }
  async listen(on: Listening = {}): Promise<string> {
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    } catch (e) {
      this.opening = false;
      throw new VoiceError((e as Error).name === 'NotFoundError' ? 'No microphone was found.' : 'The microphone is blocked. Allow it for this site to speak.');
    }
    this.opening = false;
    if (this.dropped()) {
      stream.getTracks().forEach((t) => t.stop());
      return '';
    }
    const mime = ['audio/webm;codecs=opus', 'audio/webm', 'audio/ogg;codecs=opus', 'audio/mp4'].find((m) => MediaRecorder.isTypeSupported(m)) ?? '';
    const rec = new MediaRecorder(stream, mime ? { mimeType: mime } : undefined);
    const chunks: Blob[] = [];
    rec.ondataavailable = (e) => e.data.size && chunks.push(e.data);
    const done = new Promise<void>((resolve) => (rec.onstop = () => resolve()));
    rec.start(250);
    const started = performance.now();
    let keep = true, peak = 0, tail = 0;
    this.end = (k) => {
      keep = k;
      if (rec.state !== 'recording') return;
      if (!k) return rec.stop();
      tail ||= window.setTimeout(() => rec.state === 'recording' && rec.stop(), TAIL_MS);
    };
    if (this.early === 'finish') this.end(true);
    // Loudness, read about 20 times a second, tells when the speaker has finished.
    const ac = new AudioContext();
    void ac.resume();
    const an = ac.createAnalyser();
    an.fftSize = 1024;
    ac.createMediaStreamSource(stream).connect(an);
    const buf = new Float32Array(an.fftSize);
    const ep = new Endpointer();
    const watch = setInterval(() => {
      an.getFloatTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += v * v;
      const level = Math.sqrt(sum / buf.length);
      peak = Math.max(peak, level);
      ep.held = this.holding;
      const over = ep.hear(level, performance.now());
      // Loudness on a log scale above the room's quiet, which is how loud it sounds.
      on.level?.(Math.max(0, Math.min(1, Math.log10(Math.max(1e-5, level) / Math.max(0.002, ep.quiet * 1.4)) / 1.3)));
      if (over && rec.state === 'recording') rec.stop();
    }, 50);
    await done;
    clearInterval(watch);
    clearTimeout(tail);
    stream.getTracks().forEach((t) => t.stop());
    void ac.close();
    this.end = null;
    on.level?.(0);
    // Send whatever was recorded unless it was only a blip; the transcription model knows silence when it hears it.
    if (!keep || !chunks.length || performance.now() - started < 600) return '';
    if (peak < 0.0015) throw new VoiceError('No sound reached the microphone. Check that the right one is selected.');
    on.understanding?.();
    const blob = new Blob(chunks, { type: rec.mimeType || 'audio/webm' });
    this.abort = new AbortController();
    try {
      const res = await fetch(`/api/voice/transcribe?lang=${encodeURIComponent((navigator.language || 'en').slice(0, 2))}`, { method: 'POST', headers: { 'content-type': blob.type.split(';')[0]! }, body: blob, credentials: 'include', signal: this.abort.signal });
      const data = (await res.json().catch(() => ({}))) as { text?: string; error?: string };
      if (!res.ok) throw new VoiceError(data.error ?? 'The words could not be made out.');
      return data.text ?? '';
    } catch (e) {
      if ((e as Error).name === 'AbortError') return '';
      throw e instanceof VoiceError ? e : new VoiceError('The words could not be made out. Check the connection and try again.');
    } finally {
      this.abort = null;
    }
  }
  finish() {
    if (this.end) this.end(true);
    else if (this.opening) this.early ??= 'finish';
  }
  hold() {
    this.holding = true;
  }
  cancel() {
    if (this.end) this.end(false);
    else if (this.opening) this.early = 'cancel';
    this.abort?.abort();
  }
}

const serverIn = new ServerVoiceIn();
const browserIn = new BrowserVoiceIn();
let using: VoiceIn = browserIn;
/** The server's transcription when it has a speech model (reliable everywhere), else the browser's own. */
export const voiceIn: VoiceIn & { live(): boolean } = {
  available: () => serverIn.available() || browserIn.available(),
  /** Whether the recognizer shows words as they are said (the browser's does; the server's gives them at the end). */
  live: () => using === browserIn,
  listen: async (on) => {
    serverIn.begin();
    using = (await serverIn.probe()) && serverIn.available() ? serverIn : browserIn;
    if (serverIn.dropped()) return '';
    return using.listen(on);
  },
  // (To both: which one listens may not be known yet, and the one that does not has nothing to finish.)
  finish: () => (serverIn.finish(), browserIn.finish()),
  hold: () => serverIn.hold(),
  cancel: () => (serverIn.cancel(), browserIn.cancel()),
};
