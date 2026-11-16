import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { OpenAIImageProvider, gptImageSize, openaiImageUsage } from '../src/genai/providers.ts';
import { reloadGenAI } from '../src/genai/service.ts';
import { costOf, setSpendLedger, GPT_IMAGE_PRICES } from '../src/genai/spend.ts';
import type { ProviderConfig } from '../src/genai/types.ts';

/** A mock of OpenAI's Images API: answers every call with a small PNG and the usage given. */
async function mockImages(usage: Record<string, unknown>) {
  const seen: { url: string; type: string; body: Buffer }[] = [];
  const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer();
  const server = http.createServer((req, res) => {
    const parts: Buffer[] = [];
    req.on('data', (d) => parts.push(d));
    req.on('end', () => {
      seen.push({ url: req.url ?? '', type: req.headers['content-type'] ?? '', body: Buffer.concat(parts) });
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ created: 0, data: [{ b64_json: png.toString('base64') }], usage }));
    });
  });
  await new Promise<void>((r) => server.listen(0, () => r()));
  const baseUrl = `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`;
  return { seen, baseUrl, stop: () => server.close() };
}

describe('OpenAI image models', () => {
  // The suite's own config (no models) comes back afterwards, never the checkout's config/genai.json.
  const before = process.env.DAYDREAM_GENAI_CONFIG;
  afterEach(() => {
    setSpendLedger(null);
    process.env.DAYDREAM_GENAI_CONFIG = before;
    reloadGenAI();
  });

  it('asks for sizes the model paints, keeping the shape', () => {
    expect(gptImageSize(1024, 1024)).toEqual({ width: 1024, height: 1024 });
    // Too small: grown to the minimum area. Too big: shrunk to 4K.
    const small = gptImageSize(512, 512);
    expect(small.width * small.height).toBeGreaterThanOrEqual(655_360);
    const big = gptImageSize(6144, 6144);
    expect(big.width * big.height).toBeLessThanOrEqual(8_294_400);
    expect(big.width).toBe(big.height);
    // A 3 × 2 place keeps its shape; sides are multiples of 16 and no side passes 3840.
    const wide = gptImageSize(3072, 2048);
    expect(wide.width % 16 + (wide.height % 16)).toBe(0);
    expect(wide.width / wide.height).toBeCloseTo(1.5, 1);
    const strip = gptImageSize(8000, 1000);
    expect(strip.width).toBeLessThanOrEqual(3840);
    expect(strip.width / strip.height).toBeLessThanOrEqual(3);
  });

  it('prices image input, text input and image output apart', () => {
    const cfg: ProviderConfig = { type: 'openai-image' };
    expect(GPT_IMAGE_PRICES).toMatchObject({ input: 5, imageInput: 8, output: 30 });
    expect(costOf(cfg, { input: 1_000_000 })).toBeCloseTo(5);
    expect(costOf(cfg, { imageInput: 1_000_000 })).toBeCloseTo(8);
    expect(costOf(cfg, { imageInput: 1_000_000, imageCached: 1_000_000 })).toBeCloseTo(2);
    expect(costOf(cfg, { output: 1_000_000 })).toBeCloseTo(30);
    // A provider priced in the config: image cached input defaults to a quarter of image input.
    expect(costOf({ type: 'openai-image', pricing: { inputPerM: 1, outputPerM: 10, imageInputPerM: 4 } }, { imageInput: 1_000_000, imageCached: 500_000, output: 100_000 })).toBeCloseTo(2 + 0.5 + 1);
  });

  it('paints and edits through the Images API, and charges each call to the ledger', async () => {
    const m = await mockImages({ input_tokens: 1200, input_tokens_details: { text_tokens: 200, image_tokens: 1000 }, output_tokens: 4000 });
    const charged: number[] = [];
    setSpendLedger({ record: (_u, usd) => charged.push(usd), refusal: () => null });
    try {
      const cfg: ProviderConfig = { type: 'openai-image', baseUrl: m.baseUrl, apiKey: 'test', model: 'gpt-image-2.5-flare', quality: 'low' };
      const p = new OpenAIImageProvider(cfg);
      const before = openaiImageUsage.usd;
      const png = await p.generate({ prompt: 'a village from above', width: 2048, height: 2048, seed: 1 });
      expect((await sharp(png).metadata()).width).toBe(16);
      const gen = JSON.parse(m.seen[0]!.body.toString());
      expect(m.seen[0]!.url).toBe('/v1/images/generations');
      expect(gen).toMatchObject({ model: 'gpt-image-2.5-flare', prompt: 'a village from above', size: '2048x2048', quality: 'low' });

      const map = await sharp({ create: { width: 1536, height: 1024, channels: 3, background: '#335533' } }).png().toBuffer();
      await p.edit({ prompt: 'a walkability plan', images: [map], quality: 'high' });
      expect(m.seen[1]!.url).toBe('/v1/images/edits');
      expect(m.seen[1]!.type).toMatch(/^multipart\/form-data/);
      const form = m.seen[1]!.body.toString('latin1');
      expect(form).toContain('name="image[]"');
      expect(form).toMatch(/name="size"\r\n\r\n1536x1024/);
      expect(form).toMatch(/name="quality"\r\n\r\nhigh/);

      // 200 text tokens at $5, 1000 image tokens at $8 and 4000 output tokens at $30 per million.
      const one = (200 * 5 + 1000 * 8 + 4000 * 30) / 1e6;
      expect(charged).toHaveLength(2);
      for (const c of charged) expect(c).toBeCloseTo(one, 6);
      expect(openaiImageUsage.usd - before).toBeCloseTo(2 * one, 6);
    } finally {
      m.stop();
    }
  });

  it('charges a batch’s answers once, however often its results are read', async () => {
    const png = await sharp({ create: { width: 16, height: 16, channels: 3, background: '#808080' } }).png().toBuffer();
    const line = (id: string) => JSON.stringify({ custom_id: id, response: { status_code: 200, body: { model: 'gpt-image-2.5-flare', data: [{ b64_json: png.toString('base64') }], usage: { input_tokens: 100, output_tokens: 1000 } } } });
    const server = http.createServer((_req, res) => void res.end(`${line('a')}
${line('b')}
`));
    await new Promise<void>((r) => server.listen(0, () => r()));
    const charged: number[] = [];
    setSpendLedger({ record: (_u, usd) => charged.push(usd), refusal: () => null });
    try {
      const batch = new OpenAIImageProvider({ type: 'openai-image', baseUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}/v1`, apiKey: 'test' }).batch();
      const output = `file_${Math.random().toString(36).slice(2)}`;
      const first = await batch.results({ state: 'done', detail: 'completed', output });
      expect([...first.keys()]).toEqual(['a', 'b']);
      expect(charged).toHaveLength(2);
      // Read again (a job that stopped between reading and saving): the pictures come back, the charge does not.
      const again = await batch.results({ state: 'done', detail: 'completed', output });
      expect(again.get('a')?.image).toBeInstanceOf(Buffer);
      expect(charged).toHaveLength(2);
    } finally {
      server.close();
    }
  });

  it('serves an image purpose from the gateway, refusing calls past the budget', async () => {
    const m = await mockImages({ input_tokens: 50, output_tokens: 1000 });
    try {
      const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-cfg-'));
      fs.writeFileSync(path.join(dir, 'genai.json'), JSON.stringify({ providers: { gpt: { type: 'openai-image', baseUrl: m.baseUrl, apiKey: 'test' } }, purposes: { 'image.sprite': { provider: 'gpt' } } }));
      process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'genai.json');
      const g = reloadGenAI();
      const map = await sharp({ create: { width: 1024, height: 1024, channels: 3, background: '#000' } }).png().toBuffer();
      expect(await g.image('image.sprite', { prompt: 'a lantern', seed: 3 })).toBeInstanceOf(Buffer);
      expect(await g.editImage('image.sprite', { prompt: 'make it night', images: [map] })).toBeInstanceOf(Buffer);
      expect(JSON.parse(m.seen[0]!.body.toString()).quality).toBe('medium');
      setSpendLedger({ record: () => {}, refusal: () => 'spent' });
      await expect(g.image('image.sprite', { prompt: 'a lantern', seed: 3 })).rejects.toThrow(/spent/);
      expect(m.seen).toHaveLength(2);
    } finally {
      m.stop();
    }
  });
});
