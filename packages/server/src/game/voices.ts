/**
 * An adventure's speech: who hears what (each connected player who has voices on), and each speaker's voice from
 * the world (docs/voices.md). The game says what is spoken and to whom; speech/speech.ts speaks it.
 */
import path from 'node:path';
import type { LineCodec, ServerMessage, SpokenLine, WorldDefinition } from '@daydream/shared';
import { speech, type Listener, type Reply, type Voice } from '../speech/speech.ts';
import { worldAssetDir } from '../paths.ts';
import { SentenceSplitter, type Sentence } from '../speech/text.ts';

/**
 * Speaks a text sentence by sentence as it grows (a reply being written) or whole. The reply is started at the first
 * finished sentence; `lines` are the lines so far, with where each ends in the text.
 */
export class SpokenText {
  readonly lines: SpokenLine[] = [];
  private splitter = new SentenceSplitter();
  private reply: Reply | null | undefined;
  private start: () => Reply | null;
  constructor(start: () => Reply | null) {
    this.start = start;
  }

  /** The text so far; true when it finished a sentence. */
  grow(text: string): boolean {
    return this.say(this.splitter.push(text));
  }

  /** The whole text: what is left is spoken. */
  end(text: string): SpokenLine[] {
    this.say(this.splitter.end(text));
    return this.lines;
  }

  private say(sentences: Sentence[]): boolean {
    if (!sentences.length) return false;
    if (this.reply === undefined) this.reply = this.start();
    for (const s of sentences) {
      const id = this.reply?.say(s.text);
      if (id) this.lines.push({ id, to: s.end });
    }
    return true;
  }
}

interface VoicesHost {
  readonly adventureId: string;
  readonly world: WorldDefinition;
  sendTo(userId: string, m: ServerMessage): void;
  sendBinaryTo(userId: string, data: Uint8Array): void;
}

/** The narrator's voice: one per world. */
export const NARRATOR = 'narrator';

export class AdventureVoices {
  /** How each connected player hears speech (absent: voices off, or not said yet). */
  private codecs = new Map<string, LineCodec>();
  private voices = new Map<string, Voice>();
  private h: VoicesHost;

  constructor(h: VoicesHost) {
    this.h = h;
    const dir = worldAssetDir(h.world.id);
    for (const [id, v] of Object.entries(h.world.voices ?? {}))
      this.voices.set(id, { key: `${h.world.id}/${id}`, clip: path.join(dir, 'voices', `${id}.wav`), speechDir: path.join(dir, 'speech'), gain: v.gain });
  }

  /** A player says how they hear speech (null: voices off, which also stops what they hear now). */
  setCodec(userId: string, codec: LineCodec | null) {
    if (codec) {
      const first = !this.codecs.size;
      this.codecs.set(userId, codec);
      if (first) this.prepare(NARRATOR);
    } else {
      this.codecs.delete(userId);
      speech().leave(this.key(userId));
    }
  }

  /** A player left the game: they hear nothing more. */
  left(userId: string) {
    this.setCodec(userId, null);
  }

  private key(userId: string) {
    return `${this.h.adventureId}:${userId}`;
  }

  /** Whether this world's speaker can be heard at all (it has a voice and the game speaks). */
  has(speakerId: string): boolean {
    return speech().enabled() && this.voices.has(speakerId);
  }

  listener(userId: string): Listener | null {
    const codec = this.codecs.get(userId);
    if (!codec) return null;
    return { key: this.key(userId), codec, send: (m) => this.h.sendTo(userId, m), sendBinary: (d) => this.h.sendBinaryTo(userId, d) };
  }

  /**
   * A reply by a speaker to these players, in a queue (lines of a queue play one after another). Given as a function,
   * the players are asked for at each sentence (a conversation's, as people join and leave it). Null when the speaker
   * has no voice or nobody would hear it.
   */
  reply(speakerId: string, userIds: string[] | (() => string[]), queue: string, onUnvoiced?: (lineId: string) => void, at?: { x: number; y: number }): Reply | null {
    const voice = this.voices.get(speakerId);
    const listeners = () => (typeof userIds === 'function' ? userIds() : userIds).map((u) => this.listener(u)).filter((l): l is Listener => !!l);
    if (!voice || !listeners().length || !speech().enabled()) return null;
    return speech().reply(voice, { queue: `${this.h.adventureId}/${queue}`, listeners, onUnvoiced, at });
  }

  /** A player joins a queue that may be speaking (a conversation): they hear its lines from where they are. */
  join(userId: string, queue: string) {
    const l = this.listener(userId);
    if (l) speech().join(`${this.h.adventureId}/${queue}`, l);
  }

  /** A player stops hearing a queue (closing a conversation) or one line (skipping it). */
  leave(userId: string, which: { queue?: string; lineId?: string }) {
    speech().leave(this.key(userId), { queue: which.queue && `${this.h.adventureId}/${which.queue}`, lineId: which.lineId });
  }

  /** Make a speaker's voice ready ahead of its first line (someone walks up to talk with them). */
  prepare(speakerId: string) {
    const v = this.voices.get(speakerId);
    if (v && this.codecs.size) speech().prepare(v);
  }
}
