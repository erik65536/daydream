import { afterEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { isTransient, loadGenAIConfig, reloadGenAI } from '../src/genai/service.ts';
import { GenAIError, NotConfigured } from '../src/genai/types.ts';

describe('model gateway', () => {
  const before = process.env.DAYDREAM_GENAI_CONFIG;
  afterEach(() => {
    process.env.DAYDREAM_GENAI_CONFIG = before;
    reloadGenAI();
  });

  it('retries only what a provider may recover from', () => {
    expect(isTransient(new TypeError('fetch failed'))).toBe(true);
    expect(isTransient(new Error('HTTP 429: rate limit exceeded'))).toBe(true);
    expect(isTransient(new Error('HTTP 503 Service Unavailable'))).toBe(true);
    expect(isTransient(new Error('HTTP 400: invalid request'))).toBe(false);
    expect(isTransient(new GenAIError('model not configured', false))).toBe(false);
    expect(isTransient(new NotConfigured('npc.decision'))).toBe(false);
    // A status where an error names it as one, not the same digits in an answer it quotes.
    expect(isTransient(new GenAIError('Transcription failed (503): overloaded'))).toBe(true);
    expect(isTransient(new GenAIError('ComfyUI error: ComfyUI view failed: 502'))).toBe(true);
    expect(isTransient(Object.assign(new Error('refused'), { status: 429 }))).toBe(true);
    expect(isTransient(new GenAIError('No text in response: {"id":"resp_0a5003","created_at":1763150429,"max_output_tokens":500}'))).toBe(false);
  });

  it('says plainly when a purpose has no model, and refuses provider types and purposes it does not have', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'daydream-cfg-'));
    process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'missing.json');
    const g = reloadGenAI();
    expect(g.configured('npc.decision')).toBe(false);
    expect(() => g.purpose('npc.decision')).toThrow(NotConfigured);
    fs.writeFileSync(path.join(dir, 'old.json'), JSON.stringify({ providers: { llm: { type: 'openai-chat', baseUrl: 'http://127.0.0.1:9931/v1' } }, purposes: {} }));
    process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'old.json');
    expect(() => loadGenAIConfig()).toThrow(/openai-chat/);
    // A purpose the game no longer has (the walk videos') is refused, not ignored.
    fs.writeFileSync(path.join(dir, 'gone.json'), JSON.stringify({ providers: {}, purposes: { 'video.walk': { provider: 'comfy' } } }));
    process.env.DAYDREAM_GENAI_CONFIG = path.join(dir, 'gone.json');
    expect(() => loadGenAIConfig()).toThrow(/no purpose "video.walk"/);
  });
});
