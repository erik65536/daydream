/**
 * A FLAC decoder (the format ComfyUI saves audio in): every subframe kind (constant, verbatim, fixed, and linear
 * prediction), Rice-coded residuals with escapes, wasted bits, and the three stereo decorrelations. It reads a whole
 * file into floating-point channels; nothing is streamed.
 */
import type { Pcm } from './dsp.ts';

class Bits {
  private bit = 0;
  private readonly b: Uint8Array;
  pos: number;
  constructor(b: Uint8Array, pos = 0) {
    this.b = b;
    this.pos = pos;
  }

  read(n: number): number {
    let v = 0;
    while (n > 0) {
      const byte = this.b[this.pos];
      if (byte === undefined) throw new Error('FLAC: the file ends inside a frame');
      const take = Math.min(n, 8 - this.bit);
      const part = (byte >> (8 - this.bit - take)) & ((1 << take) - 1);
      v = v * 2 ** take + part;
      n -= take;
      this.bit += take;
      if (this.bit === 8) {
        this.bit = 0;
        this.pos++;
      }
    }
    return v;
  }

  signed(n: number): number {
    if (!n) return 0;
    const v = this.read(n);
    return v >= 2 ** (n - 1) ? v - 2 ** n : v;
  }

  /** Zeros before the next one bit. */
  unary(): number {
    let n = 0;
    while (this.read(1) === 0) n++;
    return n;
  }

  align() {
    if (this.bit) {
      this.bit = 0;
      this.pos++;
    }
  }
}

/** A UTF-8-style coded number (the frame or sample number in a frame header). */
function skipCodedNumber(r: Bits) {
  const first = r.read(8);
  let extra = 0;
  for (let mask = 0x80; first & mask && mask > 1; mask >>= 1) extra++;
  for (let i = 1; i < extra; i++) r.read(8);
}

function residual(r: Bits, out: Float64Array, order: number, blockSize: number) {
  const method = r.read(2);
  if (method > 1) throw new Error('FLAC: unknown residual coding');
  const paramBits = method === 0 ? 4 : 5, escape = method === 0 ? 15 : 31;
  const partOrder = r.read(4);
  const parts = 1 << partOrder;
  let i = order;
  for (let p = 0; p < parts; p++) {
    const n = (blockSize >> partOrder) - (p === 0 ? order : 0);
    const k = r.read(paramBits);
    if (k === escape) {
      const raw = r.read(5);
      for (let j = 0; j < n; j++) out[i++] = r.signed(raw);
    } else
      for (let j = 0; j < n; j++) {
        const u = r.unary() * 2 ** k + (k ? r.read(k) : 0);
        out[i++] = u % 2 ? -(u + 1) / 2 : u / 2;
      }
  }
}

const FIXED: number[][] = [[], [1], [2, -1], [3, -3, 1], [4, -6, 4, -1]];

function subframe(r: Bits, blockSize: number, bps: number): Float64Array {
  if (r.read(1)) throw new Error('FLAC: bad subframe');
  const type = r.read(6);
  let wasted = 0;
  if (r.read(1)) wasted = r.unary() + 1;
  bps -= wasted;
  const s = new Float64Array(blockSize);
  if (type === 0) s.fill(r.signed(bps));
  else if (type === 1) for (let i = 0; i < blockSize; i++) s[i] = r.signed(bps);
  else if (type >= 8 && type <= 12) {
    const order = type - 8;
    for (let i = 0; i < order; i++) s[i] = r.signed(bps);
    residual(r, s, order, blockSize);
    const c = FIXED[order]!;
    for (let i = order; i < blockSize; i++) {
      let p = 0;
      for (let j = 0; j < order; j++) p += c[j]! * s[i - 1 - j]!;
      s[i]! += p;
    }
  } else if (type >= 32) {
    const order = type - 31;
    for (let i = 0; i < order; i++) s[i] = r.signed(bps);
    const precision = r.read(4) + 1;
    const shift = r.signed(5);
    const coef = Array.from({ length: order }, () => r.signed(precision));
    residual(r, s, order, blockSize);
    const div = 2 ** shift;
    for (let i = order; i < blockSize; i++) {
      let p = 0;
      for (let j = 0; j < order; j++) p += coef[j]! * s[i - 1 - j]!;
      s[i]! += Math.floor(p / div);
    }
  } else throw new Error(`FLAC: reserved subframe type ${type}`);
  if (wasted) for (let i = 0; i < blockSize; i++) s[i]! *= 2 ** wasted;
  return s;
}

const BLOCK = (code: number) => (code === 1 ? 192 : code <= 5 ? 576 << (code - 2) : 256 << (code - 8));
const BPS = [0, 8, 12, 0, 16, 20, 24, 32];

/** Decode a FLAC file into floating-point channels (-1 to 1). */
export function decodeFlac(file: Uint8Array): Pcm {
  if (String.fromCharCode(...file.subarray(0, 4)) !== 'fLaC') throw new Error('not a FLAC file');
  const r = new Bits(file, 4);
  let rate = 0, channels = 0, bps = 0, total = 0;
  for (let last = 0; !last; ) {
    last = r.read(1);
    const type = r.read(7);
    const length = r.read(24);
    const start = r.pos;
    if (type === 0) {
      r.read(16 + 16 + 24 + 24);
      rate = r.read(20);
      channels = r.read(3) + 1;
      bps = r.read(5) + 1;
      total = r.read(36);
    }
    r.pos = start + length;
  }
  if (!rate) throw new Error('FLAC: no stream information');
  // A file written as a stream says 0 for its length: it is as long as its frames.
  const known = total > 0;
  let out = Array.from({ length: channels }, () => new Float32Array(known ? total : 1 << 16));
  const scale = 1 / 2 ** (bps - 1);
  let at = 0;
  while ((!known || at < total) && r.pos + 2 < file.length) {
    if (r.read(15) !== 0x7ffc) throw new Error('FLAC: lost frame sync');
    r.read(1);
    const blockCode = r.read(4), rateCode = r.read(4), assign = r.read(4), sizeCode = r.read(3);
    r.read(1);
    skipCodedNumber(r);
    const blockSize = blockCode === 6 ? r.read(8) + 1 : blockCode === 7 ? r.read(16) + 1 : BLOCK(blockCode);
    if (rateCode === 12) r.read(8);
    else if (rateCode === 13 || rateCode === 14) r.read(16);
    r.read(8); // header CRC
    const frameBps = sizeCode ? BPS[sizeCode]! : bps;
    const n = assign < 8 ? assign + 1 : 2;
    const subs: Float64Array[] = [];
    for (let c = 0; c < n; c++) {
      const side = (assign === 8 && c === 1) || (assign === 9 && c === 0) || (assign === 10 && c === 1);
      subs.push(subframe(r, blockSize, frameBps + (side ? 1 : 0)));
    }
    r.align();
    r.read(16); // frame CRC
    if (assign === 8) for (let i = 0; i < blockSize; i++) subs[1]![i] = subs[0]![i]! - subs[1]![i]!;
    else if (assign === 9) for (let i = 0; i < blockSize; i++) subs[0]![i] = subs[0]![i]! + subs[1]![i]!;
    else if (assign === 10)
      for (let i = 0; i < blockSize; i++) {
        const side = subs[1]![i]!, mid = subs[0]![i]! * 2 + (side & 1);
        subs[0]![i] = (mid + side) / 2;
        subs[1]![i] = (mid - side) / 2;
      }
    const take = known ? Math.min(blockSize, total - at) : blockSize;
    if (at + take > out[0]!.length) out = out.map((c) => { const more = new Float32Array(Math.max(2 * c.length, at + take)); more.set(c); return more; });
    for (let c = 0; c < channels; c++) {
      const src = subs[c]!, dst = out[c]!;
      for (let i = 0; i < take; i++) dst[at + i] = src[i]! * scale;
    }
    at += take;
  }
  return { rate, ch: at < out[0]!.length ? out.map((c) => c.slice(0, at)) : out };
}
