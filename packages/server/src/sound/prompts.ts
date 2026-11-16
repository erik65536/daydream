/**
 * What each sound is asked for (docs/sound.md, "Prompts"). The game owns every sound's purpose (its mood, shape and
 * length, the same in every world) and the generator's tags; the build's sounds step (pipeline/steps/sounds.yaml)
 * writes only what this world makes each sound from, how its spells and creatures sound, and each piece of music's
 * style, instruments, and tempo.
 * A prompt is the game's part, then Luna's: "TrackType: SFX, A single very soft short tap with an instant decay, on a
 * hazelnut shell, close and dry, UI sound". The wording was settled by ear in docs/experiments/audio/prompt-study.md.
 */
import { MOMENTS, soundKey, soundSpec, type GameSound, type Moment, type SoundKey, type SoundSpec, type WorldDefinition } from '@daydream/shared';
import type { Records } from '../pipeline/world.ts';

/** Stable Audio 3 Small SFX (sound effects) or Medium (music, and the moments that are small pieces of music). */
export type SoundModel = 'small' | 'medium';

interface MomentPrompt {
  purpose: string;
  model: SoundModel;
  seconds: number;
  /** Made on something with a clear pitch, with no clicks or noise. */
  tonal?: boolean;
  /** Interface feedback: the prompt ends with "UI sound", which keeps it small and simple. */
  ui?: boolean;
  /** What the sounds step is told about its source beyond the general rules. */
  source?: string;
  /** The material of the game's own copy, made once (neutral, fitting most worlds). */
  neutral: string;
}

const TWO = (example: string) => `Two instruments answering each other, such as "${example}".`;

export const MOMENT_PROMPTS: Record<Moment, MomentPrompt> = {
  tap: { purpose: 'A single very soft short tap with an instant decay', model: 'small', seconds: 1, ui: true, neutral: 'on a small wooden block, close and dry' },
  panel_open: { purpose: 'A soft short sound of opening', model: 'small', seconds: 1, ui: true, source: 'Something that opens in this world, such as "of a leather book cover opening, close and dry".', neutral: 'of a leather book cover opening, close and dry' },
  panel_close: { purpose: 'A soft short sound of closing', model: 'small', seconds: 1, ui: true, source: 'What panel_open opens, closing.', neutral: 'of a leather book cover closing, close and dry' },
  refusal: { purpose: 'A short low two-note descending tone that gently says no', model: 'small', seconds: 1, tonal: true, ui: true, neutral: 'as a soft low synth tone, dry' },
  success: { purpose: 'A single short positive ding', model: 'medium', seconds: 1, tonal: true, ui: true, source: 'One simple source, struck once: it is small feedback, not a musical moment.', neutral: 'on a warm marimba bar, clean' },
  level_up: { purpose: 'A single proud ding that rings out, rewarding and positive, simple and clear', model: 'small', seconds: 2, tonal: true, neutral: 'on a large struck crystal glass, clean' },
  gold: { purpose: 'A quick bright jingle of picking up money', model: 'small', seconds: 1, ui: true, neutral: 'of three gold coins clinking, close and dry' },
  take: { purpose: 'A short soft sound of picking up an item', model: 'small', seconds: 1, ui: true, source: 'Something carried in this world, such as "of a cloth pouch lifted, close and dry".', neutral: 'of a leather satchel strap lifted, close and dry' },
  put: { purpose: 'A short soft sound of setting an item down', model: 'small', seconds: 1, ui: true, source: 'What take lifts, set down on a surface.', neutral: 'of a leather satchel set down on a wooden floor, close and dry' },
  legendary: { purpose: 'A short magical shimmer of something precious revealed', model: 'small', seconds: 2, tonal: true, neutral: 'on a celesta with a shimmering string chord, clean' },
  craft: { purpose: 'A short satisfying sound of something made by hand, two or three quick working sounds ending in one settled knock', model: 'small', seconds: 2, source: 'The tools this world makes its gear and remedies with, such as "of a small hammer tapping an anvil, close and dry".', neutral: 'of a small hammer tapping an anvil and a final knock on a wooden bench, close and dry' },
  improve: { purpose: 'A short sound of gear made stronger, one or two firm strokes ending bright and clean', model: 'small', seconds: 2, source: 'How this world hones, tightens, or reinforces its gear, such as "of a whetstone drawn along a blade, close and dry".', neutral: 'of a whetstone drawn twice along a steel blade, close and dry' },
  enchant: { purpose: 'A short magical swell of power flowing into an object, rising to a bright glint', model: 'small', seconds: 2, tonal: true, source: 'A magical sound colored by the magic of this world, not a chime or bell, such as "like an ember brightening with a soft rising hum, close".', neutral: 'like a soft rising hum with a glassy sparkle, close' },
  learn: { purpose: 'A short crisp sound of something clicking firmly into place', model: 'small', seconds: 1, source: 'Something that fits or locks into place in this world, such as "of a wooden puzzle piece pressed firmly into its slot, close and dry".', neutral: 'of a wooden puzzle piece pressed firmly into its slot, close and dry' },
  chest_open: { purpose: 'A short sound of a chest unlatching and its lid opening', model: 'small', seconds: 2, source: 'The container this world keeps treasure in.', neutral: 'of an iron-bound chest unlocking and its heavy lid creaking open, close' },
  quest_accept: { purpose: 'A short curious rising phrase that ends on an open note, an invitation to adventure', model: 'medium', seconds: 3, tonal: true, source: TWO('on a wooden flute answered by a plucked harp, clean'), neutral: 'on a wooden flute answered by a plucked harp, clean' },
  quest_complete: { purpose: 'A short satisfying sound of a task done, two or three warm notes rising to a settled ending, simple and positive', model: 'medium', seconds: 3, tonal: true, source: TWO('on a warm marimba answered by a soft horn, clean'), neutral: 'on a warm marimba answered by a soft French horn, clean' },
  quest_failed: { purpose: 'A short gentle setback, two notes stepping down to an unresolved ending', model: 'medium', seconds: 3, tonal: true, source: TWO('on a low clarinet answered by a soft cello, clean'), neutral: 'on a soft French horn answered by low strings, clean' },
  friend: { purpose: 'A soft friendly two-note chime of someone arriving', model: 'small', seconds: 1, tonal: true, ui: true, neutral: 'on two soft marimba notes, clean' },
  chat: { purpose: 'A very soft short notification blip', model: 'small', seconds: 1, tonal: true, ui: true, neutral: 'as a soft wooden marimba tone, dry' },
  timer_tick: { purpose: 'A single soft short tick', model: 'small', seconds: 1, ui: true, source: 'Something that ticks, such as "of a wooden clock, close and dry".', neutral: 'of a soft wooden metronome, close and dry' },
  my_turn: { purpose: 'A single short clear ready signal', model: 'small', seconds: 1, tonal: true, ui: true, source: 'One simple source, struck once.', neutral: 'on a single soft woodblock and celesta note together, clean' },
  hit: { purpose: 'One short punchy impact of a melee blow', model: 'small', seconds: 1, neutral: 'of a fist striking a heavy sack, close and dry' },
  swing: { purpose: 'A quick whoosh of a weapon swung through the air', model: 'small', seconds: 1, source: 'The weapon most heroes of this world carry.', neutral: 'of a wooden staff swung through the air, close and dry' },
  dodge: { purpose: 'A quick swish of air as a blow narrowly misses', model: 'small', seconds: 1, neutral: 'of a cloth sleeve swishing through air, close and dry' },
  heal: { purpose: 'A short soft rising shimmer of healing', model: 'small', seconds: 2, tonal: true, neutral: 'on a soft choir pad with a glassy shimmer, clean' },
  status_harmful: { purpose: 'A quick dark spell effect of a curse taking hold, a low wavering magical swell that sinks down', model: 'small', seconds: 2, source: 'A magical sound, not a physical object tearing, scraping, or breaking: a low hum, a dark breathy swell, or a detuned drone, colored by this world, such as "like a cold draft through a cellar door, close".', neutral: 'like a low hum from a dark cave, close' },
  status_helpful: { purpose: 'A quick spell burst of protection, a soft rising whoosh of air with a gentle magical shimmer', model: 'small', seconds: 2, source: 'A magical sound, not a chime, bell, or ding: a soft airy swell, a warm hum, or a gentle sparkle of energy, colored by this world, such as "like warm air rising from a hearth, close".', neutral: 'like warm light swelling through a window, close' },
  hero_falls: { purpose: 'A soft heavy thud of a body slumping to the ground', model: 'small', seconds: 2, source: 'A body and its clothes on the ground of this world, such as "of a person in a wool cloak slumping onto earth, close and muffled"; never rocks, metal, or hard objects striking.', neutral: 'of a body and cloak collapsing onto a wooden floor, close and muffled' },
};

const CAST = 'A quick spell burst';
const CRY = 'One short angry cry of a creature ready to fight';
const HIT = 'One short punchy impact';
const HEAVY = 'One heavy crushing impact';
const DEATH = 'One short dying cry of a defeated creature, fading away';
const AMBIENCE = 'A steady continuous ambience';
const AMBIENCE_END = 'no sudden sounds, no voices, no music';

/** Each piece of music: its mood (the game's), where it plays, its length, and whether it carries a genre tag (long pieces do). */
const CUES = {
  theme: { mood: 'a memorable main theme, a simple melody stated, built up, and returned to', where: 'on the title screen of', seconds: 45, long: true },
  place: { mood: 'a short calm cue that sets the scene and settles quietly', where: 'when the player first arrives in a new place in', seconds: 10, long: false },
  boss: { mood: 'urgent, driving, and dangerous battle music at a steady tempo', where: 'during a boss fight in', seconds: 64, long: true },
  defeat: { mood: 'a short sad falling phrase that ends quietly, a gentle sense of loss', where: "when the player's party is defeated in", seconds: 8, long: false },
} as const;

const MOMENT_IDS = Object.keys(MOMENTS) as Moment[];

/** The sounds step's answer for a world (pipeline/steps/sounds.yaml): each entry keyed by what it is for. */
export type SoundPlan = Records['sounds'];
type Piece = SoundPlan['music']['theme'];

/** One sound to make: its key, the prompt, the model and length, how it is made game-ready, and a loop's tempo. */
export interface SoundOrder {
  key: SoundKey;
  prompt: string;
  model: SoundModel;
  seconds: number;
  spec: SoundSpec;
  bpm?: number;
}

/** The plan's phrases continue a sentence the game starts. */
const lower = (s: string) => (s.charAt(0).toLowerCase() + s.slice(1)).trim().replace(/[.,]$/, '');
const sfx = (text: string) => `TrackType: SFX, ${text}`;

function momentPrompt(id: Moment, materialText: string): string {
  const m = MOMENT_PROMPTS[id];
  return sfx(`${m.purpose}, ${lower(materialText)}${m.ui ? ', UI sound' : ''}`);
}

function music(cue: keyof typeof CUES, p: Piece, game: { kind: string; genre: string }): { prompt: string; seconds: number; bpm: number } {
  const c = CUES[cue];
  const instruments = lower(p.instruments).replace(/^with /i, '');
  return {
    prompt: `TrackType: Music, VocalType: Instrumental, ${c.long ? `Genre: ${game.genre}, ` : ''}${p.style.trim()} with ${instruments}: ${c.mood}. ${p.bpm} BPM. It plays ${c.where} ${game.kind}.`,
    seconds: c.seconds,
    bpm: p.bpm,
  };
}

/** Every sound of a world, from its plan: the game's moments, each kind of damage, family and place, and the music. */
export function worldOrders(w: WorldDefinition, a: SoundPlan): SoundOrder[] {
  const out: SoundOrder[] = [];
  const add = (key: SoundKey, o: Omit<SoundOrder, 'key' | 'spec'>) => out.push({ key, spec: soundSpec(key)!, ...o });
  for (const id of MOMENT_IDS) if (a.materials[id]) add(id, { prompt: momentPrompt(id, a.materials[id]), model: MOMENT_PROMPTS[id].model, seconds: MOMENT_PROMPTS[id].seconds });
  for (const t of w.ruleset.damageTypes) {
    const el = a.elements[t.name];
    if (!el) continue;
    add(soundKey('cast', t.id), { prompt: sfx(`${CAST} ${lower(el.sound)}`), model: 'small', seconds: 2 });
    add(soundKey('hit', t.id), { prompt: sfx(`${HIT} ${lower(el.hit)}`), model: 'small', seconds: 1 });
    add(soundKey('heavy', t.id), { prompt: sfx(`${HEAVY} ${lower(el.hit)}`), model: 'small', seconds: 1 });
  }
  for (const f of w.families) {
    const s = a.families[f.id];
    if (!s) continue;
    add(soundKey('cry', f.id), { prompt: sfx(`${CRY}, ${lower(s.cry)}`), model: 'small', seconds: 2 });
    add(soundKey('death', f.id), { prompt: sfx(`${DEATH}, ${lower(s.death)}`), model: 'small', seconds: 2 });
  }
  for (const z of w.zones) if (a.ambience[z.id]) add(soundKey('ambience', z.id), { prompt: sfx(`${AMBIENCE} ${lower(a.ambience[z.id]!)}, ${AMBIENCE_END}`), model: 'small', seconds: 30 });
  const game = { kind: a.gameKind.trim(), genre: a.genreTag.trim() };
  add('theme', { ...music('theme', a.music.theme, game), model: 'medium' });
  add('defeat', { ...music('defeat', a.music.defeat, game), model: 'medium' });
  for (const z of w.zones) if (a.music.places[z.id]) add(soundKey('place', z.id), { ...music('place', a.music.places[z.id]!, game), model: 'medium' });
  for (const b of w.bosses) if (a.music.bosses[b.name]) add(soundKey('boss', b.id), { ...music('boss', a.music.bosses[b.name]!, game), model: 'medium' });
  return out;
}

/**
 * The game's own sounds (made once, neutral; docs/sound.md, "The game's own sounds"). Not the theme: it was composed
 * elsewhere and brought in with `soundkit --use`.
 */
export function gameOrders(): (SoundOrder & { key: Exclude<GameSound, 'theme'> })[] {
  const moments = MOMENT_IDS.map((id) => ({ key: id, spec: soundSpec(id)!, prompt: momentPrompt(id, MOMENT_PROMPTS[id].neutral), model: MOMENT_PROMPTS[id].model, seconds: MOMENT_PROMPTS[id].seconds }));
  return [
    ...moments,
    { key: 'cast', spec: soundSpec('cast:x')!, prompt: sfx(`${CAST} of magic, a soft swirling whoosh of energy, close`), model: 'small', seconds: 2 },
    { key: 'fight', spec: soundSpec('cry:x')!, prompt: sfx('A short tense sound of a fight beginning, a low drum strike under a rising swell, close'), model: 'small', seconds: 2 },
  ];
}
