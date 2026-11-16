/**
 * A world's sounds (docs/sound.md): the FLAC decoder against files ffmpeg made from a known signal, WAV files, the game-ready
 * rules on made-up audio, exact-length Ogg Opus, the stand-ins, and the prompts built from Luna's answer.
 */
import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { MOMENTS, readOggOpus, soundFile, soundKey, soundSpec, standIn, SOUND_FILE, type WorldDefinition } from '@daydream/shared';
import { decodeFlac } from '../src/sound/flac.ts';
import { decodeWav } from '../src/sound/wav.ts';
import { integratedLoudness, peak, peakLoudness, type Pcm } from '../src/sound/dsp.ts';
import { makeReady, measuredBpm, oggOpus, RATE, TARGET } from '../src/sound/ready.ts';
import { gameOrders, worldOrders, type SoundPlan } from '../src/sound/prompts.ts';

const FIXTURES = path.join(__dirname, 'fixtures');

/** The signal the fixtures hold: 0.2 s of two tones and a third in the right channel, then 4096 zeros. */
const left = (n: number) => (n < 8820 ? Math.floor(12000 * Math.sin((2 * Math.PI * 440 * n) / 44100) + 3000 * Math.sin((2 * Math.PI * 97 * n) / 44100) + 0.5) : 0);
const right = (n: number) => (n < 8820 ? Math.floor(0.7 * left(n) + 2000 * Math.sin((2 * Math.PI * 1234 * n) / 44100) + 0.5) : 0);

const stereo = (rate: number, seconds: number, f: (t: number) => number): Pcm => {
  const n = Math.round(rate * seconds);
  const ch = Float32Array.from({ length: n }, (_, i) => f(i / rate));
  return { rate, ch: [ch, ch.slice()] };
};

describe('FLAC', () => {
  for (const file of ['tone-lpc.flac', 'tone-fixed.flac'])
    it(`decodes ${file} sample for sample`, () => {
      const p = decodeFlac(fs.readFileSync(path.join(FIXTURES, file)));
      expect(p.rate).toBe(44100);
      expect(p.ch.length).toBe(2);
      expect(p.ch[0]!.length).toBe(8820 + 4096);
      for (let n = 0; n < p.ch[0]!.length; n++) {
        expect(Math.round(p.ch[0]![n]! * 32768)).toBe(left(n));
        expect(Math.round(p.ch[1]![n]! * 32768)).toBe(right(n));
      }
    });

  it('decodes a file that does not say how long it is, to the end of its frames', () => {
    const file = fs.readFileSync(path.join(FIXTURES, 'tone-lpc.flac'));
    // The stream information's sample count (36 bits, after the rate, channels, and sample size) set to 0, as a
    // file written as a stream has it.
    file[21]! &= 0xf0;
    file.fill(0, 22, 26);
    const p = decodeFlac(file);
    expect(p.ch[0]!.length).toBeGreaterThanOrEqual(8820 + 4096);
    for (const n of [0, 100, 4409, 8819, 8820, 12915]) expect(Math.round(p.ch[0]![n]! * 32768)).toBe(left(n));
  });
});

describe('WAV', () => {
  /** A WAV of two channels, frames [0.5, -0.25] and [-1, 0.75], in `format` (1 PCM, 3 float) at `bits`. */
  const wav = (format: number, bits: number) => {
    const values = [0.5, -0.25, -1, 0.75], step = bits / 8, data = Buffer.alloc(values.length * step);
    values.forEach((v, i) => (format === 3 ? data.writeFloatLE(v, i * step) : data.writeIntLE(Math.max(-(2 ** (bits - 1)), Math.round(v * 2 ** (bits - 1))), i * step, Math.min(step, 6))));
    const fmt = Buffer.alloc(24);
    fmt.write('fmt ', 0); fmt.writeUInt32LE(16, 4); fmt.writeUInt16LE(format, 8); fmt.writeUInt16LE(2, 10);
    fmt.writeUInt32LE(48000, 12); fmt.writeUInt32LE(48000 * 2 * step, 16); fmt.writeUInt16LE(2 * step, 20); fmt.writeUInt16LE(bits, 22);
    const head = Buffer.alloc(20);
    head.write('RIFF', 0); head.writeUInt32LE(36 + data.length, 4); head.write('WAVE', 8); head.write('data', 12); head.writeUInt32LE(data.length, 16);
    return Buffer.concat([head.subarray(0, 12), fmt, head.subarray(12), data]);
  };

  it('reads 16- and 24-bit PCM and 32-bit float, channel by channel', () => {
    for (const [format, bits] of [[1, 16], [1, 24], [3, 32]] as const) {
      const p = decodeWav(wav(format, bits));
      expect(p.rate).toBe(48000);
      expect([...p.ch[0]!]).toEqual([0.5, -1]);
      expect([...p.ch[1]!]).toEqual([-0.25, 0.75]);
    }
  });

  it('reads to the end of a file that does not say how long its samples are', () => {
    const file = wav(1, 16);
    file.writeUInt32LE(0, 40);
    expect([...decodeWav(file).ch[0]!]).toEqual([0.5, -1]);
  });
});

describe('game-ready', () => {
  const hit = (rate = 44100) => stereo(rate, 1, (t) => (t > 0.3 && t < 0.5 ? Math.sin(2 * Math.PI * 300 * t) * Math.exp(-(t - 0.3) * 20) * 0.3 : 0));

  it('keeps a one-shot\'s main sound, at its loudness group\'s level', () => {
    const r = makeReady(hit(), { kind: 'combat', shape: 'oneshot' });
    if (!r.ok) throw new Error(r.problem);
    const seconds = r.main.ch[0]!.length / RATE;
    // The silence before and after is gone.
    expect(seconds).toBeLessThan(0.35);
    expect(seconds).toBeGreaterThan(0.15);
    expect(peakLoudness(r.main)).toBeCloseTo(TARGET.combat, 0);
    expect(peak(r.main)).toBeLessThan(10 ** (-1.5 / 20) + 1e-6);
  });

  it('refuses nearly silent and clipped takes', () => {
    expect(makeReady(stereo(44100, 1, () => 0), { kind: 'interface', shape: 'oneshot' })).toMatchObject({ ok: false, problem: expect.stringContaining('silent') });
    expect(makeReady(stereo(44100, 1, (t) => Math.sign(Math.sin(2 * Math.PI * 200 * t))), { kind: 'combat', shape: 'oneshot' })).toEqual({ ok: false, problem: 'clipped' });
  });

  it('refuses an ambience with a sudden sound in it, and loops a steady one', () => {
    let seed = 1;
    const noise = () => ((seed = (seed * 16807) % 2147483647) / 2147483647 - 0.5) * 0.1;
    const steady = stereo(44100, 12, () => noise());
    const r = makeReady(steady, { kind: 'ambience', shape: 'texture' });
    if (!r.ok) throw new Error(r.problem);
    // 1.5 s goes into the crossfade.
    expect(r.main.ch[0]!.length / RATE).toBeCloseTo(10.5, 1);
    expect(integratedLoudness(r.main)).toBeCloseTo(TARGET.ambience, 0);
    const bell = stereo(44100, 12, (t) => noise() * 0.1 + (t > 6 && t < 6.3 ? Math.sin(2 * Math.PI * 800 * t) * 0.8 : 0));
    expect(makeReady(bell, { kind: 'ambience', shape: 'texture' })).toMatchObject({ ok: false, problem: expect.stringContaining('stands out') });
    // Its end is faded into its start, so it needs more than the fade to be left with.
    expect(makeReady(stereo(44100, 2, () => noise()), { kind: 'ambience', shape: 'texture' })).toEqual({ ok: false, problem: 'too short to loop' });
  });

  it('loops music on whole bars at its tempo', () => {
    const bpm = 120, beat = 0.5;
    // A click on every beat, louder on the first of each bar, over a low tone. At the game's rate: the other tests
    // resample, and a minute of music to resample would double this one's time.
    const music = stereo(RATE, 64, (t) => {
      const inBeat = t % beat, first = Math.floor(t / beat) % 4 === 0;
      return 0.2 * Math.sin(2 * Math.PI * 110 * t) + (inBeat < 0.03 ? (first ? 0.6 : 0.3) * Math.sin(2 * Math.PI * 2000 * t) : 0);
    });
    expect(measuredBpm(music.ch[0]!, RATE)).toBeCloseTo(bpm, 0);
    const r = makeReady(music, { kind: 'loop', shape: 'loop' }, bpm);
    if (!r.ok) throw new Error(r.problem);
    const bars = r.main.ch[0]!.length / RATE / (4 * beat);
    expect(bars % 8).toBeCloseTo(0, 2);
    expect(bars).toBeGreaterThanOrEqual(16);
    expect(r.intro!.ch[0]!.length / RATE / (4 * beat)).toBeCloseTo(Math.round(r.intro!.ch[0]!.length / RATE / (4 * beat)), 2);
  });

  it('runs into a music loop without a cut, from its intro and from its own end', () => {
    const beat = 0.5;
    // A tone that is somewhere else in its wave after every bar, so a join between two places in the piece would
    // show as a jump; and a click on every beat to keep time by, a little after it, so the bars' edges are in the tone.
    const music = stereo(RATE, 64, (t) => 0.3 * Math.sin(2 * Math.PI * 110.37 * t) + (t % beat > 0.1 && t % beat < 0.13 ? (Math.floor(t / beat) % 4 === 0 ? 0.5 : 0.25) * Math.sin(2 * Math.PI * 2000 * t) : 0));
    const r = makeReady(music, { kind: 'loop', shape: 'loop' }, 120);
    if (!r.ok) throw new Error(r.problem);
    const loop = r.main.ch[0]!, intro = r.intro!.ch[0]!;
    // Between two samples the tone moves by a hundredth of its height or so.
    const step = 0.02 * peak(r.main);
    expect(Math.abs(loop[1]! - loop[0]!)).toBeLessThan(step);
    expect(Math.abs(loop[0]! - intro[intro.length - 1]!)).toBeLessThan(step);
    expect(Math.abs(loop[0]! - loop[loop.length - 1]!)).toBeLessThan(step);
  });

  it('encodes Ogg Opus that ends exactly where the sound does', () => {
    const r = makeReady(hit(), { kind: 'combat', shape: 'oneshot' });
    if (!r.ok) throw new Error(r.problem);
    const ogg = readOggOpus(oggOpus(r.main, 64));
    expect(ogg).toMatchObject({ sampleRate: RATE, channels: 2, samples: r.main.ch[0]!.length });
    expect(ogg.packets.length).toBe(Math.ceil(r.main.ch[0]!.length / 960) + 1);
  });
});

describe('the sounds of a world', () => {
  it('names sound files the route serves', () => {
    for (const key of ['tap', soundKey('cast', 'fire'), soundKey('ambience', 'z_town_1'), soundKey('boss', 'b0')]) {
      expect(soundFile(key, 0)).toMatch(SOUND_FILE);
      expect(soundFile(key, 1, 'intro')).toMatch(SOUND_FILE);
    }
    expect('../world.json').not.toMatch(SOUND_FILE);
  });

  it('stands in with the game\'s own sounds, never for places, deaths or music', () => {
    for (const m of Object.keys(MOMENTS)) expect(standIn(m)).toEqual({ game: m });
    expect(standIn(soundKey('hit', 'fire'))).toEqual({ world: 'hit', game: 'hit' });
    expect(standIn(soundKey('cry', 'f0'))).toEqual({ game: 'fight' });
    for (const k of [soundKey('death', 'f0'), soundKey('ambience', 'z'), soundKey('place', 'z'), soundKey('boss', 'b'), 'theme', 'defeat']) expect(standIn(k)).toBeNull();
    expect(soundSpec(soundKey('boss', 'b'))).toMatchObject({ bus: 'music', shape: 'loop' });
  });

  it('builds every prompt from the world\'s sound plan, the game\'s part first', () => {
    const w = {
      ruleset: { damageTypes: [{ id: 'fire', name: 'Fire' }] },
      families: [{ id: 'f0', name: 'Frogs', description: '' }],
      zones: [{ id: 'z0', name: 'Town', kind: 'town', description: '' }],
      bosses: [{ id: 'b0', name: 'King', title: 'of Frogs', description: '' }],
    } as unknown as WorldDefinition;
    const piece = { style: 'A short quiet folk cue', instruments: 'With nylon-string guitar and a cello carrying the melody.', bpm: 90 };
    // The sounds step's answer: kinds of damage and bosses by name, families and places by id.
    const a: SoundPlan = {
      soundtrack: 'Acoustic folk for a cozy woodland tale.',
      gameKind: 'a cozy woodland adventure video game',
      genreTag: 'Folk',
      materials: Object.fromEntries(Object.keys(MOMENTS).map((m) => [m, 'On hollow wood, close and dry.'])),
      elements: { Fire: { sound: 'of fire, a whoosh into crackling flame', hit: 'of fire, a burst of flame' } },
      families: { f0: { cry: 'from a round frog, a deep croak, close', death: 'from a round frog, a weak croak, close' } },
      ambience: { z0: 'of a gentle breeze, distant' },
      music: { theme: piece, defeat: piece, places: { z0: piece }, bosses: { King: piece } },
    };
    const orders = new Map(worldOrders(w, a).map((o) => [o.key, o]));
    expect(orders.get('tap')!.prompt).toBe('TrackType: SFX, A single very soft short tap with an instant decay, on hollow wood, close and dry, UI sound');
    expect(orders.get('level_up')!.prompt.endsWith('UI sound')).toBe(false);
    expect(orders.get(soundKey('cast', 'fire'))!.prompt).toBe('TrackType: SFX, A quick spell burst of fire, a whoosh into crackling flame');
    expect(orders.get(soundKey('heavy', 'fire'))!.prompt).toBe('TrackType: SFX, One heavy crushing impact of fire, a burst of flame');
    expect(orders.get(soundKey('ambience', 'z0'))!.prompt).toBe('TrackType: SFX, A steady continuous ambience of a gentle breeze, distant, no sudden sounds, no voices, no music');
    expect(orders.get(soundKey('boss', 'b0'))).toMatchObject({ model: 'medium', seconds: 64, bpm: 90 });
    expect(orders.get(soundKey('boss', 'b0'))!.prompt).toBe('TrackType: Music, VocalType: Instrumental, Genre: Folk, A short quiet folk cue with nylon-string guitar and a cello carrying the melody: urgent, driving, and dangerous battle music at a steady tempo. 90 BPM. It plays during a boss fight in a cozy woodland adventure video game.');
    expect(orders.get(soundKey('place', 'z0'))!.prompt).not.toContain('Genre:');
    expect(orders.get('quest_accept')!.model).toBe('medium');
    expect(new Set(gameOrders().map((o) => o.key))).toEqual(new Set([...Object.keys(MOMENTS), 'cast', 'fight']));
  });
});
