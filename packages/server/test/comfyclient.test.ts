import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { Broker } from '../../gpu-broker/src/scheduler.ts';
import { ComfyAdapter } from '../../gpu-broker/src/adapters/comfyui.ts';
import { createFront } from '../../gpu-broker/src/http.ts';
import { blocker, fakeComfy } from '../../gpu-broker/test/fakecomfy.ts';
import { savedImages, submitAndWait, waitReason, type ComfyTarget } from '../src/genai/comfyclient.ts';
import { withCallContext } from '../src/genai/context.ts';

const listen = (s: http.Server) => new Promise<string>((r) => s.listen(0, '127.0.0.1', () => r(`http://127.0.0.1:${(s.address() as AddressInfo).port}`)));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe('ComfyUI client behind the GPU broker', () => {
  const comfy = fakeComfy();
  let front: http.Server;
  let broker: Broker;
  let target: ComfyTarget;
  beforeAll(async () => {
    const adapter = new ComfyAdapter({ url: await listen(comfy.server), pollMs: 10 });
    broker = new Broker({ comfyui: adapter, blocker }, { graceMs: 0, log: () => {} });
    front = createFront(broker, adapter, { clients: { prod: 'tok' } });
    target = { base: await listen(front), headers: { authorization: 'Bearer tok' } };
  });
  afterAll(() => {
    broker.stop();
    front.close();
    comfy.server.close();
  });

  it('does not count time waiting for its turn, and tells the job why it waits', async () => {
    const hold = broker.submit('blocker', { released: false }, { client: 'dev', rank: 0 });
    await sleep(30);
    const waits: (string | null)[] = [];
    const done = withCallContext({ priority: 'background', onWait: (w) => waits.push(w) }, () => submitAndWait({ '1': { class_type: 'X', inputs: {} } }, { workflow: 'krea', timeoutMs: 150, pollMs: 20, target }));
    await sleep(400);
    (hold.work as { released: boolean }).released = true;
    const entry = await done;
    expect(savedImages(entry).map((i) => i.filename)).toEqual(['out.png']);
    expect(waits[0]).toBe('Waiting for the GPU (next)');
    expect(waits.at(-1)).toBeNull();
    const sent = comfy.queued.at(-1)!;
    expect((sent.extra as { daydream: { workflow: string; rank: number } }).daydream).toMatchObject({ workflow: 'krea', rank: 2 });
  });

  it('takes a prompt that ran out of time off the GPU, so nothing works on what nobody waits for', async () => {
    // A broker whose prompt never finishes.
    const calls: { method: string; url: string; body: string }[] = [];
    const stuck = http.createServer((req, res) => {
      let body = '';
      req.on('data', (c) => (body += c));
      req.on('end', () => {
        calls.push({ method: req.method!, url: req.url!, body });
        res.setHeader('content-type', 'application/json');
        if (req.url === '/prompt') return void res.end(JSON.stringify({ prompt_id: 'p_stuck' }));
        if (req.url?.startsWith('/history/')) return void res.setHeader('x-broker-state', 'running').end('{}');
        res.end('{}');
      });
    });
    const base = await listen(stuck);
    try {
      await expect(submitAndWait({ '1': { class_type: 'X', inputs: {} } }, { timeoutMs: 80, pollMs: 20, target: { base, headers: {} } })).rejects.toThrow('timed out');
      const removed = calls.filter((c) => c.method === 'POST' && c.url === '/queue');
      expect(removed).toHaveLength(1);
      expect(JSON.parse(removed[0]!.body)).toEqual({ delete: ['p_stuck'] });
    } finally {
      stuck.close();
    }
  });

  it('describes queue positions and a program that does not answer', () => {
    expect(waitReason('running')).toBeNull();
    expect(waitReason('queued; position=3')).toBe('Waiting for the GPU (2 ahead)');
    expect(waitReason('queued; position=1; waiting=comfyui not answering')).toBe('Waiting for the GPU: comfyui not answering');
  });
});
