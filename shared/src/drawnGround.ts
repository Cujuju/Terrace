import { BAND_HEIGHT } from './constants.ts';
import {
  BEDROCK_FLOOR,
  columnSampleAtBand,
  isSpanDrawn,
  spanAt,
  spanCapHeight,
  spanCount,
} from './columns.ts';
import { bandOf, cellIndex, type Heightmap } from './grid.ts';
import { SHEER_RISE_HEIGHT_UNITS_PER_CELL } from './traversal.ts';

export const DRAWN_GROUND_COORD_DENOM = 1024;

export const DRAWN_GROUND_BAND_BIAS = BAND_HEIGHT / 2;

export const ISOLINE_SAMPLES_PER_CELL = 4;

export const SHEER_WALL_SPREAD_CELLS = 1;

export const DRAWN_GROUND_CROSSING_MIDPOINT = 1 / 2;

export const DRAWN_GROUND_CELL_CENTRE = 1 / 2;

const CENTRE_COORD_UNITS = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_CELL_CENTRE;

const WEIGHT_TOTAL = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_COORD_DENOM;

const BAND_NUMERATOR = BAND_HEIGHT * WEIGHT_TOTAL;

const BIAS_NUMERATOR = DRAWN_GROUND_BAND_BIAS * WEIGHT_TOTAL;

const TOP_CEILING_FIELD = null;

export function drawnBandOfSample(height: number): number {
  return Math.floor((height + DRAWN_GROUND_BAND_BIAS) / BAND_HEIGHT);
}

export function drawnSampleIsInside(height: number, threshold: number): boolean {
  return height + DRAWN_GROUND_BAND_BIAS >= threshold;
}

export const DRAWN_GROUND_CENTRE_CLEARANCE = 1 / DRAWN_GROUND_COORD_DENOM;

export const DRAWN_GROUND_SIMPLIFY_EPSILON = DRAWN_GROUND_CENTRE_CLEARANCE / 4;

export function drawnCrossingFraction(
  outsideHeight: number,
  insideHeight: number,
  threshold: number,
): number {
  const rise = insideHeight - outsideHeight;
  if (!(rise > 0)) return DRAWN_GROUND_CROSSING_MIDPOINT;
  const exact = (threshold - DRAWN_GROUND_BAND_BIAS - outsideHeight) / rise;
  const s =
    rise <= SHEER_RISE_HEIGHT_UNITS_PER_CELL
      ? exact
      : DRAWN_GROUND_CROSSING_MIDPOINT +
        (exact - DRAWN_GROUND_CROSSING_MIDPOINT) * SHEER_WALL_SPREAD_CELLS;
  if (s < DRAWN_GROUND_CENTRE_CLEARANCE) return DRAWN_GROUND_CENTRE_CLEARANCE;
  if (s > 1 - DRAWN_GROUND_CENTRE_CLEARANCE) return 1 - DRAWN_GROUND_CENTRE_CLEARANCE;
  return s;
}

export function quantizeDrawnCoord(v: number): number {
  if (!Number.isFinite(v)) return -CENTRE_COORD_UNITS;
  return Math.floor(v * DRAWN_GROUND_COORD_DENOM) - CENTRE_COORD_UNITS;
}

function clampCell(index: number, size: number): number {
  return index < 0 ? 0 : index > size - 1 ? size - 1 : index;
}

function sampleOf(map: Heightmap, x: number, y: number, band: number | null): number {
  return band === TOP_CEILING_FIELD
    ? map.cells[cellIndex(map, x, y)]!
    : columnSampleAtBand(map, x, y, band);
}

export function drawnCornerNumerator(
  northWest: number,
  northEast: number,
  southWest: number,
  southEast: number,
  tx: number,
  tz: number,
): number {
  const west = DRAWN_GROUND_COORD_DENOM - tx;
  const north = DRAWN_GROUND_COORD_DENOM - tz;
  return (northWest * west + northEast * tx) * north + (southWest * west + southEast * tx) * tz;
}

export function drawnFieldNumerator(
  map: Heightmap,
  qx: number,
  qz: number,
  band: number | null = TOP_CEILING_FIELD,
): number {
  const i0 = Math.floor(qx / DRAWN_GROUND_COORD_DENOM);
  const j0 = Math.floor(qz / DRAWN_GROUND_COORD_DENOM);
  const x0 = clampCell(i0, map.size);
  const x1 = clampCell(i0 + 1, map.size);
  const z0 = clampCell(j0, map.size);
  const z1 = clampCell(j0 + 1, map.size);
  return drawnCornerNumerator(
    sampleOf(map, x0, z0, band),
    sampleOf(map, x1, z0, band),
    sampleOf(map, x0, z1, band),
    sampleOf(map, x1, z1, band),
    qx - i0 * DRAWN_GROUND_COORD_DENOM,
    qz - j0 * DRAWN_GROUND_COORD_DENOM,
  );
}

export const ISOLINE_SOLVE_DENOM = 1 << 16;

const SOLVE_PER_COORD_UNIT = ISOLINE_SOLVE_DENOM / DRAWN_GROUND_COORD_DENOM;

const SOLVE_WEIGHT_TOTAL = ISOLINE_SOLVE_DENOM * ISOLINE_SOLVE_DENOM;

export function drawnIsolineAt(
  northWest: number,
  northEast: number,
  southWest: number,
  southEast: number,
  threshold: number,
  fixedUnits: number,
  alongX: boolean,
): number | null {
  const target = (threshold - DRAWN_GROUND_BAND_BIAS) * SOLVE_WEIGHT_TOTAL;
  const fixed = fixedUnits * SOLVE_PER_COORD_UNIT;
  const insideAt = (units: number): boolean => {
    const tx = alongX ? fixed : units;
    const tz = alongX ? units : fixed;
    const west = ISOLINE_SOLVE_DENOM - tx;
    const north = ISOLINE_SOLVE_DENOM - tz;
    const value =
      (northWest * west + northEast * tx) * north +
      (southWest * west + southEast * tx) * tz;
    return value >= target;
  };

  const insideLow = insideAt(0);
  if (insideLow === insideAt(ISOLINE_SOLVE_DENOM)) return null;
  let low = 0;
  let high = ISOLINE_SOLVE_DENOM;
  while (high - low > 1) {
    const mid = (low + high) >> 1;
    if (insideAt(mid) === insideLow) low = mid;
    else high = mid;
  }
  return (insideLow ? low : high) / ISOLINE_SOLVE_DENOM;
}

function bandOfNumerator(numerator: number): number {
  return Math.floor((numerator + BIAS_NUMERATOR) / BAND_NUMERATOR);
}

function lowestDrawnBandNear(map: Heightmap, qx: number, qz: number): number {
  const i0 = Math.floor(qx / DRAWN_GROUND_COORD_DENOM);
  const j0 = Math.floor(qz / DRAWN_GROUND_COORD_DENOM);
  let lowest = bandOf(BEDROCK_FLOOR);
  let found = false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      const count = spanCount(map, x, y);
      for (let k = 0; k < count; k++) {
        const span = spanAt(map, x, y, k);
        if (!isSpanDrawn(span)) continue;
        const band = bandOf(spanCapHeight(span));
        if (!found || band < lowest) lowest = band;
        found = true;
        break;
      }
    }
  }
  return lowest;
}

function anyCellLayered(map: Heightmap, qx: number, qz: number): boolean {
  const i0 = Math.floor(qx / DRAWN_GROUND_COORD_DENOM);
  const j0 = Math.floor(qz / DRAWN_GROUND_COORD_DENOM);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      if (map.columnSpans.has(cellIndex(map, x, y))) return true;
    }
  }
  return false;
}

export function drawnBandAt(map: Heightmap, x: number, z: number): number {
  const qx = quantizeDrawnCoord(x);
  const qz = quantizeDrawnCoord(z);
  const top = bandOfNumerator(drawnFieldNumerator(map, qx, qz));
  if (map.columnSpans.size === 0 || !anyCellLayered(map, qx, qz)) return top;
  const lowest = lowestDrawnBandNear(map, qx, qz);
  for (let band = top; band > lowest; band--) {
    if (bandOfNumerator(drawnFieldNumerator(map, qx, qz, band)) >= band) return band;
  }
  return lowest;
}

export function drawnHeightAt(map: Heightmap, x: number, z: number): number {
  return drawnBandAt(map, x, z) * BAND_HEIGHT;
}
