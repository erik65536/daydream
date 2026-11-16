import { describe, expect, it } from 'vitest';
import { BARRIER_DEPTH_M, EXIT_GAP_M, PAINT_PXM, TILE_RANGE, cutOff, exitSpots, faults, fitTiles, mapGrid, mapPixels, strayOpenings } from '../src/worldgen/mapdraw.ts';
import { candidates, edgeExits, type MapReading } from '../src/worldgen/placement.ts';
import { fixMap } from '../src/worldgen/mapfix.ts';
import { CELL, walkOf, type Grid } from '../src/worldgen/mapgrid.ts';
import { doorMarks, fuseDoors, ontoWalk } from '../src/worldgen/mapspots.ts';
import { combine, openOf, openSeams, planCells, planPixel } from '../src/worldgen/mapread.ts';
import sharp from 'sharp';

describe('painted maps', () => {
  it('are sized in tiles and read at PAINT_PXM pixels per meter', () => {
    const m = mapPixels([3, 2]);
    expect([m.W, m.H]).toEqual([3072, 2048]);
    expect(m.X).toBeCloseTo(3072 / PAINT_PXM);
  });

  it('keep each kind of place within its sizes, never over 4 × 4 tiles', () => {
    expect(fitTiles('town', [9, 1])).toEqual([3, 2]);
    expect(fitTiles('wilderness', [5, 4])).toEqual([4, 4]);
    expect(fitTiles('dungeon', [1, 1])).toEqual([2, 1]);
    expect(fitTiles('dungeon')).toEqual(TILE_RANGE.dungeon.usual);
    for (const r of Object.values(TILE_RANGE)) expect(Math.max(...r.max)).toBeLessThanOrEqual(4);
  });
});

/** A 20 × 12 m map, open everywhere unless drawn otherwise. */
function map() {
  const g: Grid = { cols: 80, rows: 48 };
  const open = new Uint8Array(g.cols * g.rows).fill(1);
  const rect = (c0: number, r0: number, c1: number, r1: number, v: number) => {
    for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) open[r * g.cols + c] = v;
  };
  return { g, open, rect, at: (m: Uint8Array, r: number, c: number) => m[r * g.cols + c] };
}
const band = Math.ceil(BARRIER_DEPTH_M / CELL), gap = EXIT_GAP_M / CELL;

describe('judging a painting by its reading', () => {
  /** A place closed 4 m deep all round, with a road through the top barrier at columns 50–54. */
  const closed = () => {
    const m = map();
    m.rect(0, 0, 79, 15, 0);
    m.rect(0, 32, 79, 47, 0);
    m.rect(0, 0, 15, 47, 0);
    m.rect(64, 0, 79, 47, 0);
    m.rect(50, 0, 54, 15, 1);
    return m;
  };

  it('counts the share of walkable ground cut off from the main region, ignoring specks', () => {
    const m = closed();
    expect(cutOff(walkOf(m.open, m.g))).toBe(0);
    // A walled-off room of about 8 m² (32 × 16 cells… inside its 1-cell wall) is cut off; a 1-cell speck is not counted.
    m.rect(16, 16, 27, 31, 0);
    m.rect(17, 17, 26, 30, 1);
    expect(cutOff(walkOf(m.open, m.g))).toBeGreaterThan(0.05);
  });

  it('puts an exit where the main region already reaches the edge, near where it was planned', () => {
    const m = closed();
    const [e] = exitSpots(walkOf(m.open, m.g), m.g, [{ side: 'top', at: 0.5 }]);
    expect(e!.at).toBeGreaterThan(0.6);
    expect(e!.at).toBeLessThan(0.7);
    expect(e!.depth).toBe(0);
    // Nothing reaches the bottom: the exit stays near its plan and is cut from the main region's edge, 4 m in.
    const [b] = exitSpots(walkOf(m.open, m.g), m.g, [{ side: 'bottom', at: 0.5 }]);
    expect(b!.depth).toBeCloseTo(4, 0);
  });

  it('finds unplanned ways off the map, but not at a planned exit', () => {
    const m = closed();
    const w = walkOf(m.open, m.g);
    expect(strayOpenings(w, m.g, [{ side: 'top', at: 52 / 80 }])).toEqual([]);
    const [o] = strayOpenings(w, m.g, []);
    expect(o!.side).toBe('top');
    expect(o!.at).toBeCloseTo(52.5 / 80, 1);
  });
});

describe('making a read map usable', () => {
  it('blocks the barrier band except at the ways out, and keeps those reachable', async () => {
    const { g, open, at } = map();
    const f = await fixMap(open, g, [{ side: 'top', at: 0.5 }, { side: 'left', at: 0.25 }], band, gap);
    expect(at(f.walk, 24, 40)).toBe(1);
    expect(at(f.walk, 0, 20)).toBe(0);
    expect(at(f.walk, 24, 79)).toBe(0);
    expect(at(f.walk, 1, 40)).toBe(1);
    expect(at(f.walk, 12, 1)).toBe(1);
  });

  it('joins a cut-off area through a thin wall, but not through a thick one', async () => {
    const thin = map();
    // A wall across the map 0.5 m thick: the right side is cut off, then joined by a carved passage.
    thin.rect(50, 0, 51, 47, 0);
    const f = await fixMap(thin.open, thin.g, [], band, gap);
    expect(f.joined).toBe(1);
    expect(at(f.walk, 24, 65)).toBe(1);
    const thick = map();
    thick.rect(40, 0, 59, 47, 0);
    const t = await fixMap(thick.open, thick.g, [], band, gap);
    expect(t.joined).toBe(0);
    expect(at(t.walk, 24, 70)).toBe(0);
    function at(m: Uint8Array, r: number, c: number) {
      return m[r * 80 + c];
    }
  });

  it('crosses a long bridge a reading saw, once the painting confirms it, but not a long wall no reading saw', async () => {
    const { g, open, rect, at } = map();
    // Water 5 m wide down the map, with a bridge 1 m wide that one reading saw as ground.
    rect(40, 0, 59, 47, 0);
    const evidence = new Float32Array(g.cols * g.rows);
    for (let r = 22; r <= 25; r++) for (let c = 40; c <= 59; c++) evidence[r * g.cols + c] = 0.6;
    const asked: number[][] = [];
    const crossed = await fixMap(open, g, [], band, gap, { evidence, confirm: async (route) => (asked.push(route), true) });
    expect(crossed.joined).toBe(1);
    expect(asked.length).toBe(1);
    expect(at(crossed.walk, 24, 63)).toBe(1);
    expect(at(crossed.walk, 16, 50)).toBe(0);
    const refused = await fixMap(open, g, [], band, gap, { evidence, confirm: async () => false });
    expect(at(refused.walk, 24, 63)).toBe(0);
    const unseen = await fixMap(open, g, [], band, gap, { evidence: new Float32Array(g.cols * g.rows), confirm: async () => true });
    expect(at(unseen.walk, 24, 63)).toBe(0);
  });

  it('joins an island beyond another island once the nearer one has joined', async () => {
    const { g, open, rect, at } = map();
    // Left to right: the far island, 2.75 m of wall, a near island, 0.5 m of wall, the main area. The far island is
    // 3.25 m of wall from the main area (too far), but only 2.75 m once the near island has joined.
    rect(21, 0, 31, 47, 0);
    rect(40, 0, 41, 47, 0);
    const f = await fixMap(open, g, [], band, gap, { evidence: new Float32Array(g.cols * g.rows) });
    expect(f.joined).toBe(2);
    expect(at(f.walk, 24, 16)).toBe(1);
  });

  it('cleans specks: a tiny blocked dot inside open ground opens', async () => {
    const { g, open, at } = map();
    open[24 * g.cols + 40] = 0;
    const f = await fixMap(open, g, [], band, gap);
    expect(at(f.open, 24, 40)).toBe(1);
  });
});

describe('reading a plan', () => {
  it('takes transparent or off-palette pixels as no answer, and lets the readings that answered decide', async () => {
    // Left cell: transparent purple (Qwen answering in the alpha channel); right cell: opaque white.
    const px = Buffer.from([160, 64, 192, 0, 160, 64, 192, 0, 255, 255, 255, 255, 255, 255, 255, 255]);
    const pic = await sharp(px, { raw: { width: 4, height: 1, channels: 4 } }).png().toBuffer();
    const g: Grid = { cols: 2, rows: 1 };
    const a = await planCells(pic, g);
    expect([...a.known]).toEqual([0, 1]);
    expect([...a.walk]).toEqual([0, 1]);
    expect(planPixel(200, 120, 60, 255)).toBe(0);
    // A second reading answers the left cell as walkable: the combination follows it there.
    const b = { walk: Float32Array.from([1, 0]), water: new Float32Array(2), known: Float32Array.from([1, 1]), building: new Uint8Array(2) };
    const c = combine([a, b], g);
    expect(c.walk[0]).toBe(1);
    expect(c.walk[1]).toBeCloseTo(0.5);
    expect(c.evidence[1]).toBe(1);
  });
});

describe('settling doubtful ground', () => {
  /** A plan over a 40 × 40 grid: every cell walkable, water or solid as `at` says, all answered. */
  const plan = (g: Grid, at: (r: number, c: number) => 'walk' | 'water' | 'solid') => {
    const n = g.cols * g.rows, walk = new Float32Array(n), water = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const k = at(Math.floor(i / g.cols), i % g.cols);
      (walk[i] = k === 'walk' ? 1 : 0), (water[i] = k === 'water' ? 1 : 0);
    }
    return { walk, water, known: new Float32Array(n).fill(1), building: new Uint8Array(n) };
  };
  const g: Grid = { cols: 40, rows: 40 };

  it('marks a thin line some plan drew solid, so a wall between rooms is never part of the rooms', () => {
    const wall = plan(g, (_, c) => (c === 20 ? 'solid' : 'walk')), floor = plan(g, () => 'walk');
    const read = combine([wall, floor, floor], g);
    expect(read.line[10 * 40 + 20]).toBe(1);
    expect(read.line[10 * 40 + 10]).toBe(0);
  });

  it('opens a one-cell seam between open ground that a plan saw as ground (a curb), not a wall no plan saw', () => {
    const kerb = plan(g, (_, c) => (c === 20 ? 'water' : 'walk')), solid = plan(g, (_, c) => (c === 20 ? 'solid' : 'walk'));
    const read = combine([kerb, solid, solid], g);
    const open = openOf(read.walk, read);
    expect(open[10 * 40 + 20]).toBe(0);
    expect(openSeams(open, read, g)).toBeGreaterThan(0);
    expect(open[10 * 40 + 20]).toBe(1);
    const wall = combine([solid, solid, solid], g), shut = openOf(wall.walk, wall);
    expect(openSeams(shut, wall, g)).toBe(0);
  });

  it('leaves water one plan drew as ground for Luna instead of opening it on a tie', () => {
    const lawn = plan(g, () => 'walk'), pond = plan(g, () => 'water');
    const read = combine([lawn, pond], g);
    expect(openOf(read.walk, read)[0]).toBe(0);
  });
});

describe('ways out across the edge', () => {
  it('stand at the gap cut on their own side, two on one side in order, and ways drawn inside are left to Luna', () => {
    const g = mapGrid([2, 2]);
    expect(g).toEqual({ cols: Math.round(2048 / PAINT_PXM / CELL), rows: Math.round(2048 / PAINT_PXM / CELL) });
    const edge = (x: number, y: number, label: string) => ({ x, y, label });
    const r: MapReading = { width: 2048, height: 2048, X: 51.2, Y: 51.2, grid: g, walk: new Uint8Array(g.cols * g.rows), sight: new Uint8Array(g.cols * g.rows), doors: [], landmarks: [], area: 0, edges: [edge(1024, 200, 'top'), edge(200, 600, 'left'), edge(200, 1400, 'left')] };
    const cands = candidates(r);
    const spots = edgeExits([{ id: 'west_a', side: 'left' }, { id: 'cellar', into: true }, { id: 'north', side: 'top' }, { id: 'west_b', side: 'left' }, { id: 'east', side: 'right' }], cands);
    expect([...spots].map(([id, c]) => [id, c.id])).toEqual([['west_a', 'E2'], ['north', 'E1'], ['west_b', 'E3']]);
  });

  it('are not ordinary cut-off regions: a refused crossing costs no look and does not stand in their way', async () => {
    // Open ground behind a thick wall below the top band, with a way out at the top: its gap joins through the wall
    // without the painting being asked, though every crossing is refused.
    const g: Grid = { cols: 80, rows: 80 }, band = 8, gap = 8;
    const open = new Uint8Array(g.cols * g.rows).fill(1);
    for (let r = band; r < band + 6; r++) for (let c = 0; c < g.cols; c++) open[r * g.cols + c] = 0;
    let asked = 0;
    const f = await fixMap(open, g, [{ side: 'top', at: 0.5 }], band, gap, { evidence: new Float32Array(g.cols * g.rows), confirm: async () => (asked++, false) });
    expect(asked).toBe(0);
    expect(f.exits).toBe(1);
    expect(f.walk[2 * g.cols + 40]).toBe(1);
  });
});

describe('judging a painting', () => {
  it('counts the checks it failed', () => {
    expect(faults({ cut: 0, share: 0.6, steep: false })).toBe(0);
    expect(faults({ cut: 0.1, share: 0.3, steep: true })).toBe(3);
  });
});

describe('placing spots', () => {
  it('moves each entrance onto the nearest unclaimed door mark within 3 m, closest pairs first', () => {
    const pxm = 40;
    const spots = [{ x: 100, y: 100, label: 'a' }, { x: 160, y: 100, label: 'b' }, { x: 1000, y: 1000, label: 'c' }];
    const marks = [{ x: 150, y: 110 }, { x: 600, y: 600 }];
    const f = fuseDoors(spots, marks, pxm);
    // b is closer to the mark than a, so b takes it; a stays; c has no mark within 3 m.
    expect(f.map((s) => [s.label, s.x, s.y])).toEqual([['a', 100, 100], ['b', 150, 110], ['c', 1000, 1000]]);
  });

  it('reads door marks from a door plan of any size, noting those painted beside a building', async () => {
    // A 400 × 200 plan of an 800 × 400 map at 40 px/m: a red building with a yellow square below it, and a lone square.
    const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="400" height="200"><rect width="400" height="200" fill="#fff"/><rect x="40" y="40" width="80" height="60" fill="#f00"/><rect x="72" y="100" width="16" height="16" fill="#ffe600"/><rect x="300" y="150" width="16" height="16" fill="#ffe600"/></svg>`;
    const marks = await doorMarks(await sharp(Buffer.from(svg)).png().toBuffer(), 800, 400, 40);
    expect(marks.map((m) => [Math.round(m.x / 8), Math.round(m.y / 8), m.building])).toEqual([[20, 27, true], [77, 40, false]]);
  });

  it('stands spots on the nearest walkable ground, and drops those with none near', () => {
    const { g, open, rect } = map();
    rect(30, 10, 45, 20, 0);
    // A spot on the roof (picture 10 px per cell) moves just outside it; one far inside a big block is dropped.
    const [s] = ontoWalk([{ x: 37 * 10 + 5, y: 19 * 10 + 5, label: 'roof' }], open, g, 800, 480);
    expect(s!.y).toBeGreaterThan(20 * 10);
    rect(0, 0, 79, 47, 0);
    expect(ontoWalk([{ x: 400, y: 240, label: 'x' }], open, g, 800, 480)).toHaveLength(0);
  });
});
