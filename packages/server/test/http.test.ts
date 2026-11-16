/**
 * The gateway's HTTP: a kept-alive connection the server closes as a request arrives on it (its idle timer fired
 * just then). The fake server here closes every reused connection on the request's arrival, unanswered.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { Agent, fetch as undiciFetch } from 'undici';
import { connectionLost, sendRequest } from '../src/genai/http.ts';

let server: http.Server;
let url: string;
let connections = 0;

beforeAll(async () => {
  const served = new WeakSet<object>();
  server = http.createServer((req, res) => {
    if (served.has(req.socket)) return void req.socket.destroy();
    served.add(req.socket);
    req.resume();
    req.on('end', () => res.end('{"ok":true}'));
  });
  server.on('connection', () => connections++);
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  url = `http://127.0.0.1:${(server.address() as AddressInfo).port}/`;
});

afterAll(() => new Promise<void>((r) => server.close(() => r())));

/** A POST on a connection kept alive from a first one. */
async function onReusedConnection(send: (dispatcher: Agent) => Promise<Response>): Promise<Response> {
  const dispatcher = new Agent();
  try {
    await (await send(dispatcher)).text();
    await new Promise((r) => setTimeout(r, 20)); // the connection is back in the pool
    return await send(dispatcher);
  } finally {
    void dispatcher.close();
  }
}

const post = { method: 'POST', body: '{}' };

describe('a connection closed as a request arrives', () => {
  it('fails a plain POST (the race this guards against)', async () => {
    const err = await onReusedConnection((dispatcher) => undiciFetch(url, { ...post, dispatcher }) as unknown as Promise<Response>).catch((e) => e);
    expect(connectionLost(err)).toBe(true);
  });

  it('is sent again on a new connection', async () => {
    const before = connections;
    const res = await onReusedConnection((dispatcher) => sendRequest(url, { ...post, dispatcher }));
    expect(await res.json()).toEqual({ ok: true });
    expect(connections - before).toBe(2);
  });
});
