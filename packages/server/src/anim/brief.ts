/**
 * An actor's animation brief, written once by the prompt writer (Luna) from its painting and description: its body
 * (every part the image model must keep in every frame and view, and the parts it lacks where that could be
 * mistaken), how it gets about, and the four key poses of each clip. The image model paints exactly what the words
 * say: a stapler monster animated from "stalking on its crooked legs" grew legs its painting did not have, and one
 * whose description never named its legs lost them in every view, so the words come from the painting.
 */
import sharp from 'sharp';
import { z } from 'zod';
import { LOCOMOTIONS } from '@daydream/shared';
import { genai } from '../genai/service.ts';

export const Brief = z.object({
  body: z.string().max(260).describe('What the character is and every body part the painting shows that must appear in every frame and view (legs and how many, arms, wings, tail, head, what it holds), and parts it does NOT have when that could be mistaken (e.g. "no legs: it floats")'),
  locomotion: z.enum(LOCOMOTIONS).describe('How it gets about'),
  move: z.string().max(260).describe('The four key poses of one loop of its movement, in order, separated by semicolons'),
  attack: z.string().max(260).describe('The four key poses of its attack, in order: wind-up, strike, the moment of impact or release at full reach, recovery'),
  hit: z.string().max(220).describe('The four key poses of being struck: the jolt, the stagger or recoil, the low point, recovering'),
  death: z.string().max(260).describe('The four key poses of dying, in order, the last one lying still on the ground or (for something that floats or is made of light or spirit) all but vanished'),
});
export type AnimBrief = z.infer<typeof Brief>;

/** Write the brief of an actor from its painting (with alpha) and its description and role. */
export async function writeBrief(painting: Buffer, desc: string, role: string, style: string): Promise<AnimBrief> {
  const img = await sharp(painting).flatten({ background: '#ffffff' }).resize(768, 768, { fit: 'inside' }).png().toBuffer();
  return genai().structured('image.prompt', {
    system: 'You are the animator of a 2D top-down RPG. An image model paints every animation frame from your words, and it paints exactly what the words say, so you write plainly and concretely.',
    prompt: `The picture is a character of the game: ${desc}${role ? ` (${role})` : ''}. Art style of the world: ${style.slice(0, 200)}.

Write its animation brief. An image model will paint four animations of this character, each as four frames, in several facings (front, side, back), from your words and a copy of this painting:
- body: name every part of its body that the painting shows and that must appear in every frame and every view (how many legs, arms, wings, tails; its head or face; what it carries and in which hand), and say plainly what it does not have when that could be mistaken (a stapler on legs has legs; a ghost has no legs and floats). The image model leaves out anything you do not name.
- locomotion: how it gets about, true to its body: a thing with legs walks, crawls, or hops; a fish swims; a light or spirit floats; a winged thing flies; a swarm swarms; a rigid object without legs hops, scoots, or slides, and rolls only if it is round.
- move, attack, hit, death: the four key poses of each, in order, separated by semicolons, each pose one short concrete clause about what the body does ("left foot forward, arms swinging"; "claws raised high"). Fit the body: no walking legs on something that floats, no hands on something without them. The attack uses what it really has (its weapon, claws, jaws, tongue, its light, a breath) and may show a small effect at the moment of impact (a flash, dust, sparks, a burst) that belongs to it. A swarm moves, attacks and dies as a group. Death ends lying still on the ground, or for light or spirit almost vanished.
Never use direction words (left, right, toward the viewer): the facing is given separately. No camera, text, or background.`,
    schema: Brief,
    name: 'animation_brief',
    images: [img],
    maxTokens: 6000,
  });
}
