/**
 * The one ComfyUI client: where the GPU broker in front of ComfyUI is, its token, and queueing a workflow and
 * waiting for it. A prompt can wait for its turn: the broker says so in an X-Broker-State header, and that time
 * does not count against the deadline; the job is told it is waiting. A broker that restarted no longer knows a
 * prompt (404), which is then sent again. While an administrator pauses GPU work, it waits before it is sent. See
 * docs/gpu-broker.md.
 */
import crypto from 'node:crypto';
import { genai } from './service.ts';
import { callContext } from './context.ts';
import { resolveSecret } from './providers.ts';
import { sendRequest } from './http.ts';
import type { ProviderConfig } from './types.ts';
import { meterGpu } from './meter.ts';

/** The GPU's shared state (it lives in the database), loaded with the first prompt: text calls never need it. */
const presence = () => import('../gpu/presence.ts');

export interface ComfyTarget {
  base: string;
  headers: Record<string, string>;
}

interface ComfyImage {
  filename: string;
  subfolder?: string;
  type?: string;
}

interface ComfyEntry {
  outputs?: Record<string, Record<string, unknown> & { images?: ComfyImage[]; audio?: ComfyImage[] }>;
  status?: { status_str?: string; completed?: boolean; messages?: [string, { exception_message?: string; timestamp?: number }][] };
}

export class ComfyError extends Error {}

/** The configured ComfyUI provider (the first of type comfyui). */
export function comfyProvider(): [string, ProviderConfig] | undefined {
  return Object.entries(genai().config.providers).find(([, p]) => p.type === 'comfyui');
}

export function comfyTarget(cfg: ProviderConfig | undefined = comfyProvider()?.[1]): ComfyTarget {
  const base = (process.env.COMFY_URL ?? cfg?.baseUrl ?? 'http://127.0.0.1:8190').replace(/\/+$/, '');
  const token = resolveSecret(cfg?.apiKey);
  return { base, headers: token ? { authorization: `Bearer ${token}` } : {} };
}

export const comfyBase = () => comfyTarget().base;
export const comfyHeaders = () => comfyTarget().headers;

/** fetch against ComfyUI (or the broker), with its token. */
export function comfyFetch(path: string, init: RequestInit = {}, t: ComfyTarget = comfyTarget()): Promise<Response> {
  return sendRequest(t.base + path, { ...init, headers: { ...t.headers, ...(init.headers as Record<string, string> | undefined) } });
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** What a job is told while its prompt waits in the broker's queue (null: not waiting). */
export function waitReason(state: string): string | null {
  if (!state.startsWith('queued')) return null;
  const pos = Number(/position=(\d+)/.exec(state)?.[1] ?? 0);
  const down = /waiting=([^;]+)/.exec(state)?.[1];
  return `Waiting for the GPU${down ? `: ${down}` : pos > 1 ? ` (${pos - 1} ahead)` : pos === 1 ? ' (next)' : ''}`;
}

/** Take a prompt off: the broker removes it while queued or interrupts it while running. */
async function cancelPrompt(t: ComfyTarget, id: string) {
  await comfyFetch('/queue', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ delete: [id] }), signal: AbortSignal.timeout(10_000) }, t);
}

/** Wait while an administrator has paused this kind of work (players' own calls are never held). */
async function waitWhilePaused(): Promise<void> {
  const { pausedFor, promptTag } = await presence();
  const ctx = callContext();
  const tag = promptTag();
  for (let told = false; ; told = true) {
    const why = pausedFor(tag.rank ?? 2);
    if (!why) {
      if (told) ctx?.onWait?.(null);
      return;
    }
    if (ctx?.cancelled?.()) throw new ComfyError('cancelled');
    if (!told) ctx?.onWait?.(why);
    await sleep(1000);
  }
}

/**
 * Queue a workflow and wait for it to finish; returns its history entry. `workflow` names it for the admin page and
 * for the broker (work for the same name runs back to back without unloading). `timeoutMs` counts only time that
 * is not spent waiting in the broker's queue.
 */
export async function submitAndWait(prompt: unknown, opts: { workflow?: string; timeoutMs: number; pollMs?: number; target?: ComfyTarget }): Promise<ComfyEntry> {
  const t0 = Date.now();
  let queueMs = 0;
  try {
    const entry = await submitAndWait_(prompt, opts, (ms) => (queueMs += ms));
    meterGpu({ workflow: opts.workflow, gpuMs: gpuTime(entry) ?? Date.now() - t0 - queueMs, queueMs, wallMs: Date.now() - t0, ok: true, cold: coldStart(prompt, entry) });
    return entry;
  } catch (e) {
    meterGpu({ workflow: opts.workflow, gpuMs: Date.now() - t0 - queueMs, queueMs, wallMs: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 200) });
    throw e;
  }
}

/** How long ComfyUI ran a finished prompt, from its own start and finish timestamps (unknown without them). */
function gpuTime(entry: ComfyEntry): number | undefined {
  const at = (kind: string) => entry.status?.messages?.find((m) => m[0] === kind)?.[1]?.timestamp;
  const start = at('execution_start'), end = at('execution_success');
  return start && end && end >= start ? end - start : undefined;
}

/** Whether ComfyUI ran any of the prompt's model loaders (none cached from the prompt before: its model was loaded). */
function coldStart(prompt: unknown, entry: ComfyEntry): boolean {
  const cached = new Set((entry.status?.messages?.find((m) => m[0] === 'execution_cached')?.[1] as { nodes?: string[] } | undefined)?.nodes ?? []);
  return Object.entries(prompt as Record<string, { class_type?: string }>).some(([id, n]) => /Loader/.test(n.class_type ?? '') && !cached.has(id));
}

async function submitAndWait_(prompt: unknown, opts: { workflow?: string; timeoutMs: number; pollMs?: number; target?: ComfyTarget }, waited: (ms: number) => void): Promise<ComfyEntry> {
  const t = opts.target ?? comfyTarget();
  const ctx = callContext();
  const paused = Date.now();
  await waitWhilePaused();
  waited(Date.now() - paused);
  const { promptBody } = await presence();
  for (let attempt = 1; ; attempt++) {
    const res = await comfyFetch('/prompt', { method: 'POST', headers: { 'content-type': 'application/json' }, body: promptBody(prompt, opts.workflow, crypto.randomUUID()), signal: AbortSignal.timeout(30_000) }, t);
    const queued = (await res.json().catch(() => ({}))) as { prompt_id?: string };
    if (!queued.prompt_id) throw new ComfyError(`ComfyUI did not queue the prompt: ${JSON.stringify(queued).slice(0, 400)}`);
    const id = queued.prompt_id;
    let used = 0;
    let last = Date.now();
    let told: string | null = null;
    let forgotten = false;
    while (used < opts.timeoutMs) {
      await sleep(opts.pollMs ?? 600);
      if (ctx?.cancelled?.()) {
        await cancelPrompt(t, id).catch(() => undefined);
        throw new ComfyError('cancelled');
      }
      let state = '';
      let entry: ComfyEntry | undefined;
      try {
        const h = await comfyFetch(`/history/${id}`, { signal: AbortSignal.timeout(15_000) }, t);
        if (h.status === 404) {
          forgotten = true;
          break;
        }
        state = h.headers.get('x-broker-state') ?? '';
        entry = ((await h.json()) as Record<string, ComfyEntry>)[id];
      } catch {
        // ComfyUI can stop answering for a while under load (a big model loading); the prompt is still queued.
      }
      const now = Date.now();
      const waiting = state.startsWith('queued');
      if (!waiting) used += now - last;
      else waited(now - last);
      last = now;
      const why = waitReason(state);
      if (why !== told) {
        told = why;
        ctx?.onWait?.(why);
      }
      if (!entry) continue;
      if (entry.status?.status_str === 'error') {
        const err = entry.status.messages?.find((m) => m[0] === 'execution_error' || m[0] === 'execution_interrupted');
        throw new ComfyError(err?.[0] === 'execution_interrupted' ? 'interrupted' : String(err?.[1]?.exception_message ?? 'execution error').slice(0, 400));
      }
      if (entry.status?.completed) return entry;
    }
    if (told) ctx?.onWait?.(null);
    if (!forgotten) {
      // Nobody waits for it any more: off the GPU, so a retry does not queue behind it.
      await cancelPrompt(t, id).catch(() => undefined);
      throw new ComfyError('timed out');
    }
    if (attempt >= 3) throw new ComfyError('the GPU broker keeps forgetting this prompt (restarting?)');
  }
}

/** Upload a picture for a workflow's LoadImage (named by its content, so the same picture is stored once). */
export async function uploadImage(png: Buffer, t: ComfyTarget = comfyTarget()): Promise<string> {
  const name = `daydream_${crypto.createHash('sha1').update(png).digest('hex').slice(0, 16)}.png`;
  const form = new FormData();
  form.append('image', new Blob([new Uint8Array(png)], { type: 'image/png' }), name);
  form.append('subfolder', 'daydream_refs');
  form.append('overwrite', 'true');
  const res = await comfyFetch('/upload/image', { method: 'POST', body: form }, t);
  if (!res.ok) throw new ComfyError(`ComfyUI upload failed: ${res.status}`);
  const out = (await res.json()) as { name: string; subfolder?: string };
  return out.subfolder ? `${out.subfolder}/${out.name}` : out.name;
}

/** Every image a finished prompt saved, in node order. */
export function savedImages(entry: ComfyEntry): ComfyImage[] {
  return Object.values(entry.outputs ?? {}).flatMap((o) => o.images ?? []);
}

/** Every audio file a finished prompt saved, in node order (downloaded like an image, with `viewImage`). */
export function savedAudio(entry: ComfyEntry): ComfyImage[] {
  return Object.values(entry.outputs ?? {}).flatMap((o) => o.audio ?? []);
}

/** Download one saved file: an image, or audio. */
export async function viewImage(img: ComfyImage, t: ComfyTarget = comfyTarget()): Promise<Buffer> {
  const q = new URLSearchParams({ filename: img.filename, subfolder: img.subfolder ?? '', type: img.type ?? 'output' });
  const res = await comfyFetch(`/view?${q}`, {}, t);
  if (!res.ok) throw new ComfyError(`ComfyUI view failed: ${res.status}`);
  return Buffer.from(await res.arrayBuffer());
}
