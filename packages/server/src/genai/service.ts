/** Routes each GenAI purpose to its configured provider, with validation, retries, and logging. */
import fs from 'node:fs';
import { checkBudget } from './spend.ts';
import { meterBatch, retries as meterRetries } from './meter.ts';
import path from 'node:path';
import { z } from 'zod';
import { DATA_DIR, genaiConfigFile } from '../paths.ts';
import { ComfyUIProvider, OpenAIDecisionProvider, OpenAIImageProvider, OpenAIResponsesProvider, OpenAITranscribeProvider } from './providers.ts';
import { callContext, priorityOf, withCallContext } from './context.ts';
import { clampToSchema, findLimitViolations, parseModelJson, restoreOptional, pathLabel, resolveRefs, setAtPath, type LimitViolation } from './json.ts';
import {
  GenAIError, NotConfigured, PROVIDER_TYPES, PURPOSES,
  type DecisionAnswer, type DecisionProvider, type DecisionRequest, type GenAIConfig, type ImageEditRequest, type ImageProvider, type ImageRequest, type ProviderConfig, type Purpose, type PurposeConfig, type TextProvider, type TextRequest,
} from './types.ts';
import { appendLine } from '../logfile.ts';

/**
 * config/genai.json (DAYDREAM_GENAI_CONFIG to use another; paths.ts). Without it nothing is configured: worlds cannot be built, and
 * people answer with simple stock replies.
 */
export function loadGenAIConfig(): GenAIConfig {
  const file = genaiConfigFile();
  if (!fs.existsSync(file)) return { providers: {}, purposes: {} };
  const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<GenAIConfig>;
  const providers = raw.providers ?? {};
  for (const [name, p] of Object.entries(providers))
    if (!(PROVIDER_TYPES as readonly string[]).includes(p.type)) throw new Error(`config/genai.json: provider "${name}" has type "${p.type}"; the types are ${PROVIDER_TYPES.join(', ')}`);
  // A purpose the game no longer has (or misspelt) would otherwise be ignored without a word.
  for (const name of Object.keys(raw.purposes ?? {}))
    if (!(PURPOSES as readonly string[]).includes(name)) throw new Error(`config/genai.json: there is no purpose "${name}"; the purposes are ${PURPOSES.join(', ')}`);
  return { ...raw, providers, purposes: raw.purposes ?? {} };
}

class Limiter {
  private active = 0;
  private queue: (() => void)[] = [];
  private max: number;
  constructor(max: number) {
    this.max = max;
  }
  async run<T>(fn: () => Promise<T>): Promise<T> {
    // A call that waited is handed the slot of the one that finished (still counted), so none slips in between.
    if (this.active >= this.max) await new Promise<void>((r) => this.queue.push(r));
    else this.active++;
    try {
      return await fn();
    } finally {
      const next = this.queue.shift();
      if (next) next();
      else this.active--;
    }
  }
}

interface CallLog {
  at: number;
  purpose: Purpose;
  provider: string;
  ms: number;
  ok: boolean;
  error?: string;
  attempt: number;
  promptChars: number;
  responseChars?: number;
  preview?: string;
  /** The job and step it was for (see genai/meter.ts). */
  jobId?: string;
  step?: string;
}

interface StructuredOptions<T extends z.ZodType> {
  system?: string;
  prompt: string;
  schema: T;
  /** The answer's shape as sent, when it was written as JSON schema (the zod schema then only checks the answer). */
  jsonSchema?: Record<string, unknown>;
  name: string;
  history?: TextRequest['messages'];
  temperature?: number;
  maxTokens?: number;
  images?: Buffer[];
  /** Ask this model of the purpose's provider instead of its configured one (e.g. a stronger model as a fallback). */
  model?: string;
  /** Request fields over the purpose's own (`{ reasoning: { effort: 'high' } }`). */
  extraBody?: Record<string, unknown>;
  /** Extra semantic validation; return an error string to trigger a retry. */
  validate?: (v: z.infer<T>) => string | null;
  /**
   * Stream the answer: the raw JSON so far at every delta (for showing a reply as it is written). A streamed answer
   * is asked for once: words already shown are not taken back by a retry, so an invalid answer throws.
   */
  onText?: (soFar: string) => void;
}

export class GenAI {
  private textProviders = new Map<string, TextProvider>();
  private imageProviders = new Map<string, ImageProvider>();
  private limiters = new Map<string, Limiter>();
  private decisionProviders = new Map<string, DecisionProvider>();
  readonly recent: CallLog[] = [];
  private logFile: string;
  config: GenAIConfig;

  constructor(config: GenAIConfig) {
    this.config = config;
    fs.mkdirSync(path.join(DATA_DIR, 'logs'), { recursive: true });
    this.logFile = path.join(DATA_DIR, 'logs', 'genai.jsonl');
  }

  /** The type of a purpose's provider (undefined when it has none). */
  providerType(p: Purpose): ProviderConfig['type'] | undefined {
    const pc = this.config.purposes[p];
    return pc ? this.config.providers[pc.provider]?.type : undefined;
  }

  /** Whether a purpose has a provider. */
  configured(p: Purpose): boolean {
    const pc = this.config.purposes[p];
    return !!pc && !!this.config.providers[pc.provider];
  }

  /** A purpose's settings; throws NotConfigured when it has no provider. */
  purpose(p: Purpose): PurposeConfig {
    if (!this.configured(p)) throw new NotConfigured(p);
    return this.config.purposes[p]!;
  }

  /**
   * The stronger model a purpose may fall back to when its usual answer is not good enough: the purpose's
   * `strongModel` (null turns the fallback off), else gpt-6.1-sol.
   */
  strongModel(p: Purpose): string | undefined {
    if (!this.configured(p)) return undefined;
    const pc = this.purpose(p);
    return pc.strongModel === undefined ? 'gpt-6.1-sol' : pc.strongModel ?? undefined;
  }

  providerConfig(name: string): ProviderConfig {
    const c = this.config.providers[name];
    if (!c) throw new GenAIError(`Unknown provider "${name}"`, false);
    return c;
  }

  describe(): { purpose: Purpose; provider: string; type: string; model?: string }[] {
    return PURPOSES.map((p) => {
      const pc = this.config.purposes[p];
      const prov = pc && this.config.providers[pc.provider];
      return { purpose: p, provider: pc?.provider ?? '—', type: prov?.type ?? 'not configured', model: pc?.model ?? prov?.model ?? prov?.checkpoint };
    });
  }

  private limiter(name: string): Limiter {
    let l = this.limiters.get(name);
    if (!l) {
      l = new Limiter(this.config.providers[name]?.concurrency ?? 2);
      this.limiters.set(name, l);
    }
    return l;
  }

  /**
   * Run a provider call within the provider's concurrency limit, retried while the provider is busy, rate-limited
   * or unreachable. A player-facing call gives up after a few seconds (the game falls back); background work waits
   * much longer and tells its job why it is waiting instead of failing. (GPU turns are the broker's: docs/gpu-broker.md.)
   */
  private async exec<T>(purpose: Purpose, providerName: string, fn: () => Promise<T>): Promise<T> {
    const cfg = this.providerConfig(providerName);
    // A paid model is refused once the budget (the user's for the month, or the server's for the day) is spent.
    checkBudget(cfg);
    const priority = priorityOf(purpose);
    const onWait = callContext()?.onWait;
    const deadline = Date.now() + (priority === 'interactive' ? 12_000 : (this.config.waitForModelsMs ?? 30 * 60_000));
    let delay = priority === 'interactive' ? 1000 : 3000;
    let waiting = false;
    const tries = meterRetries('gateway.transient', `${purpose} ${providerName}`);
    for (;;) {
      try {
        // The call carries its purpose (for the meter); the rest of its context is the caller's.
        const out = await this.limiter(providerName).run(() => withCallContext({ ...(callContext() ?? { priority }), purpose }, fn));
        if (waiting) (onWait?.(null), tries.try(true, true));
        return out;
      } catch (e) {
        if (!isTransient(e) || Date.now() + delay > deadline) {
          if (waiting) (onWait?.(null), tries.try(false, true, (e as Error).message));
          throw e;
        }
        tries.try(false, false, (e as Error).message, { waitMs: delay });
        waiting = true;
        onWait?.(`Waiting for ${providerName}: ${(e as Error).message.slice(0, 80)} (retrying in ${Math.round(delay / 1000)}s)`);
        await new Promise((r) => setTimeout(r, delay));
        delay = Math.min(60_000, delay * 2);
      }
    }
  }

  async decide(p: Purpose, req: DecisionRequest): Promise<Record<string, DecisionAnswer>> {
    const pc = this.purpose(p);
    let prov = this.decisionProviders.get(pc.provider);
    if (!prov) {
      const cfg = this.providerConfig(pc.provider);
      if (cfg.type !== 'openai-decision') throw new GenAIError(`Provider "${pc.provider}" is not a decision model`, false);
      prov = new OpenAIDecisionProvider(cfg);
      this.decisionProviders.set(pc.provider, prov);
    }
    const t0 = Date.now();
    try {
      const out = await this.exec(p, pc.provider, () => prov!.decide(req, pc.model));
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: JSON.stringify(req.state).length, preview: Object.entries(out).map(([k, v]) => `${k}=${v.type === 'choice' ? v.choice : v.type === 'score' ? v.score.toFixed(2) : v.noul.toFixed(2)}`).join(' ').slice(0, 160) });
      return out;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: 0 });
      throw e;
    }
  }

  private text_(name: string): TextProvider {
    let p = this.textProviders.get(name);
    if (p) return p;
    const cfg = this.providerConfig(name);
    if (cfg.type !== 'openai-responses') throw new GenAIError(`Provider "${name}" (${cfg.type}) cannot generate text`, false);
    p = new OpenAIResponsesProvider(cfg);
    this.textProviders.set(name, p);
    return p;
  }

  private image_(name: string): ImageProvider {
    let p = this.imageProviders.get(name);
    if (p) return p;
    const cfg = this.providerConfig(name);
    if (cfg.type === 'openai-image') p = new OpenAIImageProvider(cfg);
    else if (cfg.type === 'comfyui') p = new ComfyUIProvider(cfg);
    else throw new GenAIError(`Provider "${name}" (${cfg.type}) cannot paint (images need a ComfyUI or OpenAI image provider)`, false);
    this.imageProviders.set(name, p);
    return p;
  }

  private log(entry: CallLog) {
    const ctx = callContext();
    if (ctx?.tag?.jobId) entry.jobId = ctx.tag.jobId;
    if (ctx?.step) entry.step = ctx.step;
    this.recent.push(entry);
    if (this.recent.length > 200) this.recent.shift();
    appendLine(this.logFile, JSON.stringify(entry));
  }

  /** Plain text generation; `onText` streams it (the text so far at every delta). */
  async text(p: Purpose, req: TextRequest, onText?: (soFar: string) => void): Promise<string> {
    const pc = this.purpose(p);
    const provider = this.text_(pc.provider);
    const t0 = Date.now();
    try {
      const out = await this.exec(p, pc.provider, () =>
        provider.text({ ...req, temperature: req.temperature ?? pc.temperature, maxTokens: req.maxTokens ?? pc.maxTokens }, pc.model, pc.extraBody, onText),
      );
      const cleaned = out.trim();
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: JSON.stringify(req.messages).length, responseChars: cleaned.length, preview: cleaned.slice(0, 160) });
      return cleaned;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: 0 });
      throw e;
    }
  }

  /** Ask the model to rewrite only the fields that break their size limits, keeping their meaning. */
  private async fitLimits(p: Purpose, parsed: unknown, over: LimitViolation[], root: Record<string, unknown>, system?: string): Promise<unknown> {
    const pc = this.purpose(p);
    const provider = this.text_(pc.provider);
    const fields = over.slice(0, 24);
    const schema = { type: 'object', properties: Object.fromEntries(fields.map((v, i) => [`f${i}`, resolveRefs(v.schema, root)])), required: fields.map((_, i) => `f${i}`) };
    const list = fields.map((v, i) => `f${i} (${pathLabel(v.path)}, ${v.limit}):\n${JSON.stringify(v.value)}`).join('\n\n');
    const t0 = Date.now();
    try {
      const raw = await this.exec(p, pc.provider, () =>
        provider.structured(
          {
            system,
            messages: [{ role: 'user', content: `Some fields of your answer are over their size limits. Rewrite each one to fit its limit while keeping its meaning, names, and voice: shorter text must still read as complete; a list over its count keeps the most important items (merge where it helps).

${list}

Return a JSON object with the rewritten f0, f1, ... only.` }],
            schema,
            schemaName: 'fit_limits',
            maxTokens: Math.round(Math.min(6000, 300 + fields.reduce((t, v) => t + JSON.stringify(v.value).length / 3, 0))),
          },
          pc.model,
          pc.extraBody,
        ),
      );
      const fixed = parseModelJson(raw) as Record<string, unknown>;
      fields.forEach((v, i) => {
        if (fixed && `f${i}` in fixed) parsed = setAtPath(parsed, v.path, fixed[`f${i}`]);
      });
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: list.length, responseChars: raw.length, preview: `fitted ${fields.length} field(s) to their limits` });
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: `fit limits: ${(e as Error).message.slice(0, 300)}`, attempt: 1, promptChars: list.length });
    }
    return parsed;
  }

  /** The request body `structured` would send first, without sending it (for seeing exactly what a prompt becomes). */
  structuredBody<T extends z.ZodType>(p: Purpose, opts: StructuredOptions<T>): Record<string, unknown> {
    const pc = this.purpose(p);
    const req = { system: opts.system, messages: [...(opts.history ?? []), { role: 'user' as const, content: opts.prompt }], schema: opts.jsonSchema ?? toJsonSchema(opts.schema), schemaName: opts.name, temperature: opts.temperature ?? pc.temperature, maxTokens: opts.maxTokens ?? pc.maxTokens };
    return this.text_(pc.provider).structuredBody(req, opts.model ?? pc.model, { ...pc.extraBody, ...opts.extraBody });
  }

  /** Structured generation validated with zod, retried with the validation error as feedback. */
  async structured<T extends z.ZodType>(p: Purpose, opts: StructuredOptions<T>): Promise<z.infer<T>> {
    const pc = this.purpose(p);
    const provider = this.text_(pc.provider);
    const jsonSchema = opts.jsonSchema ?? toJsonSchema(opts.schema);
    const extraBody = { ...pc.extraBody, ...opts.extraBody };
    const retries = opts.onText ? 0 : (pc.retries ?? 2);
    const model = opts.model ?? pc.model;
    const messages = [...(opts.history ?? []), { role: 'user' as const, content: opts.prompt }];
    let lastErr: Error | null = null;
    const tries = meterRetries('gateway.structured', `${p} ${opts.name}`);
    for (let attempt = 1; attempt <= retries + 1; attempt++) {
      const t0 = Date.now();
      let raw = '';
      try {
        raw = await this.exec(p, pc.provider, () =>
          provider.structured(
            { system: opts.system, messages, schema: jsonSchema, schemaName: opts.name, temperature: opts.temperature ?? pc.temperature, maxTokens: opts.maxTokens ?? pc.maxTokens, images: opts.images },
            model,
            extraBody,
            opts.onText,
          ),
        );
        // Fields over their size limits are rewritten on their own (a small request), not by regenerating the
        // whole answer; anything still over is trimmed as a last resort.
        let parsed = restoreOptional(parseModelJson(raw), jsonSchema);
        const over = findLimitViolations(parsed, jsonSchema);
        if (over.length) parsed = await this.fitLimits(p, parsed, over, jsonSchema, opts.system);
        parsed = clampToSchema(parsed, jsonSchema);
        const result = opts.schema.safeParse(parsed);
        if (!result.success) throw new Error(`Schema validation failed: ${z.prettifyError(result.error).slice(0, 800)}`);
        const semantic = opts.validate?.(result.data);
        if (semantic) throw new Error(`Content problem: ${semantic}`);
        this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt, promptChars: opts.prompt.length + (opts.system?.length ?? 0), responseChars: raw.length });
        tries.try(true, true);
        return result.data;
      } catch (e) {
        lastErr = e as Error;
        // An answer cut off at its limit is shown by its end, where it ran long.
        const partial = e instanceof GenAIError ? e.partial : undefined;
        this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: lastErr.message.slice(0, 400), attempt, promptChars: opts.prompt.length, responseChars: (partial ?? raw).length, preview: partial ? `…${partial.slice(-400)}` : raw.slice(0, 200) });
        tries.try(false, (e instanceof GenAIError && !e.retryable) || attempt > retries, lastErr.message);
        if (e instanceof GenAIError && !e.retryable) break;
        if (raw) {
          // Give the model its own output and the error so it can correct itself.
          messages.push({ role: 'assistant', content: raw.slice(0, 6000) });
          messages.push({ role: 'user', content: `That response was invalid. ${lastErr.message}\nReturn the complete corrected JSON object only.` });
        }
      }
    }
    throw lastErr ?? new Error('structured generation failed');
  }

  /** Speech to text (the 'speech.input' purpose): returns what was said. */
  async transcribe(p: Purpose, audio: Buffer, mime: string, language?: string): Promise<string> {
    const pc = this.purpose(p);
    const cfg = this.providerConfig(pc.provider);
    if (cfg.type !== 'openai-transcribe') throw new GenAIError(`Provider "${pc.provider}" does not transcribe speech`, false);
    const prov = new OpenAITranscribeProvider(cfg);
    const t0 = Date.now();
    const text = await this.exec(p, pc.provider, () => prov.transcribe(audio, mime, pc.model, language));
    this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: audio.length, preview: text.slice(0, 160) });
    return text;
  }

  async image(p: Purpose, req: Omit<ImageRequest, 'width' | 'height'> & Partial<Pick<ImageRequest, 'width' | 'height'>>): Promise<Buffer> {
    const pc = this.purpose(p);
    const provider = this.image_(pc.provider);
    const t0 = Date.now();
    const full: ImageRequest = {
      ...req,
      width: req.width ?? pc.width ?? 1024,
      height: req.height ?? pc.height ?? 1024,
    };
    try {
      const buf = await this.exec(p, pc.provider, () => provider.generate(full, pc.model));
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: req.prompt.length, responseChars: buf.length });
      return buf;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: req.prompt.length });
      throw e;
    }
  }

  /**
   * Edits through OpenAI's Batch API for an image purpose (its provider must be an OpenAI image model): build each
   * request's body, submit them together (refused once the budget is spent), read the batch's state and, when it is
   * done, its pictures (each charged at the Batch price).
   */
  imageBatch(p: Purpose) {
    const pc = this.purpose(p);
    const cfg = this.providerConfig(pc.provider);
    if (cfg.type !== 'openai-image') throw new GenAIError(`Provider "${pc.provider}" (${cfg.type}) has no Batch API (an openai-image provider does)`, false);
    const provider = new OpenAIImageProvider(cfg);
    const batch = provider.batch();
    return {
      /** An edit's body, with the purpose's model or `model` (a batch takes one model). */
      body: (req: ImageEditRequest, model?: string) => provider.editBody(req, model ?? pc.model),
      /** A painting's body (for a batch submitted to the generations endpoint). */
      paintBody: (req: ImageRequest, model?: string) => provider.generateBody(req, model ?? pc.model),
      submit: async (requests: { id: string; body: Record<string, unknown> }[], endpoint?: '/v1/images/edits' | '/v1/images/generations') => {
        checkBudget(cfg);
        const id = await batch.submit(requests, endpoint);
        meterBatch({ id, event: 'sent', requests: requests.length });
        return id;
      },
      status: batch.status,
      results: (st: Parameters<typeof batch.results>[0]) => withCallContext({ ...(callContext() ?? { priority: 'background' as const }), purpose: p }, () => batch.results(st)),
    };
  }

  /** Redraw a picture as the prompt says (providers that edit: OpenAI's image models), with the purpose's model or `model`. */
  async editImage(p: Purpose, req: ImageEditRequest, model?: string): Promise<Buffer> {
    const pc = this.purpose(p);
    const provider = this.image_(pc.provider);
    if (!provider.edit) throw new GenAIError(`Provider "${pc.provider}" cannot edit pictures`, false);
    const t0 = Date.now();
    try {
      const buf = await this.exec(p, pc.provider, () => provider.edit!(req, model ?? pc.model));
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: true, attempt: 1, promptChars: req.prompt.length, responseChars: buf.length });
      return buf;
    } catch (e) {
      this.log({ at: t0, purpose: p, provider: pc.provider, ms: Date.now() - t0, ok: false, error: (e as Error).message.slice(0, 300), attempt: 1, promptChars: req.prompt.length });
      throw e;
    }
  }
}

/** Worth retrying: the provider is busy, rate-limited, overloaded, or unreachable (not a bad request). */
export function isTransient(e: unknown): boolean {
  if (e instanceof GenAIError && !e.retryable) return false;
  const err = e as { message?: string; code?: string; cause?: { code?: string; message?: string }; status?: number };
  if (BUSY_STATUS.test(String(err.status ?? ''))) return true;
  const text = `${err.message ?? ''} ${err.code ?? ''} ${err.cause?.code ?? ''} ${err.cause?.message ?? ''}`;
  // A status counts where an error names it as one ("HTTP 503", "failed (429)", "failed: 502"), not any such digits
  // in an answer quoted in the message (an id, a timestamp, a token count).
  return /fetch failed|ECONNREFUSED|ECONNRESET|ETIMEDOUT|EPIPE|EAI_AGAIN|UND_ERR|socket hang up|network|timed? ?out|(?:HTTP|failed:?) \(?(?:408|409|425|429|5\d\d)\b|overloaded|rate.?limit|too many requests|temporarily|unavailable|loading model/i.test(text);
}

/** The statuses of a provider that is busy, rate-limited, or failing for now. */
const BUSY_STATUS = /^(408|409|425|429|5\d\d)$/;

let instance: GenAI | null = null;
function toJsonSchema(schema: z.ZodType): Record<string, unknown> {
  const out = z.toJSONSchema(schema, { unrepresentable: 'any' }) as Record<string, unknown>;
  delete out.$schema;
  return out;
}

export function genai(): GenAI {
  if (!instance) instance = new GenAI(loadGenAIConfig());
  return instance;
}
export function reloadGenAI(): GenAI {
  instance = new GenAI(loadGenAIConfig());
  return instance;
}
