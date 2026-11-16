import { describe, expect, it } from 'vitest';
import { Nav, findPath, makeNav, nearestOnWay } from '@daydream/shared';

describe('walking where one cannot go', () => {
  // A 20×10 field split by a wall at x = 10 with no gap: the right half cannot be reached from the left.
  const opts = { width: 20, height: 10, passable: (x: number) => x !== 10 };

  it('fails a plain walk into a wall or across it', () => {
    expect(findPath({ x: 2, y: 5 }, { x: 10, y: 5 }, opts)).toBeNull();
    expect(findPath({ x: 2, y: 5 }, { x: 15, y: 5 }, opts)).toBeNull();
  });

  it('walks as near as it can when asked to', () => {
    const into = findPath({ x: 2, y: 5 }, { x: 10, y: 5 }, { ...opts, closest: true });
    expect(into?.at(-1)).toEqual({ x: 9, y: 5 });
    const across = findPath({ x: 2, y: 3 }, { x: 15, y: 7 }, { ...opts, closest: true });
    expect(across?.at(-1)).toEqual({ x: 9, y: 7 });
  });
});

describe('a way out at the edge covers its road', () => {
  // A 20 × 20 m place: a road 2 m wide across it at y = 10, open ground in its middle.
  const nav = new Nav(makeNav(20, 20, (x, y) => Math.abs(y - 10) < 1 || (x > 8 && x < 12)));

  it('runs from where it stands out to the edge', () => {
    const w = nav.wayOut({ x: 5, y: 10 });
    expect(w.out).toEqual({ x: -1, y: 0 });
    expect(w.to.x).toBeLessThan(0.6);
    expect(w.to.y).toBe(10);
    expect(nearestOnWay(w, { x: 1.5, y: 10.4 })).toEqual({ x: 1.5, y: 10 });
  });

  it('is only its spot when drawn inside the map', () => {
    const w = nav.wayOut({ x: 10, y: 10 });
    expect(w.out).toBeUndefined();
    expect(w.to).toEqual({ x: 10, y: 10 });
  });
});
