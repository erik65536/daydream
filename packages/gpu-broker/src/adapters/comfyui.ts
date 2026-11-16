/**
 * ComfyUI behind the broker. A queued prompt is sent to ComfyUI only when its turn comes, under the broker's own id
 * (ComfyUI takes a caller's prompt_id), so callers read its outcome from ComfyUI's /history as before. Unloading is
 * ComfyUI's /free, repeated until it has taken effect; canceling removes the prompt from ComfyUI's queue or interrupts
 * it.
 */
import { AdapterDown, type GpuAdapter, type RunContext } from '../scheduler.ts';

export interface ComfyWork {
  prompt: unknown;
  client_id?: string;
  extra_data?: Record<string, unknown>;
}

interface ComfyOptions {
  url: string;
  freeBetweenModels?: boolean;
  /** How often /history is read while a prompt runs. */
  pollMs?: number;
  /** How long ComfyUI may stop answering while a prompt runs (a big model loading) before it counts as down. */
  silentMs?: number;
  /** How long after a /free its effect is read (default 1 s). */
  freeSettleMs?: number;
}

/** ComfyUI refused the prompt (validation): kept so /history can answer with the error. */
class ComfyRejected extends Error {
  readonly body: unknown;
  constructor(message: string, body: unknown) {
    super(message);
    this.body = body;
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export class ComfyAdapter implements GpuAdapter<ComfyWork> {
  readonly name = 'comfyui';
  readonly url: string;
  readonly freeBetweenModels: boolean;
  private readonly pollMs: number;
  private readonly silentMs: number;
  private readonly freeSettleMs: number;

  constructor(o: ComfyOptions) {
    this.url = o.url.replace(/\/+$/, '');
    this.freeBetweenModels = o.freeBetweenModels ?? true;
    this.pollMs = o.pollMs ?? 500;
    this.silentMs = o.silentMs ?? 120_000;
    this.freeSettleMs = o.freeSettleMs ?? 1000;
  }

  private async call(path: string, init?: RequestInit & { timeoutMs?: number }): Promise<Response> {
    try {
      return await fetch(this.url + path, { ...init, signal: AbortSignal.timeout(init?.timeoutMs ?? 30_000) });
    } catch (e) {
      throw new AdapterDown(`ComfyUI at ${this.url}: ${(e as Error).message}`);
    }
  }

  private post(path: string, body: unknown) {
    return this.call(path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
  }

  async alive(): Promise<boolean> {
    try {
      return (await fetch(`${this.url}/system_stats`, { signal: AbortSignal.timeout(4000) })).ok;
    } catch {
      return false;
    }
  }

  /**
   * ComfyUI's /free only sets a flag for its worker, which reads it after each prompt and otherwise sleeps up to
   * 1000 s: one sent just after a prompt ends can sit unread, models and all. So it is sent again, a moment apart,
   * until a repeat frees nothing more (the GPU's free memory, as ComfyUI sees it).
   */
  async unload(): Promise<void> {
    let before = -1;
    for (let i = 0; i < 4; i++) {
      await this.post('/free', { unload_models: true, free_memory: true });
      await sleep(this.freeSettleMs);
      const free = await this.vramFree();
      if (free < 0 || (before >= 0 && free - before < 256 * 1024 * 1024)) return;
      if (before >= 0) console.log(`[broker] comfyui: /free took effect only when sent again (${((free - before) / 2 ** 30).toFixed(1)} GB more)`);
      before = free;
    }
  }

  /** The GPU's free memory in bytes, from ComfyUI (-1: not known). */
  private async vramFree(): Promise<number> {
    const stats = (await (await this.call('/system_stats', { timeoutMs: 5000 })).json().catch(() => ({}))) as { devices?: { vram_free?: number }[] };
    return stats.devices?.[0]?.vram_free ?? -1;
  }

  async run(work: ComfyWork, ctx: RunContext): Promise<unknown> {
    const res = await this.post('/prompt', { prompt: work.prompt, prompt_id: ctx.id, client_id: work.client_id, extra_data: work.extra_data ?? {} });
    const body = (await res.json().catch(() => ({}))) as Record<string, unknown>;
    if (!res.ok || body.prompt_id !== ctx.id) throw new ComfyRejected(`ComfyUI refused the prompt: ${JSON.stringify(body.error ?? body).slice(0, 600)}`, body);
    let quietSince = 0;
    for (;;) {
      if (ctx.signal.aborted) {
        await this.drop(ctx.id).catch(() => undefined);
        throw new Error('cancelled');
      }
      await sleep(this.pollMs);
      let entry: { status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string }][] } } | undefined;
      try {
        const h = await fetch(`${this.url}/history/${ctx.id}`, { signal: AbortSignal.timeout(15_000) });
        entry = ((await h.json()) as Record<string, typeof entry>)[ctx.id];
        quietSince = 0;
      } catch (e) {
        // ComfyUI can stop answering for a while under load; the prompt is still queued there.
        quietSince ||= Date.now();
        if (Date.now() - quietSince > this.silentMs) throw new AdapterDown(`ComfyUI stopped answering: ${(e as Error).message}`);
        continue;
      }
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find((m) => m[0] === 'execution_error' || m[0] === 'execution_interrupted');
        throw new Error(err?.[0] === 'execution_interrupted' ? 'interrupted' : String(err?.[1]?.exception_message ?? 'execution error').slice(0, 400));
      }
      if (entry.status?.completed) return undefined;
    }
  }

  /** Take our prompt off ComfyUI: removed while pending, interrupted while running. */
  private async drop(id: string) {
    const q = (await (await this.call('/queue', { timeoutMs: 5000 })).json()) as { queue_running?: unknown[][]; queue_pending?: unknown[][] };
    if ((q.queue_pending ?? []).some((p) => p[1] === id)) await this.post('/queue', { delete: [id] });
    else if ((q.queue_running ?? []).some((p) => p[1] === id)) await this.post('/interrupt', { prompt_id: id });
  }
}
