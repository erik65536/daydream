/**
 * Who a model call is for, carried through async code: how urgent it is (a player waiting on an NPC beats a
 * world build) and whom to tell while it waits for a busy or unreachable model.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import type { Purpose } from './types.ts';

/** A player waiting in a game; an owner waiting on the creation page (the review before a build); everything else. */
export type Priority = 'interactive' | 'owner' | 'background';
export const PRIORITY_RANK: Record<Priority, number> = { interactive: 0, owner: 1, background: 2 };

interface CallContext {
  priority: Priority;
  /** Told why the call is waiting (null when it goes ahead again). */
  onWait?: (why: string | null) => void;
  /** Whose budget pays for it (unset: the server's own). */
  userId?: string;
  /** Which job it is for: shown on the admin GPU page and carried in ComfyUI prompts. */
  tag?: { jobId?: string; worldId?: string; kind?: string };
  /** The job was asked to stop: long waits (a ComfyUI prompt, an animator step) give up. */
  cancelled?: () => boolean;
  /** The step of the job this call is for (genai/meter.ts counts its cost to it). */
  step?: string;
  /** The purpose the gateway is calling for. */
  purpose?: Purpose;
  /** Told what each paid call cost, as it is charged (the build pipeline's runs count their own spend). */
  onUsage?: (u: ChargedUsage) => void;
}

/** One call's tokens and dollars. */
interface ChargedUsage {
  usd: number;
  input: number;
  cached: number;
  output: number;
  reasoning: number;
}

const store = new AsyncLocalStorage<CallContext>();

export const withCallContext = <T>(ctx: CallContext, fn: () => T): T => store.run(ctx, fn);
export const callContext = (): CallContext | undefined => store.getStore();

/** Calls made while playing are interactive unless the caller says otherwise. */
export function priorityOf(purpose: Purpose): Priority {
  const ctx = store.getStore();
  if (ctx) return ctx.priority;
  return purpose.startsWith('npc.') || purpose === 'narration' ? 'interactive' : 'background';
}
