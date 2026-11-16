/** Provider-agnostic GenAI interfaces. Every purpose in the engine goes through these. */

export const PURPOSES = [
  'world.design', // concept, atlas, story — needs the smartest model
  'world.content', // per-place people, quests, lore — many calls
  'npc.judge', // a decision model reading a moment in a conversation: what the person does and how they feel
  'npc.decision', // a person's words in a conversation, once the judge has decided what they do
  'narration', // flavor text for actions, quest updates
  'image.sprite', // characters, monsters, objects
  'image.icon', // item icons
  'image.check', // vision model judging generated images
  'image.prompt', // LLM that turns asset briefs into image prompts and picks each one's chroma-key backdrop
  'image.animation', // GPT Image painting characters' animation frames (through the Batch API)
  'image.walk', // GPT Image 2.6 painting characters' walks as looping GIFs (through the Batch API)
  'image.read', // GPT Image reading painted maps for where people can walk, instead of Qwen on the GPU (docs/places.md)
  'speech.input', // speech-to-text: what a player says to the people of the world
  'speech.cpu', // text-to-speech on the game server's CPU (Pocket TTS): voices while the GPU is busy or away
  'speech.gpu', // text-to-speech on the GPU (the VoxCPM2 runner behind the GPU broker): voices while the GPU is idle
] as const;
export type Purpose = (typeof PURPOSES)[number];

/**
 * OpenAI for every text, decision, and speech purpose; ComfyUI (behind the GPU broker) for every image by default.
 * OpenAI's image models (GPT Image, through the Images API) can paint and edit too.
 */
export const PROVIDER_TYPES = ['openai-responses', 'openai-decision', 'openai-transcribe', 'openai-image', 'comfyui', 'pocket-tts'] as const;
type ProviderType = (typeof PROVIDER_TYPES)[number];

/** GPT Image quality levels (xhigh and max are new with GPT Image 2.5). */
type ImageQuality = 'low' | 'medium' | 'high' | 'xhigh' | 'max' | 'auto';

export interface ProviderConfig {
  type: ProviderType;
  /** ComfyUI: the GPU broker (docs/gpu-broker.md), the one door to the GPU, with `apiKey` its token. */
  baseUrl?: string;
  /** Literal key, "env:VAR_NAME", or "credential:NAME" (a systemd credential; see docs/hosting.md). */
  apiKey?: string;
  model?: string;
  timeoutMs?: number;
  /** Max parallel requests to this provider. */
  concurrency?: number;
  /** OpenAI: processing tier ("flex" is half price and slower; busy flex capacity is waited out, not billed). */
  serviceTier?: 'auto' | 'default' | 'flex' | 'priority';
  /**
   * Prices in dollars per million tokens (cached input defaults to a tenth, output to five times input). Paid providers
   * are metered against users' monthly budgets and the server's daily ceiling. Image models price their image input apart from their text input.
   */
  pricing?: { inputPerM: number; cachedPerM?: number; outputPerM?: number; perMinute?: number; imageInputPerM?: number; imageCachedPerM?: number };
  /** Prices for other models asked of this provider per call (e.g. a stronger fallback model), by model name. */
  modelPricing?: Record<string, { inputPerM: number; cachedPerM?: number; outputPerM?: number }>;
  /** Reasoning models: output tokens added to every request's limit for the model's thinking (billed only when used). */
  reasoningTokens?: number;
  /** Extra body parameters merged into every request (e.g. top_p, reasoning settings). */
  extraBody?: Record<string, unknown>;
  headers?: Record<string, string>;
  /** OpenAI image models: the quality asked for when a request names none (default medium). */
  quality?: ImageQuality;
  /** ComfyUI: path to an API-format workflow JSON with {{placeholders}} (assets: the painting on its chroma-key backdrop). */
  workflow?: string;
  /** ComfyUI: checkpoint/model name substituted into {{checkpoint}}. */
  checkpoint?: string;
  steps?: number;
  cfg?: number;
  /** Pocket TTS (src/speech/pocket.ts): the folder of its exported models, lines at once, threads per line, models. */
  models?: string;
  lines?: number;
  threads?: number;
  smallModel?: string;
}

export interface PurposeConfig {
  provider: string;
  model?: string;
  temperature?: number;
  maxTokens?: number;
  retries?: number;
  /** A stronger model of the same provider to fall back to when an answer is not good enough (null: no fallback). */
  strongModel?: string | null;
  /** image.check: minimum score (0-10) to accept an image. */
  minScore?: number;
  /** image.*: max generation attempts per asset. */
  maxAttempts?: number;
  /** image.read: the models whose plans of a map are voted, one plan each (default: GPT Image 2.5 and 2.6 Sunburst). */
  models?: string[];
  /** image.sprite, image.icon, image.read on an OpenAI image model: through the Batch API at half price (default), or directly (false). */
  batch?: boolean;
  /** image.*: generation size. */
  width?: number;
  height?: number;
  extraBody?: Record<string, unknown>;
}

export interface GenAIConfig {
  providers: Record<string, ProviderConfig>;
  purposes: Partial<Record<Purpose, PurposeConfig>>;
  /** Jobs (world builds, rules, painting) one worker runs at once. Default 1: a single local GPU. */
  jobConcurrency?: number;
  /** How long background work waits for a busy, rate-limited, or unreachable model before failing (ms). */
  waitForModelsMs?: number;
  /**
   * Paid models: the whole server's daily ceiling in dollars, and whether administrators are unlimited (default yes).
   * Each user's monthly budget is set on their account.
   */
  spending?: { dailyTotalUsd?: number; adminsUnlimited?: boolean };
}

// ------------------------------------------------------------------------------- decision models

/** Questions for OpenAI's decision models. Each is answered independently. */
export type DecisionQuestion =
  | { type: 'choice'; instructions: string; criteria: Record<string, string | null> }
  | { type: 'score'; instructions: string; criteria: string[] }
  | { type: 'noul'; instructions: string };

export type DecisionAnswer =
  | { type: 'choice'; choice: string; probabilities: Record<string, number>; confidence: number }
  | { type: 'score'; score: number; legend: Record<string, string>; probabilities: Record<string, number>; confidence: number }
  | { type: 'noul'; noul: number };

export interface DecisionRequest {
  state: string | ChatMessage[];
  questions: Record<string, DecisionQuestion>;
  images?: Buffer[];
}

export interface DecisionProvider {
  decide(req: DecisionRequest, model?: string): Promise<Record<string, DecisionAnswer>>;
}

interface ChatMessage {
  role: 'user' | 'assistant';
  content: string;
}

export interface TextRequest {
  system?: string;
  messages: ChatMessage[];
  temperature?: number;
  maxTokens?: number;
  /** Image attachments (PNG) for vision-capable models. */
  images?: Buffer[];
}

export interface StructuredRequest extends TextRequest {
  schema: Record<string, unknown>;
  schemaName: string;
}

export interface ImageRequest {
  prompt: string;
  width: number;
  height: number;
  /** ComfyUI only: OpenAI's image models take no seed. */
  seed: number;
  /** OpenAI image models only. */
  quality?: ImageQuality;
  /** OpenAI image models only: paint on a transparent background (PNG with alpha). */
  transparent?: boolean;
}

/** A picture (or several, the first being the one changed) redrawn as the prompt says. */
export interface ImageEditRequest {
  prompt: string;
  images: Buffer[];
  /** PNG the size of the first image whose transparent pixels may change (the rest are kept, roughly). */
  mask?: Buffer;
  /** The size of the answer (default: the first image's size, fitted to what the model can paint). */
  width?: number;
  height?: number;
  quality?: ImageQuality;
  /** Paint on a transparent background (PNG with alpha); the pictures given should be transparent too. */
  transparent?: boolean;
  /**
   * Answer with an animated GIF (GPT Image 2.6) of this many frames, each `frameMs` long, instead of one picture.
   * `width` and `height` are then one frame's size. The model paints the frames on one sheet it cuts apart, so frames
   * times the frame's size must fit a picture it can paint. A GIF's alpha is on or off (no soft edges).
   */
  gif?: { frames: number; frameMs: number };
  /** How strictly the answer is moderated (`low`: shooting and fighting in a game are not refused). */
  moderation?: 'auto' | 'low';
}

export interface TextProvider {
  /** `onText`: stream the answer, handing out the text so far as it grows. */
  text(req: TextRequest, model?: string, extra?: Record<string, unknown>, onText?: (soFar: string) => void): Promise<string>;
  /** Returns raw text that should contain JSON matching the schema. */
  structured(req: StructuredRequest, model?: string, extra?: Record<string, unknown>, onText?: (soFar: string) => void): Promise<string>;
  /** The request body `structured` would send, without sending it. */
  structuredBody(req: StructuredRequest, model?: string, extra?: Record<string, unknown>): Record<string, unknown>;
}

export interface ImageProvider {
  generate(req: ImageRequest, model?: string): Promise<Buffer>;
  /** Providers that can redraw a given picture. */
  edit?(req: ImageEditRequest, model?: string): Promise<Buffer>;
}

export class GenAIError extends Error {
  readonly retryable: boolean;
  readonly partial?: string;
  /** `partial`: the text an answer cut off at its token limit got as far as, for finding where it ran long. */
  constructor(message: string, retryable = true, partial?: string) {
    super(message);
    this.retryable = retryable;
    this.partial = partial;
  }
}

/** No provider is configured for a purpose (config/genai.json): callers with a stand-in (an NPC's simple replies) use it. */
export class NotConfigured extends GenAIError {
  constructor(purpose: string) {
    super(`No model is configured for ${purpose} (config/genai.json)`, false);
  }
}
