import { describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { alignPlan, planFrame } from '../src/worldgen/mapalign.ts';

/** A map of rooms with thin walls (white floor, dark walls, some furniture), as an SVG drawn at `w` × `h`. */
function rooms(w: number, h: number, x0 = 0, y0 = 0, sx = 1, sy = 1): string {
  const r: string[] = [];
  let seed = 7;
  const rnd = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
  for (let j = 0; j < 6; j++)
    for (let i = 0; i < 9; i++) {
      const x = 40 + i * 150 + rnd() * 30, y = 40 + j * 140 + rnd() * 30, cw = 90 + rnd() * 40, ch = 80 + rnd() * 40;
      r.push(`<rect x="${x}" y="${y}" width="${cw}" height="${ch}" fill="none" stroke="#202020" stroke-width="5"/>`);
      r.push(`<rect x="${x + 20 + rnd() * 30}" y="${y + 20 + rnd() * 30}" width="${15 + rnd() * 20}" height="${10 + rnd() * 20}" fill="#303030"/>`);
    }
  return `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}"><rect width="${w}" height="${h}" fill="#e8e8e8"/><g transform="translate(${x0} ${y0}) scale(${sx} ${sy})">${r.join('')}</g></svg>`;
}

describe('lining a plan up with its painting', () => {
  it('finds a plan drawn shifted and stretched, and moves it back', async () => {
    const W = 1456, H = 960;
    const painting = await sharp(Buffer.from(rooms(W, H))).png().toBuffer();
    // The plan as an image model might draw it: 16 px up, 6 px left, 1.5% wider and 1% shorter.
    const plan = await sharp(Buffer.from(rooms(W, H, -6, -16, 1.015, 0.99))).png().toBuffer();
    const f = await planFrame(painting, plan);
    // A painting point (x, y) is found in the plan at (x', y'): check the corners and the middle.
    for (const [x, y] of [[100, 100], [1350, 100], [100, 860], [1350, 860], [728, 480]] as const) {
      const px = f.ax[0] + f.ax[1] * x + f.ax[2] * y, py = f.ay[0] + f.ay[1] * x + f.ay[2] * y;
      expect(Math.abs(px - (x * 1.015 - 6))).toBeLessThan(1.5);
      expect(Math.abs(py - (y * 0.99 - 16))).toBeLessThan(1.5);
    }
    // Moved back, the plan's walls lie on the painting's.
    const back = await alignPlan(painting, plan);
    const dark = async (png: Buffer) => (await sharp(png).flatten({ background: '#e8e8e8' }).greyscale().raw().toBuffer()).map((v) => (v < 100 ? 1 : 0));
    const [a, b] = await Promise.all([dark(painting), dark(back)]);
    let both = 0, either = 0;
    for (let i = 0; i < a.length; i++) (both += a[i]! & b[i]!), (either += a[i]! | b[i]!);
    expect(both / either).toBeGreaterThan(0.6);
  });

  it('leaves a plan that already lines up where it is', async () => {
    const painting = await sharp(Buffer.from(rooms(1184, 1184))).png().toBuffer();
    const f = await planFrame(painting, painting);
    expect(f.ax[0]).toBeCloseTo(0, 0);
    expect(f.ay[0]).toBeCloseTo(0, 0);
    expect(f.ax[1]).toBeCloseTo(1, 3);
    expect(f.ay[2]).toBeCloseTo(1, 3);
  });
});
