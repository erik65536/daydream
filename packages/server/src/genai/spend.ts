/**
 * Spending on paid (cloud) models: every call's cost is worked out from its provider's prices and charged to
 * whoever it was for (the user in the call context, or "system"), and calls are refused once a budget (the user's
 * for the month, the server's for the day) is spent. The ledger itself lives in storage; it plugs in here so providers stay free of database code.
 */
import { callContext } from './context.ts';
import { meterCall } from './meter.ts';
import type { ProviderConfig } from './types.ts';
import { GenAIError } from './types.ts';

/** Tokens of one call. `input` and `cached` are text; image models count their image input apart. */
export interface Usage {
  input?: number;
  cached?: number;
  output?: number;
  seconds?: number;
  imageInput?: number;
  imageCached?: number;
  /** Run through OpenAI's Batch API: half price. */
  batch?: boolean;
  /** Served at OpenAI's flex tier (half price), as the answer says; unset, the provider's configured tier. */
  flex?: boolean;
  /** Output tokens spent thinking (billed as output; counted apart for reports). */
  reasoning?: number;
  /** Pictures an image model made (counted for reports, not billed apart). */
  images?: number;
}

export interface Prices { input: number; cached: number; output: number; imageInput?: number; imageCached?: number }

interface SpendLedger {
  record(userId: string, usd: number): void;
  /** Why a user may not spend more now (or null when they may). */
  refusal(userId: string): string | null;
}

let ledger: SpendLedger | null = null;
export const setSpendLedger = (l: SpendLedger | null) => (ledger = l);

/** OpenAI list prices (standard tier, short context) of models asked for by name, per million tokens. */
const OPENAI_MODEL_PRICES: Record<string, Prices> = {
  'gpt-6.1-sol': { input: 2, cached: 0.1, output: 10 },
};

/**
 * GPT Image 2.5 and 2.6 list prices (Flare and Sunburst alike, standard tier, November 2026): text input $5 (cached $1.25),
 * image input $8 (cached $2) and image output $30 per million tokens. Text output is not billed (the models answer
 * with images only). Cached input is only discounted through the Responses API's image tool, not the Images API.
 */
export const GPT_IMAGE_PRICES: Prices = { input: 5, cached: 1.25, output: 30, imageInput: 8, imageCached: 2 };

/**
 * Per-million-token prices: a model asked for by name (not the provider's own) at the provider's `modelPricing`
 * for it or its OpenAI list price; otherwise the provider's `pricing`, and OpenAI providers default to gpt-6-luna
 * list prices.
 */
function pricesOf(cfg: ProviderConfig, model?: string): Prices | null {
  const other = model && model !== cfg.model ? model : undefined;
  const mp = other ? cfg.modelPricing?.[other] : undefined;
  if (mp) return { input: mp.inputPerM, cached: mp.cachedPerM ?? mp.inputPerM / 10, output: mp.outputPerM ?? mp.inputPerM * 5 };
  if (other && (cfg.type === 'openai-responses' || cfg.type === 'openai-decision') && OPENAI_MODEL_PRICES[other]) return OPENAI_MODEL_PRICES[other];
  if (cfg.pricing) {
    const pr = cfg.pricing;
    return { input: pr.inputPerM, cached: pr.cachedPerM ?? pr.inputPerM / 10, output: pr.outputPerM ?? pr.inputPerM * 5, imageInput: pr.imageInputPerM, imageCached: pr.imageCachedPerM ?? (pr.imageInputPerM !== undefined ? pr.imageInputPerM / 4 : undefined) };
  }
  if (cfg.type === 'openai-image') return GPT_IMAGE_PRICES;
  if (cfg.type === 'openai-responses' || cfg.type === 'openai-decision') return { input: 0.1, cached: 0.01, output: 0.5 };
  // Transcription: audio input tokens and text output (gpt-4o-mini-transcribe list prices).
  if (cfg.type === 'openai-transcribe') return { input: 3, cached: 3, output: 5 };
  return null;
}

const isMetered = (cfg: ProviderConfig) => !!pricesOf(cfg) && (cfg.pricing?.inputPerM ?? 1) > 0;

export function costOf(cfg: ProviderConfig, u: Usage, model?: string): number {
  const p = pricesOf(cfg, model);
  if (!p) return 0;
  // Audio billed by the minute (some transcription models report duration instead of tokens).
  if (u.seconds !== undefined) return (u.seconds / 60) * (cfg.pricing?.perMinute ?? 0.006);
  const tier = (u.flex ?? cfg.serviceTier === 'flex') || u.batch ? 0.5 : 1;
  const input = u.input ?? 0, cached = Math.min(input, u.cached ?? 0);
  const image = u.imageInput ?? 0, imageCached = Math.min(image, u.imageCached ?? 0);
  // A provider with no image prices bills image input as input.
  const imageCost = (image - imageCached) * (p.imageInput ?? p.input) + imageCached * (p.imageCached ?? p.cached);
  return (tier * ((input - cached) * p.input + cached * p.cached + imageCost + (u.output ?? 0) * p.output)) / 1e6;
}

/** Charge a finished call to the user it ran for. */
export function chargeUsage(cfg: ProviderConfig, u: Usage, model?: string) {
  const usd = costOf(cfg, u, model);
  if (usd > 0) ledger?.record(callContext()?.userId ?? 'system', usd);
  callContext()?.onUsage?.({ usd, input: u.input ?? 0, cached: u.cached ?? 0, output: u.output ?? 0, reasoning: u.reasoning ?? 0 });
  const tier = u.batch ? 'batch' : (u.flex ?? cfg.serviceTier === 'flex') ? 'flex' : 'standard';
  meterCall({ provider: cfg.type, api: cfg.type, model: model || cfg.model || '?', tier, usd, input: u.input, cached: u.cached, output: u.output, reasoning: u.reasoning, imageInput: u.imageInput, images: u.images });
}

export class BudgetExceeded extends GenAIError {
  constructor(message: string) {
    super(message, false);
  }
}

/** Refuse a paid call when the user has spent the month's budget, or the whole server the day's. */
export function checkBudget(cfg: ProviderConfig) {
  if (!ledger || !isMetered(cfg)) return;
  const why = ledger.refusal(callContext()?.userId ?? 'system');
  if (why) throw new BudgetExceeded(why);
}
