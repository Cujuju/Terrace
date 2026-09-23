import {
  BAND_HEIGHT,
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

/** Noise values run in [-NOISE_ONE, NOISE_ONE]. */
const NOISE_ONE = 256;

/** Fixed-point one for the interpolation fade. */
const FADE_ONE = 1 << 16;

/** Sixteen gradients 22.5 degrees apart, length NOISE_ONE, rounded once. */
const GRADIENTS: readonly number[] = [
  256, 0, 237, 98, 181, 181, 98, 237, 0, 256, -98, 237, -181, 181, -237, 98,
  -256, 0, -237, -98, -181, -181, -98, -237, 0, -256, 98, -237, 181, -181, 237, -98,
];
const GRADIENT_MASK = GRADIENTS.length / 2 - 1;

/** A 2D gradient noise peaks at half a diagonal: sqrt(2) in NOISE_ONE fixed point rescales it to one. */
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
const RANGE_SPACINGS = [NEIGHBOURHOOD_CELLS * 4, NEIGHBOURHOOD_CELLS * 2, NEIGHBOURHOOD_CELLS];
/** Which regions are plains, hills or ranges. */
const REGION_SPACINGS = [NEIGHBOURHOOD_CELLS * 8, NEIGHBOURHOOD_CELLS * 6];

/** Domain warp: coarse bends coastlines and ranges, fine roughens them. Reach as a fraction of spacing. */
const COARSE_WARP_SPACING = NEIGHBOURHOOD_CELLS * 4;
const COARSE_WARP_REACH_CELLS = (COARSE_WARP_SPACING * 3) / 8;
const FINE_WARP_SPACING = NEIGHBOURHOOD_CELLS;
const FINE_WARP_REACH_CELLS = (FINE_WARP_SPACING * 5) / 16;

/** The shelf falls to the fresh shelf depth over this much continental value, then the slope to the abyss. */
const SHELF_WIDTH = 40;
const SLOPE_WIDTH = 180;

/** Coasts climb from the beach to the grass line over this much continental value. */
const COAST_RISE_WIDTH = NOISE_ONE / 4;
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

/** Valley walls and every other slope genesis draws: at most one band per cell. */
const MAX_SLOPE_PER_CELL = SUB_BAND;
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
  readonly salt: number;
  readonly seed: number;
  readonly offsetX: number;
  readonly offsetY: number;
  readonly fade: Int32Array;
}

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

function octave(spacing: number, seed: number, salt: number): Octave {
  if (spacing > MAX_SPACING_CELLS) throw new Error(`lattice spacing ${spacing} exceeds ${MAX_SPACING_CELLS}`);
  return {
    spacing,
    salt,
    seed,
    // Each octave's lattice sits at its own offset, so no two share grid lines.
    offsetX: hash(seed, salt, 0, 1) % spacing,
    offsetY: hash(seed, salt, 1, 0) % spacing,
    fade: fadeTable(spacing),
  };
}

function corner(o: Octave, i: number, j: number, dx: number, dy: number): number {
  const g = (hash(o.seed, o.salt, i, j) & GRADIENT_MASK) * 2;
  return GRADIENTS[g]! * dx + GRADIENTS[g + 1]! * dy;
}

/** Gradient noise at a cell, in [-NOISE_ONE, NOISE_ONE]. */
function noise(o: Octave, x: number, y: number): number {
  const s = o.spacing;
  const px = x + o.offsetX;
  const py = y + o.offsetY;
  const i = Math.floor(px / s);
  const j = Math.floor(py / s);
  const fx = px - i * s;
  const fy = py - j * s;
  const d00 = corner(o, i, j, fx, fy);
  const d10 = corner(o, i + 1, j, fx - s, fy);
  const d01 = corner(o, i, j + 1, fx, fy - s);
  const d11 = corner(o, i + 1, j + 1, fx - s, fy - s);
  const u = o.fade[fx]!;
  const v = o.fade[fy]!;
  const top = d00 * FADE_ONE + (d10 - d00) * u;
  const bottom = d01 * FADE_ONE + (d11 - d01) * u;
  const blended = Math.floor((top * FADE_ONE + (bottom - top) * v) / FADE_ONE);
  return Math.floor((blended * SQRT2_FIXED) / (s * FADE_ONE * NOISE_ONE));
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
): void {
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
  if (landCells >= starter.cells) return;

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
}

/** Sea floor below the coast: shelf, slope, abyss. `depth` > 0. */
function seaFloor(depth: number): number {
  if (depth < SHELF_WIDTH) return -Math.floor((depth * FRESH_SHELF_BANDS_BELOW_SEA * SUB_BAND) / SHELF_WIDTH);
  const slope = Math.floor(
    ((depth - SHELF_WIDTH) * (GENESIS_ABYSS_BANDS_BELOW_SEA - FRESH_SHELF_BANDS_BELOW_SEA) * SUB_BAND) / SLOPE_WIDTH,
  );
  return -FRESH_SHELF_BANDS_BELOW_SEA * SUB_BAND - slope;
}

const NEIGHBOURS_BACK: readonly (readonly [number, number, number])[] = [
  [-1, 0, SIDE_FIXED], [0, -1, SIDE_FIXED], [-1, -1, DIAGONAL_FIXED], [1, -1, DIAGONAL_FIXED],
];
const NEIGHBOURS_ALL: readonly (readonly [number, number])[] = [
  [1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, 1], [1, -1], [-1, -1],
];

/** Forward then backward raster pass: the exact chamfer envelope. `grow` spreads maxima, else minima. */
function chamfer(a: Int32Array, size: number, perCell: number, grow: boolean): void {
  for (let pass = 0; pass < 2; pass++) {
    const sign = pass === 0 ? 1 : -1;
    for (let k = 0; k < size * size; k++) {
      const i = pass === 0 ? k : size * size - 1 - k;
      const x = i % size;
      const y = (i - x) / size;
      let v = a[i]!;
      for (const [bx, by, length] of NEIGHBOURS_BACK) {
        const nx = x + sign * bx;
        const ny = y + sign * by;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const step = Math.floor((perCell * length) / SIDE_FIXED);
        const n = a[ny * size + nx]!;
        if (grow) {
          if (n - step > v) v = n - step;
        } else if (n + step < v) v = n + step;
      }
      a[i] = v;
    }
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
  const push = (i: number): void => {
    const b = level[i]! + offset;
    link[i] = buckets[b]!;
    buckets[b] = i;
    if (b < lowest) lowest = b;
  };

  for (let i = 0; i < count; i++) {
    const x = i % size;
    const y = (i - x) / size;
    if (e[i]! <= 0 || x === 0 || y === 0 || x === size - 1 || y === size - 1) {
      queued[i] = 1;
      push(i);
    }
  }
  for (let popped = 0; popped < count; popped++) {
    while (buckets[lowest] === -1) lowest++;
    const i = buckets[lowest]!;
    buckets[lowest] = link[i]!;
    order[popped] = i;
    const x = i % size;
    const y = (i - x) / size;
    for (const [dx, dy] of NEIGHBOURS_ALL) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
      const j = ny * size + nx;
      if (queued[j] === 1) continue;
      queued[j] = 1;
      if (level[j]! < level[i]!) level[j] = level[i]!;
      drain[j] = i;
      push(j);
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

/** Whole-band height offsets from sea level, one per cell, row-major. */
export function drawGenesisField(size: number, shape: GenesisFieldShape): Int16Array {
  const { seed, relief } = shape;
  let salt = 0;
  const next = (spacing: number): Octave => octave(spacing, seed, ++salt);
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
  raiseStarterLand(continent, warpX, warpY, size, coast, shape.starter);

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
        e[i] = clamp(seabed, -GENESIS_ABYSS_BANDS_BELOW_SEA * SUB_BAND, 0);
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
  chamfer(e, size, MAX_SLOPE_PER_CELL, false);

  const bands = new Int16Array(count);
  for (let i = 0; i < count; i++) bands[i] = Math.floor(e[i]! / SUB_BAND);
  return bands;
}
