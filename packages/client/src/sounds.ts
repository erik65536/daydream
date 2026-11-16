/**
 * Playing the game's sounds (docs/sound.md, "What the player hears"): a world's own set, with the game's own copies
 * standing in for any it lacks; one channel of music that crossfades between pieces; and one ambience under each
 * place. Sounds load and decode once (Ogg Opus: the browser decodes it, or WebCodecs where the browser cannot) and
 * play through their bus in sound.ts, so the Settings volumes apply. The short sounds stay decoded; of the long ones
 * (music, ambience: tens of megabytes each once decoded) only the piece heard now and the one before it do, and a
 * world's are let go on leaving it.
 *
 * Moments that land together (a quest reward that levels a hero up) play only the highest: one that comes within a
 * moment of a higher one is dropped, and a lower one already started is cut when a higher one follows.
 */
import { GAME_SOUNDS, readOggOpus, soundSpec, standIn, gameSoundSpec, type GameSound, type SoundDef, type SoundKey, type SoundSpec } from '@daydream/shared';
import { sound } from './sound';
import { CONTROL } from './input/haptics';

interface SetSource {
  /** Where its files are served. */
  base: string;
  defs: Record<string, SoundDef>;
}

interface Resolved {
  source: SetSource;
  def: SoundDef;
  spec: SoundSpec;
}

/** How long a moment counts as landing with another. */
const TOGETHER_S = 0.25;
/** A repeated sound is pitched up to this much up or down. */
const VARY = 0.04;
/** A page's theme ends like a finished piece: it rests this long before playing again. */
const REPEAT_REST_S = 8;
/** News held while someone spoke plays this long after they finish, as a breath. */
const AFTER_SPEECH_MS = 350;

const decodeWithCodecs = async (ctx: AudioContext, bytes: ArrayBuffer): Promise<AudioBuffer> => {
  const ogg = readOggOpus(new Uint8Array(bytes));
  const parts: Float32Array[][] = [];
  const dec = new AudioDecoder({
    output: (d) => {
      parts.push(Array.from({ length: d.numberOfChannels }, (_, c) => {
        const plane = new Float32Array(d.numberOfFrames);
        d.copyTo(plane, { planeIndex: c, format: 'f32-planar' });
        return plane;
      }));
      d.close();
    },
    error: () => undefined,
  });
  dec.configure({ codec: 'opus', sampleRate: 48000, numberOfChannels: ogg.channels });
  ogg.packets.forEach((p, i) => dec.decode(new EncodedAudioChunk({ type: 'key', timestamp: i * 20_000, data: p })));
  await dec.flush();
  dec.close();
  const total = parts.reduce((n, p) => n + p[0]!.length, 0);
  const n = Math.max(1, Math.min(ogg.samples || total, total - ogg.preSkip));
  const buf = ctx.createBuffer(ogg.channels, n, 48000);
  for (let c = 0; c < ogg.channels; c++) {
    const all = new Float32Array(total);
    let at = 0;
    for (const p of parts) {
      all.set(p[c] ?? p[0]!, at);
      at += p[0]!.length;
    }
    buf.copyToChannel(all.subarray(ogg.preSkip, ogg.preSkip + n), c);
  }
  return buf;
};

/** A moment asked for: it counts from then, while its sound loads; `cut` when a higher one came within a moment. */
interface Playing {
  key: SoundKey;
  rank: number;
  at: number;
  cut?: boolean;
  src?: AudioBufferSourceNode;
  gain?: GainNode;
}

/** A piece of music or an ambience playing: what it is, and how to fade it out. */
interface Track {
  id: string;
  /** The files it plays. */
  urls: string[];
  gain: GainNode;
  sources: AudioBufferSourceNode[];
  /** It ends by itself (a stinger), at this context time. */
  endsAt?: number;
  /** Resting before it plays again. */
  again?: ReturnType<typeof setTimeout>;
}

interface PlayOptions {
  at?: { x: number; y: number };
  db?: number;
  afterSpeech?: boolean;
}

interface MusicOptions {
  /** The game's own piece rather than the world's. */
  from?: 'world' | 'game';
  /** Play again after a rest until other music is asked for (a page's theme). */
  repeat?: boolean;
}

class Sounds {
  private world: SetSource | null = null;
  private game: SetSource | null = null;
  private gameLoad: Promise<void> | null = null;
  private buffers = new Map<string, Promise<AudioBuffer | null>>();
  /** The files of the long pieces heard last, the newest last: those of the piece heard now and of the one before it. */
  private long: Record<'music' | 'ambience', string[][]> = { music: [], ambience: [] };
  private lastTake = new Map<SoundKey, number>();
  private moments: Playing[] = [];
  /** News waiting for someone to finish speaking (sounds asked to come `afterSpeech`). */
  private held: { key: SoundKey; opts: PlayOptions }[] = [];
  private music: Track | null = null;
  private ambience: Track | null = null;
  /** Music asked for before sound was allowed: it starts on the first interaction. */
  private wanted: (() => void) | null = null;
  /** The place's ambience, whether it is heard now or not. */
  private place: SoundKey | null = null;
  /**
   * The lasting piece asked for (a battle loop, a page's theme), whether it is heard now or not: asked for while music
   * is at 0%, it starts when the volume is raised. A short cue belongs to its moment and is not kept.
   */
  private lasting: { key: SoundKey; opts: MusicOptions } | null = null;

  constructor() {
    if (typeof window === 'undefined') return;
    sound.onUnlock(() => {
      const w = this.wanted;
      this.wanted = null;
      w?.();
      this.preload();
      this.setAmbience(this.place);
    });
    // A volume raised from zero or the pages unmuted: what it plays loads, and the place's ambience comes back; one
    // lowered to zero stops it.
    sound.onChange(() => {
      this.preload();
      this.setAmbience(this.place);
      if (this.lasting && sound.audible('music')) this.playMusic(this.lasting.key, this.lasting.opts);
    });
  }

  /** A sound's spec, the game's own too (its spell and fight-start sounds, its theme). */
  private specOf(key: SoundKey): SoundSpec | undefined {
    return soundSpec(key) ?? (GAME_SOUNDS.includes(key as GameSound) ? gameSoundSpec(key as GameSound) : undefined);
  }

  /** The short sounds are small: they load as soon as they can (unless they are not heard at all), so each plays at once. */
  private preload() {
    if (!sound.context()) return;
    for (const set of [this.world, this.game])
      for (const [key, def] of Object.entries(set?.defs ?? {})) {
        const bus = this.specOf(key)?.bus;
        if ((bus === 'interface' || bus === 'effects') && sound.audible(bus)) for (const f of def.files) void this.buffer(set!.base + f);
      }
  }

  /** The game's own sounds (once): stand-ins and the game's theme. */
  private loadGame(): Promise<void> {
    this.gameLoad ??= fetch('/sounds/index.json')
      .then((r) => (r.ok ? (r.json() as Promise<Record<string, SoundDef>>) : {}))
      .then((defs) => {
        this.game = { base: '/sounds/', defs };
        this.preload();
      })
      .catch(() => void (this.game = { base: '/sounds/', defs: {} }));
    return this.gameLoad;
  }

  /** The world being played (or shown), whose sounds come first; null for none. */
  setWorld(world: { id: string; sounds?: Record<SoundKey, SoundDef> } | null) {
    this.world = world ? { base: `/api/worlds/${world.id}/sounds/`, defs: world.sounds ?? {} } : null;
    void this.loadGame();
    this.preload();
  }

  private resolve(key: SoundKey): Resolved | null {
    const spec = this.specOf(key);
    if (!spec) return null;
    const mine = this.world?.defs[key];
    if (mine && this.world) return { source: this.world, def: mine, spec };
    const s = standIn(key);
    if (s?.world && this.world?.defs[s.world]) return { source: this.world, def: this.world.defs[s.world]!, spec };
    const g = s?.game ? this.game?.defs[s.game] : undefined;
    return g && this.game ? { source: this.game, def: g, spec } : null;
  }

  private buffer(url: string): Promise<AudioBuffer | null> {
    let b = this.buffers.get(url);
    if (!b) {
      b = (async () => {
        const ctx = sound.context();
        if (!ctx) return null;
        const bytes = await (await fetch(url)).arrayBuffer();
        return ctx.decodeAudioData(bytes.slice(0)).catch(() => (typeof AudioDecoder !== 'undefined' ? decodeWithCodecs(ctx, bytes) : null));
      })().catch(() => null);
      // A failed load may be tried again later (sound allowed, the network back).
      void b.then((x) => x || this.buffers.delete(url));
      this.buffers.set(url, b);
    }
    return b;
  }

  /**
   * A long piece starts: its decoded audio is kept with that of the piece before it (going back to a place just left
   * does not load again), and what older pieces held is let go.
   */
  private keep(kind: 'music' | 'ambience', urls: string[]) {
    const list = this.long[kind].filter((g) => g.join() !== urls.join());
    list.push(urls);
    const gone = list.splice(0, Math.max(0, list.length - 2)).flat();
    this.long[kind] = list;
    const held = new Set([...this.long.music, ...this.long.ambience].flat());
    for (const url of gone) if (!held.has(url)) this.buffers.delete(url);
  }

  /** One of a sound's takes, never the one played last when it has others. */
  private pick(key: SoundKey, def: SoundDef): string {
    const n = def.files.length;
    let i = Math.floor(Math.random() * n);
    if (n > 1 && i === this.lastTake.get(key)) i = (i + 1) % n;
    this.lastTake.set(key, i);
    return def.files[i]!;
  }

  /**
   * Play a sound effect. `at`: where in the world it is (heard from the middle of the view); `db`: louder or softer than
   * made (a heavy blow the world has no heavy hit for); `afterSpeech`: news, which waits while someone is speaking to
   * the player (a quest given in a conversation is heard when its giver finishes).
   */
  play(key: SoundKey, opts: PlayOptions = {}) {
    const ctx = sound.context();
    if (!ctx) return;
    if (opts.afterSpeech && sound.speaking()) {
      if (!this.held.length) sound.whenQuiet(() => this.release());
      this.held.push({ key, opts });
      return;
    }
    const r = this.resolve(key);
    // Not the world's own: the game's copy may still be on its way (asked for again once, when it is there).
    if (!r && !this.game) return void this.loadGame().then(() => this.play(key, opts));
    if (!r || (r.spec.bus !== 'interface' && r.spec.bus !== 'effects') || !sound.audible(r.spec.bus)) return;
    const busName = r.spec.bus;
    const now = ctx.currentTime;
    const rank = r.spec.rank;
    const heard = sound.heard(opts.at);
    if (heard.gain <= 0.01) return;
    let moment: Playing | undefined;
    if (rank !== undefined) {
      this.moments = this.moments.filter((m) => now - m.at < TOGETHER_S);
      if (this.moments.some((m) => m.rank > rank)) return;
      // A lower moment just before gives way, whether it is heard yet or still loading.
      for (const m of this.moments) {
        if (m.rank >= rank) continue;
        m.cut = true;
        if (m.src && m.gain) fadeOut(m.gain, now, 0.03, m.src);
      }
      this.moments.push((moment = { key, rank, at: now }));
    }
    const file = this.pick(key, r.def);
    void this.buffer(r.source.base + file).then((buf) => {
      const bus = sound.bus(busName);
      if (!buf || !bus || moment?.cut) return;
      const src = ctx.createBufferSource();
      src.buffer = buf;
      if (r.spec.vary) src.playbackRate.value = 1 + (Math.random() * 2 - 1) * VARY;
      const gain = ctx.createGain();
      gain.gain.value = heard.gain * 10 ** ((opts.db ?? 0) / 20);
      const pan = ctx.createStereoPanner();
      pan.pan.value = heard.pan;
      src.connect(gain).connect(pan).connect(bus);
      src.start(ctx.currentTime);
      if (moment) Object.assign(moment, { src, gain });
    });
  }

  /**
   * The speaking stopped: after a breath (unless someone speaks again), the news held plays, the highest first, so
   * what landed together is heard as the highest alone.
   */
  private release() {
    setTimeout(() => {
      if (sound.speaking()) return sound.whenQuiet(() => this.release());
      const held = this.held.splice(0).sort((a, b) => (this.specOf(b.key)?.rank ?? 0) - (this.specOf(a.key)?.rank ?? 0));
      for (const h of held) this.play(h.key, { ...h.opts, afterSpeech: false });
    }, AFTER_SPEECH_MS);
  }

  /** Whether a world has a sound of its own (not a stand-in). */
  has(key: SoundKey): boolean {
    return !!this.world?.defs[key];
  }

  /**
   * Play a piece of music: a world's (`theme`, `defeat`, `place:<id>`, `boss:<id>`) or the game's theme. The piece
   * playing fades out; asking for the one already playing changes nothing. A loop plays its intro once, then loops;
   * a piece asked to `repeat` plays again after a rest. Asked before sound is allowed, it starts on the first
   * interaction.
   */
  playMusic(key: SoundKey, opts: MusicOptions = {}) {
    this.lasting = soundSpec(key)?.shape === 'loop' || opts.repeat ? { key, opts } : null;
    const start = () => {
      const ctx = sound.context();
      const bus = sound.bus('music');
      const source = opts.from === 'game' ? this.game : this.world;
      const def = source?.defs[key];
      if (!ctx || !bus || !source || !def || !sound.audible('music')) return;
      const id = source.base + key;
      // The piece playing, or resting between two plays of it.
      if (this.music?.id === id && (this.music.endsAt === undefined || this.music.endsAt > ctx.currentTime || this.music.again)) return;
      this.fadeMusic(1.5);
      const gain = ctx.createGain();
      gain.connect(bus);
      const urls = [source.base + def.files[0]!, ...(def.intro ? [source.base + def.intro] : [])];
      const track: Track = { id, urls, gain, sources: [] };
      this.music = track;
      this.keep('music', urls);
      this.duckAmbience(true);
      void Promise.all([this.buffer(urls[0]!), urls[1] ? this.buffer(urls[1]) : null]).then(([main, intro]) => {
        if (this.music !== track || !main) return;
        const t = ctx.currentTime + 0.05;
        gain.gain.setValueAtTime(0, ctx.currentTime);
        gain.gain.linearRampToValueAtTime(1, t + 0.4);
        const loops = soundSpec(key)?.shape === 'loop';
        let at = t;
        if (intro) {
          const s = ctx.createBufferSource();
          s.buffer = intro;
          s.connect(gain);
          s.start(at);
          track.sources.push(s);
          at += intro.duration;
        }
        const s = ctx.createBufferSource();
        s.buffer = main;
        s.loop = loops;
        s.connect(gain);
        s.start(at);
        track.sources.push(s);
        if (!loops) {
          track.endsAt = at + main.duration;
          s.onended = () => {
            if (this.music !== track) return;
            if (opts.repeat) {
              track.again = setTimeout(() => {
                if (this.music !== track) return;
                this.music = null;
                start();
              }, REPEAT_REST_S * 1000);
              return;
            }
            this.music = null;
            if (this.lasting?.key === key) this.lasting = null;
            this.duckAmbience(false);
          };
        }
      });
    };
    if (sound.context()) start();
    else this.wanted = () => void this.loadGame().then(start);
    void this.loadGame();
  }

  /**
   * What music is playing (or resting before it plays again), if any: where it is served from and its key
   * (`/sounds/theme`, `/api/worlds/<id>/sounds/boss:<id>`).
   */
  musicPlaying(): string | null {
    const ctx = sound.context();
    if (!this.music || !ctx) return null;
    return this.music.endsAt === undefined || this.music.endsAt > ctx.currentTime || this.music.again ? this.music.id : null;
  }

  /** A piece is over (a boss's fight ended): it stops if it is playing, and is no longer started when the music is raised. */
  end(key: SoundKey) {
    const id = (this.lasting?.opts.from === 'game' ? this.game : this.world)?.base + key;
    if (this.lasting?.key === key) this.lasting = null;
    if (this.music?.id === id) this.stopMusic(3);
  }

  /** Stop the music, and forget what was asked for. */
  stopMusic(fade = 2) {
    this.wanted = null;
    this.lasting = null;
    this.fadeMusic(fade);
  }

  private fadeMusic(fade: number) {
    const m = this.music;
    const ctx = sound.context();
    this.music = null;
    clearTimeout(m?.again);
    if (m && ctx) for (const s of m.sources) fadeOut(m.gain, ctx.currentTime, fade, s);
    this.duckAmbience(false);
  }

  /**
   * The steady sound of the place (`ambience:<id>`), crossfaded from the last; null for silence. It is kept as the
   * place's, so it starts when sound is allowed or its volume is raised from zero, and stops when that goes to zero.
   */
  setAmbience(key: SoundKey | null) {
    this.place = key;
    const ctx = sound.context();
    const heard = key && sound.audible('ambience') ? key : null;
    const id = heard ?? '';
    if ((this.ambience?.id ?? '') === id) return;
    const old = this.ambience;
    this.ambience = null;
    if (old && ctx) for (const s of old.sources) fadeOut(old.gain, ctx.currentTime, 2.5, s);
    const bus = sound.bus('ambience');
    const def = heard ? this.world?.defs[heard] : undefined;
    if (!ctx || !bus || !def || !this.world) return;
    const gain = ctx.createGain();
    gain.connect(bus);
    const urls = [this.world.base + def.files[0]!];
    const track: Track = { id, urls, gain, sources: [] };
    this.ambience = track;
    this.keep('ambience', urls);
    void this.buffer(urls[0]!).then((buf) => {
      if (this.ambience !== track || !buf) return;
      const s = ctx.createBufferSource();
      s.buffer = buf;
      s.loop = true;
      // Each visit starts somewhere else in the loop.
      const offset = Math.random() * buf.duration;
      const level = this.music ? 0.45 : 1;
      gain.gain.setValueAtTime(0, ctx.currentTime);
      gain.gain.linearRampToValueAtTime(level, ctx.currentTime + 2.5);
      s.connect(gain);
      s.start(ctx.currentTime, offset);
      track.sources.push(s);
    });
  }

  /** Music over a place: its ambience steps back while the music plays. */
  private duckAmbience(down: boolean) {
    const ctx = sound.context();
    if (!ctx || !this.ambience) return;
    this.ambience.gain.gain.setTargetAtTime(down ? 0.45 : 1, ctx.currentTime, 0.6);
  }

  /**
   * The music of a page outside the game: a world's theme (its page, while the world has one), or the game's own
   * (signing in, the home page, a world still being built). It plays again after a rest for as long as the player
   * stays, carries on across pages that play it, and crossfades to another page's.
   */
  pageMusic(world?: { id: string; theme?: SoundDef }) {
    if (world?.theme) {
      if (this.world?.base !== `/api/worlds/${world.id}/sounds/`) this.setWorld({ id: world.id, sounds: { theme: world.theme } });
      this.playMusic('theme', { repeat: true });
    } else this.playMusic('theme', { from: 'game', repeat: true });
  }

  /** Leaving the world: its ambience and its battle music stop (its theme may carry on to the next page). */
  quiet() {
    this.held = [];
    this.setAmbience(null);
    if (this.music && !this.music.id.endsWith('/theme')) this.stopMusic(1.5);
    // The world's decoded sounds are let go (all but a theme still playing): the next world brings its own.
    const base = this.world?.base, playing = new Set(this.music?.urls);
    if (base) {
      const mine = (url: string) => url.startsWith(base) && !playing.has(url);
      for (const url of [...this.buffers.keys()]) if (mine(url)) this.buffers.delete(url);
      this.long = { music: this.long.music.filter((g) => !g.some(mine)), ambience: this.long.ambience.filter((g) => !g.some(mine)) };
    }
    // The pages around the game tap and open with the game's own sounds.
    this.setWorld(null);
  }
}

function fadeOut(g: GainNode, now: number, seconds: number, src: AudioBufferSourceNode) {
  g.gain.cancelScheduledValues(now);
  g.gain.setValueAtTime(g.gain.value, now);
  g.gain.linearRampToValueAtTime(0, now + seconds);
  try {
    src.stop(now + seconds + 0.05);
  } catch {
    /* not started */
  }
}

export const sounds = new Sounds();

// Every control pressed taps, in the game and on the pages around it (mouse, finger, keyboard, or controller).
if (typeof window !== 'undefined') {
  window.addEventListener('click', (e) => {
    const t = e.target as Element | null;
    if (t?.closest?.(CONTROL) && !t.closest('[disabled], .na')) sounds.play('tap');
  }, { capture: true, passive: true });
}
