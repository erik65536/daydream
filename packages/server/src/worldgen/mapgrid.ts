/**
 * A place's plan while it is made: its top-down map laid over a grid of quarter-meter cells, each open (floor people
 * may stand on) or not, and where people can actually walk: a character's center keeps CLEARANCE meters from
 * anything not open, and the walkable cells split into joined regions (the largest is the place).
 */

/** Plan cell size in meters. */
export const CELL = 0.25;
/** A character's center keeps this far from anything not open (meters): one cell, so a passage a reader drew a little
 * narrow still opens (characters may clip slightly into things that look solid). */
const CLEARANCE = 0.25;

export type Side = 'top' | 'bottom' | 'left' | 'right';

export interface Grid {
  cols: number;
  rows: number;
}

export interface Walk {
  /** Walkable cells (clearance included). */
  walk: Uint8Array;
  /** Region of each walkable cell (-1 none), each region's size in cells, and the largest one. */
  label: Int32Array;
  sizes: number[];
  main: number;
}

/** Where people can walk on an open mask: clearance (R cells), then 4-joined regions. The grid's edge counts as open (ways out). */
export function walkOf(open: Uint8Array, g: Grid, R = Math.ceil(CLEARANCE / CELL)): Walk {
  const { cols, rows } = g, n = cols * rows;
  const disc: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= R * R) disc.push([dr, dc]);
  const walk = new Uint8Array(n);
  for (let r = 0; r < rows; r++)
    for (let c = 0; c < cols; c++) {
      if (!open[r * cols + c]) continue;
      let ok = true;
      for (const [dr, dc] of disc) {
        const rr = r + dr, cc = c + dc;
        if (rr < 0 || cc < 0 || rr >= rows || cc >= cols) continue;
        if (!open[rr * cols + cc]) {
          ok = false;
          break;
        }
      }
      if (ok) walk[r * cols + c] = 1;
    }
  const label = new Int32Array(n).fill(-1);
  const sizes: number[] = [];
  for (let i = 0; i < n; i++) {
    if (!walk[i] || label[i]! >= 0) continue;
    const id = sizes.length, st = [i];
    label[i] = id;
    let size = 0;
    while (st.length) {
      const k = st.pop()!;
      size++;
      for (const j of neighbours(k, g)) if (walk[j] && label[j]! < 0) (label[j] = id), st.push(j);
    }
    sizes.push(size);
  }
  let main = -1;
  sizes.forEach((s, i) => (main < 0 || s > sizes[main]! ? (main = i) : 0));
  return { walk, label, sizes, main };
}

/** The 4 neighbors of a cell inside the grid. */
export function neighbours(i: number, g: Grid): number[] {
  const r = Math.floor(i / g.cols), c = i % g.cols, out: number[] = [];
  if (c > 0) out.push(i - 1);
  if (c < g.cols - 1) out.push(i + 1);
  if (r > 0) out.push(i - g.cols);
  if (r < g.rows - 1) out.push(i + g.cols);
  return out;
}

/** Connected pieces of the cells where `on` holds (4-joined). */
export function components(g: Grid, on: (i: number) => boolean): number[][] {
  const seen = new Uint8Array(g.cols * g.rows), out: number[][] = [];
  for (let i = 0; i < seen.length; i++) {
    if (seen[i] || !on(i)) continue;
    const comp = [i], st = [i];
    seen[i] = 1;
    while (st.length) {
      const k = st.pop()!;
      for (const j of neighbours(k, g)) if (!seen[j] && on(j)) (seen[j] = 1), st.push(j), comp.push(j);
    }
    out.push(comp);
  }
  return out;
}

/** A mask with every part narrower than a disc of radius `R` cells removed (erosion, then dilation). */
export function opening(mask: Uint8Array, g: Grid, R: number): Uint8Array {
  const disc: [number, number][] = [];
  for (let dr = -R; dr <= R; dr++) for (let dc = -R; dc <= R; dc++) if (dr * dr + dc * dc <= R * R) disc.push([dr, dc]);
  const pass = (src: Uint8Array, keep: boolean) => {
    const out = new Uint8Array(src.length);
    for (let r = 0; r < g.rows; r++)
      for (let c = 0; c < g.cols; c++) {
        // Erosion keeps a cell whose whole disc is set; dilation sets a cell any disc cell of which is set.
        let all = true, any = false;
        for (const [dr, dc] of disc) {
          const rr = r + dr, cc = c + dc, v = rr >= 0 && cc >= 0 && rr < g.rows && cc < g.cols ? src[rr * g.cols + cc]! : 0;
          if (v) any = true;
          else all = false;
          if (keep ? !all : any) break;
        }
        out[r * g.cols + c] = (keep ? all : any) ? 1 : 0;
      }
    return out;
  };
  return Uint8Array.from(pass(pass(mask, true), false), (v, i) => v & mask[i]!);
}
