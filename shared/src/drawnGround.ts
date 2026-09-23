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
import { drawnSquareHoldsBand } from './drawnSquare.ts';

export {
  DRAWN_GROUND_BAND_BIAS,
  drawnBandOfSample,
  drawnLevelThreshold,
} from './bands.ts';
import {
  DRAWN_GROUND_BAND_BIAS,
  bandLevelHeight,
  drawnBandOfSample,
  drawnBandField,
} from './bands.ts';

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

/** The top ceiling, or the wall-rule field band `band` is drawn from. */
function sampleOf(map: Heightmap, x: number, y: number, band: number | null): number {
  return band === TOP_CEILING_FIELD
    ? map.cells[cellIndex(map, x, y)]!
    : drawnBandField(columnSampleAtBand(map, x, y, band), band);
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
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
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
  return Math.floor((numerator - SHORE_NUMERATOR) / BAND_NUMERATOR);
}

function lowestDrawnBandNear(map: Heightmap, qx: number, qz: number): number {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  let lowest = drawnBandOfSample(BEDROCK_FLOOR);
  let found = false;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
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

function anyCellLayered(map: Heightmap, qx: number, qz: number): boolean {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      if (map.columnSpans.has(cellIndex(map, x, y))) return true;
    }
  }
  return false;
}

/** Highest drawn band among the four corner tops a point blends. */
function highestCornerBand(map: Heightmap, qx: number, qz: number): number {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  let highest = -Infinity;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      const band = drawnBandOfSample(sampleOf(map, x, y, TOP_CEILING_FIELD));
      if (band > highest) highest = band;
    }
  }
  return highest;
}

function lowestCornerBand(map: Heightmap, qx: number, qz: number): number {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  let lowest = Infinity;
  for (let dz = 0; dz <= 1; dz++) {
    for (let dx = 0; dx <= 1; dx++) {
      const x = clampCell(i0 + dx, map.size);
      const y = clampCell(j0 + dz, map.size);
      const band = drawnBandOfSample(sampleOf(map, x, y, TOP_CEILING_FIELD));
      if (band < lowest) lowest = band;
    }
  }
  return lowest;
}

function rawSampleOf(map: Heightmap, x: number, y: number, band: number): number {
  return columnSampleAtBand(map, x, y, band);
}

/**
 * Band `band` is solid at the point. Its field's bilinear blend decides it,
 * except where a tall step fans its bands: there, the fanned outline itself.
 */
function bandSolidAt(map: Heightmap, qx: number, qz: number, band: number): boolean {
  const i0 = drawnCornerIndex(qx);
  const j0 = drawnCornerIndex(qz);
  const x0 = clampCell(i0, map.size);
  const x1 = clampCell(i0 + 1, map.size);
  const z0 = clampCell(j0, map.size);
  const z1 = clampCell(j0 + 1, map.size);
  const raw = [
    rawSampleOf(map, x0, z0, band),
    rawSampleOf(map, x1, z0, band),
    rawSampleOf(map, x1, z1, band),
    rawSampleOf(map, x0, z1, band),
  ];
  let lowest = Infinity;
  let highest = -Infinity;
  for (const h of raw) {
    const b = drawnBandOfSample(h);
    if (b < lowest) lowest = b;
    if (b > highest) highest = b;
  }
  if (highest - lowest <= 1) {
    return bandOfNumerator(drawnFieldNumerator(map, qx, qz, band)) >= band;
  }
  return drawnSquareHoldsBand(
    raw,
    band,
    (qx - i0 * DRAWN_GROUND_COORD_DENOM) / DRAWN_GROUND_COORD_DENOM,
    (qz - j0 * DRAWN_GROUND_COORD_DENOM) / DRAWN_GROUND_COORD_DENOM,
  );
}

export function drawnBandAt(map: Heightmap, x: number, z: number): number {
  const qx = quantizeDrawnCoord(x);
  const qz = quantizeDrawnCoord(z);
  const top = highestCornerBand(map, qx, qz);
  const layered = map.columnSpans.size !== 0 && anyCellLayered(map, qx, qz);
  // Every corner covers the lowest corner band, so nothing below it needs a test.
  const lowest = layered ? lowestDrawnBandNear(map, qx, qz) : lowestCornerBand(map, qx, qz);
  for (let band = top; band > lowest; band--) {
    if (bandSolidAt(map, qx, qz, band)) return band;
  }
  return lowest;
}

/**
 * Cap band of the drawn layer holding `band` at (x, z), or null when that band
 * is open there. Unlike drawnBandAt, a gap under an overhang reads as open.
 */
export function drawnLayerCapAt(map: Heightmap, x: number, z: number, band: number): number | null {
  const qx = quantizeDrawnCoord(x);
  const qz = quantizeDrawnCoord(z);
  if (map.columnSpans.size === 0 || !anyCellLayered(map, qx, qz)) {
    const top = drawnBandAt(map, x, z);
    return band <= top ? top : null;
  }
  const top = highestCornerBand(map, qx, qz);
  if (!bandSolidAt(map, qx, qz, band)) return null;
  // A band's field never exceeds the one beneath it, so `top` bounds the climb.
  let cap = band;
  while (cap < top && bandSolidAt(map, qx, qz, cap + 1)) cap++;
  return cap;
}

export function drawnHeightAt(map: Heightmap, x: number, z: number): number {
  return bandLevelHeight(drawnBandAt(map, x, z));
}
