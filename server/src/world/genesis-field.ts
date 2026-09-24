import {
  BAND_HEIGHT,
  MAX_STEP,
  RELAX_SLACK,
  GRASSLAND_MIN_HEIGHT,
  LAND_RAMP_ANCHOR_SPACING,
  NEIGHBOURHOOD_CELLS,
  RAMP_CELLS_PER_BAND,
  SEA_LEVEL,
  SNOW_LINE_HEIGHT,
} from '@terrace/shared';

// Genesis terrain: continents with shelves, plains and hill country, ridged ranges,
// and valleys cut along the drainage. Integer arithmetic only, every product below 2^53.

/** Heights carry this many sub-band steps until the final floor to whole bands. */
const SUB_BAND = 256;

/** Noise values run in [-NOISE_ONE, NOISE_ONE]: fine enough that no contour steps between cells. */
const NOISE_ONE = 1024;

/** Fixed-point one for the interpolation fade. */
const FADE_ONE = 1 << 16;

/** Sixteen gradients 22.5 degrees apart, length GRADIENT_ONE, rounded once. */
const GRADIENT_ONE = 256;
const GRADIENTS: readonly number[] = [
  256, 0, 237, 98, 181, 181, 98, 237, 0, 256, -98, 237, -181, 181, -237, 98,
  -256, 0, -237, -98, -181, -181, -98, -237, 0, -256, 98, -237, 181, -181, 237, -98,
];
const GRADIENT_MASK = GRADIENTS.length / 2 - 1;

/** A 2D gradient noise peaks at half a diagonal: sqrt(2), in GRADIENT_ONE fixed point, rescales it to one. */
const SQRT2_FIXED = 362;

/** Largest lattice spacing: keeps every interpolation product below 2^53. */
const MAX_SPACING_CELLS = NEIGHBOURHOOD_CELLS * 8;

export const FRESH_SEABED_DEPTH_BELOW_SEA = 192;
export const FRESH_SEABED_BANDS_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / BAND_HEIGHT;

export const FRESH_SHELF_DEPTH_BELOW_SEA = FRESH_SEABED_DEPTH_BELOW_SEA / 3;
export const FRESH_SHELF_BANDS_BELOW_SEA = FRESH_SHELF_DEPTH_BELOW_SEA / BAND_HEIGHT;

export function heightAtBandsBelowSea(bands: number): number {
  return SEA_LEVEL - bands * BAND_HEIGHT;
}

export const FRESH_SEABED_HEIGHT = heightAtBandsBelowSea(FRESH_SEABED_BANDS_BELOW_SEA);

export const FRESH_SHELF_HEIGHT = heightAtBandsBelowSea(FRESH_SHELF_BANDS_BELOW_SEA);

/** One land-ramp anchor above the snow line, so the highest peaks carry snow. */
export const GENESIS_PEAK_HEIGHT_ABOVE_SEA = SNOW_LINE_HEIGHT + LAND_RAMP_ANCHOR_SPACING;
export const GENESIS_PEAK_BANDS = GENESIS_PEAK_HEIGHT_ABOVE_SEA / BAND_HEIGHT;
export const GENESIS_ABYSS_DEPTH_BELOW_SEA = 640;
export const GENESIS_ABYSS_BANDS_BELOW_SEA = GENESIS_ABYSS_DEPTH_BELOW_SEA / BAND_HEIGHT;

/** Continents: three octaves, the widest eight neighbourhoods across. */
const CONTINENT_SPACINGS = [NEIGHBOURHOOD_CELLS * 8, NEIGHBOURHOOD_CELLS * 4, NEIGHBOURHOOD_CELLS * 2];
/** Hills: two octaves, one neighbourhood and half of one. */
const HILL_SPACINGS = [NEIGHBOURHOOD_CELLS, NEIGHBOURHOOD_CELLS / 2];
/** Ranges: three ridged octaves. */
const RANGE_SPACINGS = [NEIGHBOURHOOD_CELLS * 8, NEIGHBOURHOOD_CELLS * 4, NEIGHBOURHOOD_CELLS * 2];
/** Which regions are plains, hills or ranges. */
const REGION_SPACINGS = [NEIGHBOURHOOD_CELLS * 8, NEIGHBOURHOOD_CELLS * 6];

/** Domain warp: coarse bends coastlines and ranges, fine roughens them. Reach as a fraction of spacing. */
const COARSE_WARP_SPACING = NEIGHBOURHOOD_CELLS * 4;
const COARSE_WARP_REACH_CELLS = (COARSE_WARP_SPACING * 3) / 8;
const FINE_WARP_SPACING = NEIGHBOURHOOD_CELLS;
const FINE_WARP_REACH_CELLS = (FINE_WARP_SPACING * 5) / 16;

/** The shelf falls to the fresh shelf depth over this much continental value, then the slope to the abyss. */
const SHELF_WIDTH = (NOISE_ONE * 5) / 32;
const SLOPE_WIDTH = (NOISE_ONE * 45) / 64;

/** Coasts climb from the beach to the grass line over this much continental value. */
const COAST_RISE_WIDTH = NOISE_ONE / 2;
const COAST_BANDS = 1;
const LOWLAND_BANDS = GRASSLAND_MIN_HEIGHT / BAND_HEIGHT - COAST_BANDS;
/** Continental interiors keep rising gently: bands per NOISE_ONE of continental value. */
const INTERIOR_RISE_BANDS = 3;

/** Full-relief hill and range heights, in bands per NOISE_ONE of noise. */
const HILL_BANDS = 4;
/** The seabed is hill country too, fading in offshore as the land's hills fade in inland. */
const SEABED_HILL_BANDS = HILL_BANDS;
const RANGE_BANDS = 18;

/** Region value: plains below -PLAINS_BELOW, hills above; ranges fade in above RANGES_ABOVE. */
const PLAINS_BELOW = (NOISE_ONE * 3) / 8;
const RANGES_ABOVE = NOISE_ONE / 6;
const RANGE_ONSET_GAIN = 3;

/** A valley starts where this many cells drain through one, and deepens a band per doubling. */
const VALLEY_MIN_AREA_CELLS = (NEIGHBOURHOOD_CELLS * NEIGHBOURHOOD_CELLS) / 2;
const VALLEY_MIN_AREA_LOG2 = 31 - Math.clz32(VALLEY_MIN_AREA_CELLS);

/** Genesis draws at rest: no pair steeper than the slope settle relaxes to (MAX_STEP + RELAX_SLACK). */
const MAX_SLOPE_PER_CELL = ((MAX_STEP + RELAX_SLACK) * SUB_BAND) / BAND_HEIGHT;
const VALLEY_WALL_PER_CELL = SUB_BAND / RAMP_CELLS_PER_BAND;
/** Chamfer step lengths in 1/SIDE_FIXED: a side step is one, a diagonal sqrt(2). */
const SIDE_FIXED = 256;
const DIAGONAL_FIXED = 362;

/** Starter land counts from halfway up the coast rise, so it has an interior above the beach. */
const STARTER_INTERIOR = COAST_RISE_WIDTH / 2;

/** Starter land is raised this far around its site, in cells, before the warp bends it. */
const STARTER_RISE_RADIUS_CELLS = NEIGHBOURHOOD_CELLS * 2;

/** Bisection steps for the starter rise: past the widest continental range a rise can need. */
const STARTER_RISE_SEARCH_STEPS = 16;

export interface GenesisStarterLand {
  readonly minCell: number;
  readonly maxCell: number;
  /** Cells of the square the continents must raise halfway up the coast; the island pass backs this up. */
  readonly cells: number;
}

export interface GenesisFieldShape {
  /** Percent of the map the continents cover before any guarantee pass. */
  readonly landPercent: number;
  /** Hill and range height scale, 0..SUB_BAND. */
  readonly relief: number;
  readonly seed: number;
  readonly starter: GenesisStarterLand;
}

interface Octave {
  readonly spacing: number;
  /** log2(spacing) when a power of two, else -1. */
  readonly shift: number;
  readonly salt: number;
  readonly seed: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly fade: Int32Array;
  /** Gradient offsets (index * 2) per lattice point over [latticeMin, latticeMin + latticeCols)². */
  readonly gradients: Int8Array;
  readonly latticeMin: number;
  readonly latticeCols: number;
}

/** Warped samples stray this far outside the world, plus a cell for rounding. */
const WARP_MARGIN_CELLS = COARSE_WARP_REACH_CELLS + FINE_WARP_REACH_CELLS + 1;

function hash(seed: number, salt: number, i: number, j: number): number {
  let h =
    (Math.imul(seed ^ 0x9e37_79b9, 0x85eb_ca6b) ^
      Math.imul(salt + 0x632b_e5ab, 0xc2b2_ae35) ^
      Math.imul(i, 0x27d4_eb2d) ^
      Math.imul(j, 0x1656_67b1)) >>>
    0;
  h = Math.imul(h ^ (h >>> 16), 0x7feb_352d) >>> 0;
  h = Math.imul(h ^ (h >>> 15), 0x846c_a68b) >>> 0;
  return (h ^ (h >>> 16)) >>> 0;
}

/** Quintic fade 6t^5 - 15t^4 + 10t^3 for every offset in one lattice cell, in FADE_ONE. */
function fadeTable(spacing: number): Int32Array {
  const table = new Int32Array(spacing + 1);
  for (let f = 0; f <= spacing; f++) {
    const t = Math.floor((f * FADE_ONE) / spacing);
    let v = 6 * t - 15 * FADE_ONE;
    v = Math.floor((t * v) / FADE_ONE) + 10 * FADE_ONE;
    v = Math.floor((t * v) / FADE_ONE);
    v = Math.floor((t * v) / FADE_ONE);
    table[f] = Math.floor((t * v) / FADE_ONE);
  }
  return table;
}

function octave(spacing: number, seed: number, salt: number, size: number): Octave {
  if (spacing > MAX_SPACING_CELLS) throw new Error(`lattice spacing ${spacing} exceeds ${MAX_SPACING_CELLS}`);
  // Each octave's lattice sits at its own offset, so no two share grid lines.
  const offsetX = hash(seed, salt, 0, 1) % spacing;
  const offsetY = hash(seed, salt, 1, 0) % spacing;
  const latticeMin = Math.floor((Math.min(offsetX, offsetY) - WARP_MARGIN_CELLS) / spacing);
  const latticeMax = Math.floor((size + Math.max(offsetX, offsetY) + WARP_MARGIN_CELLS) / spacing) + 1;
  const latticeCols = latticeMax - latticeMin + 1;
  const gradients = new Int8Array(latticeCols * latticeCols);
  for (let j = 0; j < latticeCols; j++) {
    for (let i = 0; i < latticeCols; i++) {
      gradients[j * latticeCols + i] = (hash(seed, salt, latticeMin + i, latticeMin + j) & GRADIENT_MASK) * 2;
    }
  }
  const shift = (spacing & (spacing - 1)) === 0 ? 31 - Math.clz32(spacing) : -1;
  return { spacing, shift, salt, seed, offsetX, offsetY, fade: fadeTable(spacing), gradients, latticeMin, latticeCols };
}

function corner(o: Octave, i: number, j: number, dx: number, dy: number): number {
  const li = i - o.latticeMin;
  const lj = j - o.latticeMin;
  const g =
    li >= 0 && lj >= 0 && li < o.latticeCols && lj < o.latticeCols
      ? o.gradients[lj * o.latticeCols + li]!
      : (hash(o.seed, o.salt, i, j) & GRADIENT_MASK) * 2;
  return GRADIENTS[g]! * dx + GRADIENTS[g + 1]! * dy;
}

/** Gradient noise at a cell, in [-NOISE_ONE, NOISE_ONE]. */
function noise(o: Octave, x: number, y: number): number {
  const s = o.spacing;
  const px = x + o.offsetX;
  const py = y + o.offsetY;
  const i = o.shift >= 0 ? px >> o.shift : Math.floor(px / s);
  const j = o.shift >= 0 ? py >> o.shift : Math.floor(py / s);
  const fx = px - i * s;
  const fy = py - j * s;
  const li = i - o.latticeMin;
  const lj = j - o.latticeMin;
  const cols = o.latticeCols;
  let d00: number;
  let d10: number;
  let d01: number;
  let d11: number;
  if (li >= 0 && lj >= 0 && li + 1 < cols && lj + 1 < cols) {
    const at = lj * cols + li;
    const g00 = o.gradients[at]!;
    const g10 = o.gradients[at + 1]!;
    const g01 = o.gradients[at + cols]!;
    const g11 = o.gradients[at + cols + 1]!;
    d00 = GRADIENTS[g00]! * fx + GRADIENTS[g00 + 1]! * fy;
    d10 = GRADIENTS[g10]! * (fx - s) + GRADIENTS[g10 + 1]! * fy;
    d01 = GRADIENTS[g01]! * fx + GRADIENTS[g01 + 1]! * (fy - s);
    d11 = GRADIENTS[g11]! * (fx - s) + GRADIENTS[g11 + 1]! * (fy - s);
  } else {
    d00 = corner(o, i, j, fx, fy);
    d10 = corner(o, i + 1, j, fx - s, fy);
    d01 = corner(o, i, j + 1, fx, fy - s);
    d11 = corner(o, i + 1, j + 1, fx - s, fy - s);
  }
  const u = o.fade[fx]!;
  const v = o.fade[fy]!;
  const top = d00 * FADE_ONE + (d10 - d00) * u;
  const bottom = d01 * FADE_ONE + (d11 - d01) * u;
  const blended = Math.floor((top * FADE_ONE + (bottom - top) * v) / FADE_ONE);
  const scaled = Math.floor((blended * NOISE_ONE) / (s * FADE_ONE));
  return Math.floor((scaled * SQRT2_FIXED) / (GRADIENT_ONE * GRADIENT_ONE));
}

/** Octaves summed at halving weights. */
function fractal(octaves: readonly Octave[], x: number, y: number): number {
  let sum = 0;
  for (let k = 0; k < octaves.length; k++) sum += noise(octaves[k]!, x, y) >> k;
  return sum;
}

/** Ridged octaves: sharp crests where the noise crosses zero, squared to narrow them. */
function ridged(octaves: readonly Octave[], x: number, y: number): number {
  let sum = 0;
  for (let k = 0; k < octaves.length; k++) {
    const crest = NOISE_ONE - 2 * Math.abs(noise(octaves[k]!, x, y));
    if (crest > 0) sum += ((crest * crest) / NOISE_ONE) >> k;
  }
  return Math.floor(sum);
}

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Continental value above which `landPercent` of the cells lie. */
function coastThreshold(continent: Int16Array, landPercent: number): number {
  let lo = 0;
  let hi = 0;
  for (const c of continent) {
    if (c < lo) lo = c;
    if (c > hi) hi = c;
  }
  const counts = new Int32Array(hi - lo + 1);
  for (const c of continent) counts[c - lo]! += 1;
  const wanted = Math.floor((continent.length * landPercent) / 100);
  let above = 0;
  for (let c = hi; c > lo; c--) {
    above += counts[c - lo]!;
    if (above >= wanted) return c;
  }
  return lo;
}

/** A smooth rise, `amplitude` at the site falling to zero at STARTER_RISE_RADIUS_CELLS. */
function starterRise(fade: Int32Array, amplitude: number, dx: number, dy: number): number {
  const distance = Math.floor(Math.sqrt(dx * dx + dy * dy));
  if (distance >= STARTER_RISE_RADIUS_CELLS) return 0;
  return Math.floor((amplitude * (FADE_ONE - fade[distance]!)) / FADE_ONE);
}

/**
 * Raises the continents around the starter square's highest point until they cover
 * `starter.cells` of it. The rise follows the warp, so the coast it draws is the field's own.
 */
function raiseStarterLand(
  continent: Int16Array,
  warpX: Int16Array,
  warpY: Int16Array,
  size: number,
  coast: number,
  starter: GenesisStarterLand,
): GenesisStarterRise | null {
  const { minCell: lo, maxCell: hi } = starter;
  let landCells = 0;
  let site = lo * size + lo;
  let lowest = coast;
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      const c = continent[y * size + x]!;
      if (c >= coast + STARTER_INTERIOR) landCells++;
      if (c > continent[site]!) site = y * size + x;
      if (c < lowest) lowest = c;
    }
  }
  if (landCells >= starter.cells) return null;

  const siteX = (site % size) + warpX[site]!;
  const siteY = Math.floor(site / size) + warpY[site]!;
  const fade = fadeTable(STARTER_RISE_RADIUS_CELLS);
  const covered = (amplitude: number): number => {
    let cells = 0;
    for (let y = lo; y <= hi; y++) {
      for (let x = lo; x <= hi; x++) {
        const i = y * size + x;
        const rise = starterRise(fade, amplitude, x + warpX[i]! - siteX, y + warpY[i]! - siteY);
        if (continent[i]! + rise >= coast + STARTER_INTERIOR) cells++;
      }
    }
    return cells;
  };
  let low = 0;
  let high = coast + STARTER_INTERIOR - lowest + NOISE_ONE;
  for (let step = 0; step < STARTER_RISE_SEARCH_STEPS && high - low > 1; step++) {
    const mid = (low + high) >> 1;
    if (covered(mid) >= starter.cells) high = mid;
    else low = mid;
  }
  // A cell reaches the rise through its warp, so the rise spans its radius plus the warp's reach.
  const reach = STARTER_RISE_RADIUS_CELLS + COARSE_WARP_REACH_CELLS + FINE_WARP_REACH_CELLS;
  for (let y = Math.max(0, siteY - reach); y <= Math.min(size - 1, siteY + reach); y++) {
    for (let x = Math.max(0, siteX - reach); x <= Math.min(size - 1, siteX + reach); x++) {
      const i = y * size + x;
      continent[i] = continent[i]! + starterRise(fade, high, x + warpX[i]! - siteX, y + warpY[i]! - siteY);
    }
  }
  return { cell: site, amplitude: high };
}

/** Sea floor below the coast: shelf, slope, abyss, falling from the coast level so the shore has no step. */
function seaFloor(depth: number): number {
  const coastLevel = COAST_BANDS * SUB_BAND;
  const shelfEdge = -FRESH_SHELF_BANDS_BELOW_SEA * SUB_BAND;
  if (depth < SHELF_WIDTH) return coastLevel - Math.floor((depth * (coastLevel - shelfEdge)) / SHELF_WIDTH);
  const abyss = -GENESIS_ABYSS_BANDS_BELOW_SEA * SUB_BAND;
  return shelfEdge - Math.floor(((depth - SHELF_WIDTH) * (shelfEdge - abyss)) / SLOPE_WIDTH);
}

/** Flood neighbours in a fixed order: it breaks ties between equal levels. */
const FLOOD_DX = [1, -1, 0, 0, 1, -1, 1, -1];
const FLOOD_DY = [0, 0, 1, -1, 1, 1, -1, -1];

/** Forward then backward raster pass: the exact chamfer envelope. `grow` spreads maxima, else minima. */
function chamfer(a: Int32Array, size: number, perCell: number, grow: boolean): void {
  const side = Math.floor((perCell * SIDE_FIXED) / SIDE_FIXED);
  const diagonal = Math.floor((perCell * DIAGONAL_FIXED) / SIDE_FIXED);
  // Growing is shrinking the negated field.
  const sign = grow ? -1 : 1;
  const last = size - 1;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      let v = sign * a[i]!;
      if (x > 0 && sign * a[i - 1]! + side < v) v = sign * a[i - 1]! + side;
      if (y > 0) {
        if (sign * a[i - size]! + side < v) v = sign * a[i - size]! + side;
        if (x > 0 && sign * a[i - size - 1]! + diagonal < v) v = sign * a[i - size - 1]! + diagonal;
        if (x < last && sign * a[i - size + 1]! + diagonal < v) v = sign * a[i - size + 1]! + diagonal;
      }
      a[i] = sign * v;
    }
  }
  for (let y = last; y >= 0; y--) {
    for (let x = last; x >= 0; x--) {
      const i = y * size + x;
      let v = sign * a[i]!;
      if (x < last && sign * a[i + 1]! + side < v) v = sign * a[i + 1]! + side;
      if (y < last) {
        if (sign * a[i + size]! + side < v) v = sign * a[i + size]! + side;
        if (x < last && sign * a[i + size + 1]! + diagonal < v) v = sign * a[i + size + 1]! + diagonal;
        if (x > 0 && sign * a[i + size - 1]! + diagonal < v) v = sign * a[i + size - 1]! + diagonal;
      }
      a[i] = sign * v;
    }
  }
}

/** Lowers every cell to at most `perCell` above each side neighbour (diagonals by sqrt(2)). */
export function limitSlope(a: Int32Array, size: number, perCell: number): void {
  chamfer(a, size, perCell, false);
}

/** Raster passes before the seabed raise is taken as converged; winding sea paths need a few. */
const SEABED_RAISE_SWEEPS = 4;

/**
 * Raises cells at or below `surface` to within `perCell` of their neighbours, capped at
 * `surface`. Higher cells only lift: a steep drop raises seabed, never sinks coast.
 */
export function raiseSeabed(a: Int32Array, size: number, perCell: number, surface: number): void {
  const side = perCell;
  const diagonal = Math.floor((perCell * DIAGONAL_FIXED) / SIDE_FIXED);
  const last = size - 1;
  const sea = new Uint8Array(size * size);
  for (let i = 0; i < sea.length; i++) sea[i] = a[i]! <= surface ? 1 : 0;
  for (let sweep = 0; sweep < SEABED_RAISE_SWEEPS; sweep++) {
    let raised = false;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const i = y * size + x;
        if (sea[i] === 0) continue;
        let v = a[i]!;
        if (x > 0 && a[i - 1]! - side > v) v = a[i - 1]! - side;
        if (y > 0) {
          if (a[i - size]! - side > v) v = a[i - size]! - side;
          if (x > 0 && a[i - size - 1]! - diagonal > v) v = a[i - size - 1]! - diagonal;
          if (x < last && a[i - size + 1]! - diagonal > v) v = a[i - size + 1]! - diagonal;
        }
        if (v > surface) v = surface;
        if (v !== a[i]) raised = true;
        a[i] = v;
      }
    }
    for (let y = last; y >= 0; y--) {
      for (let x = last; x >= 0; x--) {
        const i = y * size + x;
        if (sea[i] === 0) continue;
        let v = a[i]!;
        if (x < last && a[i + 1]! - side > v) v = a[i + 1]! - side;
        if (y < last) {
          if (a[i + size]! - side > v) v = a[i + size]! - side;
          if (x < last && a[i + size + 1]! - diagonal > v) v = a[i + size + 1]! - diagonal;
          if (x > 0 && a[i + size - 1]! - diagonal > v) v = a[i + size - 1]! - diagonal;
        }
        if (v > surface) v = surface;
        if (v !== a[i]) raised = true;
        a[i] = v;
      }
    }
    if (!raised) return;
  }
}

/** Cuts valleys along the drainage of the pit-filled field. Land stays land. */
function carveValleys(e: Int32Array, size: number): void {
  const count = size * size;
  const offset = GENESIS_ABYSS_BANDS_BELOW_SEA * SUB_BAND;
  const buckets = new Int32Array((GENESIS_ABYSS_BANDS_BELOW_SEA + GENESIS_PEAK_BANDS) * SUB_BAND + 1).fill(-1);
  const link = new Int32Array(count);
  const level = Int32Array.from(e);
  const order = new Int32Array(count);
  const drain = new Int32Array(count).fill(-1);
  const queued = new Uint8Array(count);
  let lowest = buckets.length;
  const last = size - 1;

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      if (e[i]! > 0 && x !== 0 && y !== 0 && x !== last && y !== last) continue;
      queued[i] = 1;
      const b = level[i]! + offset;
      link[i] = buckets[b]!;
      buckets[b] = i;
      if (b < lowest) lowest = b;
    }
  }
  for (let popped = 0; popped < count; popped++) {
    while (buckets[lowest] === -1) lowest++;
    const i = buckets[lowest]!;
    buckets[lowest] = link[i]!;
    order[popped] = i;
    const y = (i / size) | 0;
    const x = i - y * size;
    const here = level[i]!;
    for (let n = 0; n < FLOOD_DX.length; n++) {
      const nx = x + FLOOD_DX[n]!;
      const ny = y + FLOOD_DY[n]!;
      if (nx < 0 || ny < 0 || nx > last || ny > last) continue;
      const j = ny * size + nx;
      if (queued[j] === 1) continue;
      queued[j] = 1;
      if (level[j]! < here) level[j] = here;
      drain[j] = i;
      const b = level[j]! + offset;
      link[j] = buckets[b]!;
      buckets[b] = j;
      if (b < lowest) lowest = b;
    }
  }

  const area = link.fill(1);
  for (let k = count - 1; k >= 0; k--) {
    const i = order[k]!;
    if (drain[i]! >= 0) area[drain[i]!]! += area[i]!;
  }

  const depth = level;
  for (let i = 0; i < count; i++) {
    const a = area[i]!;
    depth[i] = e[i]! > 0 && a >= VALLEY_MIN_AREA_CELLS
      ? (31 - Math.clz32(a) - VALLEY_MIN_AREA_LOG2 + 1) * SUB_BAND
      : 0;
  }
  chamfer(depth, size, VALLEY_WALL_PER_CELL, true);
  for (let i = 0; i < count; i++) {
    const h = e[i]!;
    if (h <= 0 || depth[i]! <= 0) continue;
    const carved = h - depth[i]!;
    e[i] = carved > COAST_BANDS * SUB_BAND ? carved : Math.min(h, COAST_BANDS * SUB_BAND);
  }
}

export interface GenesisStarterRise {
  /** The cell the rise centres on: the starter square's highest continental value. */
  readonly cell: number;
  readonly amplitude: number;
}

export interface GenesisField {
  /** Whole-band height offsets from sea level, one per cell, row-major. */
  readonly bands: Int16Array;
  /** Each cell's position within its band, in 1/GENESIS_FIELD_SUB_BAND. */
  readonly fraction: Uint8Array;
  /** Null where the continents already covered the starter square. */
  readonly starterRise: GenesisStarterRise | null;
}

export const GENESIS_FIELD_SUB_BAND = SUB_BAND;

export function drawGenesisField(size: number, shape: GenesisFieldShape): GenesisField {
  const { seed, relief } = shape;
  let salt = 0;
  const next = (spacing: number): Octave => octave(spacing, seed, ++salt, size);
  const continents = CONTINENT_SPACINGS.map(next);
  const coarseWarp = [next(COARSE_WARP_SPACING), next(COARSE_WARP_SPACING)];
  const fineWarp = [next(FINE_WARP_SPACING), next(FINE_WARP_SPACING)];
  const hills = HILL_SPACINGS.map(next);
  const ranges = RANGE_SPACINGS.map(next);
  const regions = REGION_SPACINGS.map(next);

  const count = size * size;
  const warpX = new Int16Array(count);
  const warpY = new Int16Array(count);
  const continent = new Int16Array(count);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const wx =
        x +
        Math.floor((noise(coarseWarp[0]!, x, y) * COARSE_WARP_REACH_CELLS) / NOISE_ONE) +
        Math.floor((noise(fineWarp[0]!, x, y) * FINE_WARP_REACH_CELLS) / NOISE_ONE);
      const wy =
        y +
        Math.floor((noise(coarseWarp[1]!, x, y) * COARSE_WARP_REACH_CELLS) / NOISE_ONE) +
        Math.floor((noise(fineWarp[1]!, x, y) * FINE_WARP_REACH_CELLS) / NOISE_ONE);
      warpX[i] = wx - x;
      warpY[i] = wy - y;
      continent[i] = fractal(continents, wx, wy);
    }
  }
  const coast = coastThreshold(continent, shape.landPercent);
  const starterRise = raiseStarterLand(continent, warpX, warpY, size, coast, shape.starter);

  const e = new Int32Array(count);
  const coastFade = fadeTable(COAST_RISE_WIDTH);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * size + x;
      const c = continent[i]! - coast;
      const wx = x + warpX[i]!;
      const wy = y + warpY[i]!;
      if (c < 0) {
        const offshore = clamp(Math.floor((-c * SUB_BAND) / COAST_RISE_WIDTH), 0, SUB_BAND);
        const seabed =
          seaFloor(-c) +
          Math.floor(
            (fractal(hills, wx, wy) * SEABED_HILL_BANDS * offshore * relief) /
              (NOISE_ONE * SUB_BAND),
          );
        e[i] = clamp(seabed, -GENESIS_ABYSS_BANDS_BELOW_SEA * SUB_BAND, COAST_BANDS * SUB_BAND - 1);
        continue;
      }
      const inland = clamp(Math.floor((c * SUB_BAND) / COAST_RISE_WIDTH), 0, SUB_BAND);
      const rise = c < COAST_RISE_WIDTH ? coastFade[c]! : FADE_ONE;
      let h =
        COAST_BANDS * SUB_BAND +
        Math.floor((rise * LOWLAND_BANDS * SUB_BAND) / FADE_ONE) +
        Math.floor((c * INTERIOR_RISE_BANDS * SUB_BAND) / NOISE_ONE);

      const region = fractal(regions, x, y);
      const hilliness = clamp(PLAINS_BELOW + region, 0, NOISE_ONE);
      h += Math.floor(
        (fractal(hills, wx, wy) * HILL_BANDS * hilliness * inland * relief) /
          (NOISE_ONE * NOISE_ONE * SUB_BAND),
      );
      const rangeness = clamp((region - RANGES_ABOVE) * RANGE_ONSET_GAIN, 0, NOISE_ONE);
      h += Math.floor(
        (ridged(ranges, wx, wy) * RANGE_BANDS * rangeness * inland * relief) /
          (NOISE_ONE * NOISE_ONE * SUB_BAND),
      );
      e[i] = Math.min(h, GENESIS_PEAK_BANDS * SUB_BAND);
    }
  }

  carveValleys(e, size);
  // Seabed up before land down, so a steep drop never drags a coast under.
  raiseSeabed(e, size, MAX_SLOPE_PER_CELL, COAST_BANDS * SUB_BAND - 1);
  chamfer(e, size, MAX_SLOPE_PER_CELL, false);

  const bands = new Int16Array(count);
  const fraction = new Uint8Array(count);
  for (let i = 0; i < count; i++) {
    const whole = Math.floor(e[i]! / SUB_BAND);
    bands[i] = whole;
    fraction[i] = e[i]! - whole * SUB_BAND;
  }
  return { bands, fraction, starterRise };
}
