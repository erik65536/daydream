/**
 * The words given to the models about a person: who they are (the same every turn, so OpenAI caches it), and the
 * scales the judge reads a line on. What is going on now is put together in dialogue.ts: the judge (a decision model)
 * reads it to decide what the person does, and Luna reads the person and the situation, with that decision, to say it.
 * Everything here describes a real person living in their world,
 * never a character in a game: worlds can be cozy, grim, absurd, or modern, and people in all of them talk plainly about
 * their own lives.
 */
import type { NpcDef, WorldDefinition, ZoneDef } from '@daydream/shared';

/** How a person feels about someone, by what they think of them (Regard.value, -100 to 100). */
export function feeling(value: number, reasons: number): string {
  if (value <= -60) return 'cannot stand them';
  if (value <= -25) return 'dislike and distrust them';
  if (value <= -8) return 'are wary of them';
  if (value < 8) return reasons ? 'have mixed feelings about them' : 'do not know them yet';
  if (value < 35) return 'like them';
  if (value < 65) return 'are fond of them and trust them';
  return 'would do almost anything for them';
}

/** The judge's scale for how the person feels after a line, and the value each step stands for. */
export const FEELINGS = ['hostile', 'cold', 'wary', 'neutral', 'warm', 'fond', 'devoted'] as const;
export const FEELING_VALUES = [-80, -50, -20, 0, 25, 55, 85];

/** What the player is doing with a line, as the judge reads it. */
export const MOVES = {
  chat: 'small talk, a question, or asking for news or advice',
  ask: 'asking for something: an item, money, help, a favor, a job',
  bargain: 'haggling over a price, a reward, or terms',
  persuade: 'arguing a case or trying to change their mind',
  claim: 'telling them something about themselves or what they did, to gain something',
  threaten: 'threatening, bullying, or intimidating them',
  insult: 'insulting or mocking them',
  flatter: 'flattering or charming them',
  kind: 'being kind, generous, sympathetic, or helpful',
  farewell: 'saying goodbye',
} as const;
export type Move = keyof typeof MOVES;

/** The places a person knows well enough to give directions to: home (first) and the places next to it. */
export function knownPlaces(w: WorldDefinition, def: NpcDef): ZoneDef[] {
  const home = w.zones.find((z) => z.id === def.zoneId);
  return home ? [home, ...home.links.map((id) => w.zones.find((z) => z.id === id)).filter((z) => !!z)] : [];
}

function places(w: WorldDefinition, def: NpcDef): string {
  const [home, ...near] = knownPlaces(w, def);
  if (!home) return '';
  const first = (t: string) => t.split(/(?<=[.!?])\s/)[0] ?? t;
  const kind = (k: string) => (k === 'town' ? 'a town' : k === 'dungeon' ? 'a dangerous place' : 'the wilds');
  return `Places you know:\n- ${home.name} (home): ${first(home.description)}${near.map((z) => `\n- ${z.name} (${kind(z.kind)}, next to ${home.name}): ${first(z.description)}`).join('')}`;
}

/** Who the person is, for Luna's system prompt: stable across a whole conversation. */
export function personSheet(w: WorldDefinition, def: NpcDef, homeName: string, names: (npcId: string) => string | undefined): string {
  const opinions = def.opinions.map((o) => ({ name: names(o.npcId), text: o.text })).filter((o) => o.name);
  return [
    `You are ${def.name} (${def.pronouns}), ${def.title}, in ${homeName}.`,
    `Who you are: ${def.personality} ${def.backstory}`,
    def.manner ? `How you talk: ${def.manner}` : '',
    def.life.length ? `Your days:\n${def.life.map((l) => `- ${l}`).join('\n')}` : '',
    def.want ? `What you want right now: ${def.want}` : '',
    def.values.likes.length || def.values.dislikes.length ? `What wins you over: ${def.values.likes.join('; ') || 'nothing in particular'}. What you cannot stand: ${def.values.dislikes.join('; ') || 'nothing in particular'}.` : '',
    opinions.length ? `People you know:\n${opinions.map((o) => `- ${o.name}: ${o.text}`).join('\n')}` : '',
    def.knowledge.length ? `Things you know and talk about when they come up:\n${def.knowledge.map((k) => `- ${k}`).join('\n')}` : '',
    def.secrets.length ? 'There are things you keep to yourself. You do not talk about them, hint at them, or invent them; when you choose to share one, you are told what it is.' : '',
    `Where you live: ${w.concept.pitch} The world's mood: ${w.concept.tone}.`,
    places(w, def),
    `HOW YOU TALK
- You're a real person talking to someone right in front of you. Write only the words you say out loud, no stage directions.
- ${w.concept.speech ? `Talk the way this world's owner wants people here to talk: ${w.concept.speech} Keep it easy to follow the first time.` : 'Talk in plain, everyday words that are easy to follow the first time: short sentences, common words, one thing at a time.'}
- Talk like a normal person, not a character in a play. Don't sound like a robot, and don't overact: a bit of your personality now and then is plenty.
- No proverbs, sayings, riddles, speeches, or spooky hints. Don't call people "traveler" or "stranger" unless you really would.
- The world's mood decides what happens to people and how they feel about it, not how hard you act.
- Answer what they just said. Bring up your own worries when they fit, not every time. If you don't know something, say so.
- Be specific: real names, places, and amounts. Don't make up people, places, jobs, or rewards you weren't told about, or what the people in front of you carry, wear, or did.
- If you don't know them, they just got here and know nothing about this place. The first time you mention someone or something, say who or what it is. If you ask for something, say why it matters to you.
- Don't repeat yourself. If they ask again, say it shorter or add something new.
- Keep it short: one to three sentences unless they ask for more. You don't have to end on a question.
- What you do each turn is already decided, and you're told what it is. Your words do exactly that: don't promise, hand over, agree to, or reveal anything else.`,
  ]
    .filter(Boolean)
    .join('\n\n');
}
