import { describe, expect, it } from 'vitest';
import type { ActorAnim } from '@daydream/shared';
import { FADE, advance, fadeOf, frameOf, newMotion, playOnce, rowOf } from '../src/render/actors';

const anim: ActorAnim = {
  body: 'walks', scale: 2, cell: [100, 120], anchor: [50, 100], height: 1.75, from: 'x.png',
  clips: {
    idle: { frames: 20, fps: 8, loop: true, rows: [] },
    walk: { frames: 16, fps: 12, loop: true, stride: 1, rows: [] },
    attack: { frames: 24, fps: 15, loop: false, event: 6, rows: [] },
    hit: { frames: 6, fps: 15, loop: false, rows: [] },
    die: { frames: 30, fps: 12, loop: false, rows: [] },
  },
};
const step = (m: ReturnType<typeof newMotion>, s: number, moving: boolean, speed: number, down = false) => {
  for (let t = 0; t < s; t += 0.05) advance(m, anim, 0.05, moving, speed, down);
};

describe('actor motion', () => {
  it('idles and walks', () => {
    const m = newMotion();
    step(m, 0.5, false, 0);
    expect(m.clip).toBe('idle');
    step(m, 0.5, true, 1.2);
    expect(m.clip).toBe('walk');
    step(m, 1, true, 4.2);
    expect(m.clip).toBe('walk');
  });

  it('keeps the feet with the ground: a walk at one stride per second loops once a second', () => {
    const m = newMotion();
    step(m, 1, true, 1);
    const p0 = m.phase;
    step(m, 1, true, 1);
    expect(m.phase - p0).toBeCloseTo(1, 1);
    expect(frameOf(m, anim.clips.walk!)).toBeGreaterThanOrEqual(0);
  });

  it('plays a blow once over the walk, and a hit does not cut it short', () => {
    const m = newMotion();
    step(m, 0.3, true, 1);
    playOnce(m, 'attack', anim);
    step(m, 0.5, true, 1);
    expect(m.clip).toBe('attack');
    playOnce(m, 'hit', anim);
    expect(m.clip).toBe('attack');
    step(m, 1.2, true, 1);
    expect(m.clip).toBe('walk');
    playOnce(m, 'hit', anim);
    expect(m.clip).toBe('hit');
    expect(frameOf(m, anim.clips.hit!)).toBe(0);
  });

  it('falls and stays down, ignoring blows, then gets up by playing the fall backwards', () => {
    const m = newMotion();
    step(m, 5, false, 0, true);
    expect(m.clip).toBe('die');
    expect(frameOf(m, anim.clips.die!)).toBe(29);
    playOnce(m, 'attack', anim);
    expect(m.clip).toBe('die');
    step(m, 0.2, false, 0, false);
    expect(m.clip).toBe('die');
    const rising = frameOf(m, anim.clips.die!);
    expect(rising).toBeLessThan(29);
    expect(rising).toBeGreaterThan(0);
    step(m, 3, false, 0, false);
    expect(m.clip).toBe('idle');
  });

  it('plays a blow once, and skips clips the actor has none of', () => {
    const m = newMotion();
    playOnce(m, 'attack', anim);
    expect(m.once).toBe('attack');
    const still = newMotion();
    playOnce(still, 'attack', { ...anim, clips: { idle: anim.clips.idle } });
    expect(still.once).toBeUndefined();
  });

  it('cross-fades a clip change: the frame it left fades out as the new one comes in', () => {
    const m = newMotion();
    step(m, 0.5, true, 1);
    const left = frameOf(m, anim.clips.walk!);
    playOnce(m, 'attack', anim);
    expect(m.from).toMatchObject({ clip: 'walk', frame: left, t: 0 });
    expect(fadeOf(m)).toEqual({ from: 1, to: 0 });
    advance(m, anim, FADE / 2, true, 1, false);
    expect(fadeOf(m)).toEqual({ from: 1, to: 1 });
    advance(m, anim, FADE, true, 1, false);
    expect(fadeOf(m)).toBeUndefined();
  });

  it('cuts between standing and walking, a walk starting on its first frame', () => {
    const m = newMotion();
    step(m, 0.7, true, 1);
    step(m, 0.3, false, 0);
    expect(m.clip).toBe('idle');
    expect(m.from).toBeUndefined();
    advance(m, anim, 0.05, true, 1, false);
    expect(m.clip).toBe('walk');
    expect(m.from).toBeUndefined();
    expect(m.phase).toBeLessThan(0.1);
    expect(frameOf(m, anim.clips.walk!)).toBe(0);
  });

  it('faces the row of its ground direction, or the painted one mirrored', () => {
    expect(rowOf(Math.PI / 2)).toEqual({ row: 0, flip: false }); // ground (0, 1): down the screen
    expect(rowOf(0)).toEqual({ row: 6, flip: false }); // (1, 0): right
    // A clip painted facing west only: facing east draws it mirrored.
    const empty: [number, number, number, number, number, number] = [0, 0, 0, 0, 0, 1];
    const west = { frames: 4, fps: 6, loop: false, rows: [empty, empty, [0, 9, 9, 0, 0, 1] as typeof empty, empty, empty, empty, empty, empty] };
    expect(rowOf(0, west)).toEqual({ row: 2, flip: true });
  });
});
