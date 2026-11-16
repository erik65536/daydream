/**
 * Ogg Opus files (RFC 7845): written from the 20 ms packets an Opus encoder makes, and read back into packets. Lines
 * spoken at build time (`assets/speech/<hash>.opus`) are streamed to players from their packets exactly as live lines
 * are; a world's sounds (`assets/sounds/`) are decoded by the browser from theirs.
 */

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let r = i << 24;
    for (let j = 0; j < 8; j++) r = r & 0x80000000 ? (r << 1) ^ 0x04c11db7 : r << 1;
    t[i] = r >>> 0;
  }
  return t;
})();

function crc(data: Uint8Array): number {
  let c = 0;
  for (const b of data) c = ((c << 8) ^ CRC_TABLE[((c >>> 24) ^ b) & 0xff]!) >>> 0;
  return c;
}

function concat(parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let at = 0;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const ascii = (s: string) => Uint8Array.from(s, (c) => c.charCodeAt(0));
const text = (b: Uint8Array, from: number, to: number) => String.fromCharCode(...b.subarray(from, to));

function page(packets: Uint8Array[], granule: bigint, serial: number, seq: number, flags: number): Uint8Array {
  const lacing: number[] = [];
  for (const p of packets) {
    let n = p.length;
    while (n >= 255) {
      lacing.push(255);
      n -= 255;
    }
    lacing.push(n);
  }
  const head = new Uint8Array(27 + lacing.length);
  const v = new DataView(head.buffer);
  head.set(ascii('OggS'), 0);
  head[5] = flags;
  v.setBigInt64(6, granule, true);
  v.setUint32(14, serial, true);
  v.setUint32(18, seq, true);
  head[26] = lacing.length;
  head.set(lacing, 27);
  const out = concat([head, ...packets]);
  new DataView(out.buffer).setUint32(22, crc(out), true);
  return out;
}

/**
 * An Ogg Opus file from 20 ms packets of audio at `sampleRate` (the encoder's input rate), mono or stereo.
 * `samples`: how many 48 kHz samples the audio really has (the last packet is padded to 20 ms), so a player can end
 * it exactly, which a loop needs.
 */
export function writeOggOpus(packets: Uint8Array[], sampleRate: number, opts: { channels?: 1 | 2; preSkip?: number; samples?: number } = {}): Uint8Array {
  const channels = opts.channels ?? 1, preSkip = opts.preSkip ?? 312;
  const serial = 0x44617964; // "Dayd"
  const opusHead = new Uint8Array(19);
  const hv = new DataView(opusHead.buffer);
  opusHead.set(ascii('OpusHead'), 0);
  opusHead[8] = 1;
  opusHead[9] = channels;
  hv.setUint16(10, preSkip, true);
  hv.setUint32(12, sampleRate, true);
  const vendor = ascii('daydream');
  const tags = new Uint8Array(8 + 4 + vendor.length + 4);
  tags.set(ascii('OpusTags'), 0);
  new DataView(tags.buffer).setUint32(8, vendor.length, true);
  tags.set(vendor, 12);
  const pages = [page([opusHead], 0n, serial, 0, 2), page([tags], 0n, serial, 1, 0)];
  // Granule positions count 48 kHz samples whatever the input rate; 20 ms is 960 of them.
  let granule = BigInt(preSkip);
  let seq = 2;
  for (let i = 0; i < packets.length; i += 50) {
    const group = packets.slice(i, i + 50);
    granule += BigInt(group.length * 960);
    const last = i + 50 >= packets.length;
    if (last && opts.samples !== undefined) granule = BigInt(preSkip + opts.samples);
    pages.push(page(group, granule, serial, seq++, last ? 4 : 0));
  }
  return concat(pages);
}

/**
 * The Opus packets of an Ogg Opus file, its input sample rate and channels, the 48 kHz samples to skip at the start
 * (the decoder's delay), and how many follow them.
 */
export function readOggOpus(file: Uint8Array): { packets: Uint8Array[]; sampleRate: number; channels: number; preSkip: number; samples: number } {
  const packets: Uint8Array[] = [];
  let partial: Uint8Array[] = [];
  let at = 0;
  let granule = 0n;
  while (at + 27 <= file.length && text(file, at, at + 4) === 'OggS') {
    granule = new DataView(file.buffer, file.byteOffset + at + 6, 8).getBigInt64(0, true);
    const segs = file[at + 26]!;
    const lacing = file.subarray(at + 27, at + 27 + segs);
    let body = at + 27 + segs;
    for (const n of lacing) {
      partial.push(file.subarray(body, body + n));
      body += n;
      if (n < 255) {
        packets.push(partial.length === 1 ? partial[0]! : concat(partial));
        partial = [];
      }
    }
    at = body;
  }
  const head = packets.shift();
  packets.shift(); // OpusTags
  if (!head || text(head, 0, 8) !== 'OpusHead') throw new Error('not an Ogg Opus file');
  const v = new DataView(head.buffer, head.byteOffset, head.byteLength);
  const preSkip = v.getUint16(10, true);
  return { packets, sampleRate: v.getUint32(12, true), channels: head[9]!, preSkip, samples: Math.max(0, Number(granule) - preSkip) };
}
