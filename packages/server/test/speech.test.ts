import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import OpusModule from '@discordjs/opus';
import { FrameReader, audioFrame, jsonFrame, readLinePacket, readOggOpus, writeOggOpus, type ServerMessage } from '@daydream/shared';
import { genWorld, hero, until } from './helpers.ts';
import { adventures } from '../src/game/manager.ts';
import { WebSocketServer, type AddressInfo } from 'ws';
import { FakeEngine } from '../src/speech/fake.ts';
import { GpuEngine } from '../src/speech/gpu.ts';
import { Speech, fixedLineFile, speech, type Listener, type ReplyOptions, type Voice } from '../src/speech/speech.ts';
import { SentenceSplitter, sentences, spokenText } from '../src/speech/text.ts';
import { gainFor, loudness } from '../src/speech/loudness.ts';
import { Tokenizer, prepareTextPrompt, splitIntoBestSentences, type Vocabulary } from '../src/speech/pocketText.ts';
import { buildVoices, fixedLines, speakersOf } from '../src/worldgen/voices.ts';

const { OpusEncoder } = OpusModule as unknown as { OpusEncoder: new (rate: number, ch: number) => { encode(b: Buffer): Buffer } };

/** A listener that keeps what it was sent. */
function ear(key: string, codec: 'opus' | 'pcm' = 'opus') {
  const msgs: ServerMessage[] = [];
  const packets: { lineId: string; bytes: number }[] = [];
  const l: Listener = { key, codec, send: (m) => msgs.push(m), sendBinary: (d) => packets.push({ lineId: readLinePacket(d)!.lineId, bytes: d.length }) };
  const ended = (id: string) => msgs.find((m): m is Extract<ServerMessage, { t: 'line_end' }> => m.t === 'line_end' && m.id === id)?.status;
  return { l, msgs, packets, ended };
}

const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dd-speech-'));
const voice: Voice = { key: 'w_test/n1', clip: path.join(tmp, 'n1.wav'), speechDir: tmp, gain: { cpu: 1, gpu: 1 } };
/** A single line: a reply of one sentence. */
const say = (hub: Speech, text: string, opts: ReplyOptions) => hub.reply(voice, opts).say(text);

describe('Pocket TTS text', () => {
  const S = '▁';
  const normal = [S, `${S}hello`, `${S}he`, 'llo', `${S}world`, `${S}a`, '.', '!', ',', 'h', 'e', 'l', 'o', 'w', 'r', 'd', 'a'];
  const vocab: Vocabulary = {
    pieces: [
      ...['<unk>', '<s>', '</s>', '<pad>'].map((p) => [p, 0, 'control'] as [string, number, 'control']),
      ...Array.from({ length: 256 }, (_, b) => [`<0x${b.toString(16).toUpperCase().padStart(2, '0')}>`, 0, 'byte'] as [string, number, 'byte']),
      ...normal.map((p, i) => [p, -1 - i * 0.1 - (p.length === 1 ? 5 : 0), 'normal'] as [string, number, 'normal']),
    ],
  };
  const tok = new Tokenizer(vocab);
  const id = (p: string) => vocab.pieces.findIndex(([x]) => x === p);
  const opts = { padShortInputs: false, removeSemicolons: false, terminalPunctuation: true, capitalize: true, replace: { '’': "'" } };

  it('cuts words into their best pieces, spells unknown characters in bytes and decodes back', () => {
    expect(tok.encode('hello world.')).toEqual([id(`${S}hello`), id(`${S}world`), id('.')]);
    const tokens = tok.encode('a é!');
    expect(tokens).toEqual([id(`${S}a`), id(S), id('<0xC3>'), id('<0xA9>'), id('!')]);
    expect(tok.decode(tokens)).toBe('a é!');
  });

  it('readies a line as the model was trained on it and splits long ones on sentences', () => {
    expect(prepareTextPrompt('  well, it’s here,', opts)).toEqual({ text: "Well, it's here.", framesAfterEos: 3 });
    expect(splitIntoBestSentences(tok, 'hello world. hello world!', 3, opts)).toEqual(['Hello world.', 'hello world!']);
    expect(splitIntoBestSentences(tok, 'hello world. hello world!', 50, opts)).toEqual(['Hello world. hello world!']);
  });
});

describe('spoken text', () => {
  it('leaves out what is not said aloud and cuts sentences, joining short ones', () => {
    expect(spokenText('*sighs* Well [laughs] that is <b>it</b>.')).toBe('Well that is it.');
    // Words before a colon are words (a speaker's own name is taken off where the reply is written).
    expect(spokenText('Listen: the bridge is out.')).toBe('Listen: the bridge is out.');
    expect(sentences('Ah. Well, I suppose you could help. The mill is north of here! Done').map((s) => s.text)).toEqual(['Ah. Well, I suppose you could help.', 'The mill is north of here!', 'Done']);
    const text = 'Hello there, traveler. What brings you here today? Speak.';
    expect(sentences(text).map((s) => text.slice(0, s.end))).toEqual(['Hello there, traveler.', 'Hello there, traveler. What brings you here today?', text]);
  });

  it('cuts text as it grows, only at finished sentences', () => {
    const sp = new SentenceSplitter();
    expect(sp.push('Hello there, traveler. What brings')).toEqual([{ text: 'Hello there, traveler.', end: 22 }]);
    expect(sp.push('Hello there, traveler. What brings you here today? I')).toEqual([{ text: 'What brings you here today?', end: 50 }]);
    expect(sp.end('Hello there, traveler. What brings you here today? I wonder.')).toEqual([{ text: 'I wonder.', end: 60 }]);
  });
});

describe('the speech engines’ framing', () => {
  it('reads frames however the bytes arrive', () => {
    const bytes = Buffer.concat([jsonFrame({ ev: 'started', lineId: 'a', sampleRate: 24000 }), audioFrame('a', new Uint8Array([1, 2, 3, 4])), jsonFrame({ ev: 'done', lineId: 'a' })]);
    const r = new FrameReader();
    const got = [...bytes].flatMap((b) => r.push(new Uint8Array([b])));
    expect(got.map((f) => (f.kind === 'json' ? f.msg.ev : `audio:${f.lineId}:${f.pcm.length}`))).toEqual(['started', 'audio:a:4', 'done']);
  });
});

describe('speaking lines', () => {
  let hub: Speech;
  afterEach(() => hub?.stop());

  it('streams a line as Opus to everyone listening, and to a late listener from the start', async () => {
    hub = new Speech();
    hub.setEngine('cpu', new FakeEngine('cpu', 2, true));
    const a = ear('a'), b = ear('b'), late = ear('late'), pcm = ear('p', 'pcm');
    const id = say(hub, 'Good morning to you, traveler. The road is long.', { queue: 'dialog:n1', listeners: [a.l, b.l, pcm.l] })!;
    expect(a.msgs[0]).toMatchObject({ t: 'line', id, queue: 'dialog:n1' });
    // While the line plays.
    await until(() => expect(a.packets.length).toBeGreaterThan(0));
    hub.join('dialog:n1', late.l);
    await until(() => expect(a.ended(id)).toBeTruthy());
    for (const e of [a, b, late]) {
      expect(e.msgs.map((m) => m.t)).toEqual(['line', 'line_start', 'line_end']);
      expect(e.ended(id)).toBe('done');
      // 20 ms packets for the whole line, the same for everyone.
      expect(e.packets.length).toBe(a.packets.length);
    }
    expect(a.packets.length).toBeGreaterThan(100);
    expect(pcm.msgs.find((m) => m.t === 'line_start')).toMatchObject({ codec: 'pcm', rate: 24000 });
    expect(pcm.packets.length).toBeGreaterThan(10);
    expect(hub.counts.spoken.cpu).toBe(1);
  });

  it('cancels a line nobody hears any more, and marks a line no engine could start in time', async () => {
    hub = new Speech();
    const engine = new FakeEngine('cpu', 1, true);
    hub.setEngine('cpu', engine);
    const a = ear('a');
    const unvoiced: string[] = [];
    const id = say(hub, 'A long line that nobody will hear to its end, sadly.', { queue: 'q', listeners: [a.l], onUnvoiced: (l) => unvoiced.push(l) })!;
    await until(() => expect(a.msgs.map((m) => m.t)).toContain('line_start'));
    hub.leave('a', { queue: 'q' });
    expect(hub.counts.cancelled).toBe(1);
    expect(hub.status().lines).toBe(0);
    expect(engine.status().free).toBe(1);
    void id;
    engine.ready = false;
    const late = say(hub, 'No engine can say this one.', { queue: 'q', listeners: [a.l], onUnvoiced: (l) => unvoiced.push(l) })!;
    await until(() => expect(a.ended(late)).toBe('expired'));
    expect(unvoiced).toEqual([late]);
  });

  it('speaks a whole reply on the engine chosen at its first sentence: the GPU while it is on and free', async () => {
    hub = new Speech();
    const cpu = new FakeEngine('cpu', 2), gpu = new FakeEngine('gpu', 16);
    hub.setEngine('cpu', cpu);
    hub.setEngine('gpu', gpu);
    const a = ear('a');
    const r = hub.reply(voice, { queue: 'q', listeners: [a.l] });
    r.say('The first sentence of the reply.');
    gpu.ready = false;
    r.say('The second sentence, after the GPU went away.');
    // Both on the GPU (a GPU that went away fails its lines; the next reply chooses again).
    await until(() => expect(gpu.spoken.length).toBe(2));
    hub.gpuOn = () => false;
    gpu.ready = true;
    say(hub, 'The GPU is switched off now.', { queue: 'q', listeners: [a.l] });
    await until(() => expect(cpu.spoken.map((l) => l.text)).toEqual(['The GPU is switched off now.']));
  });

  it('speaks each sentence of a reply to whoever listens then: not to someone who left or skipped a line, and to someone who joined', async () => {
    hub = new Speech();
    hub.setEngine('cpu', new FakeEngine('cpu', 2));
    const a = ear('a'), b = ear('b'), c = ear('c');
    const here = [a.l, b.l];
    const r = hub.reply(voice, { queue: 'q', listeners: () => here });
    const first = r.say('The first sentence of the reply.')!;
    await until(() => expect(a.ended(first)).toBe('done'));
    // B skips the line (the server has sent all of it by now), A leaves and C joins.
    hub.leave('b', { lineId: first });
    here.splice(0, 1, c.l);
    const second = r.say('The second sentence, for those here now.')!;
    await until(() => expect(c.ended(second)).toBe('done'));
    expect(a.msgs.some((m) => m.t === 'line' && m.id === second)).toBe(false);
    expect(b.msgs.some((m) => m.t === 'line' && m.id === second)).toBe(false);
  });

  it('drops a line that has not started by its deadline, whatever its engine is doing, and frees the engine', async () => {
    hub = new Speech();
    // An engine that takes lines and never starts them (a runner that went quiet).
    const engine = new FakeEngine('gpu', 0);
    hub.setEngine('gpu', engine);
    const a = ear('a');
    const unvoiced: string[] = [];
    const id = hub.speak(engine, voice, 'Nobody will ever say this.', { queue: 'q', listeners: [a.l], onUnvoiced: (l) => unvoiced.push(l) }, Date.now() + 60);
    expect(engine.status().waiting).toBe(1);
    await until(() => expect(a.ended(id)).toBe('expired'));
    expect(unvoiced).toEqual([id]);
    expect(engine.status().waiting).toBe(0);
    expect(hub.status().lines).toBe(0);
  });

  it('plays a line spoken at build time from its file', async () => {
    hub = new Speech();
    const enc = new OpusEncoder(24000, 1);
    const packets = Array.from({ length: 30 }, () => enc.encode(Buffer.alloc(960)));
    const file = writeOggOpus(packets, 24000);
    const back = readOggOpus(file);
    expect(back.sampleRate).toBe(24000);
    expect(back.packets.map((p) => p.length)).toEqual(packets.map((p) => p.length));
    fs.mkdirSync(voice.speechDir, { recursive: true });
    fs.writeFileSync(fixedLineFile(voice.speechDir, 'n1', 'Welcome back, friend.'), file);
    const a = ear('a');
    // No engine at all: the file needs none.
    const id = say(hub, 'Welcome back, friend.', { queue: 'q', listeners: [a.l] })!;
    expect(a.ended(id)).toBe('done');
    expect(a.packets.length).toBe(30);
  });
});

describe('speech on the GPU', () => {
  it("sends a voice's clip only when the broker lacks it, so once whatever reconnects; a new clip is a new voice", async () => {
    // A broker that keeps clips (as its service does, on disk) across connections.
    const kept = new Set<string>();
    const clipsSent: string[] = [];
    const waits: [number | undefined, number | undefined][] = [];
    const wss = new WebSocketServer({ port: 0 });
    wss.on('connection', (ws) => {
      const waiting = new Map<string, string[]>();
      const say = (lineId: string) => {
        ws.send(jsonFrame({ ev: 'started', lineId, sampleRate: 48000 }));
        ws.send(audioFrame(lineId, new Uint8Array(960)));
        ws.send(jsonFrame({ ev: 'done', lineId }));
      };
      ws.send(jsonFrame({ ev: 'status', ready: true, slots: 4, free: 4 }));
      const reader = new FrameReader();
      ws.on('message', (data: Buffer) => {
        for (const f of reader.push(new Uint8Array(data))) {
          if (f.kind !== 'json') continue;
          const m = f.msg as { op: string; lineId: string; voiceId: string; wav: string; startWithinMs?: number; deadline?: number };
          // How long a line may wait, never a time on this side's clock.
          if (m.op === 'speak') waits.push([m.startWithinMs, m.deadline]);
          if (m.op === 'speak' && kept.has(m.voiceId)) say(m.lineId);
          else if (m.op === 'speak') {
            waiting.set(m.voiceId, [...(waiting.get(m.voiceId) ?? []), m.lineId]);
            ws.send(jsonFrame({ ev: 'need', lineId: m.lineId, voiceId: m.voiceId }));
          } else if (m.op === 'voice') {
            expect(crypto.createHash('sha256').update(Buffer.from(m.wav, 'base64')).digest('hex')).toBe(m.voiceId);
            clipsSent.push(m.voiceId);
            kept.add(m.voiceId);
            for (const id of waiting.get(m.voiceId) ?? []) say(id);
            waiting.delete(m.voiceId);
          }
        }
      });
    });
    const engine = new GpuEngine({ baseUrl: `http://127.0.0.1:${(wss.address() as AddressInfo).port}` });
    const ready = () => until(() => expect(engine.canStart(300, 0)).toBe(true));
    const speak = (lineId: string) =>
      new Promise<string>((resolve) =>
        engine.speak({ lineId, voiceId: voice.key, clip: voice.clip, text: 'Hello there.', deadline: Date.now() + 5000, priority: 0 }, { started() {}, audio() {}, end: (how) => resolve(how) }),
      );
    try {
      fs.writeFileSync(voice.clip, 'RIFF one voice');
      await ready();
      expect(await Promise.all([speak('a'), speak('b')])).toEqual(['done', 'done']);
      expect(await speak('c')).toBe('done');
      expect(clipsSent).toHaveLength(1);
      for (const [within, deadline] of waits) {
        expect(within).toBeGreaterThan(4000);
        expect(within).toBeLessThanOrEqual(5000);
        expect(deadline).toBeUndefined();
      }

      // Cut off: the engine sees it (it waits a second before calling again), then is back.
      for (const ws of wss.clients) ws.terminate();
      await until(() => expect(engine.canStart(300, 0)).toBe(false));
      await ready();
      expect(await speak('d')).toBe('done');
      expect(clipsSent).toHaveLength(1);

      fs.writeFileSync(voice.clip, 'RIFF a voice designed again');
      expect(await speak('e')).toBe('done');
      expect(clipsSent).toHaveLength(2);
    } finally {
      engine.stop();
      wss.close();
    }
  });
});

describe('loudness', () => {
  it("reads a full-scale 997 Hz tone as BS.1770 does (-3 LUFS), and finds the gain to the game's level", () => {
    for (const rate of [24000, 48000]) {
      const pcm = Buffer.alloc(rate * 4 * 2);
      for (let i = 0; i < rate * 4; i++) pcm.writeInt16LE(Math.round(Math.sin((2 * Math.PI * 997 * i) / rate) * 32767), i * 2);
      expect(loudness(pcm, rate)).toBeCloseTo(-3.01, 1);
    }
    expect(gainFor(-24)).toBeCloseTo(2, 1);
    expect(loudness(Buffer.alloc(48000), 24000)).toBe(-Infinity);
    expect(gainFor(-Infinity)).toBe(1);
  });
});

describe('building voices', () => {
  it('knows every speaker and every line known before play, sentence by sentence; without GPU speech a world has none', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const speakers = speakersOf(w);
    expect(speakers.map((s) => s.id)).toEqual(expect.arrayContaining(['narrator', ...w.npcs.map((n) => n.id), ...w.bosses.map((b) => b.id)]));
    const lines = fixedLines(w);
    const npc = w.npcs.find((n) => n.greeting)!;
    expect(lines).toContainEqual({ speakerId: npc.id, text: sentences(npc.greeting)[0]!.text });
    // Their own "hello again" lines, known before play.
    expect(lines.some((l) => l.speakerId === npc.id && l.text === sentences(npc.returning!.plain)[0]!.text)).toBe(true);
    // A greeting that holds the hero's name is spoken live.
    expect(lines.some((l) => l.text.startsWith('Back again'))).toBe(false);
    expect(lines.filter((l) => l.speakerId === 'narrator').length).toBeGreaterThanOrEqual(sentences(w.concept.intro).length);
    const notes: string[] = [];
    await buildVoices(w, { report: (m) => notes.push(m), shouldStop: () => false });
    expect(w.voices).toEqual({});
    expect(notes[0]).toMatch(/no GPU speech/);
  }, 120_000);
});

describe('voices in the game', () => {
  afterEach(() => speech().stop());

  it('a person greets everyone in the conversation aloud; leaving stops it; voices off hears nothing', async () => {
    const w = await genWorld('A windswept island kingdom of fishing villages and sea caves');
    const npc = w.npcs.find((n) => n.zoneId === w.startZoneId && n.greeting)!;
    w.voices = { [npc.id]: { gain: { cpu: 1, gpu: 1 } }, narrator: { gain: { cpu: 1, gpu: 1 } } };
    const engine = new FakeEngine('cpu', 2, true);
    speech().setEngine('cpu', engine);
    const adv = adventures.create(w, 'uv', 'Vi', 'voices', [hero(w, 'Vi', 'melee')]);
    adv.addPlayer('uw', 'Wen', [hero(w, 'Wen', 'ranged')]);
    const got: Record<string, ServerMessage[]> = { uv: [], uw: [] };
    const bin: Record<string, number> = { uv: 0, uw: 0 };
    adv.join({ userId: 'uv', audio: 'opus', send: (m) => got.uv!.push(m), sendBinary: () => bin.uv!++ });
    adv.join({ userId: 'uw', audio: null, send: (m) => got.uw!.push(m), sendBinary: () => bin.uw!++ });
    // The narrator reads the prologue to the player who has voices on.
    const intro = got.uv!.find((m): m is Extract<ServerMessage, { t: 'narration' }> => m.t === 'narration' && m.style === 'intro')!;
    expect(intro.lines?.length).toBeGreaterThan(0);
    expect(intro.lines!.at(-1)!.to).toBe(intro.text.trimEnd().length);
    await adv.dialogue.open('uv', npc.id);
    const dialog = got.uv!.filter((m): m is Extract<ServerMessage, { t: 'dialog' }> => m.t === 'dialog').pop()!.dialog!;
    const greeting = dialog.messages.find((m) => m.speaker === 'npc')!;
    expect(greeting.lines?.length).toBeGreaterThan(0);
    expect(engine.spoken.some((l) => l.voiceId === `${w.id}/${npc.id}`)).toBe(true);
    // Leaving the conversation stops its lines for the one who left (nobody else hears them: canceled).
    await until(() => expect(bin.uv).toBeGreaterThan(0));
    adv.dialogue.close('uv');
    await until(() => expect(speech().counts.cancelled).toBeGreaterThan(0));
    expect(bin.uw).toBe(0);
    expect(got.uw!.some((m) => m.t === 'line')).toBe(false);
    // A story card whose text grows as it is written (the story so far): one card, read sentence by sentence.
    const card = adv.liveNarration(['uv'], 'The story so far', 'arc');
    card.grow('While you were away, the frost');
    card.grow('While you were away, the frost broke on the river. Then');
    card.end('While you were away, the frost broke on the river. Then the lantern was found.');
    const cards = got.uv!.filter((m): m is Extract<ServerMessage, { t: 'narration' }> => m.t === 'narration' && m.title === 'The story so far');
    expect(new Set(cards.map((m) => m.id)).size).toBe(1);
    expect(cards.at(-1)).toMatchObject({ text: 'While you were away, the frost broke on the river. Then the lantern was found.', pending: undefined });
    expect(cards.some((m) => m.pending)).toBe(true);
    expect(cards.at(-1)!.lines!.map((l) => l.to)).toEqual([50, cards.at(-1)!.text.length]);
    adv.leave({ userId: 'uv', send: () => {} } as never);
    adv.leave({ userId: 'uw', send: () => {} } as never);
  }, 120_000);
});
