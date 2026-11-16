/**
 * A mist tile made from noise, no image model: fractal gradient noise that tiles by construction (every octave's
 * lattice wraps at the tile's edge, and so does the warp that curls it), shaped by a few numbers that say what kind
 * of air it is (sea fog, ash haze, cave spores) and colored from two colors of the place. Brightness is density,
 * as the game reads it (see docs/world-art.md).
 *
 * It is built the way fog looks from above: broad soft banks, long soft veins of wisps running through them with a
 * fibrous grain along them, and a halo (a wide blur of the density added back) so the dense parts glow into the thin
 * ones.
 */

/** How the air of a place looks, as numbers (each 0..1 unless said). */
export interface MistShape {
  /** Banks across the tile, 1..6 (a tile spans 16 m): 1 one broad bank, 6 small puffs. */
  scale: number;
  /** How much the wisps curl: 0 straight soft billows, 1 curling eddies. */
  swirl: number;
  /** How much it streams one way: 0 still air, 1 long streaks on the wind. */
  flow: number;
  /** How much of its density is fine wisps rather than soft banks. */
  wisps: number;
  /** 0 soft rounded wisps, 1 thin bright threads and streaks. */
  threads: number;
  /** Share of the tile with mist in it. */
  cover: number;
  /** 0 hazy and even (gradual edges, much glow), 1 crisp banks with clear gaps. */
  contrast: number;
  /** Small bright specks drifting in it (spores, embers, snow, pollen): 0 none, 1 many. */
  motes: number;
  /** Its color where thin and where dense (hex). */
  thin: string;
  dense: string;
}

const HASH = 4096;

/** Seeded unit gradients for the lattice. */
function gradients(seed: number): Float32Array {
  const g = new Float32Array(HASH * 2);
  let s = seed >>> 0 || 1;
  for (let i = 0; i < HASH; i++) {
    s ^= s << 13; s >>>= 0; s ^= s >>> 17; s ^= s << 5; s >>>= 0;
    const a = (s / 4294967296) * Math.PI * 2;
    g[i * 2] = Math.cos(a);
    g[i * 2 + 1] = Math.sin(a);
  }
  return g;
}

/** Gradient noise with a lattice of period `p` cells across and `q` down, about -0.7..0.7. */
function perlin(G: Float32Array, x: number, y: number, p: number, q: number, salt: number): number {
  const x0 = Math.floor(x), y0 = Math.floor(y), tx = x - x0, ty = y - y0;
  const sx = tx * tx * tx * (tx * (tx * 6 - 15) + 10), sy = ty * ty * ty * (ty * (ty * 6 - 15) + 10);
  // Lattice corners wrapped to the period, hashed to a gradient.
  const xa = ((x0 % p) + p) % p, ya = ((y0 % q) + q) % q, xb = xa + 1 === p ? 0 : xa + 1, yb = ya + 1 === q ? 0 : ya + 1;
  const s = Math.imul(salt, 83492791), hx0 = Math.imul(xa, 73856093), hx1 = Math.imul(xb, 73856093), hy0 = Math.imul(ya, 19349663), hy1 = Math.imul(yb, 19349663);
  const g00 = (((hx0 ^ hy0 ^ s) >>> 0) % HASH) * 2, g10 = (((hx1 ^ hy0 ^ s) >>> 0) % HASH) * 2;
  const g01 = (((hx0 ^ hy1 ^ s) >>> 0) % HASH) * 2, g11 = (((hx1 ^ hy1 ^ s) >>> 0) % HASH) * 2;
  const a = G[g00]! * tx + G[g00 + 1]! * ty, b = G[g10]! * (tx - 1) + G[g10 + 1]! * ty;
  const c = G[g01]! * tx + G[g01 + 1]! * (ty - 1), d = G[g11]! * (tx - 1) + G[g11 + 1]! * (ty - 1);
  return (a + (b - a) * sx) * (1 - sy) + (c + (d - c) * sx) * sy;
}

/**
 * Fractal noise at tile position (u, v), `cells` = [across, down] at its first octave (whole numbers: it tiles at
 * whole units of u and v).
 */
function fbm(G: Float32Array, u: number, v: number, cells: readonly [number, number], octaves: number, gain: number, salt: number, ridged = 0): number {
  let sum = 0, amp = 1, norm = 0;
  for (let o = 0, p = cells[0], q = cells[1]; o < octaves; o++, p *= 2, q *= 2, amp *= gain) {
    const n = perlin(G, u * p, v * q, p, q, salt * 16 + o);
    // Ridges fold the noise at zero into thin bright creases: threads instead of soft wisps.
    sum += amp * (ridged ? n + ridged * (0.45 - Math.abs(n) * 1.6 - n) : n);
    norm += amp;
  }
  return sum / norm;
}

/** Wrap-around blur (three box passes each way, about a Gaussian of sigma `r`). */
function blur(src: Float32Array, size: number, r: number): Float32Array {
  const R = Math.max(1, Math.round(r * 1.2));
  let a = Float32Array.from(src), b = new Float32Array(src.length);
  const pass = (from: Float32Array, to: Float32Array, step: (line: number, i: number) => number) => {
    for (let line = 0; line < size; line++) {
      let s = 0;
      for (let i = -R; i <= R; i++) s += from[step(line, (i + size) % size)]!;
      for (let i = 0; i < size; i++) {
        to[step(line, i)] = s / (2 * R + 1);
        s += from[step(line, (i + R + 1) % size)]! - from[step(line, (i - R + size) % size)]!;
      }
    }
  };
  for (let k = 0; k < 3; k++) {
    pass(a, b, (y, x) => y * size + x);
    pass(b, a, (x, y) => y * size + x);
  }
  return a;
}

/** The value below which a share `q` of the field lies. */
function quantile(field: Float32Array, q: number): number {
  const step = Math.max(1, Math.floor(field.length / 65536)), sample: number[] = [];
  for (let i = 0; i < field.length; i += step) sample.push(field[i]!);
  sample.sort((x, y) => x - y);
  return sample[Math.max(0, Math.min(sample.length - 1, Math.floor(q * sample.length)))]!;
}

const rgb = (h: string) => [1, 3, 5].map((i) => parseInt(h.slice(i, i + 2), 16) || 0);
const luma = (c: number[]) => 0.2126 * c[0]! + 0.7152 * c[1]! + 0.0722 * c[2]!;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

/** The tile, `size` px square, RGB raw; the same shape and seed always give the same tile. */
export function mistTile(m: MistShape, size: number, seed: number): Buffer {
  const G = gradients(seed);
  // Flow: the noise is finer down the tile than across it, so banks and strands stream sideways, the way the game
  // drifts the mist.
  const base = Math.max(1, Math.round(m.scale)), across = Math.round(base * (1 + clamp01(m.flow)));
  const cells = (k: number) => [base * k, across * k] as const;
  // The warp is smooth, so it is worked out on a coarse grid and read back bilinearly (wrapping).
  const C = size / 4, warp = new Float32Array(C * C * 4);
  for (let y = 0; y < C; y++)
    for (let x = 0; x < C; x++) {
      const u = x / C, v = y / C, k = (y * C + x) * 4;
      warp[k] = fbm(G, u, v, cells(1), 3, 0.5, 1);
      warp[k + 1] = fbm(G, u, v, cells(1), 3, 0.5, 2);
      // A second, finer warp read through the first curls the wisps into eddies.
      const qu = u + (0.6 * warp[k]!) / base, qv = v + (0.6 * warp[k + 1]!) / across;
      warp[k + 2] = fbm(G, qu, qv, cells(2), 3, 0.5, 3);
      warp[k + 3] = fbm(G, qu, qv, cells(2), 3, 0.5, 4);
    }
  const warpAt = (x: number, y: number, ch: number) => {
    const fx = (x / size) * C - 0.5, fy = (y / size) * C - 0.5, x0 = Math.floor(fx), y0 = Math.floor(fy), tx = fx - x0, ty = fy - y0;
    const w = (i: number, j: number) => warp[(((j + C) % C) * C + ((i + C) % C)) * 4 + ch]!;
    return (w(x0, y0) * (1 - tx) + w(x0 + 1, y0) * tx) * (1 - ty) + (w(x0, y0 + 1) * (1 - tx) + w(x0 + 1, y0 + 1) * tx) * ty;
  };
  const banks = new Float32Array(size * size), wisps = new Float32Array(size * size);
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      const u = x / size, v = y / size, i = y * size + x;
      const bu = u + (0.5 * warpAt(x, y, 0)) / base, bv = v + (0.5 * warpAt(x, y, 1)) / across;
      // Half the banks' weight is an octave finer: broad dark holes read as bare fog in the game.
      banks[i] = 0.5 * fbm(G, bu, bv, cells(1), 1, 0.5, 5) + 0.5 * fbm(G, bu, bv, cells(2), 5, 0.5, 9);
    }
  streaks(wisps, size, seed, m, (x, y, ch) => warpAt(x, y, ch));
  // The wisps are veins: lines where a curled noise crosses zero, a broad layer and a finer one, fading in and out
  // along their length. A vein's width is its distance from the crossing in pixels (the noise over its slope), so it
  // stays a line where the noise lingers near zero instead of swelling into a blob; thinner as `threads` rises. The
  // halo softens them later, and the fibers are a light grain along them.
  {
    const lo = quantile(wisps, 0.02), hi = quantile(wisps, 0.98), px = size / 512;
    // Level lines of round noise close into loops round blobs; noise stretched along the drift draws long veins, and
    // a coarser lattice than the banks' keeps them few.
    const vb = Math.max(1, Math.round(base / 2)), streak = (k: number) => [vb * k, across * k] as const;
    const layer = (k: number, w0: number, w1: number, salt: number) => {
      const n = new Float32Array(size * size);
      for (let y = 0; y < size; y++)
        for (let x = 0; x < size; x++) n[y * size + x] = fbm(G, x / size + (0.35 * warpAt(x, y, w0)) / vb, y / size + (0.35 * warpAt(x, y, w1)) / across, streak(k), 2, 0.35, salt);
      return n;
    };
    const n1 = layer(1, 0, 1, 7), n2 = layer(2, 2, 3, 8), width = (5.5 - 3.5 * m.threads) * px;
    const slope = (n: Float32Array, x: number, y: number) =>
      Math.hypot(n[y * size + ((x + 1) % size)]! - n[y * size + ((x + size - 1) % size)]!, n[((y + 1) % size) * size + x]! - n[((y + size - 1) % size) * size + x]!) / 2;
    // The slope is floored at a third of its mean, or a vein would get a dark hole where the noise flattens on it.
    const floor = (n: Float32Array) => {
      let s = 0, k = 0;
      for (let y = 0; y < size; y += 4) for (let x = 0; x < size; x += 4, k++) s += slope(n, x, y);
      return (s / k) / 3;
    };
    const f1 = floor(n1), f2 = floor(n2);
    const vein = (n: Float32Array, f: number, i: number, x: number, y: number, w: number) => Math.exp(-((Math.abs(n[i]!) / Math.max(f, slope(n, x, y)) / w) ** 2));
    for (let y = 0; y < size; y++)
      for (let x = 0; x < size; x++) {
        const i = y * size + x, along = clamp01(0.6 + 1.4 * fbm(G, x / size, y / size, cells(2), 2, 0.5, 10));
        wisps[i] = (0.8 * vein(n1, f1, i, x, y, width * (0.6 + 1.6 * along)) + 0.2 * vein(n2, f2, i, x, y, width * (0.4 + along))) * along * (0.75 + 0.25 * clamp01((wisps[i]! - lo) / (hi - lo)));
      }
  }
  const norm = (f: Float32Array) => {
    const lo = quantile(f, 0.01), hi = quantile(f, 0.99);
    for (let i = 0; i < f.length; i++) f[i] = clamp01((f[i]! - lo) / (hi - lo));
  };
  norm(banks);
  norm(wisps);
  // The banks carry the wisps: dense air has strands running through it, thin air a few faint ones. In wispy air the
  // banks mostly just shade the veins, so they fall off faster than the wisps rise.
  const w = 0.2 + 0.6 * m.wisps, field = new Float32Array(size * size);
  for (let i = 0; i < field.length; i++) field[i] = banks[i]! * (1 - w) ** 2 + wisps[i]! * w * (0.25 + 0.75 * banks[i]!);
  // The halo: dense air glows into thin air around it, more in hazy places.
  const halo = blur(field, size, size / (48 - 16 * m.wisps)), glow = (0.3 - 0.2 * m.contrast) * (1 + m.wisps);
  for (let i = 0; i < field.length; i++) field[i] = field[i]! * (1 - glow) + halo[i]! * glow;
  // Density by rank: whatever the noise's own spread, the tile's brightness spreads evenly from clear to dense, as a
  // painted mist's does (the game reads it as density, so a tile mostly black would be mostly bare fog). Contrast
  // pushes it toward clear and dense (an S-curve); cover moves its middle (the median density 0.3..0.7), and wispy
  // air is mostly clear between its strands. Spreading evenly would lift the dim haze between sparse veins into
  // patches, so wispy air keeps part of its own brightness (bright veins over a dim haze).
  const sample: number[] = [];
  for (let i = 0; i < field.length; i += 7) sample.push(field[i]!);
  sample.sort((x, y) => x - y);
  const rank = (v: number) => {
    let lo = 0, hi = sample.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (sample[mid]! < v) lo = mid + 1;
      else hi = mid;
    }
    return lo / sample.length;
  };
  const k = 0.6 * m.contrast, gamma = Math.log((0.3 + 0.4 * clamp01(m.cover)) * (1 - 0.4 * clamp01(m.wisps))) / Math.log(0.5);
  const own = 0.8 * clamp01(m.wisps), peak = quantile(field, 0.995), d = new Float32Array(size * size);
  for (let i = 0; i < d.length; i++) {
    const r = rank(field[i]!);
    d[i] = ((r * (1 - k) + r * r * (3 - 2 * r) * k) * (1 - own) + clamp01(field[i]! / peak) * own) ** gamma;
  }
  addMotes(d, size, m.motes, seed);
  // Brightness is the density stretched to the full range; its hue goes from the thin color to the dense one, both
  // half grayed: the game tints the mist with the place's light as well.
  const muted = (h: string) => rgb(h).map((v, _, c) => (v + luma(c)) / 2);
  const top = Math.max(0.2, quantile(d, 0.998)), thin = muted(m.thin), dense = muted(m.dense);
  const out = Buffer.alloc(size * size * 3);
  for (let i = 0; i < d.length; i++) {
    const t = clamp01(d[i]! / top), c = thin.map((a, ch) => a + (dense[ch]! - a) * t), l = Math.max(24, luma(c));
    for (let ch = 0; ch < 3; ch++) out[i * 3 + ch] = Math.max(0, Math.min(255, Math.round((c[ch]! / l) * t * 255)));
  }
  return out;
}

/**
 * Wisps as fibers: fine noise smeared along the streamlines of a swirling flow (line integral convolution), the way
 * smoke is drawn out into strands. The flow is the warp's curl plus a steady drift sideways (`flow`); `swirl` weighs
 * the curl, `threads` makes the fibers finer and longer. Everything wraps, so the result tiles.
 */
function streaks(out: Float32Array, size: number, seed: number, m: MistShape, warpAt: (x: number, y: number, ch: number) => number) {
  // Fine noise to smear: random values a few thousandths of the tile across (wrapping).
  const grain = Math.max(1, ((m.threads > 0.5 ? 2 : 4) * size) / 1024), noise = new Float32Array(size * size);
  let h = (seed * 2654435761) >>> 0 || 1;
  const cells = size / grain, rnd = new Float32Array(cells * cells);
  for (let i = 0; i < rnd.length; i++) {
    h ^= h << 13; h >>>= 0; h ^= h >>> 17; h ^= h << 5; h >>>= 0;
    rnd[i] = h / 4294967296;
  }
  for (let y = 0; y < size; y++) for (let x = 0; x < size; x++) noise[y * size + x] = rnd[Math.floor(y / grain) * cells + Math.floor(x / grain)]!;
  const soft = blur(noise, size, grain * 0.6);
  // The flow, on a grid of 4 px cells: the curl of the broad warp (its gradient turned a quarter), plus the drift.
  const e = 2, drift = 0.3 + 0.7 * m.flow, swirl = 0.3 + 0.9 * m.swirl, C = size / 4, flow = new Float32Array(C * C * 2);
  for (let cy = 0; cy < C; cy++)
    for (let cx = 0; cx < C; cx++) {
      const x = cx * 4 + 2, y = cy * 4 + 2;
      const dx = warpAt(x + e, y, 0) - warpAt(x - e, y, 0), dy = warpAt(x, y + e, 0) - warpAt(x, y - e, 0);
      const k = (swirl * size) / (8 * e);
      const fx = drift + dy * k, fy = -dx * k, l = Math.hypot(fx, fy) || 1;
      flow[(cy * C + cx) * 2] = fx / l;
      flow[(cy * C + cx) * 2 + 1] = fy / l;
    }
  const steps = Math.round(16 + 16 * m.threads), step = (2 * size) / 1024, wrap = (v: number) => ((Math.round(v) % size) + size) % size;
  for (let y = 0; y < size; y++)
    for (let x = 0; x < size; x++) {
      let sum = soft[y * size + x]!, n = 1;
      for (const dir of [1, -1]) {
        let px = x, py = y;
        for (let s = 0; s < steps; s++) {
          const f = ((((Math.floor(py / 4) % C) + C) % C) * C + (((Math.floor(px / 4) % C) + C) % C)) * 2;
          px += dir * flow[f]! * step;
          py += dir * flow[f + 1]! * step;
          // Fading along the line, so the fibers are soft at their ends.
          const w = 1 - s / steps;
          sum += soft[wrap(py) * size + wrap(px)]! * w;
          n += w;
        }
      }
      out[y * size + x] = sum / n;
    }
}

/** A sprinkle of soft bright specks, at most one in each cell of a 48 × 48 grid. */
function addMotes(d: Float32Array, size: number, amount: number, seed: number) {
  if (amount <= 0) return;
  const cells = 48, cell = size / cells;
  for (let cy = 0; cy < cells; cy++)
    for (let cx = 0; cx < cells; cx++) {
      const h = (((cx * 92837111) ^ (cy * 689287499) ^ (seed * 283923481)) >>> 0) / 4294967296;
      if (h > amount * 0.08) continue;
      const h2 = (h * 7919) % 1, h3 = (h * 104729) % 1;
      const mx = (cx + h2) * cell, my = (cy + h3) * cell, r = cell * (0.08 + 0.12 * h3), b = 0.35 + 0.4 * h2, R = Math.ceil(r * 3);
      for (let dy = -R; dy <= R; dy++)
        for (let dx = -R; dx <= R; dx++) {
          const k = ((Math.round(my) + dy + size) % size) * size + ((Math.round(mx) + dx + size) % size);
          d[k] = Math.max(d[k]!, b * Math.exp(-(dx * dx + dy * dy) / (r * r)));
        }
    }
}
