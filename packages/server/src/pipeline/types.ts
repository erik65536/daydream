import type { Purpose } from '../genai/types.ts';
import type { PromptTopic, WorldInput } from '@daydream/shared';

/** One Responses API call of the build (a YAML file in pipeline/steps/, named by its id). */
export interface StepDef {
  id: string;
  /** Chooses the model and its settings, as every gateway call does. */
  purpose: Purpose;
  /** A model of the purpose's provider instead of its configured one. */
  model?: string;
  /** The reasoning effort, over the purpose's own. */
  reasoning?: 'none' | 'minimal' | 'low' | 'medium' | 'high';
  maxTokens?: number;
  /** Run once per item of this list (a path), in parallel; the output is keyed by each item's id. */
  forEach?: string;
  /** Run only when this path finds something (a non-empty list or text, or true); the output is null otherwise. */
  when?: string;
  system: string;
  user: string;
  schema: SchemaNode;
  /** What an answer must hold that a schema cannot say; an answer that fails one is asked for again, told why. */
  checks?: CheckDef[];
  /**
   * Paths to names that must all differ: the step's own (paths starting with its id, into its answer) and those of
   * steps before it. A name of its own that repeats one before it is renamed on its own (names.ts).
   */
  names?: string[];
}

/**
 * Values an answer must hold somewhere: every value of `has` (given, or read from a path) is found at one of the
 * paths `in` (paths into the answer). Without `has`, one of the paths must find something at all (of several fields
 * that may each be nothing, one is there). With `when`, the check is there only when that path finds something.
 */
interface CheckDef {
  /** What is wrong when it fails, said to the model, before the values missing. */
  says: string;
  in: string[];
  has?: (string | number | boolean)[] | { from: string };
  when?: string;
}

/**
 * A schema as a step writes it: a subset of JSON Schema in which every property is required (`nullable: true`
 * makes one optional) and three forms refer to what already exists:
 *   - `enum: { from: <path> }`: the values found there;
 *   - `keys: { from: <path> }` with `each`: an object with one required key per value found, `each` describing
 *     every entry, with `$` the item the key was read from;
 *   - `minItems` and `maxItems` may be `{ from: <path> }`, a number read from there (with `keys`, `$.field`);
 *   - every `description` is a template;
 *   - `when: <path>` on a property or a union member: it is there only when the path finds something (a system
 *     that is on, a list that is not empty), or with `<path>=a|b` one of those values, so a field for what does not
 *     exist is never asked for.
 */
export type SchemaNode = {
  description?: string;
  nullable?: boolean;
  type?: 'string' | 'integer' | 'number' | 'boolean' | 'object' | 'array';
  minLength?: number;
  maxLength?: number;
  pattern?: string;
  minimum?: number;
  maximum?: number;
  /** Values given, or read from a path (texts, numbers, or true and false: an owner's fixed choice is one of them). */
  enum?: (string | number | boolean)[] | { from: string };
  const?: string | number | boolean;
  properties?: Record<string, SchemaNode>;
  items?: SchemaNode;
  minItems?: number | { from: string };
  maxItems?: number | { from: string };
  anyOf?: SchemaNode[];
  keys?: { from: string };
  each?: SchemaNode;
  /** A condition, or a list of conditions of which any one will do. */
  when?: string | string[];
};

/** A schema made concrete for one example: plain JSON Schema, with keyed objects marked, and an object's properties left out by their `when`. */
export type Resolved = Record<string, unknown> & {
  'x-keyed'?: true;
  'x-off'?: string[];
  properties?: Record<string, Resolved>;
  items?: Resolved;
  anyOf?: Resolved[];
};

/** An owner's input to run steps on: a saved example, or a world's own (its id lays out its map, as for a world). */
export interface Example {
  id: string;
  input: WorldInput;
}

export const TOPIC_ABOUT: Record<PromptTopic, string> = {
  story: 'the story',
  places: 'the places',
  people: 'the people',
  monsters: 'the creatures and foes',
  art: 'the art',
  rules: 'the rules',
};
