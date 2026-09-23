import { BAND_HEIGHT, DRAWN_SHORE_HEIGHT } from './constants.ts';
import {
  BEDROCK_FLOOR,
  columnSampleAtBand,
  isSpanDrawn,
  spanAt,
  spanCount,
  spanIndexCoveringBand,
  type Span,
} from './columns.ts';
import { cellIndex, type Heightmap } from './grid.ts';
import { SHEER_RISE_HEIGHT_UNITS_PER_CELL } from './traversal.ts';
import type { DrawnSurfaceField } from './drawnFieldFilter.ts';

export {
  DRAWN_GROUND_BAND_BIAS,
  drawnBandOfSample,
  drawnLevelThreshold,
} from './bands.ts';
import { DRAWN_GROUND_BAND_BIAS, bandLevelHeight, drawnBandOfSample } from './bands.ts';

export const DRAWN_GROUND_COORD_DENOM = 1024;

export const ISOLINE_SAMPLES_PER_CELL = 4;

export const SHEER_WALL_SPREAD_CELLS = 1;

export const DRAWN_GROUND_CROSSING_MIDPOINT = 1 / 2;

export const DRAWN_GROUND_CELL_CENTRE = 1 / 2;

const CENTRE_COORD_UNITS = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_CELL_CENTRE;

const WEIGHT_TOTAL = DRAWN_GROUND_COORD_DENOM * DRAWN_GROUND_COORD_DENOM;

const BAND_NUMERATOR = BAND_HEIGHT * WEIGHT_TOTAL;

const SHORE_NUMERATOR = DRAWN_SHORE_HEIGHT * WEIGHT_TOTAL;

const TOP_CEILING_FIELD = null;

export function drawnSpanIndexCoveringBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number | null {
  return spanIndexCoveringBand(map, x, y, band);
}

export function drawnBandOfSpan(span: Span): number {
  return drawnBandOfSample(span.ceiling);
}

export function drawnSpanCapHeight(span: Span): number {
  return drawnBandOfSpan(span) * BAND_HEIGHT;
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

function drawnCornerIndex(quantized: number): number {
  return Math.floor(quantized / DRAWN_GROUND_COORD_DENOM);
}

export function quantizeDrawnCoord(v: number): number {
  if (!Number.isFinite(v)) return -CENTRE_COORD_UNITS;
  return Math.floor(v * DRAWN_GROUND_COORD_DENOM) - CENTRE_COORD_UNITS;
}

export function drawnSampleCellIndex(coordinate: number): number {
  return drawnCornerIndex(quantizeDrawnCoord(coordinate));
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
  surface?: DrawnSurfaceField,
): number {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  const x0 = clampCell(i0, map.size);
  const x1 = clampCell(i0 + 1, map.size);
  const z0 = clampCell(j0, map.size);
  const z1 = clampCell(j0 + 1, map.size);
  return drawnCornerNumerator(
    surface ? surface.sample(x0, z0, band) : sampleOf(map, x0, z0, band),
    surface ? surface.sample(x1, z0, band) : sampleOf(map, x1, z0, band),
    surface ? surface.sample(x0, z1, band) : sampleOf(map, x0, z1, band),
    surface ? surface.sample(x1, z1, band) : sampleOf(map, x1, z1, band),
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

function bandOfNumerator(numerator: number, scale = 1): number {
  return Math.floor((numerator - SHORE_NUMERATOR * scale) / (BAND_NUMERATOR * scale));
}

function lowestDrawnBandNear(map: Heightmap, qx: number, qz: number, reach = 0): number {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  let lowest = drawnBandOfSample(BEDROCK_FLOOR);
  let found = false;
  for (let dz = -reach; dz <= 1 + reach; dz++) {
    for (let dx = -reach; dx <= 1 + reach; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      const count = spanCount(map, x, y);
      for (let k = 0; k < count; k++) {
        const span = spanAt(map, x, y, k);
        if (!isSpanDrawn(span)) continue;
        const band = drawnBandOfSample(span.ceiling);
        if (!found || band < lowest) lowest = band;
        found = true;
        break;
      }
    }
  }
  return lowest;
}

function anyCellLayered(map: Heightmap, qx: number, qz: number, reach = 0): boolean {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  for (let dz = -reach; dz <= 1 + reach; dz++) {
    for (let dx = -reach; dx <= 1 + reach; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      if (map.columnSpans.has(cellIndex(map, x, y))) return true;
    }
  }
  return false;
}

function highestDrawnBandNear(map: Heightmap, qx: number, qz: number, reach: number): number {
  let highest = -Infinity;
  for (let dz = -reach; dz <= 1 + reach; dz++) {
    for (let dx = -reach; dx <= 1 + reach; dx++) {
      highest = Math.max(highest, drawnBandOfSample(sampleOf(map,
        clampCell(drawnCornerIndex(qx) + dx, map.size),
        clampCell(drawnCornerIndex(qz) + dz, map.size), null)));
    }
  }
  return highest;
}

export function drawnBandAt(map: Heightmap, x: number, z: number, surface?: DrawnSurfaceField): number {
  const qx = quantizeDrawnCoord(x);
  const qz = quantizeDrawnCoord(z);
  const scale = surface?.scale ?? 1;
  const reach = surface?.reach ?? 0;
  const fieldTop = bandOfNumerator(drawnFieldNumerator(map, qx, qz, null, surface), scale);
  if (map.columnSpans.size === 0 || !anyCellLayered(map, qx, qz, reach)) return fieldTop;
  const top = reach ? highestDrawnBandNear(map, qx, qz, reach) : fieldTop;
  const lowest = lowestDrawnBandNear(map, qx, qz, reach);
  for (let band = top; band > lowest; band--) {
    if (bandOfNumerator(drawnFieldNumerator(map, qx, qz, band, surface), scale) >= band) return band;
  }
  return lowest;
}

/**
 * Cap band of the drawn layer holding `band` at (x, z), or null when that band
 * is open there. Unlike drawnBandAt, a gap under an overhang reads as open.
 */
export function drawnLayerCapAt(
  map: Heightmap,
  x: number,
  z: number,
  band: number,
  surface?: DrawnSurfaceField,
): number | null {
  const qx = quantizeDrawnCoord(x);
  const qz = quantizeDrawnCoord(z);
  const scale = surface?.scale ?? 1;
  const reach = surface?.reach ?? 0;
  const fieldTop = bandOfNumerator(drawnFieldNumerator(map, qx, qz, null, surface), scale);
  if (map.columnSpans.size === 0 || !anyCellLayered(map, qx, qz, reach)) {
    return band <= fieldTop ? fieldTop : null;
  }
  const top = reach ? highestDrawnBandNear(map, qx, qz, reach) : fieldTop;
  const solidAt = (b: number): boolean =>
    bandOfNumerator(drawnFieldNumerator(map, qx, qz, b, surface), scale) >= b;
  if (!solidAt(band)) return null;
  // Independently filtered band fields require a raw-support upper bound.
  let cap = band;
  while (cap < top && solidAt(cap + 1)) cap++;
  return cap;
}

export function drawnHeightAt(map: Heightmap, x: number, z: number, surface?: DrawnSurfaceField): number {
  return bandLevelHeight(drawnBandAt(map, x, z, surface));
}
