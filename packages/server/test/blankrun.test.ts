import { describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { OpenAIResponsesProvider } from '../src/genai/providers.ts';
import { GenAIError } from '../src/genai/types.ts';

/** A Responses API that streams `deltas` as server-sent events, then completes (if the client is still there). */
async function fakeServer(deltas: string[]) {
  let sent = 0;
  const server = http.createServer((req, res) => {
    req.resume();
    req.on('end', async () => {
      res.writeHead(200, { 'content-type': 'text/event-stream' });
      for (const d of deltas) {
        if (res.destroyed) return;
        res.write(`data: ${JSON.stringify({ type: 'response.output_text.delta', delta: d })}\n\n`);
        sent++;
        await new Promise((r) => setImmediate(r));
      }
      const text = deltas.join('');
      res.end(`data: ${JSON.stringify({ type: 'response.completed', response: { status: 'completed', output_text: text, usage: { input_tokens: 1, output_tokens: deltas.length } } })}\n\n`);
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  const port = (server.address() as AddressInfo).port;
  const provider = new OpenAIResponsesProvider({ type: 'openai-responses', baseUrl: `http://127.0.0.1:${port}/v1`, model: 'mock', apiKey: 'test', pricing: { inputPerM: 0, outputPerM: 0 } } as never);
  return { provider, sent: () => sent, close: () => new Promise((r) => server.close(r)) };
}

const ask = (p: OpenAIResponsesProvider) => p.structured({ messages: [{ role: 'user', content: 'Name five qualities.' }], schema: { type: 'object', properties: { a: { type: 'string' } } }, schemaName: 'q' } as never);

describe('a structured answer that writes only blank space', () => {
  it('is stopped long before its token limit, with what it wrote', async () => {
    const s = await fakeServer(['{"a":', '"x"', ...Array.from({ length: 5000 }, () => '  ')]);
    try {
      const err = await ask(s.provider).catch((e) => e);
      expect(err).toBeInstanceOf(GenAIError);
      expect(err.message).toMatch(/blank space/);
      expect(err.retryable).toBe(false);
      expect(err.partial.startsWith('{"a":"x"')).toBe(true);
      expect(s.sent()).toBeLessThan(400);
    } finally {
      await s.close();
    }
  });

  it('is not stopped for ordinary spacing between tokens', async () => {
    const s = await fakeServer(['{\n  ', '"a": ', '"x"', '\n', '}']);
    try {
      expect(await ask(s.provider)).toBe('{\n  "a": "x"\n}');
    } finally {
      await s.close();
    }
  });
});
