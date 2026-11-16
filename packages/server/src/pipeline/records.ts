/**
 * The game's records the pipeline fills, and the shape each accepts. pipeline/records.yaml names the output that
 * fills each one (a path); a record's own code turns that shape into game data. A field of an output that a record
 * does not take, and no step reads, is shown as unread.
 *
 * Ids are the engine's (a place's, a story person's, a resident's, an arc's); names that refer to things the rules
 * made (a damage type, a weapon, a status) are those names, as the steps chose them from what exists. Every choice
 * from a fixed list is the game's own list (rules/vocabulary.ts, shared), so a record cannot drift from the game.
 */
import { FIGHTER_KINDS, FX_BLASTS, FX_MOTIONS, FX_RUSHES, FX_SHAPES, FX_SHOTS, FX_TRAILS } from '@daydream/shared';
import { z } from 'zod';
import { RULES_VOCABULARY as V } from '../rules/vocabulary.ts';

const hex = z.string().regex(/^#[0-9a-fA-F]{6}$/);
/** A creature's or boss's kind of fighter, and the class it fights as. */
const fighter = z.enum(FIGHTER_KINDS);
const fightsAs = z.enum(['physical_melee', 'physical_ranged', 'magic_melee', 'magic_ranged', 'healer', 'buff_and_debuff']);
const text = z.string();
const id = (what: string) => z.string().describe(`${what}'s id`);
const person = id('a person');
const place = z.string().describe("a place's name");
/** Entries keyed by the engine's ids. */
const keyed = <T extends z.ZodType>(of: T, what: string) => z.record(z.string(), of).describe(`one per ${what}, keyed by its id`);
/** Entries keyed by names the rules made. */
const named = <T extends z.ZodType>(of: T, what: string) => z.record(z.string(), of).describe(`one per ${what}, keyed by its name`);

const heroClass = z.object({ name: text, description: text });
/** A healer or buff and debuff class, which attacks up close or from a distance. */
const supportClass = heroClass.extend({ reach: z.enum(['melee', 'ranged']) });
/** A kind of damage's classes, melee, ranged, or both, with the damage they deal. */
const damageClasses = z.object({ damage: z.object({ name: text, color: hex, defence: text }), melee: heroClass.nullish(), ranged: heroClass.nullish() });
/** What a status increases or decreases, by kind of damage and defense where the world has both. */
const STATUS_STATS = ['physical_damage', 'magic_damage', 'physical_defence', 'magic_defence', 'movement', 'dodge', 'crit_chance'] as const;
/** What a status does: increases or decreases a stat, or harms, heals, or controls. */
const statusEffect = z.union([
  z.object({ increases: z.enum(STATUS_STATS) }),
  z.object({ decreases: z.enum(STATUS_STATS) }),
  z.enum(['physical_damage_over_time', 'magic_damage_over_time', 'heal_over_time', 'stun', 'root', 'silence', 'disarm', 'thorns', 'life_steal']),
]);
const condition = { name: text, color: hex, description: text };
/** Where players keep what they do not carry: nowhere, in each town's own store, or in one every town shares. */
export const STORAGES = ['none', 'each_town', 'shared'] as const;
/** A class's names for the class keys of the rules steps: physical_melee and the rest. */
export const CLASS_KEYS = ['physical_melee', 'physical_ranged', 'magic_melee', 'magic_ranged', 'healer', 'buff_and_debuff'] as const;
/** What a skill does, each from the step's fixed list or a status by name and whom it goes on. */
const skillEffect = z.union([z.enum(['damage', 'physical_damage', 'magic_damage', 'heal', 'removes_statuses', 'revive', 'life_steal', 'dash']), z.object({ status: text, on: z.enum(['enemies', 'allies', 'self']) })]);
const skill = z.object({ name: text, description: text, target: z.enum(['enemy', 'ally', 'self']), area: z.enum(['single', 'small', 'large']), effects: z.array(skillEffect) });
const PASSIVE_EFFECTS = ['health', 'physical_defence', 'magic_defence', 'skill_damage', 'skill_power', 'dodge', 'crit_chance'] as const;
const weapon = z.object({ name: text, description: text, damage: z.enum(['physical_damage', 'magic_damage']).optional() });
const armorKind = z.object({ description: text, pieces: z.record(z.string(), text).describe('keyed by armor slot') });
/** Something the rules name and describe: a consumable, a valuable, a material, a craft. */
const thing = z.object({ name: text, description: text });
/** A buff (for allies) or a debuff (for enemies). */
const statusOf = z.object({ ...condition, kind: z.enum(['buff', 'debuff']), effects: z.array(statusEffect) });

/** What the heroes do in a step of a quest, main or side, with everything it names chosen from what exists. */
const persuade = z.object({ kind: z.literal('persuade'), person, to: text });
const bring = z.object({ kind: z.literal('bring'), item: text, from: place, to: person.nullable() });
const fight = z.object({ kind: z.literal('fight'), where: place, foes: z.string().describe("a creature family's name") });
const foe = z.object({ kind: z.literal('foe'), name: text, who: text, member: z.string().describe("a creature's name, of one of the families"), where: place, taunt: text, voice: text });
const questStep = z.discriminatedUnion('kind', [
  persuade, bring, fight, foe,
  // Players choose: fight (and take what the fight wins), or a clever way someone knows.
  z.object({ kind: z.literal('either'), fight: z.array(z.discriminatedUnion('kind', [fight, foe, bring])), otherwise: persuade }),
  z.object({ kind: z.literal('boss'), name: text, who: text, where: place, classes: z.array(fightsAs).describe('one, or two it mixes'), looks: text, taunt: text, voice: text }),
]);
const quest = z.object({ title: text, giver: person, background: text, steps: z.array(questStep) });

const look = z.object({ shapes: z.array(z.enum(FX_SHAPES)), colors: z.array(hex), glow: z.boolean(), motion: z.enum(FX_MOTIONS), trail: z.enum(FX_TRAILS) });
const moves = z.object({ rush: z.enum(FX_RUSHES), shot: z.enum(FX_SHOTS), blast: z.enum(FX_BLASTS) });
const piece = z.object({ style: text, instruments: text, bpm: z.number() });

const life = z.object({
  want: text,
  life: z.array(text),
  manner: text,
  likes: z.array(text),
  dislikes: z.array(text),
  opinions: z.array(z.object({ of: person, text })),
  knowledge: z.array(text),
  secrets: z.array(z.object({ text, tellsWhen: text, stash: z.object({ place, thing: text }).nullable() })),
  greeting: text,
  returning: z.object({ warm: text, plain: text, cold: text }),
  barks: z.array(text),
});
const looksAndVoice = { pronouns: text, personality: text, appearance: text, backstory: text, voice: text };

export const RECORDS = {
  ownerStyle: z.object({ speech: text.nullable().describe("how the owner wants people to talk, in their words") }),
  concept: z.object({ title: text, genre: text, setting: text, tone: text }),
  art: z.object({
    artStyle: text,
    palette: z.object({ primary: hex, secondary: hex, accent: hex }),
    interface: z.object({ material: z.enum(V.ui.materials), ornament: z.enum(V.ui.ornaments), typeface: z.enum(V.ui.typefaces), tint: hex, mood: z.enum(V.ui.moods) }),
  }),
  places: keyed(z.object({ name: text, description: text, indoor: z.boolean(), size: z.string().describe('its map in tiles, as "columns x rows"') }), 'place'),

  // The rules, compiled together into the world's ruleset.
  rulesSystems: z.object({
    crafting: z.boolean(), upgrades: z.boolean(), enchanting: z.boolean(), control: z.boolean(), crit: z.boolean(), dodge: z.boolean(),
    fastTravel: z.boolean(), lifeSteal: z.boolean(), thorns: z.boolean(), regeneration: z.boolean(), healing: z.boolean(), shields: z.boolean(), magic: z.boolean(),
    revive: z.enum(V.revives),
    storage: z.enum(STORAGES),
    defeat: z.object({ loseExperience: z.boolean(), loseMoney: z.boolean(), recoverBody: z.boolean() }),
    potions: z.object({ healing: z.boolean(), cleansing: z.boolean(), buffs: z.boolean(), debuffs: z.boolean(), bombs: z.boolean() }),
    swing: z.enum(V.variances),
  }),
  rulesCore: z.object({
    name: text,
    words: z.object({ health: text, experience: text, level: text, money: text, party: text, quest: text, town: text, wilds: text, dungeon: text, race: text, class: text, talent_point: text, talent_points: text, magic: text.nullish() }),
    healthColor: hex,
    numbers: z.enum(V.numbers),
    races: z.array(z.object({ name: text, description: text, look: text, names: z.array(text).describe('example first names') })),
    classes: z.object({ physical: damageClasses, magical: damageClasses.nullish(), healer: supportClass.nullish(), buff_and_debuff: supportClass.nullish() }),
    slots: z.object({ weapon: text, offhand: text.nullish(), armor: z.array(text), accessories: z.array(text) }),
    qualities: z.object({ common: text, uncommon: text, rare: text, epic: text, legendary: text }),
  }),
  rulesStatuses: z.object({ statuses: z.array(statusOf) }),
  rulesSkills: z.record(z.string(), z.record(z.string(), z.array(skill))).describe("each class's active skills, keyed by class and then by tier"),
  rulesPassives: z.record(z.string(), z.record(z.string(), z.array(z.object({ name: text, effects: z.array(z.enum(PASSIVE_EFFECTS)) })))).describe("each class's passives, keyed by class and then by tier"),
  rulesGear: z.object({
    weapons: z.record(z.string(), z.object({ weapon: weapon.optional(), one_handed: weapon.optional(), two_handed: weapon.optional() })).describe('the weapons of each class'),
    shields: z.array(z.object({ name: text, description: text })).nullish(),
    armor: z.object({ balanced: armorKind, sturdy: armorKind.nullable(), nimble: armorKind.nullable() }),
    accessories: z.record(z.string(), z.array(z.object({ name: text, description: text }))).nullish().describe('keyed by accessory slot'),
  }),
  rulesItems: z.object({
    healing: thing.nullish(),
    cleansing: thing.nullish(),
    buffs: z.array(thing.extend({ status: text })).nullish(),
    debuffs: z.array(thing.extend({ status: text })).nullish(),
    bombs: z.object({ physical: thing, magic: thing.nullish() }).nullish(),
    valuables: z.array(thing),
    materials: z.object({ hard: thing.nullish(), soft: thing.nullish(), essence: thing.nullish(), reagent: thing.nullish() }),
    crafts: z.object({ craft: thing.nullish(), brew: thing.nullish(), upgrade: thing.nullish(), enchant: thing.nullish() }),
  }),
  fightLooks: z.object({ damageTypes: named(look, 'kind of damage'), moves: named(moves, 'kind of damage'), healing: look, statuses: named(look, 'status') }),

  creatures: keyed(z.object({ name: text, description: text, lives: z.array(place), members: z.array(z.object({ fighter, class: fightsAs, name: text, description: text, appearance: text })) }), 'family'),
  story: z.object({
    cast: keyed(z.object({ name: text, who: text }), 'story person'),
    arcs: keyed(z.object({ title: text, quests: z.array(quest) }), 'arc'),
  }),
  telling: z.object({ pitch: text, intro: text, arcs: keyed(z.object({ closing: text }), 'arc'), ending: text, narratorVoice: text }),
  towns: keyed(
    z.object({
      cast: keyed(z.object({ title: text, ...looksAndVoice }), 'story person of the town'),
      residents: keyed(z.object({ name: text, title: text, ...looksAndVoice }), 'resident'),
      buildings: z.array(z.object({ name: text, purpose: text, keeper: person.nullable() })),
      sign: text,
      quests: keyed(quest, 'side quest'),
    }),
    'town',
  ),
  areas: keyed(z.object({ notes: keyed(z.object({ title: text, what: text, text }), 'note') }), 'wild place or dungeon'),
  people: keyed(z.object({ cast: keyed(life, 'story person of the town'), residents: keyed(life, 'resident') }), 'town'),
  sounds: z.object({
    soundtrack: text,
    gameKind: text,
    genreTag: text,
    materials: z.record(z.string(), text).describe("one per game moment, keyed by the moment's id"),
    elements: named(z.object({ sound: text, hit: text }), 'kind of damage'),
    families: keyed(z.object({ cry: text, death: text }), 'creature family'),
    ambience: keyed(text, 'place'),
    music: z.object({ theme: piece, defeat: piece, places: keyed(piece, 'place'), bosses: named(piece, 'boss') }),
  }),
} satisfies Record<string, z.ZodType>;

export type RecordName = keyof typeof RECORDS;
