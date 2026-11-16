import http from 'node:http';
import type { GpuAdapter } from '../src/scheduler.ts';

/** A fake GPU program that keeps the GPU until its work is released, so a test can queue real work behind it. */
export const blocker: GpuAdapter<{ released: boolean }> = {
  name: 'blocker',
  alive: async () => true,
  unload: async () => {},
  run: async (work, ctx) => {
    while (!work.released && !ctx.signal.aborted) await new Promise((r) => setTimeout(r, 5));
  },
};

const GB = 2 ** 30;

/**
 * A fake ComfyUI: prompts finish one poll after they are queued, each with one saved image, and leave 9 GB of models
 * loaded on a 16 GB GPU. `gpu.lostFrees` makes that many /free calls go unread, as ComfyUI's worker sometimes does.
 */
export function fakeComfy() {
  const gpu = { used: 0, lostFrees: 0 };
  const history: Record<string, unknown> = {};
  const queued: { id: string; prompt: unknown; extra: unknown }[] = [];
  const calls: string[] = [];
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const c of req) chunks.push(c as Buffer);
    const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString() || '{}') : {};
    const send = (v: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(v));
    };
    calls.push(`${req.method} ${req.url}`);
    if (req.url === '/prompt') {
      queued.push({ id: body.prompt_id, prompt: body.prompt, extra: body.extra_data });
      gpu.used = 9 * GB;
      return send({ prompt_id: body.prompt_id, number: 1, node_errors: {} });
    }
    const h = /^\/history\/(.+)$/.exec(req.url ?? '');
    if (h) {
      const q = queued.find((x) => x.id === h[1]);
      if (q && !history[q.id]) {
        history[q.id] = { outputs: { '9': { images: [{ filename: 'out.png', subfolder: '', type: 'output' }] } }, status: { status_str: 'success', completed: true, messages: [] } };
        return send({});
      }
      return send(history[h[1]!] ? { [h[1]!]: history[h[1]!] } : {});
    }
    if (req.url === '/queue') return send({ queue_running: [], queue_pending: [] });
    if (req.url?.startsWith('/view')) {
      res.writeHead(200, { 'content-type': 'image/png' });
      // A download ComfyUI drops partway through.
      if (req.url.includes('cut.png')) return res.write(Buffer.alloc(64 * 1024), () => res.destroy());
      return res.end(Buffer.from('PNGDATA'));
    }
    if (req.url === '/free') {
      if (gpu.lostFrees > 0) gpu.lostFrees--;
      else gpu.used = 0;
      return send({});
    }
    if (req.url === '/system_stats') return send({ devices: [{ vram_total: 16 * GB, vram_free: 16 * GB - gpu.used }] });
    if (req.url === '/interrupt') return send({});
    res.writeHead(404);
    res.end();
  });
  return { server, calls, queued, gpu };
}

