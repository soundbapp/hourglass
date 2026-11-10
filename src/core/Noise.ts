/**
 * Tileable procedural noise.
 *
 * Every function here wraps on an integer lattice, so a texture generated from
 * them repeats seamlessly across a surface. That constraint is the whole reason
 * this exists instead of a stock simplex implementation: open noise produces a
 * visible seam at every tile boundary, and on a wall that repeats six times
 * across a room the seam is the first thing the eye finds.
 *
 * All functions are pure and deterministic from their seed, so the level looks
 * identical on every machine and every reload.
 */

/** Permutation-free integer hash. Three rounds of avalanche on a 32-bit word. */
function hash2(x: number, y: number, seed: number): number {
  let h = (x * 374761393 + y * 668265263 + seed * 1442695040) | 0;
  h = (h ^ (h >>> 13)) | 0;
  h = Math.imul(h, 1274126177) | 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Hash to the unit interval. */
function hashUnit(x: number, y: number, seed: number): number {
  return hash2(x, y, seed) / 4294967295;
}

/** Quintic interpolant: zero first and second derivative at both ends. */
function smootherstep(t: number): number {
  return t * t * t * (t * (t * 6 - 15) + 10);
}

/** Positive modulo, so negative sample coordinates wrap correctly. */
function wrap(value: number, period: number): number {
  return ((value % period) + period) % period;
}

/**
 * Precomputed gradient directions.
 *
 * Indexed by a corner's hash instead of evaluating `cos`/`sin` per corner.
 * A single Perlin sample touches four corners, so the trigonometric form costs
 * eight transcendental calls per sample — and texture synthesis performs tens
 * of millions of samples at load time. The table turns that into two array
 * reads and is the difference between a one-second load and a ten-second one.
 */
const GRADIENT_COUNT = 16;
const GRADIENTS = ((): Float32Array => {
  const table = new Float32Array(GRADIENT_COUNT * 2);
  for (let i = 0; i < GRADIENT_COUNT; i++) {
    const angle = (i / GRADIENT_COUNT) * Math.PI * 2;
    table[i * 2] = Math.cos(angle);
    table[i * 2 + 1] = Math.sin(angle);
  }
  return table;
})();

/**
 * Tileable gradient (Perlin) noise.
 *
 * @param x - Sample coordinate, in lattice units.
 * @param y - Sample coordinate, in lattice units.
 * @param period - Lattice period. The field repeats every `period` units.
 * @param seed - Field selector.
 * @returns Value in roughly `[-1, 1]`.
 */
export function perlin2(x: number, y: number, period: number, seed: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = x - xi;
  const yf = y - yi;

  const u = smootherstep(xf);
  const v = smootherstep(yf);

  // Lattice corners are wrapped into the period before hashing, which is what
  // makes opposite edges of the generated image agree exactly.
  const x0 = wrap(xi, period);
  const y0 = wrap(yi, period);
  const x1 = wrap(xi + 1, period);
  const y1 = wrap(yi + 1, period);

  const grad = (hx: number, hy: number, dx: number, dy: number): number => {
    const index = (hash2(hx, hy, seed) % GRADIENT_COUNT) * 2;
    return GRADIENTS[index] * dx + GRADIENTS[index + 1] * dy;
  };

  const n00 = grad(x0, y0, xf, yf);
  const n10 = grad(x1, y0, xf - 1, yf);
  const n01 = grad(x0, y1, xf, yf - 1);
  const n11 = grad(x1, y1, xf - 1, yf - 1);

  const nx0 = n00 + (n10 - n00) * u;
  const nx1 = n01 + (n11 - n01) * u;
  return nx0 + (nx1 - nx0) * v;
}

/** Parameters of a fractal sum. */
export interface FractalOptions {
  readonly octaves: number;
  /** Lattice period of the first octave. */
  readonly period: number;
  readonly lacunarity?: number;
  readonly gain?: number;
}

/**
 * Fractal Brownian motion over {@link perlin2}, normalised to `[-1, 1]`.
 *
 * Each octave doubles the lattice period alongside the frequency, so the sum
 * stays tileable at the base period.
 */
export function fbm2(x: number, y: number, seed: number, options: FractalOptions): number {
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;

  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let normalisation = 0;

  for (let octave = 0; octave < options.octaves; octave++) {
    total +=
      perlin2(
        x * frequency,
        y * frequency,
        Math.max(1, Math.round(options.period * frequency)),
        seed + octave * 1013,
      ) * amplitude;
    normalisation += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return normalisation === 0 ? 0 : total / normalisation;
}

/**
 * Ridged fractal noise, in `[0, 1]`.
 *
 * Folding each octave's absolute value turns zero-crossings into creases, which
 * is what reads as cracking and erosion rather than as soft lumps.
 */
export function ridged2(x: number, y: number, seed: number, options: FractalOptions): number {
  const lacunarity = options.lacunarity ?? 2;
  const gain = options.gain ?? 0.5;

  let frequency = 1;
  let amplitude = 1;
  let total = 0;
  let normalisation = 0;

  for (let octave = 0; octave < options.octaves; octave++) {
    const folded =
      1 -
      Math.abs(
        perlin2(
          x * frequency,
          y * frequency,
          Math.max(1, Math.round(options.period * frequency)),
          seed + octave * 7717,
        ),
      );
    total += folded * folded * amplitude;
    normalisation += amplitude;
    frequency *= lacunarity;
    amplitude *= gain;
  }

  return normalisation === 0 ? 0 : total / normalisation;
}

/** Result of a cellular lookup. */
export interface CellularSample {
  /** Distance to the nearest feature point, in cell units. */
  readonly f1: number;
  /** Distance to the second nearest. `f2 - f1` traces cell borders. */
  readonly f2: number;
  /** Deterministic value owned by the nearest cell, in `[0, 1)`. */
  readonly cellValue: number;
}

/**
 * Tileable cellular (Worley) noise.
 *
 * The workhorse for anything made of discrete lumps: concrete aggregate, rust
 * blooms, chipped paint, puddle edges. `f2 - f1` gives the border network,
 * which is how cracks and grout lines are drawn.
 *
 * @param x - Sample coordinate, in cell units.
 * @param y - Sample coordinate, in cell units.
 * @param period - Cell grid period; the field repeats every `period` cells.
 * @param seed - Field selector.
 */
export function cellular2(x: number, y: number, period: number, seed: number): CellularSample {
  const xi = Math.floor(x);
  const yi = Math.floor(y);

  let f1 = Number.POSITIVE_INFINITY;
  let f2 = Number.POSITIVE_INFINITY;
  let nearestValue = 0;

  for (let oy = -1; oy <= 1; oy++) {
    for (let ox = -1; ox <= 1; ox++) {
      const cx = xi + ox;
      const cy = yi + oy;
      const wx = wrap(cx, period);
      const wy = wrap(cy, period);

      // Feature point jittered inside its cell, derived from the wrapped cell
      // index so that cells on opposite edges of the period agree.
      const jitterX = hashUnit(wx, wy, seed);
      const jitterY = hashUnit(wx, wy, seed + 9871);
      const px = cx + jitterX;
      const py = cy + jitterY;

      const dx = px - x;
      const dy = py - y;
      const distance = Math.sqrt(dx * dx + dy * dy);

      if (distance < f1) {
        f2 = f1;
        f1 = distance;
        nearestValue = hashUnit(wx, wy, seed + 4523);
      } else if (distance < f2) {
        f2 = distance;
      }
    }
  }

  return { f1, f2, cellValue: nearestValue };
}

/**
 * Samples fractal noise through a domain warp.
 *
 * Displacing the sample position by another noise field breaks up the uniform
 * "cloud" look of plain fBm and produces the meandering, layered structure of
 * weathering and staining.
 */
export function warpedFbm2(
  x: number,
  y: number,
  seed: number,
  options: FractalOptions,
  strength: number,
): number {
  const warpX = fbm2(x + 11.3, y + 7.1, seed + 331, options);
  const warpY = fbm2(x - 5.7, y - 3.9, seed + 977, options);
  return fbm2(x + warpX * strength, y + warpY * strength, seed, options);
}

/** Linear interpolation. */
export function lerp(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** Constrains a value to `[0, 1]`. */
export function saturate(value: number): number {
  return value < 0 ? 0 : value > 1 ? 1 : value;
}

/** Hermite band remap, clamped. */
export function smoothBand(edge0: number, edge1: number, value: number): number {
  if (edge0 === edge1) {
    return value < edge0 ? 0 : 1;
  }
  return smootherstep(saturate((value - edge0) / (edge1 - edge0)));
}
