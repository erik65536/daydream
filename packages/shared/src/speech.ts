/**
 * Speech on the wire (docs/voices.md).
 *
 * Between the game server, the GPU broker and its VoxCPM2 runner (Pocket TTS runs inside the game server and needs
 * no wire): frames of a 4-byte little-endian length and that many bytes, the first saying what follows: 1 a JSON
 * message, 2 a line's audio (a 2-byte length, the line's id, then 16-bit little-endian mono PCM). The Python side is
 * `speech/wire.py`.
 *
 * Between the game server and a player: a line is announced by a `line` message, its audio follows as binary
 * WebSocket messages (one byte 1, one byte of id length, the id, then one Opus packet or a run of 16-bit PCM), and
 * `line_end` closes it.
 */

const FRAME_JSON = 1;
const FRAME_AUDIO = 2;

type EngineFrame = { kind: 'json'; msg: Record<string, unknown> } | { kind: 'audio'; lineId: string; pcm: Uint8Array };

// Both the browser and Node have these (shared code is compiled without either's library types).
declare const TextEncoder: new () => { encode(s: string): Uint8Array };
declare const TextDecoder: new () => { decode(b: Uint8Array): string };
const enc = new TextEncoder();
const dec = new TextDecoder();

export function jsonFrame(msg: unknown): Uint8Array {
  const body = enc.encode(JSON.stringify(msg));
  const out = new Uint8Array(5 + body.length);
  new DataView(out.buffer).setUint32(0, body.length + 1, true);
  out[4] = FRAME_JSON;
  out.set(body, 5);
  return out;
}

export function audioFrame(lineId: string, pcm: Uint8Array): Uint8Array {
  const id = enc.encode(lineId);
  const out = new Uint8Array(7 + id.length + pcm.length);
  const v = new DataView(out.buffer);
  v.setUint32(0, 3 + id.length + pcm.length, true);
  out[4] = FRAME_AUDIO;
  v.setUint16(5, id.length, true);
  out.set(id, 7);
  out.set(pcm, 7 + id.length);
  return out;
}

/** Reads frames out of a byte stream that arrives in pieces. */
export class FrameReader {
  private buf = new Uint8Array(0);
  push(chunk: Uint8Array): EngineFrame[] {
    const joined = new Uint8Array(this.buf.length + chunk.length);
    joined.set(this.buf);
    joined.set(chunk, this.buf.length);
    const out: EngineFrame[] = [];
    let at = 0;
    while (joined.length - at >= 4) {
      const v = new DataView(joined.buffer, joined.byteOffset + at);
      const n = v.getUint32(0, true);
      if (n === 0 || n > 16 * 1024 * 1024) throw new Error(`bad speech frame length ${n}`);
      if (joined.length - at - 4 < n) break;
      const body = joined.subarray(at + 4, at + 4 + n);
      if (body[0] === FRAME_JSON) out.push({ kind: 'json', msg: JSON.parse(dec.decode(body.subarray(1))) as Record<string, unknown> });
      else if (body[0] === FRAME_AUDIO) {
        const k = new DataView(body.buffer, body.byteOffset + 1).getUint16(0, true);
        out.push({ kind: 'audio', lineId: dec.decode(body.subarray(3, 3 + k)), pcm: body.slice(3 + k) });
      } else throw new Error(`bad speech frame type ${body[0]}`);
      at += 4 + n;
    }
    this.buf = joined.slice(at);
    return out;
  }
}

/** A player's binary message carrying a piece of a line's audio. */
export function linePacket(lineId: string, data: Uint8Array): Uint8Array {
  const id = enc.encode(lineId);
  const out = new Uint8Array(2 + id.length + data.length);
  out[0] = 1;
  out[1] = id.length;
  out.set(id, 2);
  out.set(data, 2 + id.length);
  return out;
}

export function readLinePacket(data: Uint8Array): { lineId: string; data: Uint8Array } | null {
  if (data.length < 2 || data[0] !== 1) return null;
  const k = data[1]!;
  return { lineId: dec.decode(data.subarray(2, 2 + k)), data: data.subarray(2 + k) };
}

/** Lines said aloud where someone stands (barks, taunts) are heard within this many meters, quieter with distance. */
export const EARSHOT_M = 12;

/** How a line is sent to a player: Opus packets of 20 ms, or 16-bit PCM for a browser without WebCodecs. */
export type LineCodec = 'opus' | 'pcm';
