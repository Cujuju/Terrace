import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_SPANS_PER_COLUMN,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_NEAR_N,
  CELL_CENTRE_OFFSET_CELLS,
} from './constants.ts';
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

function blendBandAt(
  fx: number,
  fy: number,
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): number {
  const numerator =
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * h00 +
    fx * (SUBCELL_DENOM - fy) * h10 +
    (SUBCELL_DENOM - fx) * fy * h01 +
    fx * fy * h11;
  return floorDiv(numerator, BAND_BLEND_DENOM);
}

function blendBand(
  fp: Footprint,
  h00: number,
  h10: number,
  h01: number,
  h11: number,
): number {
  return blendBandAt(fp.fx, fp.fy, h00, h10, h01, h11);
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

function cornersAreUnlayered(
  map: Heightmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
): boolean {
  return (
    spanCount(map, x0, y0) === 1 &&
    spanCount(map, x1, y0) === 1 &&
    spanCount(map, x0, y1) === 1 &&
    spanCount(map, x1, y1) === 1
  );
}

function footprintIsUnlayered(map: Heightmap, fp: Footprint): boolean {
  if (map.columnSpans.size === 0) return true;
  return cornersAreUnlayered(map, fp.x0, fp.y0, fp.x1, fp.y1);
}

function settleBand(
  map: Heightmap,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  fx: number,
  fy: number,
  seed: number,
): number {
  let band = seed;
  for (let step = 0; step < DRAWN_GROUND_FIXPOINT_STEPS; step++) {
    const next = blendBandAt(
      fx,
      fy,
      columnSampleAtBand(map, x0, y0, band),
      columnSampleAtBand(map, x1, y0, band),
      columnSampleAtBand(map, x0, y1, band),
      columnSampleAtBand(map, x1, y1, band),
    );
    if (next === band) break;
    band = next;
  }
  return band;
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
  const seed = bandOfCellBlend(map, fp);
  if (footprintIsUnlayered(map, fp)) return seed * BAND_HEIGHT;
  return settleBand(map, fp.x0, fp.y0, fp.x1, fp.y1, fp.fx, fp.fy, seed) * BAND_HEIGHT;
}

const NEAR_SUBCELLS_PER_CELL = TERRAIN_LOD_NEAR_N;

const FAR_SUBCELLS_PER_CHUNK = CHUNK_SIZE * TERRAIN_LOD_FAR_N;

/** `latticeOffset` of near sub-cell `s`, relative to the lattice of its own cell. */
function subcellLatticeOffset(sub: number): number {
  return 2 * sub + 1 - TERRAIN_LOD_NEAR_N;
}

/** Footprint fraction of near sub-cell `s`. */
const SUBCELL_FRACTIONS = Array.from({ length: NEAR_SUBCELLS_PER_CELL }, (_, s) =>
  subcellLatticeOffset(s) < 0
    ? subcellLatticeOffset(s) + SUBCELL_DENOM
    : subcellLatticeOffset(s),
);

/** Cells from the footprint base to the cell near sub-cell `s` belongs to. */
const SUBCELL_CELL_STEPS = Array.from({ length: NEAR_SUBCELLS_PER_CELL }, (_, s) =>
  subcellLatticeOffset(s) < 0 ? 1 : 0,
);

function farSubcellOf(nearSub: number): number {
  return Math.floor((nearSub * TERRAIN_LOD_FAR_N) / TERRAIN_LOD_NEAR_N);
}

/** Worst gap between a chunk's near sub-cell heights and the far samples covering them. */
export function drawnGroundLodError(map: Heightmap, cx: number, cy: number): number {
  const cellX0 = cx * CHUNK_SIZE;
  const cellY0 = cy * CHUNK_SIZE;
  const far = new Int32Array(FAR_SUBCELLS_PER_CHUNK * FAR_SUBCELLS_PER_CHUNK);
  for (let j = 0; j < FAR_SUBCELLS_PER_CHUNK; j++) {
    const y = cellY0 + (j + CELL_CENTRE_OFFSET_CELLS) / TERRAIN_LOD_FAR_N;
    for (let i = 0; i < FAR_SUBCELLS_PER_CHUNK; i++) {
      const x = cellX0 + (i + CELL_CENTRE_OFFSET_CELLS) / TERRAIN_LOD_FAR_N;
      far[j * FAR_SUBCELLS_PER_CHUNK + i] = drawnGroundHeight(map, x, y);
    }
  }
  const flat = map.columnSpans.size === 0;
  let worst = 0;
  for (let by = cellY0 - 1; by < cellY0 + CHUNK_SIZE; by++) {
    const y0 = clampCell(map.size, by);
    const y1 = clampCell(map.size, by + 1);
    for (let bx = cellX0 - 1; bx < cellX0 + CHUNK_SIZE; bx++) {
      const x0 = clampCell(map.size, bx);
      const x1 = clampCell(map.size, bx + 1);
      const h00 = map.cells[cellIndex(map, x0, y0)]!;
      const h10 = map.cells[cellIndex(map, x1, y0)]!;
      const h01 = map.cells[cellIndex(map, x0, y1)]!;
      const h11 = map.cells[cellIndex(map, x1, y1)]!;
      const unlayered = flat || cornersAreUnlayered(map, x0, y0, x1, y1);
      for (let sy = 0; sy < NEAR_SUBCELLS_PER_CELL; sy++) {
        const cellY = by + SUBCELL_CELL_STEPS[sy]! - cellY0;
        if (cellY < 0 || cellY >= CHUNK_SIZE) continue;
        const fy = SUBCELL_FRACTIONS[sy]!;
        const farRow =
          farSubcellOf(cellY * NEAR_SUBCELLS_PER_CELL + sy) * FAR_SUBCELLS_PER_CHUNK;
        for (let sx = 0; sx < NEAR_SUBCELLS_PER_CELL; sx++) {
          const cellX = bx + SUBCELL_CELL_STEPS[sx]! - cellX0;
          if (cellX < 0 || cellX >= CHUNK_SIZE) continue;
          const fx = SUBCELL_FRACTIONS[sx]!;
          const seed = blendBandAt(fx, fy, h00, h10, h01, h11);
          const band = unlayered ? seed : settleBand(map, x0, y0, x1, y1, fx, fy, seed);
          const nearHeight = band * BAND_HEIGHT;
          const farHeight = far[farRow + farSubcellOf(cellX * NEAR_SUBCELLS_PER_CELL + sx)]!;
          const gap = nearHeight > farHeight ? nearHeight - farHeight : farHeight - nearHeight;
          if (gap > worst) worst = gap;
        }
      }
    }
  }
  return worst;
}
