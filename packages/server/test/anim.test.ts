import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ANIM_DIRS, SHEET_PAD, clipFrame, clipKey, dirRow, paintedRow, sheetFrame, type AnimClip, type AssetRecord, type SheetRow, type WorldDefinition } from '@daydream/shared';
import { actorSprites, fights, needsAnimation, paintingHash } from '../src/anim/actors.ts';
import { assemble, cell, gifBackdrop, gifSheet, paleHaze } from '../src/anim/assemble.ts';
import { animationState, clearAnimations, markRequested, runAnimateJob, saveAnimation } from '../src/anim/job.ts';
import { packSheet } from '../src/anim/pack.ts';
import { reloadGenAI } from '../src/genai/service.ts';
import { withCallContext } from '../src/genai/context.ts';
import { setSpendLedger } from '../src/genai/spend.ts';
import type { Job } from '../src/jobs/job.ts';
import { loadWorld, saveWorld, worldAssetDir, worldDir } from '../src/storage.ts';

const sprite = (key: string, prompt = '', extra: Partial<AssetRecord> = {}): AssetRecord => ({ key, kind: 'sprite', prompt, status: 'ok', file: `${key}.png`, ...extra });
const row = (w: number): SheetRow => [0, w, w, 0, 0, 1];

describe('sheet rows and frames', () => {
  it('picks the row from the direction on screen', () => {
    // The maps are top-down: ground y runs down the screen, x to the right.
    expect(ANIM_DIRS[dirRow(0, 1)]).toBe('S');
    expect(ANIM_DIRS[dirRow(0, -1)]).toBe('N');
    expect(ANIM_DIRS[dirRow(1, 0)]).toBe('E');
    expect(ANIM_DIRS[dirRow(-1, 0)]).toBe('W');
    expect(ANIM_DIRS[dirRow(1, 1)]).toBe('SE');
    expect(ANIM_DIRS[dirRow(-1, 1)]).toBe('SW');
    expect(ANIM_DIRS[dirRow(-1, -1)]).toBe('NW');
    expect(ANIM_DIRS[dirRow(1, -1)]).toBe('NE');
    expect(dirRow(0, 0)).toBe(0);
  });

  it('draws east-facing rows as the west-facing ones mirrored, and the nearest painted one for the rest', () => {
    // A move painted in S, SW, W, NW, N; an attack in S, W, N; a death in W alone.
    const empty = row(0);
    const move: AnimClip = { frames: 4, fps: 6, loop: true, rows: [row(9), row(9), row(9), row(9), row(9), empty, empty, empty] };
    const attack: AnimClip = { frames: 4, fps: 8, loop: false, rows: [row(9), empty, row(9), empty, row(9), empty, empty, empty] };
    const die: AnimClip = { frames: 4, fps: 6, loop: false, rows: [empty, empty, row(9), empty, empty, empty, empty, empty] };
    const at = (c: AnimClip, d: string) => paintedRow(c, ANIM_DIRS.indexOf(d as never));
    expect(at(move, 'NE')).toEqual({ row: ANIM_DIRS.indexOf('NW'), flip: true });
    expect(at(move, 'E')).toEqual({ row: ANIM_DIRS.indexOf('W'), flip: true });
    expect(at(move, 'S')).toEqual({ row: 0, flip: false });
    // An attack facing down-left plays the nearest painted facing: front or side (front comes first round the compass).
    expect([0, 2]).toContain(at(attack, 'SW')!.row);
    expect(at(attack, 'E')).toEqual({ row: ANIM_DIRS.indexOf('W'), flip: true });
    expect(at(die, 'N')!.row).toBe(ANIM_DIRS.indexOf('W'));
    expect(at(die, 'SE')).toEqual({ row: ANIM_DIRS.indexOf('W'), flip: true });
    expect(paintedRow({ ...die, rows: Array(8).fill(empty) }, 3)).toBeNull();
  });

  it('loops gaits at the pace of the ground and holds one-shots on their last frame', () => {
    const walk: AnimClip = { frames: 4, fps: 6, loop: true, stride: 1, rows: [] };
    // One meter per second over a one-meter stride: one loop per second.
    expect(clipFrame(walk, 0.5, 1)).toBe(2);
    expect(clipFrame(walk, 1.25, 1)).toBe(1);
    const die: AnimClip = { frames: 4, fps: 6, loop: false, rows: [] };
    expect(clipFrame(die, 0.4)).toBe(2);
    expect(clipFrame(die, 99)).toBe(3);
  });

  it('keys clip sheets apart from the base sprite', () => {
    expect(clipKey('spr_npc_a', 'walk')).toBe('spr_npc_a@anim-walk');
    expect(clipKey('spr_npc_a', 'walk')).not.toBe('spr_npc_a@walk');
  });
});

describe('actors', () => {
  it('animates character and creature sprites only, again when repainted', () => {
    const id = `w_animneeds_${Date.now().toString(36)}`;
    fs.mkdirSync(worldAssetDir(id), { recursive: true });
    fs.writeFileSync(path.join(worldAssetDir(id), 'spr_npc_a.png'), 'a painting');
    const w = {
      id,
      assets: {
        spr_npc_a: sprite('spr_npc_a'),
        'spr_npc_a@anim-walk': { ...sprite('spr_npc_a@anim-walk'), kind: 'sheet', ref: 'spr_npc_a' },
        spr_mon_b: sprite('spr_mon_b', '', { status: 'failed' }),
        icon_x: { ...sprite('icon_x'), kind: 'icon' },
        obj_chest: { ...sprite('obj_chest'), kind: 'object' },
      },
    } as unknown as WorldDefinition;
    expect(actorSprites(w).map((a) => a.key)).toEqual(['spr_npc_a']);
    const rec = w.assets.spr_npc_a!;
    expect(needsAnimation(w, rec)).toBe(true);
    rec.anim = { body: 'walks', scale: 2, cell: [10, 10], anchor: [5, 8], height: 1.75, from: paintingHash(id, rec), clips: { walk: { frames: 4, fps: 6, loop: true, rows: [] } } };
    expect(needsAnimation(w, rec)).toBe(false);
    // Sheets are known by the content of the painting they were made from, never by its file's name.
    expect(needsAnimation(w, { ...rec, anim: { ...rec.anim, from: 'spr_npc_a.png' } })).toBe(true);
    // A clip whose sheet is missing needs animating again.
    rec.anim.clips.idle = { frames: 1, fps: 1, loop: true, rows: [] };
    expect(needsAnimation(w, rec)).toBe(true);
    delete rec.anim.clips.idle;
    rec.file = 'spr_npc_a_v2.png';
    expect(needsAnimation(w, rec)).toBe(true);
    fs.rmSync(worldDir(id), { recursive: true, force: true });
  });

  it('gives every clip to those who fight and the move alone to townspeople', () => {
    expect(fights(sprite('spr_npc_a'))).toBe(false);
    expect(fights(sprite('spr_npc_b'))).toBe(false);
    expect(fights(sprite('spr_mon_f0_x'))).toBe(true);
    expect(fights(sprite('spr_hero_cl_x_k_y'))).toBe(true);
  });

  it('starts an actor again when it is repainted, though its file keeps its name', () => {
    const id = `w_animrepaint_${Date.now().toString(36)}`;
    const w = { id, input: {}, assets: { spr_npc_a: sprite('spr_npc_a') } } as unknown as WorldDefinition;
    const painting = path.join(worldAssetDir(id), 'spr_npc_a.png'), turn = path.join(worldDir(id), 'anim', 'spr_npc_a', 'turn.png');
    try {
      fs.mkdirSync(worldAssetDir(id), { recursive: true });
      fs.writeFileSync(painting, 'the first painting');
      const rec = w.assets.spr_npc_a!;
      // Its animation's steps are kept for this painting, and its sheets name it by its content.
      markRequested(w, ['spr_npc_a']);
      fs.writeFileSync(turn, 'a turnaround painted from the first painting');
      rec.anim = { body: 'walks', scale: 2, cell: [10, 10], anchor: [5, 8], height: 1.75, from: paintingHash(id, rec), clips: {} };
      expect(needsAnimation(w, rec)).toBe(false);
      markRequested(w, ['spr_npc_a']);
      expect(fs.existsSync(turn)).toBe(true);
      // Repainted: the same file, another picture. What was painted from the old one goes, and it is animated again.
      fs.writeFileSync(painting, 'the second painting, of another figure');
      expect(needsAnimation(w, rec)).toBe(true);
      markRequested(w, ['spr_npc_a']);
      expect(fs.existsSync(turn)).toBe(false);
      // Steps kept without the painting's hash (none are made so now) are not taken for this painting's.
      const state = path.join(path.dirname(turn), 'state.json');
      fs.writeFileSync(state, JSON.stringify({ ...JSON.parse(fs.readFileSync(state, 'utf8')), hash: undefined }));
      fs.writeFileSync(turn, 'a turnaround from who knows which painting');
      markRequested(w, ['spr_npc_a']);
      expect(fs.existsSync(turn)).toBe(false);
    } finally {
      fs.rmSync(worldDir(id), { recursive: true, force: true });
    }
  });

  it('saves a sheet per clip and the layout on the sprite, and clears them', async () => {
    const id = `w_animtest_${Date.now().toString(36)}`;
    const w = { id, assets: { spr_npc_a: sprite('spr_npc_a') } } as unknown as WorldDefinition;
    const webp = await sharp({ create: { width: 40, height: 80, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).webp().toBuffer();
    const sheet = { webp, width: 40, height: 80, rows: [] };
    const anim = { body: 'walks' as const, scale: 2, cell: [10, 10] as [number, number], anchor: [5, 8] as [number, number], height: 1.75, from: 'spr_npc_a.png', clips: { idle: { frames: 1, fps: 1, loop: true, rows: [] }, die: { frames: 4, fps: 6, loop: false, rows: [] } } };
    saveAnimation(w, 'spr_npc_a', { anim, sheets: { idle: sheet, die: sheet } });
    expect(w.assets.spr_npc_a!.anim).toEqual(anim);
    for (const clip of ['idle', 'die'] as const) {
      const rec = w.assets[clipKey('spr_npc_a', clip)]!;
      expect(rec).toMatchObject({ kind: 'sheet', status: 'ok', ref: 'spr_npc_a', width: 40, height: 80 });
      expect(fs.existsSync(path.join(worldAssetDir(id), rec.file!))).toBe(true);
    }
    expect(w.assets[clipKey('spr_npc_a', 'walk')]).toBeUndefined();
    const file = w.assets[clipKey('spr_npc_a', 'die')]!.file!;
    expect(clearAnimations(w)).toBe(1);
    expect(w.assets.spr_npc_a!.anim).toBeUndefined();
    expect(Object.keys(w.assets)).toEqual(['spr_npc_a']);
    expect(fs.existsSync(path.join(worldAssetDir(id), file))).toBe(false);
    fs.rmSync(worldDir(id), { recursive: true, force: true });
  });
});

describe('packing sheets', () => {
  it("keeps each direction's box and puts every frame back where it was in its cell", async () => {
    // 5 frames of 20x30 cells; in row r, frame f draws a 3x4 block at (2 + f + r, 10 + r).
    const [cw, ch, frames] = [20, 30, 5];
    const raw = Buffer.alloc(cw * frames * ch * 8 * 4);
    for (let r = 0; r < 8; r++)
      for (let f = 0; f < frames; f++)
        for (let y = 0; y < 4; y++)
          for (let x = 0; x < 3; x++) raw.set([r * 30, f * 50, 200, 255], (((r * ch + 10 + r + y) * cw * frames) + f * cw + 2 + f + r + x) * 4);
    raw.set([255, 0, 0, 255], ((5 * ch + 0) * cw * frames + 7) * 4); // a lone pixel at the top of row 5, frame 0
    const png = await sharp(raw, { raw: { width: cw * frames, height: ch * 8, channels: 4 } }).png().toBuffer();
    const p = await packSheet(png, [cw, ch], frames);
    expect(p.rows).toHaveLength(8);
    expect(p.rows[0]!.slice(1, 5)).toEqual([7, 4, 2, 10]);
    expect(p.rows[5]!.slice(1, 5)).toEqual([7, 19, 7, 0]);
    const meta = await sharp(p.webp).metadata();
    expect([meta.width, meta.height]).toEqual([p.width, p.height]);
    expect(p.width * p.height).toBeLessThan(cw * frames * ch * 8);
    const out = await sharp(p.webp).ensureAlpha().raw().toBuffer();
    const clip: AnimClip = { frames, fps: 8, loop: true, rows: p.rows };
    for (const [r, f] of [[0, 0], [3, 4], [7, 2]] as const) {
      const { sx, sy, dx, dy } = sheetFrame(clip, f, r);
      const o = ((sy + 10 + r - dy) * p.width + sx + 2 + f + r - dx) * 4;
      expect(out[o + 3]).toBeGreaterThan(200);
      expect(out[((sy + 10 + r - dy) * p.width + sx - 1) * 4 + 3]).toBe(0);
    }
    expect(SHEET_PAD).toBeGreaterThan(0);
  });
});

/** A transparent sheet with a solid figure standing in every cell (feet at 92% of the cell, `fh` of its height tall). */
async function figures(width: number, height: number, cols: number, rows: number, fh = 0.6): Promise<Buffer> {
  const cw = Math.floor(width / cols), ch = Math.floor(height / rows);
  const fig = await sharp({ create: { width: Math.round(cw * 0.3), height: Math.round(ch * fh), channels: 4, background: { r: 120, g: 60, b: 30, alpha: 1 } } }).png().toBuffer();
  const comp = Array.from({ length: cols * rows }, (_, i) => ({ input: fig, left: (i % cols) * cw + Math.round(cw * 0.35), top: Math.floor(i / cols) * ch + Math.round(ch * 0.92 - ch * fh) }));
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(comp).png().toBuffer();
}

describe('assembling painted sheets', () => {
  it('scales the standing figure to the still sprite, puts the feet on the anchor and leaves unpainted directions empty', async () => {
    // The painting: 100 x 200, a figure filling it. Its sheets come back at their input size (perPainting is then
    // the placement factor alone).
    const painting = await figures(100, 200, 1, 1, 0.9);
    const idle = await Promise.all((['S', 'SW', 'W', 'NW', 'N'] as const).map(async (view) => ({ view, png: painting, perPainting: 1 })));
    const W = await figures(4 * 200, 4 * 288, 4, 4);
    const S = await figures(4 * 200, 3 * 288, 4, 3);
    const SW = await figures(2 * 200, 2 * 288, 2, 2);
    const r = await assemble('walks', 'spr.png', 200, idle, [
      { png: W, view: 'W', rows: ['move', 'attack', 'hit', 'death'], perPainting: 1 },
      { png: S, view: 'S', rows: ['move', 'attack', 'hit'], perPainting: 1 },
      { png: SW, view: 'SW', rows: ['move'], perPainting: 1 },
    ]);
    expect(Object.keys(r.anim.clips).sort()).toEqual(['attack', 'die', 'hit', 'idle', 'walk']);
    const painted = (c: AnimClip) => c.rows.map((x, i) => (x[1] ? ANIM_DIRS[i] : '')).filter(Boolean);
    expect(painted(r.anim.clips.walk!)).toEqual(['S', 'SW', 'W']);
    expect(painted(r.anim.clips.attack!)).toEqual(['S', 'W']);
    expect(painted(r.anim.clips.die!)).toEqual(['W']);
    expect(painted(r.anim.clips.idle!)).toEqual(['S', 'SW', 'W', 'NW', 'N']);
    expect(r.anim.clips.walk).toMatchObject({ frames: 4, loop: true, stride: 1.4 });
    expect(r.anim.clips.attack).toMatchObject({ frames: 4, loop: false, event: 2 });
    // The standing figure (90% of the 200 px painting) is drawn as the still sprite: 164 sheet px for the painting.
    const [, , ih, , idy] = r.anim.clips.idle!.rows[0]!;
    expect(ih).toBeGreaterThan(140);
    expect(ih).toBeLessThan(160);
    // Its feet on the anchor line.
    expect(Math.abs(idy + ih - r.anim.anchor[1])).toBeLessThanOrEqual(2);
    // The clip sheets' figures came back larger and stockier than the painting's (as a stride is wider): the walk is
    // given the standing figure's height, and so are the attack and hit, whose last frames stand.
    const tall = (c: AnimClip, d: number) => c.rows[d]![2];
    for (const v of ['S', 'SW', 'W'] as const) expect(tall(r.anim.clips.walk!, ANIM_DIRS.indexOf(v)) / tall(r.anim.clips.idle!, ANIM_DIRS.indexOf(v))).toBeCloseTo(1, 1);
    for (const c of [r.anim.clips.attack!, r.anim.clips.hit!]) expect(tall(c, ANIM_DIRS.indexOf('W')) / tall(r.anim.clips.idle!, ANIM_DIRS.indexOf('W'))).toBeCloseTo(1, 1);
  });

  it('measures a figure without the specks the model leaves round it', async () => {
    // A 40 x 100 figure with its feet at row 150, and a 3 x 3 speck below them at row 180.
    const fig = await sharp({ create: { width: 40, height: 100, channels: 4, background: { r: 90, g: 70, b: 50, alpha: 1 } } }).png().toBuffer();
    const speck = await sharp({ create: { width: 3, height: 3, channels: 4, background: { r: 90, g: 70, b: 50, alpha: 1 } } }).png().toBuffer();
    const png = await sharp({ create: { width: 200, height: 200, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } })
      .composite([{ input: fig, left: 80, top: 50 }, { input: speck, left: 150, top: 180 }]).png().toBuffer();
    const c = await cell(png, 1, 1, 0);
    expect(c.foot).toBe(149);
    expect(c.bh).toBe(100);
    expect(c.ux).toBe(99.5); // columns 80 to 119
  });

  it('tells a pale backdrop painted behind the figure from the figure', async () => {
    const figure = await figures(400, 400, 2, 2);
    expect(await paleHaze(figure)).toBe(0);
    const haze = await sharp({ create: { width: 400, height: 400, channels: 4, background: { r: 235, g: 235, b: 238, alpha: 0.5 } } }).composite([{ input: figure }]).png().toBuffer();
    expect(await paleHaze(haze)).toBeGreaterThan(0.5);
  });

  it('tells a backdrop painted behind a walk GIF from a figure standing clear of its edges', async () => {
    expect(await gifBackdrop(await walkGif(320, 256, 8))).toBe(0);
    expect(await gifBackdrop(await walkGif(320, 256, 8, true))).toBe(1);
  });

  it('plays a walk GIF of eight frames at twice the frame rate, steadied like a painted walk', async () => {
    const painting = await figures(100, 200, 1, 1, 0.9);
    const idle = (['S', 'SW', 'W', 'NW', 'N'] as const).map((view) => ({ view, png: painting, perPainting: 1 }));
    const S = await figures(4 * 200, 3 * 288, 4, 3);
    // The GIF's figure came back a fifth taller than the painting's (perPainting 1 says they should match).
    const gif = await gifSheet(await walkGif(200, 240, 8, false, 0.9));
    expect(gif.frames).toBe(8);
    const r = await assemble('walks', 'spr.png', 200, idle, [
      { png: S, view: 'S', rows: ['move', 'attack', 'hit'], perPainting: 1 },
      { png: gif.png, view: 'S', rows: ['move'], frames: gif.frames, perPainting: 1 },
    ]);
    expect(r.anim.clips.walk).toMatchObject({ frames: 8, fps: 12, loop: true });
    expect(r.anim.clips.attack).toMatchObject({ frames: 4, fps: 8 });
    // Given the standing figure's height, as a painted walk is.
    const s = ANIM_DIRS.indexOf('S');
    expect(r.anim.clips.walk!.rows[s]![2] / r.anim.clips.idle!.rows[s]![2]).toBeCloseTo(1, 1);
  });
});

/**
 * A walk GIF (`w` × `h` frames): a brown figure standing on 92% of the frame's height, `fh` of it tall, one leg
 * swinging; with `backdrop`, on a solid pale ground.
 */
async function walkGif(w: number, h: number, frames: number, backdrop = false, fh = 0.6): Promise<Buffer> {
  const pngs = await Promise.all(Array.from({ length: frames }, (_, f) => {
    const top = Math.round(h * (0.92 - fh)), body = Math.round(h * fh * 0.7), leg = Math.round(h * fh) - body;
    const x = Math.round(w / 2 + w * 0.08 * Math.sin((2 * Math.PI * f) / frames));
    const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">${backdrop ? `<rect width="${w}" height="${h}" fill="#e8e8ec"/>` : ''}<rect x="${Math.round(w * 0.4)}" y="${top}" width="${Math.round(w * 0.2)}" height="${body}" fill="#783c1e"/><rect x="${x - 6}" y="${top + body}" width="12" height="${leg}" fill="#783c1e"/><rect x="${Math.round(w / 2 - 6)}" y="${top + body}" width="12" height="${leg}" fill="#5a2a14"/></svg>`;
    return sharp(Buffer.from(svg)).png().toBuffer();
  }));
  return sharp(pngs, { join: { animated: true } }).gif({ loop: 0, delay: Array(frames).fill(120) }).toBuffer();
}

describe('the animation job', () => {
  const answered: string[] = [];
  /** Every request a batch carried, and each batch's models. */
  const bodies = new Map<string, Record<string, unknown>>();
  const batchModels: string[][] = [];
  /** Frames the mock paints in a walk GIF (the job asks for eight). */
  let gifFrames = 8;
  let server: http.Server;
  let port = 0;
  let dir = '';
  /** The test's genai config: GPT Image 2.5 for the sheets, and with `walks` GPT Image 2.6 for the walk GIFs. */
  const configure = (walks: boolean) => {
    fs.writeFileSync(path.join(dir, 'genai.json'), JSON.stringify({
      providers: {
        luna: { type: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'test', pricing: { inputPerM: 0, outputPerM: 0 } },
        gpt: { type: 'openai-image', baseUrl: `http://127.0.0.1:${port}/v1`, apiKey: 'test', model: 'gpt-image-2.5-flare' },
      },
      purposes: { 'image.prompt': { provider: 'luna', retries: 0 }, 'image.animation': { provider: 'gpt' }, ...(walks ? { 'image.walk': { provider: 'gpt', model: 'gpt-image-2.6-sunburst' } } : {}) },
    }));
    process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'genai.json');
    reloadGenAI();
  };
  const before = process.env.DAYDREAM_GENAI_CONFIG;
  const usage = { input_tokens: 100, input_tokens_details: { image_tokens: 80, text_tokens: 20 }, output_tokens: 50 };

  beforeAll(async () => {
    // A mock of OpenAI: the Responses API for the brief, the Files and Batch APIs for the pictures. A batch is done
    // as soon as it is made; its answers have a figure in every cell of the grid its request asked for, or for a GIF
    // a figure walking in every frame.
    const files = new Map<string, string>();
    let n = 0;
    server = http.createServer((req, res) => {
      const parts: Buffer[] = [];
      req.on('data', (d) => parts.push(d));
      req.on('end', async () => {
        const body = Buffer.concat(parts);
        const json = (o: unknown) => (res.setHeader('content-type', 'application/json'), res.end(JSON.stringify(o)));
        const url = req.url ?? '';
        if (url.endsWith('/responses')) {
          const brief = { body: 'a test beast on four legs', locomotion: 'walks', move: 'step; step; step; step', attack: 'rear; strike; bite; recover', hit: 'jolt; stagger; low; up', death: 'sway; fall; slump; still' };
          const response = { status: 'completed', output_text: JSON.stringify(brief), usage: { input_tokens: 10, output_tokens: 10 } };
          if (!JSON.parse(body.toString()).stream) return json(response);
          // Streamed as OpenAI streams it: the text as a delta, then the whole response.
          res.setHeader('content-type', 'text/event-stream');
          res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: response.output_text })}\n\n`);
          return res.end(`data: ${JSON.stringify({ type: 'response.completed', response })}\n\n`);
        }
        if (url.endsWith('/files') && req.method === 'POST') {
          const text = body.toString('utf8');
          const jsonl = text.slice(text.indexOf('{"custom_id"'), text.lastIndexOf('}') + 1);
          const id = `file_${++n}`;
          files.set(id, jsonl);
          return json({ id });
        }
        if (url.endsWith('/batches') && req.method === 'POST') {
          const { input_file_id } = JSON.parse(body.toString());
          const lines = files.get(input_file_id)!.split('\n').filter(Boolean).map((l) => JSON.parse(l) as { custom_id: string; body: { size: string; model: string; output_format?: string } });
          batchModels.push([...new Set(lines.map((l) => l.body.model))]);
          const out = await Promise.all(lines.map(async (l) => {
            const [w, h] = l.body.size.split('x').map(Number) as [number, number];
            const part = l.custom_id.split('|')[1]!;
            answered.push(l.custom_id);
            bodies.set(l.custom_id, l.body);
            const [cols, rows] = part === 'turn' ? [3, 2] : part === 'SW' || part === 'NW' ? [2, 2] : part === 'W' ? [4, 4] : [4, 3];
            const image = l.body.output_format === 'gif' ? await walkGif(w, h, gifFrames) : await figures(w, h, cols, rows);
            return JSON.stringify({ custom_id: l.custom_id, response: { status_code: 200, body: { model: l.body.model, data: [{ b64_json: image.toString('base64') }], usage } } });
          }));
          const outId = `file_${++n}`;
          files.set(outId, out.join('\n'));
          return json({ id: `batch_${outId}`, status: 'validating', output: outId });
        }
        const b = /\/batches\/batch_(file_\d+)$/.exec(url);
        if (b) return json({ id: `batch_${b[1]}`, status: 'completed', output_file_id: b[1] });
        const c = /\/files\/(file_\d+)\/content$/.exec(url);
        if (c) return void res.end(files.get(c[1]!) ?? '');
        res.statusCode = 404;
        res.end('{}');
      });
    });
    await new Promise<void>((r) => server.listen(0, () => r()));
    port = (server.address() as { port: number }).port;
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-anim-'));
    configure(false);
  });
  afterAll(() => {
    server.close();
    setSpendLedger(null);
    if (before === undefined) delete process.env.DAYDREAM_GENAI_CONFIG;
    else process.env.DAYDREAM_GENAI_CONFIG = before;
    reloadGenAI();
  });

  it('paints an actor asked for by name through batches, at the Batch price, and assembles it', async () => {
    const id = `w_animjob_${Date.now().toString(36)}`;
    const key = 'spr_mon_f0_beast';
    const w = {
      id, ownerId: 'u_owner', ownerName: 'Owner', status: 'ready', public: false, createdAt: Date.now(), updatedAt: Date.now(), input: {}, npcs: [], zones: [], families: [], concept: { title: 'Test', artStyle: 'painted' },
      assets: { [key]: sprite(key, 'A test beast, Testy, hostile creature', { view: 'side', file: 'beast.png' }) },
    } as unknown as WorldDefinition;
    fs.mkdirSync(worldAssetDir(id), { recursive: true });
    fs.writeFileSync(path.join(worldAssetDir(id), 'beast.png'), await figures(200, 120, 1, 1, 0.9));
    saveWorld(w);
    answered.length = 0;
    try {
      // A world built with animation waits for every actor; one built without it, until the actor is asked for.
      expect(animationState({ ...w, input: { ...w.input, animate: true } }, w.assets[key]!).state).toBe('waiting');
      expect(animationState(w, w.assets[key]!).state).toBe('off');
      markRequested(w, [key]);
      expect(animationState(w, w.assets[key]!).state).toBe('waiting');

      const charged: number[] = [];
      setSpendLedger({ record: (_u, usd) => charged.push(usd), refusal: () => null });
      const log: string[] = [];
      const job = { owner: { id: 'u_owner', name: 'Owner' }, cancelled: false, push: (m: string) => log.push(m) } as unknown as Job;
      const run = () => withCallContext({ priority: 'background', userId: 'u_owner' }, () => runAnimateJob(job, id, { queue: false }));
      // Run 1: the brief, then the turnaround and the painting's own view (W) go out.
      await run();
      expect(answered.sort()).toEqual([`${key}|W`, `${key}|turn`]);
      // Run 2: they come back; the other four views go out (from the turnaround).
      await run();
      expect(answered.length).toBe(6);
      // Run 3: they come back and the actor is assembled.
      await run();
      const done = loadWorld(id)!;
      const anim = done.assets[key]!.anim!;
      expect(anim.body).toBe('walks');
      expect(Object.keys(anim.clips).sort()).toEqual(['attack', 'die', 'hit', 'idle', 'walk']);
      expect(anim.clips.walk).toMatchObject({ frames: 4, fps: 6 });
      for (const c of Object.keys(anim.clips)) expect(fs.existsSync(path.join(worldAssetDir(id), done.assets[clipKey(key, c as never)]!.file!))).toBe(true);
      expect(animationState(done, done.assets[key]!).state).toBe('animated');
      // Six pictures at half the list price: 20 text tokens at $5, 80 image tokens at $8, 50 output tokens at $30 per million.
      const each = (20 * 5 + 80 * 8 + 50 * 30) / 1e6 / 2;
      expect(charged.filter((c) => c > 0)).toHaveLength(6);
      for (const c of charged.filter((x) => x > 0)) expect(c).toBeCloseTo(each, 8);
      // Nothing more to do.
      await run();
      expect(answered.length).toBe(6);
    } finally {
      // A world left half-written would trip every later test run (its folder is adopted at start).
      fs.rmSync(worldDir(id), { recursive: true, force: true });
    }
  });

  /** A world with one beast (or, with `key`, a townsperson) asked for by name, run through `runs` runs of the job. */
  async function animateBeast(runs: number, key = 'spr_mon_f0_beast') {
    const id = `w_animgif_${Date.now().toString(36)}`;
    const w = {
      id, ownerId: 'u_owner', ownerName: 'Owner', status: 'ready', public: false, createdAt: Date.now(), updatedAt: Date.now(), input: {}, npcs: [{ id: 'b' }], zones: [], families: [], concept: { title: 'Test', artStyle: 'painted' },
      assets: { [key]: sprite(key, 'A test beast, Testy, hostile creature', { view: 'side', file: 'beast.png' }) },
    } as unknown as WorldDefinition;
    fs.mkdirSync(worldAssetDir(id), { recursive: true });
    fs.writeFileSync(path.join(worldAssetDir(id), 'beast.png'), await figures(200, 120, 1, 1, 0.9));
    saveWorld(w);
    markRequested(w, [key]);
    const log: string[] = [];
    const job = { owner: { id: 'u_owner', name: 'Owner' }, cancelled: false, push: (m: string) => log.push(m) } as unknown as Job;
    for (let i = 0; i < runs; i++) await withCallContext({ priority: 'background', userId: 'u_owner' }, () => runAnimateJob(job, id, { queue: false }));
    return { id, key, log, world: loadWorld(id)! };
  }
  const partsOf = (key: string) => answered.filter((a) => a.startsWith(`${key}|`)).map((a) => a.split('|')[1]!).sort();

  it('paints the walk as GIFs with GPT Image 2.6 and the other clips as sheets, each model in its own batch', async () => {
    configure(true);
    answered.length = 0;
    batchModels.length = 0;
    const { id, key, world } = await animateBeast(3);
    try {
      // Sheets only where attack and hit are; a walk GIF for every painted view.
      expect(partsOf(key)).toEqual(['NW', 'SW', 'W', 'turn', 'walk_N', 'walk_NW', 'walk_S', 'walk_SW', 'walk_W']);
      for (const m of batchModels) expect(m).toHaveLength(1);
      expect(batchModels.flat()).toContain('gpt-image-2.6-sunburst');
      // A GIF request: eight frames 256 px tall, on a transparent background, moderated leniently.
      expect(bodies.get(`${key}|walk_S`)).toMatchObject({ model: 'gpt-image-2.6-sunburst', output_format: 'gif', frame_count: 8, background: 'transparent', moderation: 'low', quality: 'low' });
      expect(String(bodies.get(`${key}|walk_S`)!.size)).toMatch(/x256$/);
      const anim = world.assets[key]!.anim!;
      expect(Object.keys(anim.clips).sort()).toEqual(['attack', 'die', 'hit', 'idle', 'walk']);
      expect(anim.clips.walk).toMatchObject({ frames: 8, fps: 12, loop: true });
      expect(anim.clips.attack).toMatchObject({ frames: 4 });
      // The walk is the GIF's: the swinging leg makes its frames differ.
      const walk = fs.readFileSync(path.join(worldAssetDir(id), world.assets[clipKey(key, 'walk')]!.file!));
      const frames = await Promise.all(Array.from({ length: 8 }, async (_, f) => { const b = sheetFrame(anim.clips.walk!, f, ANIM_DIRS.indexOf('W')); return (await sharp(walk).extract({ left: b.sx, top: b.sy, width: b.w, height: b.h }).raw().toBuffer()).toString('base64'); }));
      expect(new Set(frames).size).toBeGreaterThan(1);
    } finally {
      fs.rmSync(worldDir(id), { recursive: true, force: true });
      configure(false);
    }
  });

  it('paints no clip sheet for a townsperson: the turnaround and the walk GIFs are all it needs', async () => {
    configure(true);
    answered.length = 0;
    const { id, key, world } = await animateBeast(3, 'spr_npc_b');
    try {
      expect(partsOf(key)).toEqual(['turn', 'walk_N', 'walk_NW', 'walk_S', 'walk_SW', 'walk_W']);
      expect(Object.keys(world.assets[key]!.anim!.clips).sort()).toEqual(['idle', 'walk']);
    } finally {
      fs.rmSync(worldDir(id), { recursive: true, force: true });
      configure(false);
    }
  });

  it('asks again for a walk GIF with too few frames, and fails the actor after three', async () => {
    configure(true);
    gifFrames = 4;
    answered.length = 0;
    const { id, key, log, world } = await animateBeast(5);
    try {
      expect(answered.filter((a) => a === `${key}|walk_W`)).toHaveLength(3);
      expect(log.some((l) => l.startsWith(`Could not animate ${key}: it painted 4 frames, not 8`))).toBe(true);
      expect(world.assets[key]!.anim).toBeUndefined();
      expect(JSON.parse(fs.readFileSync(path.join(worldDir(id), 'anim', key, 'state.json'), 'utf8')).error).toMatch(/^walk_\w+: it painted 4 frames/);
    } finally {
      gifFrames = 8;
      fs.rmSync(worldDir(id), { recursive: true, force: true });
      configure(false);
    }
  });
});

