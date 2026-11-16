/** What an owner gives to build a world, as the server accepts it (and the build pipeline's examples are checked). */
import { z } from 'zod';
import { GAME_LENGTHS, PROMPT_TOPICS, WORLD_SIZES, type RulesChoices } from '@daydream/shared';

const on = z.boolean().optional();

/** The systems an owner fixed (RulesChoices): the rules systems step's answer, any part of it left out. */
const RulesChoicesSchema: z.ZodType<RulesChoices> = z
  .object({
    revive: z.enum(['heal', 'special', 'after_combat']).optional(),
    defeat: z.object({ loseExperience: on, loseMoney: on, recoverBody: on }).strict().optional(),
    crit: on,
    dodge: on,
    control: on,
    crafting: on,
    upgrades: on,
    enchanting: on,
    lifeSteal: on,
    thorns: on,
    regeneration: on,
    healing: on,
    shields: on,
    magic: on,
    fastTravel: on,
    potions: z.object({ healing: on, cleansing: on, buffs: on, debuffs: on, bombs: on }).strict().optional(),
    storage: z.enum(['none', 'each_town', 'shared']).optional(),
  })
  .strict();

export const WorldInputSchema = z.object({
  theme: z.string().trim().min(10, 'Describe the theme in at least a sentence.').max(4000),
  prompts: z.array(z.object({ topic: z.enum(PROMPT_TOPICS), text: z.string().trim().min(1).max(2000) })).max(12).optional(),
  size: z.enum(WORLD_SIZES),
  length: z.enum(GAME_LENGTHS),
  communication: z.coerce.number().int().min(0).max(3).transform((n) => n as 0 | 1 | 2 | 3),
  rules: RulesChoicesSchema.optional(),
  animate: z.boolean().optional(),
}).strict();
