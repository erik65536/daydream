/** Concrete GenAI provider adapters. */
import { chargeUsage, costOf } from './spend.ts';
import { FormData as UFormData } from 'undici';
import sharp from 'sharp';
import fs from 'node:fs';
import path from 'node:path';
import { GenAIError, type DecisionAnswer, type DecisionProvider, type DecisionRequest, type ImageEditRequest, type ImageProvider, type ImageRequest, type ProviderConfig, type StructuredRequest, type TextProvider, type TextRequest } from './types.ts';
import { ROOT_DIR } from '../paths.ts';
import { strictSchema } from './json.ts';
import { patientAgent, sendRequest } from './http.ts';
import { ComfyError, comfyTarget, savedImages, submitAndWait, viewImage } from './comfyclient.ts';

/**
 * A key from the config: "env:NAME" reads an environment variable (.env in development); "credential:NAME" reads a
 * systemd credential (LoadCredentialEncrypted=NAME), a file only this service can read and that, unlike the
 * environment, child processes (the animator's Python, Chromium) do not inherit. Anything else is the key itself.
 */
export function resolveSecret(v?: string): string | undefined {
  if (!v) return undefined;
  if (v.startsWith('env:')) return process.env[v.slice(4)] || undefined;
  if (v.startsWith('credential:')) {
    const name = v.slice(11);
    const dir = process.env.CREDENTIALS_DIRECTORY;
    if (!dir || !/^[\w.-]+$/.test(name)) return undefined;
    try {
      return fs.readFileSync(path.join(dir, name), 'utf8').trim() || undefined;
    } catch {
      return undefined;
    }
  }
  return v;
}

async function httpJson(url: string, init: RequestInit & { timeoutMs?: number }): Promise<any> {
  let res: Response;
  try {
    res = await sendRequest(url, { ...init, dispatcher: patientAgent, signal: AbortSignal.timeout(init.timeoutMs ?? 180_000) });
  } catch (e) {
    throw new GenAIError(`Request to ${url} failed: ${(e as Error).message}`);
  }
  const text = await res.text();
  if (!res.ok) {
    const retryable = res.status === 429 || res.status >= 500;
    throw new GenAIError(`HTTP ${res.status} from ${url}: ${text.slice(0, 600)}`, retryable);
  }
  try {
    return JSON.parse(text);
  } catch {
    throw new GenAIError(`Non-JSON response from ${url}: ${text.slice(0, 300)}`);
  }
}

const trimSlash = (s: string) => s.replace(/\/+$/, '');

/**
 * Blank space a structured answer may write in a row before it is stopped. Strict decoding keeps every token valid
 * JSON but cannot make a model finish: one the schema has cornered (a list of exactly five after writing four) can
 * only go on with blank space, which is valid between tokens, and does so to its token limit.
 */
const MAX_BLANK_RUN = 400;

/** Why a streamed call stopped itself early, with what it had written and roughly how many tokens that took. */
class StoppedEarly extends Error {
  readonly text: string;
  readonly deltas: number;
  constructor(message: string, text: string, deltas: number) {
    super(message);
    this.text = text;
    this.deltas = deltas;
  }
}

/**
 * A streamed Responses API call (server-sent events): `onText` gets the output text so far at every delta; resolves
 * to the final response object, as a call without streaming returns it. A failure after text was `shown` is final
 * (not retried), since the words may already be on someone's screen. With `blankLimit` a run of that much blank
 * space stops the call (StoppedEarly).
 */
async function streamResponse(url: string, init: RequestInit & { timeoutMs?: number }, onText: (soFar: string) => void, opts: { shown: boolean; blankLimit?: number }): Promise<any> {
  const stop = new AbortController();
  let res: Response;
  try {
    res = await sendRequest(url, { ...init, dispatcher: patientAgent, signal: AbortSignal.any([stop.signal, AbortSignal.timeout(init.timeoutMs ?? 180_000)]) });
  } catch (e) {
    throw new GenAIError(`Request to ${url} failed: ${(e as Error).message}`);
  }
  if (!res.ok || !res.body) {
    const text = await res.text();
    throw new GenAIError(`HTTP ${res.status} from ${url}: ${text.slice(0, 600)}`, res.status === 429 || res.status >= 500);
  }
  let text = '';
  let buf = '';
  let final: any = null;
  let deltas = 0;
  let blank = 0;
  const retryable = () => !opts.shown || !text;
  const decoder = new TextDecoder();
  try {
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      buf += decoder.decode(chunk, { stream: true });
      let end: number;
      while ((end = buf.indexOf('\n\n')) >= 0) {
        const block = buf.slice(0, end);
        buf = buf.slice(end + 2);
        const data = block.split('\n').filter((l) => l.startsWith('data:')).map((l) => l.slice(5).trimStart()).join('\n');
        if (!data || data === '[DONE]') continue;
        const ev = JSON.parse(data);
        if (ev.type === 'response.output_text.delta' && typeof ev.delta === 'string') {
          text += ev.delta;
          deltas++;
          const tail = ev.delta.length - ev.delta.trimEnd().length;
          blank = tail === ev.delta.length ? blank + tail : tail;
          if (opts.blankLimit && blank >= opts.blankLimit) {
            stop.abort();
            throw new StoppedEarly(`Stopped after ${blank} characters of blank space in a row (the schema likely left the model no way to finish)`, text, deltas);
          }
          onText(text);
        } else if (ev.type === 'response.completed' || ev.type === 'response.incomplete') final = ev.response;
        else if (ev.type === 'response.failed' || ev.type === 'error') throw new GenAIError(`Streamed response failed: ${JSON.stringify(ev.response?.error ?? ev.error ?? ev).slice(0, 400)}`, retryable());
      }
    }
  } catch (e) {
    if (e instanceof GenAIError || e instanceof StoppedEarly) throw e;
    throw new GenAIError(`Stream from ${url} broke: ${(e as Error).message}`, retryable());
  }
  if (!final) throw new GenAIError(`Stream from ${url} ended without a response`, retryable());
  return final.output_text === undefined && text ? { ...final, output_text: text } : final;
}

// ---------------------------------------------------------------------------- OpenAI Responses API

/** Tokens used on OpenAI this process (for cost reports in tools and logs). */
export const openaiUsage = { calls: 0, input: 0, cached: 0, output: 0, reasoning: 0, decisionCalls: 0, decisionInput: 0 };

/** Rough spend in dollars at gpt-6-luna prices (flex halves text). */
export function openaiCost(flex = true): number {
  const k = flex ? 0.5 : 1;
  return k * ((openaiUsage.input - openaiUsage.cached) * 0.1 + openaiUsage.cached * 0.01 + openaiUsage.output * 0.5) / 1e6 + (openaiUsage.decisionInput * 0.1) / 1e6;
}

export class OpenAIResponsesProvider implements TextProvider {
  private cfg: ProviderConfig;
  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
  }

  /**
   * One request. With `onText` the answer is streamed: `onText` gets the text so far at every delta. Once any of it
   * has been handed out a failure is final (not retried), since the words may already be on someone's screen.
   */
  private async call(req: TextRequest, model: string | undefined, format: unknown, extra?: Record<string, unknown>, onText?: (soFar: string) => void): Promise<string> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const body = this.body(req, model, format, extra);
    const url = `${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/responses`;
    const init = { method: 'POST', headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) }, timeoutMs: this.cfg.timeoutMs };
    const charge = (u: { input?: number; cached?: number; output?: number; reasoning?: number }, tier = body.service_tier) => {
      chargeUsage(this.cfg, { ...u, flex: tier === undefined ? undefined : tier === 'flex' }, String(body.model));
      openaiUsage.calls++;
      openaiUsage.input += u.input ?? 0;
      openaiUsage.cached += u.cached ?? 0;
      openaiUsage.output += u.output ?? 0;
      openaiUsage.reasoning += u.reasoning ?? 0;
    };
    // Structured answers are streamed even when nobody reads them as they come, so blank space can stop them.
    let data: any;
    try {
      data = onText || format ? await streamResponse(url, { ...init, body: JSON.stringify({ ...body, stream: true }) }, onText ?? (() => {}), { shown: !!onText, blankLimit: format ? MAX_BLANK_RUN : undefined }) : await httpJson(url, { ...init, body: JSON.stringify(body) });
    } catch (e) {
      if (!(e instanceof StoppedEarly)) throw e;
      // A stopped call reports no usage: about one token a delta, and the request's characters over four.
      charge({ input: Math.round(JSON.stringify(body).length / 4), output: e.deltas });
      throw new GenAIError(e.message, false, e.text);
    }
    const u = data.usage;
    // Priced at the tier that served it, which the answer names.
    if (u) charge({ input: u.input_tokens, cached: u.input_tokens_details?.cached_tokens, output: u.output_tokens, reasoning: u.output_tokens_details?.reasoning_tokens }, data.service_tier ?? body.service_tier);
    const parts: string[] = [];
    for (const o of data.output ?? []) if (o.type === 'message') for (const c of o.content ?? []) if (c.type === 'output_text') parts.push(c.text);
    if (data.status === 'incomplete') throw new GenAIError(`Response incomplete (${data.incomplete_details?.reason ?? 'unknown'}); raise maxTokens or reasoningTokens`, false, data.output_text ?? parts.join(''));
    if (typeof data.output_text === 'string') return data.output_text;
    if (!parts.length) throw new GenAIError(`No text in response: ${JSON.stringify(data).slice(0, 300)}`);
    return parts.join('');
  }

  /** The request body as sent to /responses (credentials go in the headers, not here). */
  private body(req: TextRequest, model: string | undefined, format: unknown, extra?: Record<string, unknown>): Record<string, unknown> {
    const input = req.messages.map((m, i) => {
      const isLastUser = i === req.messages.length - 1 && m.role === 'user';
      if (isLastUser && req.images?.length)
        return { role: 'user', content: [{ type: 'input_text', text: m.content }, ...req.images.map((b) => ({ type: 'input_image', image_url: `data:image/png;base64,${b.toString('base64')}` }))] };
      return { role: m.role, content: m.content };
    });
    const body: Record<string, unknown> = { model: model ?? this.cfg.model, instructions: req.system, input, max_output_tokens: req.maxTokens ? req.maxTokens + (this.cfg.reasoningTokens ?? 0) : undefined, ...(this.cfg.serviceTier ? { service_tier: this.cfg.serviceTier } : {}), ...(this.cfg.extraBody ?? {}), ...extra };
    // Reasoning models take no sampling temperature.
    if (req.temperature !== undefined && !/^(o\d|gpt-[5-9])/.test(String(body.model))) body.temperature = req.temperature;
    if (format) body.text = { format };
    return body;
  }

  text(req: TextRequest, model?: string, extra?: Record<string, unknown>, onText?: (soFar: string) => void) {
    return this.call(req, model, undefined, extra, onText);
  }

  /** Strict structured outputs: the schema is enforced while decoding (see strictSchema for what that covers). */
  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>, onText?: (soFar: string) => void) {
    return this.call(req, model, structuredFormat(req), extra, onText);
  }

  structuredBody(req: StructuredRequest, model?: string, extra?: Record<string, unknown>) {
    return this.body(req, model, structuredFormat(req), extra);
  }
}

/** A structured answer's format: the schema in strict mode, enforced while decoding (see strictSchema). */
function structuredFormat(req: StructuredRequest) {
  return { type: 'json_schema', name: req.schemaName, schema: strictSchema(req.schema as never), strict: true };
}

// ---------------------------------------------------------------------------- OpenAI images

/** Images and dollars spent on OpenAI's image models this process (for cost reports and the caps of tools). */
export const openaiImageUsage = { calls: 0, textInput: 0, imageInput: 0, output: 0, usd: 0 };

/**
 * The nearest size GPT Image 2, 2.5 and 2.6 paint: both sides multiples of 16, neither over 3840 px, at most 3:1,
 * and between 655,360 and 8,294,400 pixels (sizes over 2560 × 1440 are experimental). The aspect ratio is kept.
 * A GIF's frames are exempt from the minimum (they share one painted sheet): their sides are only snapped to 16.
 */
export function gptImageSize(width: number, height: number): { width: number; height: number } {
  const r = Math.max(1 / 3, Math.min(3, width / height));
  const px = Math.max(655_360, Math.min(8_294_400, width * height));
  let w = Math.sqrt(px * r), h = w / r;
  const k = Math.min(1, 3840 / Math.max(w, h));
  w *= k;
  h *= k;
  const snap = (v: number) => Math.max(16, Math.round(v / 16) * 16);
  let W = snap(w), H = snap(h);
  // Rounding may leave the area a little under the minimum or over the maximum.
  while (W * H < 655_360) W * r >= H ? (H += 16) : (W += 16);
  while (W * H > 8_294_400) W >= H ? (W -= 16) : (H -= 16);
  return { width: W, height: H };
}

/**
 * OpenAI's image models through the Images API (POST /v1/images/generations and /images/edits): stateless, one
 * picture per call, billed by token (image input, text input, and image output apart; see GPT_IMAGE_PRICES).
 */
export class OpenAIImageProvider implements ImageProvider {
  private cfg: ProviderConfig;
  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
  }

  private get url() {
    return trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1');
  }

  private headers(): Record<string, string> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    return { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) };
  }

  /** The picture of an answer, and its tokens charged (at half price when it came through the Batch API). */
  take(data: any, model: string, batch = false, charge = true): Buffer {
    const u = data?.usage;
    if (u && charge) {
      const d = u.input_tokens_details ?? {};
      const image = d.image_tokens ?? 0;
      const text = d.text_tokens ?? Math.max(0, (u.input_tokens ?? 0) - image);
      const usage = { input: text, imageInput: image, output: u.output_tokens ?? 0, batch, images: 1 };
      chargeUsage(this.cfg, usage, model);
      openaiImageUsage.calls++;
      openaiImageUsage.textInput += text;
      openaiImageUsage.imageInput += image;
      openaiImageUsage.output += usage.output;
      openaiImageUsage.usd += costOf(this.cfg, usage, model);
    }
    const b64 = data?.data?.[0]?.b64_json;
    if (typeof b64 !== 'string') throw new GenAIError(`No image in answer: ${JSON.stringify(data).slice(0, 300)}`, false);
    return Buffer.from(b64, 'base64');
  }

  /** A painting's request body, as the Images API and the Batch API take it. */
  generateBody(req: ImageRequest, model?: string): Record<string, unknown> {
    const { width, height } = gptImageSize(req.width, req.height);
    return {
      model: model ?? this.cfg.model ?? 'gpt-image-2.5-flare',
      prompt: req.prompt,
      size: `${width}x${height}`,
      quality: req.quality ?? this.cfg.quality ?? 'medium',
      n: 1,
      ...(req.transparent ? { background: 'transparent', output_format: 'png' } : {}),
      ...(this.cfg.extraBody ?? {}),
    };
  }

  async generate(req: ImageRequest, model?: string): Promise<Buffer> {
    const body = this.generateBody(req, model);
    const data = await httpJson(`${this.url}/images/generations`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...this.headers() },
      body: JSON.stringify(body),
      timeoutMs: this.cfg.timeoutMs ?? 600_000,
    });
    return this.take(data, String(body.model));
  }

  /** An edit's settings (everything but its pictures), as both the form and the JSON body of the Images API take them. */
  private async fields(req: ImageEditRequest, model?: string): Promise<Record<string, unknown>> {
    if (!req.images.length) throw new GenAIError('An edit needs a picture', false);
    const first = await sharp(req.images[0]!).metadata();
    const w = req.width ?? first.width!, h = req.height ?? first.height!;
    const snap = (v: number) => Math.max(16, Math.round(v / 16) * 16);
    const { width, height } = req.gif ? { width: snap(w), height: snap(h) } : gptImageSize(w, h);
    return {
      model: model ?? this.cfg.model ?? 'gpt-image-2.5-flare',
      prompt: req.prompt,
      size: `${width}x${height}`,
      quality: req.quality ?? this.cfg.quality ?? 'medium',
      n: 1,
      ...(req.transparent ? { background: 'transparent' } : {}),
      ...(req.gif ? { output_format: 'gif', frame_count: req.gif.frames, frame_duration_ms: req.gif.frameMs } : req.transparent ? { output_format: 'png' } : {}),
      ...(req.moderation ? { moderation: req.moderation } : {}),
      ...(this.cfg.extraBody ?? {}),
    };
  }

  /** An edit, answered with its picture (PNG, or GIF for `req.gif`). */
  async edit(req: ImageEditRequest, model?: string): Promise<Buffer> {
    const fields = await this.fields(req, model);
    const form = new UFormData();
    for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
    for (const [i, img] of req.images.entries()) form.append('image[]', new Blob([new Uint8Array(img)], { type: 'image/png' }), `image${i}.png`);
    if (req.mask) form.append('mask', new Blob([new Uint8Array(req.mask)], { type: 'image/png' }), 'mask.png');
    const data = await httpJson(`${this.url}/images/edits`, { method: 'POST', headers: this.headers(), body: form as never, timeoutMs: this.cfg.timeoutMs ?? 600_000 });
    return this.take(data, String(fields.model));
  }

  /**
   * An edit as a JSON request body, for the Batch API (whose lines are JSON): the pictures go as data URLs in
   * `images`. The same request as `edit` otherwise.
   */
  async editBody(req: ImageEditRequest, model?: string): Promise<Record<string, unknown>> {
    return {
      ...(await this.fields(req, model)),
      images: req.images.map((b) => ({ image_url: `data:image/png;base64,${b.toString('base64')}` })),
      ...(req.mask ? { mask: { image_url: `data:image/png;base64,${req.mask.toString('base64')}` } } : {}),
    };
  }

  /**
   * OpenAI's Batch API for edits (POST /v1/files, /v1/batches): requests sent together, answered within 24 hours at
   * half price. `submit` uploads the requests (JSON lines) and starts the batch; `status` reads it; `results` reads
   * a finished batch's answers, charging each one once however often this process reads them.
   */
  batch() {
    const base = this.url, headers = () => this.headers(), timeoutMs = this.cfg.timeoutMs ?? 600_000;
    const take = (data: unknown, model: string, answer: string) => {
      const charge = !chargedAnswers.has(answer);
      chargedAnswers.add(answer);
      return this.take(data, model, true, charge);
    };
    return {
      /** `endpoint`: edits (the default) or generations; one batch takes one endpoint and one model. */
      async submit(requests: { id: string; body: Record<string, unknown> }[], endpoint: '/v1/images/edits' | '/v1/images/generations' = '/v1/images/edits'): Promise<string> {
        const lines = requests.map((r) => JSON.stringify({ custom_id: r.id, method: 'POST', url: endpoint, body: r.body })).join('\n') + '\n';
        const form = new UFormData();
        form.append('purpose', 'batch');
        form.append('file', new Blob([lines], { type: 'application/jsonl' }), 'requests.jsonl');
        const file = await httpJson(`${base}/files`, { method: 'POST', headers: headers(), body: form as never, timeoutMs });
        if (typeof file?.id !== 'string') throw new GenAIError(`The batch file was not stored: ${JSON.stringify(file).slice(0, 300)}`);
        const b = await httpJson(`${base}/batches`, { method: 'POST', headers: { 'content-type': 'application/json', ...headers() }, body: JSON.stringify({ input_file_id: file.id, endpoint, completion_window: '24h' }), timeoutMs });
        if (typeof b?.id !== 'string') throw new GenAIError(`The batch was not started: ${JSON.stringify(b).slice(0, 300)}`);
        return b.id as string;
      },
      async status(id: string): Promise<BatchStatus> {
        const b = await httpJson(`${base}/batches/${id}`, { headers: headers(), timeoutMs });
        const ended = ['completed', 'failed', 'expired', 'cancelled'].includes(b.status);
        return { state: b.status === 'completed' ? 'done' : ended ? 'failed' : 'running', detail: String(b.status), output: b.output_file_id ?? undefined, errors: b.error_file_id ?? undefined };
      },
      /** A finished batch's answers by request id: the picture (PNG or GIF, as asked), or why there is none. */
      async results(st: BatchStatus): Promise<Map<string, { image?: Buffer; error?: string }>> {
        const out = new Map<string, { image?: Buffer; error?: string }>();
        for (const fileId of [st.output, st.errors]) {
          if (!fileId) continue;
          const res = await sendRequest(`${base}/files/${fileId}/content`, { headers: headers(), dispatcher: patientAgent, signal: AbortSignal.timeout(timeoutMs) });
          if (!res.ok) throw new GenAIError(`HTTP ${res.status} reading batch results`);
          for (const line of (await res.text()).split('\n')) {
            if (!line.trim()) continue;
            const o = JSON.parse(line) as { custom_id: string; response?: { status_code: number; body: any }; error?: { message?: string } };
            const body = o.response?.body;
            if (o.response?.status_code === 200 && body?.data?.[0]?.b64_json) {
              try {
                out.set(o.custom_id, { image: take(body, String(body.model ?? ''), `${fileId}/${o.custom_id}`) });
              } catch (e) {
                out.set(o.custom_id, { error: (e as Error).message });
              }
            } else out.set(o.custom_id, { error: String(o.error?.message ?? body?.error?.message ?? `status ${o.response?.status_code ?? '?'}`).slice(0, 300) });
          }
        }
        return out;
      },
    };
  }
}

/**
 * The batch answers this process has charged (results file and request id): a batch read again, as a job that
 * stopped between reading and saving does, is not charged again. A restarted process starts afresh.
 */
const chargedAnswers = new Set<string>();

/** Where a batch is: still running, finished (`done`: read its results), or ended without results (`failed`). */
export interface BatchStatus {
  state: 'running' | 'done' | 'failed';
  detail: string;
  output?: string;
  errors?: string;
}

// ---------------------------------------------------------------------------- ComfyUI

/**
 * ComfyUI runs the asset workflow (config/comfyui/klein_cutout.json): Klein paints the subject on its chroma-key
 * backdrop, which cutout.ts then keys out.
 */
export class ComfyUIProvider implements ImageProvider {
  private template: unknown;
  private cfg: ProviderConfig;
  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
    const file = cfg.workflow ?? 'config/comfyui/klein_cutout.json';
    this.template = JSON.parse(fs.readFileSync(path.resolve(ROOT_DIR, file), 'utf8'));
  }

  private fill(node: unknown, vars: Record<string, string | number>): unknown {
    if (typeof node === 'string') {
      const whole = node.match(/^\{\{(\w+)\}\}$/);
      if (whole && whole[1]! in vars) return vars[whole[1]!];
      return node.replace(/\{\{(\w+)\}\}/g, (m, k: string) => (k in vars ? String(vars[k]) : m));
    }
    if (Array.isArray(node)) return node.map((n) => this.fill(n, vars));
    if (node && typeof node === 'object') return Object.fromEntries(Object.entries(node).map(([k, v]) => [k, this.fill(v, vars)]));
    return node;
  }

  async generate(req: ImageRequest, model?: string): Promise<Buffer> {
    const checkpoint = model ?? this.cfg.checkpoint ?? this.cfg.model ?? 'flux3-image-klein-int8-convrot.safetensors';
    const workflow = this.fill(this.template, {
      prompt: req.prompt,
      seed: req.seed,
      width: req.width,
      height: req.height,
      checkpoint,
      steps: this.cfg.steps ?? 16,
      cfg: this.cfg.cfg ?? 1,
    });
    return this.run(workflow, checkpoint);
  }

  /** Queue a workflow and wait for its first image. */
  private async run(workflow: unknown, model: string): Promise<Buffer> {
    const target = comfyTarget(this.cfg);
    try {
      const img = savedImages(await submitAndWait(workflow, { workflow: model, timeoutMs: this.cfg.timeoutMs ?? 300_000, pollMs: 750, target }))[0];
      if (!img) throw new GenAIError('ComfyUI saved no image');
      return await viewImage(img, target);
    } catch (e) {
      if (!(e instanceof ComfyError)) throw e;
      if (e.message === 'cancelled') throw new GenAIError('cancelled', false);
      throw new GenAIError(e.message === 'timed out' ? 'ComfyUI timed out' : `ComfyUI error: ${e.message}`);
    }
  }
}

// ---------------------------------------------------------------------------- decision models

/**
 * OpenAI decision models (POST /v1/decisions): questions answered independently over shared evidence, as
 * probabilities. Our question types map onto theirs: choice -> choice, score -> score levels, noul -> predicate.
 */
export class OpenAIDecisionProvider implements DecisionProvider {
  private cfg: ProviderConfig;
  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
  }
  async decide(req: DecisionRequest, model?: string): Promise<Record<string, DecisionAnswer>> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const state = typeof req.state === 'string' ? req.state : req.state.map((m) => `${m.role}: ${m.content}`).join('\n');
    const names = Object.keys(req.questions);
    const questions = names.map((name) => {
      const q = req.questions[name]!;
      if (q.type === 'choice') return { type: 'choice', name, instructions: q.instructions, choices: Object.entries(q.criteria).map(([value, description]) => ({ value, description: description ?? value })) };
      if (q.type === 'score') return { type: 'score', name, instructions: q.instructions, levels: q.criteria.map((label) => ({ label, description: label })) };
      return { type: 'predicate', name, instructions: q.instructions };
    });
    const content = [{ type: 'input_text', text: state }, ...(req.images ?? []).map((b) => ({ type: 'input_image', image_url: `data:image/png;base64,${b.toString('base64')}` }))];
    const data = await httpJson(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/decisions`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) },
      body: JSON.stringify({ model: model ?? this.cfg.model ?? 'gpt-6-luna', input: [{ role: 'user', content }], questions, ...(this.cfg.extraBody ?? {}) }),
      timeoutMs: this.cfg.timeoutMs ?? 120_000,
    });
    if (!Array.isArray(data?.answers)) throw new GenAIError(`Decision model returned no answers: ${JSON.stringify(data).slice(0, 300)}`);
    openaiUsage.decisionCalls++;
    openaiUsage.decisionInput += data.usage?.input_tokens ?? 0;
    chargeUsage(this.cfg, { input: data.usage?.input_tokens, output: data.usage?.output_tokens }, String(model ?? this.cfg.model ?? 'gpt-6-luna'));
    const out: Record<string, DecisionAnswer> = {};
    for (const a of data.answers as { type: string; name: string; probability?: number; choice?: string; score?: number; confidence?: number; probabilities?: { value: string; label?: string; probability: number }[] }[]) {
      const probs = Object.fromEntries((a.probabilities ?? []).map((p) => [p.value, p.probability]));
      if (a.type === 'predicate') out[a.name] = { type: 'noul', noul: a.probability ?? 0.5 };
      else if (a.type === 'choice') out[a.name] = { type: 'choice', choice: String(a.choice), probabilities: probs, confidence: a.confidence ?? 0 };
      else if (a.type === 'score') {
        const q = req.questions[a.name];
        const legend = q?.type === 'score' ? Object.fromEntries(q.criteria.map((c, i) => [String(i), c])) : {};
        out[a.name] = { type: 'score', score: a.score ?? 0, legend, probabilities: probs, confidence: a.confidence ?? 0 };
      }
      // A refusal leaves the question unanswered; callers treat missing answers as neutral.
    }
    return out;
  }
}

// ---------------------------------------------------------------------------- speech to text

/** OpenAI transcription (POST /v1/audio/transcriptions): a recorded utterance in, its words out. */
export class OpenAITranscribeProvider {
  private cfg: ProviderConfig;
  constructor(cfg: ProviderConfig) {
    this.cfg = cfg;
  }
  async transcribe(audio: Buffer, mime: string, model?: string, language?: string): Promise<string> {
    const key = resolveSecret(this.cfg.apiKey) ?? process.env.OPENAI_API_KEY;
    const form = new UFormData();
    const ext = mime.includes('ogg') ? 'ogg' : mime.includes('mp4') ? 'mp4' : mime.includes('wav') ? 'wav' : 'webm';
    form.append('file', new Blob([new Uint8Array(audio)], { type: mime }), `speech.${ext}`);
    form.append('model', model ?? this.cfg.model ?? 'gpt-4o-mini-transcribe');
    if (language) form.append('language', language);
    const res = await sendRequest(`${trimSlash(this.cfg.baseUrl ?? 'https://api.openai.com/v1')}/audio/transcriptions`, {
      method: 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(this.cfg.headers ?? {}) },
      body: form as never,
      signal: AbortSignal.timeout(this.cfg.timeoutMs ?? 30_000),
    });
    const data = (await res.json().catch(() => ({}))) as { text?: string; error?: { message?: string }; usage?: { type?: string; seconds?: number; input_tokens?: number; output_tokens?: number } };
    if (!res.ok) throw new GenAIError(`Transcription failed (${res.status}): ${data.error?.message ?? 'unknown error'}`, res.status === 429 || res.status >= 500);
    const u = data.usage;
    if (u) chargeUsage(this.cfg, u.type === 'duration' ? { seconds: u.seconds ?? 0 } : { input: u.input_tokens, output: u.output_tokens });
    return (data.text ?? '').trim();
  }
}
