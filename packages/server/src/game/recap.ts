/**
 * "The story so far": for a player coming back to an adventure that moved on without them, a short recap of what the
 * shared journal says happened meanwhile. The narration model writes it; without one the journal's own lines serve.
 */
import type { JournalEntry, WorldDefinition } from '@daydream/shared';
import { genai } from '../genai/service.ts';

/** Journal entries worth a recap: the story and quests, not every discovery or level. */
export const recapWorthy = (e: JournalEntry) => e.kind === 'story' || e.kind === 'quest' || (e.kind === 'combat' && /^Defeated /.test(e.text));

/** `onText` gets the recap so far as it is written (it streams). */
export async function storySoFar(world: WorldDefinition, entries: JournalEntry[], reader: string, onText?: (soFar: string) => void): Promise<string> {
  const lines = entries.map((e) => `Day ${e.day}: ${e.text}`);
  const plain = entries.slice(-6).map((e) => e.text).join(' ');
  const g = genai();
  if (!g.configured('narration')) return plain;
  try {
    const text = await g.text('narration', {
      system: `You write the "story so far" for a player returning to a role-playing game, in the world's voice: second person ("while you were away"), 2-4 short sentences, plain words, past tense. Only what the notes say; no game numbers.`,
      messages: [{ role: 'user', content: `World: "${world.concept.title}" — ${world.concept.pitch}\nThe player's hero: ${reader}.\nWhat happened while they were away:\n${lines.slice(-24).join('\n')}` }],
      maxTokens: 220,
    }, onText);
    return text.trim() || plain;
  } catch (e) {
    console.warn('[recap] failed, using the journal:', (e as Error).message);
    return plain;
  }
}
