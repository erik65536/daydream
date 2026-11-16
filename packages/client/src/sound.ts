/**
 * The game's sound (docs/voices.md, "What the player hears and sees"; docs/sound.md): one AudioContext with a gain
 * per kind of sound (voices, interface, effects, music, ambience) feeding a master gain and a light limiter. Interface
 * sounds, effects, music, and ambience are played by sounds.ts; spoken lines here.
 *
 * Spoken lines arrive from the server (shared/speech.ts): `line` keeps a line's place in its queue, `line_start` and
 * binary packets bring its audio (Opus, decoded with WebCodecs, or 16-bit PCM), `line_end` closes it. The lines of
 * a queue play one after another, each as soon as its audio is there, with a short buffer to keep it smooth.
 *
 * Browsers keep sound off until the player has interacted with the page, so sound is unlocked by the first click,
 * tap or key press (a gamepad press may not count).
 */
import { readLinePacket, type LineCodec, type SoundBus } from '@daydream/shared';
import { onSettings, pagesMuted, settings } from './settings';

const BUSES = ['interface', 'effects', 'music', 'ambience'] as const satisfies readonly SoundBus[];

/** Audio is scheduled this far ahead of now when a line starts or runs dry. */
const LEAD_S = 0.12;
/** The pause between two lines of a queue. */
const GAP_S = 0.18;

type LineStatus = 'done' | 'expired' | 'failed' | 'cancelled';

interface PlayLine {
  id: string;
  queue: string;
  at?: { x: number; y: number };
  codec?: LineCodec;
  rate: number;
  /** Decoded audio waiting to be scheduled. */
  chunks: AudioBuffer[];
  decoder?: AudioDecoder;
  timestamp: number;
  status?: LineStatus;
  /** All its audio is decoded (the decoder flushed after the end). */
  complete: boolean;
  gain?: GainNode;
  sources: AudioBufferSourceNode[];
  /** Context time its first audio plays, and when its last scheduled audio ends. */
  startsAt?: number;
  endsAt?: number;
}

class Sound {
  private ctx: AudioContext | null = null;
  private master!: GainNode;
  private voice!: GainNode;
  private buses = {} as Record<SoundBus, GainNode>;
  private lines = new Map<string, PlayLine>();
  /** Each queue's lines in order, and where its audio is scheduled up to. */
  private queues = new Map<string, { lines: PlayLine[]; playhead: number }>();
  private endListeners = new Set<(id: string, status: LineStatus) => void>();
  /**
   * Where the player hears the world from (ground meters), and how far: sounds with a place are heard from there. The
   * game sets it to the middle of the view, so what the player sees is what they hear.
   */
  listener: () => { x: number; y: number; earshot: number } | null = () => null;

  constructor() {
    if (typeof window === 'undefined') return;
    const unlock = () => this.unlock();
    for (const ev of ['pointerdown', 'keydown', 'touchend']) window.addEventListener(ev, unlock, { capture: true });
    onSettings(() => this.changed());
  }

  /** The game is being played: the pages' mute does not reach it. */
  private playing = false;
  private changeListeners = new Set<() => void>();

  setPlaying(on: boolean) {
    if (on === this.playing) return;
    this.playing = on;
    this.changed();
  }

  private silenced(): boolean {
    return pagesMuted() && !this.playing;
  }

  private changed() {
    this.applyVolumes();
    for (const f of this.changeListeners) f();
  }

  /** What can be heard may have changed: a volume, the pages' mute, or the game starting or ending. */
  onChange(fn: () => void) {
    this.changeListeners.add(fn);
    return () => this.changeListeners.delete(fn);
  }

  /** Sound is allowed (the page has been interacted with). */
  get unlocked(): boolean {
    return this.ctx?.state === 'running';
  }

  /** Try to start sound: on the first interaction, or at once if the page already had one. */
  unlock() {
    if (!this.ctx) {
      const activated = (navigator as Navigator & { userActivation?: { hasBeenActive: boolean } }).userActivation?.hasBeenActive;
      if (activated === false) return;
      this.ctx = new AudioContext({ latencyHint: 'interactive' });
      const limiter = this.ctx.createDynamicsCompressor();
      limiter.threshold.value = -3;
      limiter.knee.value = 2;
      limiter.ratio.value = 12;
      limiter.attack.value = 0.003;
      limiter.release.value = 0.15;
      this.master = this.ctx.createGain();
      this.voice = this.ctx.createGain();
      this.voice.connect(this.master).connect(limiter).connect(this.ctx.destination);
      for (const b of BUSES) (this.buses[b] = this.ctx.createGain()).connect(this.master);
      this.applyVolumes();
      // Sound is allowed whenever the context runs: made during an interaction it may run at once, or after resume().
      let was = false;
      const changed = () => {
        const now = this.ctx?.state === 'running';
        if (now && !was) this.unlockListeners.forEach((f) => f());
        was = now;
      };
      this.ctx.addEventListener('statechange', changed);
      queueMicrotask(changed);
    }
    // iOS also leaves it 'interrupted' after a call or a trip to another app: any touch brings it back.
    if (this.ctx.state !== 'running') void this.ctx.resume();
  }

  private unlockListeners = new Set<() => void>();
  /** Sound becomes allowed (the first time, and again after the browser suspended it). */
  onUnlock(fn: () => void) {
    this.unlockListeners.add(fn);
    return () => this.unlockListeners.delete(fn);
  }

  private applyVolumes() {
    if (!this.ctx) return;
    const s = settings().sound;
    const t = this.ctx.currentTime;
    this.master.gain.setTargetAtTime(this.silenced() ? 0 : s.master, t, 0.03);
    this.voice.gain.setTargetAtTime(s.voices, t, 0.03);
    for (const b of BUSES) this.buses[b].gain.setTargetAtTime(s[b], t, 0.03);
  }

  /** The audio context once sound is allowed (null before the first interaction). */
  context(): AudioContext | null {
    return this.ctx?.state === 'running' ? this.ctx : null;
  }

  /**
   * Whether sounds of a kind can be heard at all (not on muted pages, their volume, and the master's above zero): unheard
   * ones are not even loaded.
   */
  audible(b: SoundBus | 'voices'): boolean {
    const s = settings().sound;
    return !this.silenced() && s.master > 0 && s[b] > 0;
  }

  /** Where sounds of a kind go (their volume in Settings); null before sound is allowed. */
  bus(b: SoundBus): GainNode | null {
    return this.context() ? this.buses[b] : null;
  }

  /** How this browser takes speech: Opus where WebCodecs can decode it, else 16-bit PCM. */
  codec(): LineCodec {
    return typeof AudioDecoder !== 'undefined' ? 'opus' : 'pcm';
  }

  /** A line was announced: it takes its place in its queue. */
  line(id: string, queue: string, at?: { x: number; y: number }) {
    if (this.lines.has(id)) return;
    const line: PlayLine = { id, queue, at, rate: 24000, chunks: [], timestamp: 0, complete: false, sources: [] };
    this.lines.set(id, line);
    let q = this.queues.get(queue);
    if (!q) this.queues.set(queue, (q = { lines: [], playhead: 0 }));
    q.lines.push(line);
  }

  start(id: string, rate: number, codec: LineCodec) {
    const line = this.lines.get(id);
    if (!line || !this.ctx) return;
    line.rate = rate;
    line.codec = codec;
    if (codec === 'opus' && typeof AudioDecoder !== 'undefined') {
      const decoder = new AudioDecoder({
        output: (data) => {
          const n = data.numberOfFrames;
          const buf = this.ctx!.createBuffer(1, n, data.sampleRate);
          const plane = new Float32Array(n);
          data.copyTo(plane, { planeIndex: 0, format: 'f32-planar' });
          buf.copyToChannel(plane, 0);
          data.close();
          line.chunks.push(buf);
          this.pump(line.queue);
        },
        error: () => this.end(id, 'failed'),
      });
      decoder.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: 1 });
      line.decoder = decoder;
    }
  }

  /** A binary message from the server: a piece of a line's audio. */
  packet(data: ArrayBuffer) {
    const p = readLinePacket(new Uint8Array(data));
    const line = p && this.lines.get(p.lineId);
    if (!line || !this.ctx || line.status) return;
    if (line.decoder) {
      if (line.decoder.state !== 'configured') return;
      line.decoder.decode(new EncodedAudioChunk({ type: 'key', timestamp: line.timestamp, data: p.data }));
      line.timestamp += 20_000;
    } else if (line.codec === 'pcm') {
      const pcm = new Int16Array(p.data.slice().buffer);
      const buf = this.ctx.createBuffer(1, pcm.length, line.rate);
      const ch = buf.getChannelData(0);
      for (let i = 0; i < pcm.length; i++) ch[i] = pcm[i]! / 32768;
      line.chunks.push(buf);
      this.pump(line.queue);
    }
  }

  /** The server closed a line. */
  end(id: string, status: LineStatus) {
    const line = this.lines.get(id);
    if (!line || line.status) return;
    line.status = status;
    for (const f of this.endListeners) f(id, status);
    const finish = () => {
      line.complete = true;
      this.pump(line.queue);
      this.checkQuiet();
    };
    if (status === 'done' && line.decoder?.state === 'configured') line.decoder.flush().then(finish, finish);
    else finish();
  }

  onEnd(fn: (id: string, status: LineStatus) => void) {
    this.endListeners.add(fn);
    return () => this.endListeners.delete(fn);
  }

  /** Schedule what a queue can play now. */
  private pump(queueId: string) {
    const q = this.queues.get(queueId);
    const ctx = this.ctx;
    if (!q || !ctx) return;
    while (q.lines.length) {
      const line = q.lines[0]!;
      if (line.chunks.length) {
        if (!line.gain) {
          line.gain = ctx.createGain();
          line.gain.gain.value = this.distanceGain(line);
          line.gain.connect(this.voice);
        }
        for (const buf of line.chunks.splice(0)) {
          const at = Math.max(q.playhead, ctx.currentTime + (line.startsAt === undefined ? LEAD_S : 0.02));
          const src = ctx.createBufferSource();
          src.buffer = buf;
          src.connect(line.gain);
          src.start(at);
          line.sources.push(src);
          line.startsAt ??= at;
          q.playhead = at + buf.duration;
          line.endsAt = q.playhead;
        }
      }
      if (!line.complete) break;
      // Over: the next line follows after a breath (or at once if this one was never heard).
      q.lines.shift();
      if (line.endsAt !== undefined) q.playhead = line.endsAt + GAP_S;
      line.decoder?.state === 'configured' && line.decoder.close();
      setTimeout(() => this.lines.delete(line.id), Math.max(0, ((line.endsAt ?? 0) - ctx.currentTime) * 1000) + 1000);
    }
    if (!q.lines.length && q.playhead < ctx.currentTime) this.queues.delete(queueId);
    this.checkQuiet();
  }

  /**
   * Someone is speaking to the player: a line of a conversation or the narrator is still to be heard or being heard.
   * A remark heard from a place (a passer-by's) does not count.
   */
  speaking(): boolean {
    for (const line of this.lines.values()) if (!line.at && this.pending(line.id)) return true;
    return false;
  }

  private afterQuiet: (() => void)[] = [];
  private quietTimer: ReturnType<typeof setTimeout> | null = null;

  /** Run `fn` once nobody is speaking to the player (at once if nobody is). */
  whenQuiet(fn: () => void) {
    this.afterQuiet.push(fn);
    this.checkQuiet();
  }

  private checkQuiet() {
    if (!this.afterQuiet.length) return;
    if (this.quietTimer) clearTimeout(this.quietTimer);
    this.quietTimer = null;
    if (!this.speaking()) {
      for (const f of this.afterQuiet.splice(0)) f();
      return;
    }
    // Every line is known to its end: look again when the last of them has played. Otherwise its end comes as news.
    const talking = [...this.lines.values()].filter((l) => !l.at && this.pending(l.id));
    if (!this.ctx || talking.some((l) => !l.complete)) return;
    const ends = Math.max(...talking.map((l) => l.endsAt ?? 0));
    this.quietTimer = setTimeout(() => this.checkQuiet(), Math.max(0, ends - this.ctx.currentTime) * 1000 + 30);
  }

  private distanceGain(line: PlayLine): number {
    return this.heard(line.at).gain;
  }

  /**
   * How a sound from a place in the world is heard from the listener: quieter with distance (silent past its earshot)
   * and a little to the side it is on. Everywhere at once when it has no place.
   */
  heard(at?: { x: number; y: number }): { gain: number; pan: number } {
    const me = at && this.listener();
    if (!at || !me) return { gain: 1, pan: 0 };
    const d = Math.hypot(at.x - me.x, at.y - me.y);
    return { gain: Math.max(0, 1 - d / me.earshot) ** 1.5, pan: Math.max(-0.6, Math.min(0.6, (at.x - me.x) / me.earshot)) };
  }

  /**
   * How far a line has played: null before it is heard; `seconds` played of `total` known so far, and whether all of
   * it is known. For pacing text to the voice.
   */
  progress(id: string): { seconds: number; total: number; complete: boolean } | null {
    const line = this.lines.get(id);
    if (!line || line.startsAt === undefined || !this.ctx) return null;
    const total = (line.endsAt ?? line.startsAt) - line.startsAt;
    return { seconds: Math.max(0, Math.min(total, this.ctx.currentTime - line.startsAt)), total, complete: line.complete };
  }

  /** Whether a line is still to be heard or being heard (not over, skipped, or dropped). */
  pending(id: string): boolean {
    const line = this.lines.get(id);
    if (!line || !this.ctx) return false;
    if (line.status && line.status !== 'done') return false;
    return !line.complete || (line.endsAt ?? 0) > this.ctx.currentTime;
  }

  /** Stop lines at once: those of queues whose names pass the test. Returns their ids (to tell the server). */
  stop(test: (queue: string, id: string) => boolean): string[] {
    const stopped: string[] = [];
    for (const [qid, q] of this.queues) {
      const keep: PlayLine[] = [];
      for (const line of q.lines) {
        if (!test(qid, line.id)) keep.push(line);
        else stopped.push(this.silence(line));
      }
      // Lines already handed to the audio clock and still playing.
      q.lines = keep;
      if (!keep.length) this.queues.delete(qid);
    }
    for (const line of this.lines.values()) if (!stopped.includes(line.id) && test(line.queue, line.id) && this.pending(line.id)) stopped.push(this.silence(line));
    this.checkQuiet();
    return stopped;
  }

  private silence(line: PlayLine): string {
    for (const s of line.sources) {
      try {
        s.stop();
      } catch {
        /* not started */
      }
    }
    line.sources = [];
    line.chunks = [];
    line.status ??= 'cancelled';
    line.complete = true;
    line.endsAt = this.ctx?.currentTime;
    if (line.decoder?.state === 'configured') line.decoder.close();
    return line.id;
  }

  /** Forget everything (a new connection). */
  reset() {
    this.stop(() => true);
    this.lines.clear();
    this.queues.clear();
    this.checkQuiet();
  }
}

export const sound = new Sound();
