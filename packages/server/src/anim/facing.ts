/**
 * Which way painted figures face. The game draws SW, W, and NW as painted and mirrors them for SE, E, and NE, so every
 * figure painted in those views, standing in the turnaround or acting in a clip sheet, must face and act toward the
 * picture's left. The image model gets this wrong now and then: in the first world animated with turnarounds, 7 of 45
 * NW cells (and one SW cell) faced the picture's right, so that actor walked up-right when it went up-left; and an
 * attack, which the model likes to draw side-on toward the picture's right, turned that way in about a third of the
 * W sheets of the worlds animated in November 2026 (a rifle fired to the right, a kick to the right). The mirror of a
 * figure facing the wrong way is the right one, so such a cell is mirrored rather than painted again.
 *
 * The checker (Luna's decision model) says which side of the picture each figure is turned toward. Its confident
 * "right" (at least 80%) was right in every case checked by eye; what it was unsure of were near-straight back views
 * (a teacup for a head, a figure walking almost straight away), where a mirror would barely show.
 */
import sharp from 'sharp';
import { genai } from '../genai/service.ts';
import type { View } from './paint.ts';

/** The painted views that face the picture's left (their mirrors face its right). */
export const LEFT_VIEWS: View[] = ['SW', 'W', 'NW'];

/** How sure the checker must be that a figure faces the picture's right before it is mirrored. */
const SURE = 0.8;

/**
 * What the checker is asked of a figure: a standing view of the turnaround, or a frame of a clip sheet, where a blow,
 * shot, or spell may go another way than the body (a rifle fired toward the right from a body turned left).
 */
const ASK = {
  standing: {
    state: 'One view of a game character from a turnaround sheet, on a gray background.',
    instructions: 'Which side of the picture is the character turned toward? Judge by where its face, chest, and toes point; seen from behind, by where its head is turned and its toes point.',
  },
  acting: {
    state: "One frame of a game character's animation, on a gray background.",
    instructions: 'Which side of the picture is the character turned toward? Where it strikes, aims, throws, or casts, judge by where that goes; otherwise by where its face, chest, and toes point, or seen from behind, by where its head is turned and its toes point.',
  },
};
type Pose = keyof typeof ASK;

/** Whether a figure (on transparency) faces the picture's right, by the checker; false when there is no checker. */
async function facesRight(figure: Buffer, pose: Pose): Promise<boolean> {
  const g = genai();
  if (!g.configured('image.check')) return false;
  const img = await sharp(figure).flatten({ background: '#808080' }).resize(512, 512, { fit: 'inside' }).png().toBuffer();
  try {
    const a = await g.decide('image.check', {
      state: ASK[pose].state,
      images: [img],
      questions: {
        facing: {
          type: 'choice',
          instructions: ASK[pose].instructions,
          criteria: { left: 'toward the left edge of the picture', right: 'toward the right edge of the picture', neither: 'straight toward or straight away from the viewer' },
        },
      },
    });
    const f = a.facing;
    return f?.type === 'choice' && (f.probabilities.right ?? 0) >= SURE;
  } catch (e) {
    console.warn('[anim] facing check failed:', (e as Error).message);
    return false;
  }
}

/** A cell's rectangle in a sheet of cols × rows cells. */
function cellBox(width: number, height: number, cols: number, rows: number, i: number) {
  const cw = Math.floor(width / cols), ch = Math.floor(height / rows);
  return { left: (i % cols) * cw, top: Math.floor(i / cols) * ch, width: cw, height: ch };
}

/**
 * A sheet of cols × rows cells with every one of `cells` (all by default) that faces the picture's right mirrored in
 * place, and which cells those were.
 */
export async function faceLeft(sheet: Buffer, cols: number, rows: number, pose: Pose, cells?: number[]): Promise<{ png: Buffer; mirrored: number[] }> {
  const { width, height } = (await sharp(sheet).metadata()) as { width: number; height: number };
  const which = cells ?? Array.from({ length: cols * rows }, (_, i) => i);
  const flips = await Promise.all(which.map(async (i) => facesRight(await sharp(sheet).extract(cellBox(width, height, cols, rows, i)).png().toBuffer(), pose)));
  const mirrored = which.filter((_, j) => flips[j]);
  return { png: mirrored.length ? await mirrorCells(sheet, cols, rows, mirrored) : sheet, mirrored };
}

/** A sheet of cols × rows cells with the given cells mirrored in place. */
async function mirrorCells(sheet: Buffer, cols: number, rows: number, which: number[]): Promise<Buffer> {
  const { width, height } = (await sharp(sheet).metadata()) as { width: number; height: number };
  const cells = await Promise.all(
    Array.from({ length: cols * rows }, async (_, i) => {
      const box = cellBox(width, height, cols, rows, i);
      const c = sharp(sheet).extract(box);
      return { input: await (which.includes(i) ? c.flop() : c).png().toBuffer(), left: box.left, top: box.top };
    }),
  );
  return sharp({ create: { width, height, channels: 4, background: { r: 0, g: 0, b: 0, alpha: 0 } } }).composite(cells).png().toBuffer();
}
