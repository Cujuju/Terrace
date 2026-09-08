import { BAND_HEIGHT, MAX_SPANS_PER_COLUMN, TERRAIN_LOD_NEAR_N } from './constants.ts';
import { cellIndex, type Heightmap } from './grid.ts';
import { columnSampleAtBand, spanCount } from './columns.ts';

const SUBCELL_DENOM = 2 * TERRAIN_LOD_NEAR_N;

const BLEND_DENOM = SUBCELL_DENOM * SUBCELL_DENOM;

const BAND_BLEND_DENOM = BLEND_DENOM * BAND_HEIGHT;

const FIXPOINT_STEPS_PER_SPAN = 4;

export const DRAWN_GROUND_FIXPOINT_STEPS = FIXPOINT_STEPS_PER_SPAN * MAX_SPANS_PER_COLUMN;

interface Footprint {
  readonly x0: number;
  readonly y0: number;
  readonly x1: number;
  readonly y1: number;
  readonly fx: number;
  readonly fy: number;
}

function floorDiv(a: number, b: number): number {
  const q = Math.trunc(a / b);
  return q * b > a ? q - 1 : q;
}

function clampCell(size: number, i: number): number {
  return i < 0 ? 0 : i > size - 1 ? size - 1 : i;
}

// Ordered so NaN, failing every comparison, lands on the low border.
function clampCoord(size: number, coord: number): number {
  return coord > 0 ? (coord < size ? coord : size) : 0;
}

function latticeOffset(coord: number): number {
  return 2 * Math.floor(coord * TERRAIN_LOD_NEAR_N) + 1 - TERRAIN_LOD_NEAR_N;
}

function footprintAt(map: Heightmap, x: number, y: number): Footprint {
  const qx = latticeOffset(clampCoord(map.size, x));
  const qy = latticeOffset(clampCoord(map.size, y));
  const baseX = floorDiv(qx, SUBCELL_DENOM);
  const baseY = floorDiv(qy, SUBCELL_DENOM);
  return {
    x0: clampCell(map.size, baseX),
    y0: clampCell(map.size, baseY),
    x1: clampCell(map.size, baseX + 1),
    y1: clampCell(map.size, baseY + 1),
    fx: qx - baseX * SUBCELL_DENOM,
    fy: qy - baseY * SUBCELL_DENOM,
  };
}

function blendBand(
  fp: Footprint,
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): number {
  const numerator =
    (SUBCELL_DENOM - fp.fx) * (SUBCELL_DENOM - fp.fy) * h00 +
    fp.fx * (SUBCELL_DENOM - fp.fy) * h10 +
    (SUBCELL_DENOM - fp.fx) * fp.fy * h01 +
    fp.fx * fp.fy * h11;
  return floorDiv(numerator, BAND_BLEND_DENOM);
}

function bandOfCellBlend(map: Heightmap, fp: Footprint): number {
  return blendBand(
    fp,
    map.cells[cellIndex(map, fp.x0, fp.y0)]!,
    map.cells[cellIndex(map, fp.x1, fp.y0)]!,
    map.cells[cellIndex(map, fp.x0, fp.y1)]!,
    map.cells[cellIndex(map, fp.x1, fp.y1)]!,
  );
}

function bandOfSampleBlend(map: Heightmap, fp: Footprint, band: number): number {
  return blendBand(
    fp,
    columnSampleAtBand(map, fp.x0, fp.y0, band),
    columnSampleAtBand(map, fp.x1, fp.y0, band),
    columnSampleAtBand(map, fp.x0, fp.y1, band),
    columnSampleAtBand(map, fp.x1, fp.y1, band),
  );
}

function footprintIsUnlayered(map: Heightmap, fp: Footprint): boolean {
  if (map.columnSpans.size === 0) return true;
  return (
    spanCount(map, fp.x0, fp.y0) === 1 &&
    spanCount(map, fp.x1, fp.y0) === 1 &&
    spanCount(map, fp.x0, fp.y1) === 1 &&
    spanCount(map, fp.x1, fp.y1) === 1
  );
}

export function drawnGroundCoversBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): boolean {
  return bandOfSampleBlend(map, footprintAt(map, x, y), band) >= band;
}

export function drawnGroundHeight(map: Heightmap, x: number, y: number): number {
  const fp = footprintAt(map, x, y);
  let band = bandOfCellBlend(map, fp);
  if (footprintIsUnlayered(map, fp)) return band * BAND_HEIGHT;
  for (let step = 0; step < DRAWN_GROUND_FIXPOINT_STEPS; step++) {
    const next = bandOfSampleBlend(map, fp, band);
    if (next === band) break;
    band = next;
  }
  return band * BAND_HEIGHT;
}
