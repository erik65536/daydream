/**
 * WAV files: integer PCM of 16, 24, or 32 bits, or 32-bit float, any number of channels. Read for sounds made outside
 * the game (`soundkit --use`) and for voice clips.
 */
import type { Pcm } from './dsp.ts';

export function decodeWav(file: Buffer): Pcm {
  if (file.toString('ascii', 0, 4) !== 'RIFF' || file.toString('ascii', 8, 12) !== 'WAVE') throw new Error('not a WAV file');
  let format = 0, channels = 0, rate = 0, bits = 0;
  for (let at = 12; at + 8 <= file.length; ) {
    const id = file.toString('ascii', at, at + 4);
    const size = file.readUInt32LE(at + 4);
    if (id === 'fmt ') {
      format = file.readUInt16LE(at + 8);
      channels = file.readUInt16LE(at + 10);
      rate = file.readUInt32LE(at + 12);
      bits = file.readUInt16LE(at + 22);
      // WAVE_FORMAT_EXTENSIBLE names the real format in its sub-format's first two bytes.
      if (format === 0xfffe && size >= 26) format = file.readUInt16LE(at + 32);
      if (!((format === 1 && [16, 24, 32].includes(bits)) || (format === 3 && bits === 32))) throw new Error(`an unsupported WAV format (${format}, ${bits} bits)`);
    } else if (id === 'data' && channels) {
      // A file written as a stream says 0 (or more than there is) for its length: its samples are the rest of the file.
      const step = bits / 8, n = Math.floor(Math.min(size || Infinity, file.length - at - 8) / step / channels);
      const ch = Array.from({ length: channels }, () => new Float32Array(n));
      for (let i = 0, o = at + 8; i < n; i++)
        for (let c = 0; c < channels; c++, o += step)
          ch[c]![i] = format === 3 ? file.readFloatLE(o) : bits === 16 ? file.readInt16LE(o) / 32768 : bits === 24 ? file.readIntLE(o, 3) / 8388608 : file.readInt32LE(o) / 2147483648;
      return { rate, ch };
    }
    at += 8 + size + (size & 1);
  }
  throw new Error('a WAV file without its format or samples');
}
