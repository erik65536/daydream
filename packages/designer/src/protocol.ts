/** What the editor's page and its local server say to each other (src/server/api.ts). */
import type { Analysis, Status, StepDef } from '../../server/src/pipeline/index.ts';
import type { ChatView } from '../../server/src/pipeline/chat.ts';

export type { Analysis, ChatView, Status, StepDef };

/** The people one can talk with in an example's world, town by town. */
export type People = { town: string; people: { id: string; name: string; title: string; role: string; story: boolean }[] }[];

export interface Job {
  id: number;
  label: string;
  started: number;
  lines: string[];
  done: boolean;
  error?: string;
}

export interface State {
  examples: string[];
  example: string;
  analysis: Analysis;
  status: Record<string, Status>;
  /** What the example's newest answers call each id (`t0_0` → its place's name), to show beside ids. */
  names: Record<string, string>;
  /** Each step's settings, for the list, and a stamp that changes when its file does. */
  steps: Record<string, Pick<StepDef, 'purpose' | 'forEach' | 'when'> & { stamp: string }>;
  spend: { spent: number; cap: number };
  jobs: Job[];
}

/** A step as the editor edits it: its fields, with the schema as YAML text. */
export interface StepEdit {
  purpose: string;
  model: string;
  reasoning: string;
  maxTokens: string;
  forEach: string;
  when: string;
  system: string;
  user: string;
  schema: string;
}

interface PreviewCall {
  item?: string;
  system: string;
  user: string;
  /** The answer's shape as the model is told it (limits as given). */
  schema: Record<string, unknown>;
  /** The request body as sent. */
  body?: Record<string, unknown>;
}

export interface PreviewOut {
  calls: PreviewCall[];
  missing: string[];
  problems: string[];
  runs: boolean;
}

export interface RunSummary {
  id: string;
  at: number;
  ms: number;
  usd: number;
  calls: number;
  error?: string;
}

/** A game record: its shape, and what the newest runs of the example fill it with. */
export interface RecordOut {
  /** As JSON Schema. */
  shape: Record<string, unknown>;
  from?: string;
  value: unknown;
  /** Steps it needs that have not run on this example. */
  missing: string[];
}
