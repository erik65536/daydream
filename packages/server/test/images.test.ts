import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { KEY_COLORS, backdropSentence, cutout, cutoutProblems, finishCutout } from '../src/genai/cutout.ts';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { withCallContext } from '../src/genai/context.ts';
import { reloadGenAI } from '../src/genai/service.ts';
import { Unchecked, batchAnswers, batchResults, buildPrompt, canvasOf, produceAssets, type BatchReader, type ImageRecord } from '../src/genai/images.ts';
import { parseModelJson } from '../src/genai/json.ts';

const W = 600, H = 800;
/** Krea's rendering of the magenta key (a hot pink, not #ff00ff): the cut must read the real backdrop. */
const MAGENTA = '#e04aa8';
const svg = (body: string, bg?: string) => Buffer.from(`<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${H}">${bg ? `<rect width="100%" height="100%" fill="${bg}"/>` : ''}${body}</svg>`);

/** A painting of `shapes` on `bg`. */
const painted = (bg: string, shapes: string) => sharp(svg(shapes, bg)).removeAlpha().png().toBuffer();
const px = (c: { data: Buffer; width: number }, x: number, y: number) => [...c.data.subarray((y * c.width + x) * 4, (y * c.width + x) * 4 + 4)];

describe('cutting assets out of their chroma-key backdrop', () => {
  it('cuts a figure out and un-mixes the backdrop from its soft edges', async () => {
    const c = await cutout(await painted(MAGENTA, '<ellipse cx="300" cy="420" rx="110" ry="300" fill="#4a3020"/>'));
    expect(c.key).toBe('magenta');
    expect(cutoutProblems(c)).toEqual([]);
    expect(px(c, 300, 420)[3]).toBe(255);
    expect(px(c, 300 + 116, 420)[3]).toBe(0);
    // Soft edge pixels carry the figure's color, not pink.
    let blue = 0, n = 0;
    for (let k = 0; k < W * H; k++) {
      const a = c.data[k * 4 + 3]!;
      if (a > 20 && a < 235) (blue += c.data[k * 4 + 2]!), n++;
    }
    expect(n).toBeGreaterThan(50);
    expect(blue / n).toBeLessThan(70);
  });

  it('opens the middle of a ring and keeps every separate piece', async () => {
    const ring = await cutout(await painted(KEY_COLORS.green.hex, '<circle cx="300" cy="400" r="150" fill="none" stroke="#c0c4c8" stroke-width="30"/>'));
    expect(px(ring, 300, 400)[3]).toBe(0);
    expect(px(ring, 450, 400)[3]).toBe(255);
    const at = [[150, 300], [300, 260], [450, 320], [220, 520], [400, 560]];
    const coins = await cutout(await painted(KEY_COLORS.blue.hex, at.map(([x, y]) => `<circle cx="${x}" cy="${y}" r="45" fill="#b08840"/>`).join('')));
    expect(cutoutProblems(coins)).toEqual([]);
    for (const [x, y] of at) expect(px(coins, x!, y!)[3]).toBe(255);
  });

  it('keeps see-through parts see-through and gray, and solid red parts red', async () => {
    // Pale smoke at half opacity over the backdrop, and a red-brown cork (strongly red, like the magenta key).
    const c = await cutout(await painted(MAGENTA, '<rect x="100" y="100" width="200" height="200" fill="#d0d0d0" fill-opacity="0.5"/><rect x="350" y="400" width="120" height="120" fill="#a0502a"/>'));
    expect(cutoutProblems(c)).toEqual([]);
    const [r, g, b, a] = px(c, 200, 200) as [number, number, number, number];
    expect(Math.abs(a - 128)).toBeLessThan(25);
    expect(Math.max(r, g, b) - Math.min(r, g, b)).toBeLessThan(20);
    expect(px(c, 410, 460)).toEqual([0xa0, 0x50, 0x2a, 255]);
  });

  it('will not judge a subject painted in the key’s own hue (it is painted again on another)', async () => {
    // An opaque pink-lavender robe on magenta: the key reads it as partly backdrop and un-mixes it to teal.
    const c = await cutout(await painted(MAGENTA, '<ellipse cx="300" cy="420" rx="160" ry="300" fill="#d080c0"/>'));
    expect(c.clash).toBeGreaterThan(0.5);
    expect(cutoutProblems(c)).toEqual(['the backdrop color clashes with the subject']);
  });

  it('will not judge a dull backdrop', async () => {
    const c = await cutout(await painted('#808080', '<circle cx="300" cy="400" r="100" fill="#333"/>'));
    expect(cutoutProblems(c)).toEqual(['the backdrop is too dull to key']);
  });

  it('trims to the subject and flags one cut off by the frame', async () => {
    const whole = await finishCutout(await cutout(await painted(KEY_COLORS.green.hex, '<rect x="200" y="100" width="200" height="600" fill="#553322"/>')), 256);
    expect(whole.problems).toEqual([]);
    expect(whole.height).toBe(256);
    expect(whole.width).toBeLessThan(100);
    expect(whole.anchorY).toBeGreaterThan(0.95);
    const cut = await finishCutout(await cutout(await painted(KEY_COLORS.green.hex, '<rect x="200" y="300" width="200" height="500" fill="#553322"/>')), 256);
    expect(cut.problems.some((p) => p.includes('cut off'))).toBe(true);
  });
});

describe('asset prompts', () => {
  const rec = (over: Partial<ImageRecord>): ImageRecord => ({ key: 'k', kind: 'sprite', prompt: 'a marsh hound', status: 'pending', ...over }) as ImageRecord;
  it('ends every prompt with its key-color backdrop', () => {
    const p = buildPrompt(rec({ imagePrompt: 'A painterly hound.' }), 'painterly', 'blue');
    expect(p.startsWith('A painterly hound.')).toBe(true);
    expect(p.endsWith(backdropSentence('blue'))).toBe(true);
    expect(p).toContain('#0047bb');
  });
  it('paints people upright and animals side-on', () => {
    expect(canvasOf(rec({ view: 'front' }))).toEqual({ width: 832, height: 1216 });
    expect(canvasOf(rec({ view: 'side' }))).toEqual({ width: 1216, height: 832 });
    expect(canvasOf(rec({ kind: 'icon' }))).toEqual({ width: 1024, height: 1024 });
  });
});

describe('model JSON parsing', () => {
  it('handles fences, think tags, trailing commas and truncation', () => {
    expect(parseModelJson('```json\n{"a": 1,}\n```')).toEqual({ a: 1 });
    expect(parseModelJson('<think>hmm {"x":2}</think>Here: {"a": [1, 2,], "b": "ok"}')).toEqual({ a: [1, 2], b: 'ok' });
    expect(parseModelJson('{"a": {"b": "unterminated')).toEqual({ a: { b: 'unterminated' } });
    expect(() => parseModelJson('no json here')).toThrow();
  });
});

describe('waiting for a batch', () => {
  const answers = new Map([['a', { image: Buffer.from('picture') }]]);
  const reader = (states: ('running' | 'done' | 'failed')[], output?: string): BatchReader & { read: number } => {
    const r = { read: 0, status: async () => ({ state: states.length > 1 ? states.shift()! : states[0]!, detail: 'expired', output }), results: async () => (r.read++, answers) };
    return r;
  };

  it('reads a batch that ended early for what it did answer, and one with no answers for none', async () => {
    const partly = reader(['failed'], 'file_1');
    expect((await batchResults(partly, await partly.status('b'))).answers.get('a')?.image).toBeTruthy();
    const empty = reader(['failed']);
    expect(await batchResults(empty, await empty.status('b'))).toEqual({ answers: new Map(), detail: 'expired' });
    expect(empty.read).toBe(0);
  });

  it('stops waiting when told to, leaving the batch out', async () => {
    const out = reader(['running']);
    expect(await batchAnswers(out, 'b', () => true)).toBeUndefined();
    expect(out.read).toBe(0);
    expect((await batchAnswers(reader(['done']), 'b'))?.answers.size).toBe(1);
  });
});

describe('a painting the checker does not answer for', () => {
  it('is never kept: its asset is painted again, and the production fails when the checker stays down', async () => {
    // A mock of OpenAI: the Images API paints a figure on transparency; the decisions endpoint answers or refuses.
    let checkerUp = false, painted = 0;
    const figure = (await sharp(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="672" height="976"><ellipse cx="336" cy="488" rx="150" ry="330" fill="#a33"/></svg>')).png().toBuffer()).toString('base64');
    const server = http.createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('content-type', 'application/json');
        if (req.url!.endsWith('/images/generations')) return void (painted++, res.end(JSON.stringify({ data: [{ b64_json: figure }], usage: { input_tokens: 10, output_tokens: 10 } })));
        if (!checkerUp) return void ((res.statusCode = 400), res.end(JSON.stringify({ error: { message: 'the checker is away' } })));
        res.end(JSON.stringify({ answers: [], usage: { input_tokens: 10, output_tokens: 1 } }));
      });
    });
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'gd-unchecked-'));
    fs.writeFileSync(path.join(dir, 'genai.json'), JSON.stringify({
      providers: { img: { type: 'openai-image', baseUrl: base, apiKey: 'test', model: 'gpt-image-2.5-flare' }, chk: { type: 'openai-decision', baseUrl: base, apiKey: 'test', model: 'mock', pricing: { inputPerM: 0, outputPerM: 0 } } },
      purposes: { 'image.sprite': { provider: 'img', batch: false, maxAttempts: 2 }, 'image.check': { provider: 'chk', retries: 0, minScore: 3 } },
    }));
    const before = process.env.DAYDREAM_GENAI_CONFIG;
    process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'genai.json');
    reloadGenAI();
    const done: ImageRecord[] = [];
    const produce = () => withCallContext({ priority: 'background' }, () => produceAssets([{ key: 'spr_npc_k', kind: 'sprite', prompt: 'a marsh hound', status: 'pending', view: 'front' }], { style: 'painted', outDir: path.join(dir, 'out'), worldSeed: 'w', onDone: (r) => done.push(r) }));
    try {
      await expect(produce()).rejects.toThrow(Unchecked);
      expect(painted).toBe(2);
      expect(done).toEqual([]);
      // With the checker back, the same asset is painted, checked, and kept.
      checkerUp = true;
      await produce();
      expect(done.map((r) => r.status)).toEqual(['ok']);
    } finally {
      server.close();
      if (before === undefined) delete process.env.DAYDREAM_GENAI_CONFIG;
      else process.env.DAYDREAM_GENAI_CONFIG = before;
      reloadGenAI();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
