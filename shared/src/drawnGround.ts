import { BAND_HEIGHT, TERRAIN_LOD_NEAR_N } from './constants.ts';
import { cellIndex, type Heightmap } from './grid.ts';
import { columnSampleAtBand, OPEN_COLUMN_SAMPLE } from './columns.ts';

const SUBCELL_DENOM = 2 * TERRAIN_LOD_NEAR_N;

const BLEND_DENOM = SUBCELL_DENOM * SUBCELL_DENOM;

const TOP_SURFACE = null;

function floorDiv(a: number, b: number): number {
  const q = Math.trunc(a / b);
  return q * b > a ? q - 1 : q;
}

function clampCell(size: number, i: number): number {
  return i < 0 ? 0 : i > size - 1 ? size - 1 : i;
}

function latticeOffset(coord: number): number {
  return 2 * Math.floor(coord * TERRAIN_LOD_NEAR_N) + 1 - TERRAIN_LOD_NEAR_N;
}

function cornerSample(map: Heightmap, cx: number, cy: number, band: number | null): number {
  if (band === TOP_SURFACE) return map.cells[cellIndex(map, cx, cy)]!;
  return columnSampleAtBand(map, cx, cy, band);
}

function drawnSurface(map: Heightmap, x: number, y: number, band: number | null): number {
  const qx = latticeOffset(x);
  const qy = latticeOffset(y);
  const baseX = floorDiv(qx, SUBCELL_DENOM);
  const baseY = floorDiv(qy, SUBCELL_DENOM);
  const fx = qx - baseX * SUBCELL_DENOM;
  const fy = qy - baseY * SUBCELL_DENOM;
  const x0 = clampCell(map.size, baseX);
  const x1 = clampCell(map.size, baseX + 1);
  const y0 = clampCell(map.size, baseY);
  const y1 = clampCell(map.size, baseY + 1);
  const h00 = cornerSample(map, x0, y0, band);
  const h10 = cornerSample(map, x1, y0, band);
  const h01 = cornerSample(map, x0, y1, band);
  const h11 = cornerSample(map, x1, y1, band);

  let numerator: number;
  if (
    h00 === OPEN_COLUMN_SAMPLE ||
    h10 === OPEN_COLUMN_SAMPLE ||
    h01 === OPEN_COLUMN_SAMPLE ||
    h11 === OPEN_COLUMN_SAMPLE
  ) {
    const takeX1 = 2 * fx > SUBCELL_DENOM;
    const takeY1 = 2 * fy > SUBCELL_DENOM;
    const nearest = takeY1 ? (takeX1 ? h11 : h01) : takeX1 ? h10 : h00;
    numerator = nearest * BLEND_DENOM;
  } else {
    numerator =
      (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * h00 +
      fx * (SUBCELL_DENOM - fy) * h10 +
      (SUBCELL_DENOM - fx) * fy * h01 +
      fx * fy * h11;
  }

  return floorDiv(numerator, BLEND_DENOM * BAND_HEIGHT) * BAND_HEIGHT;
}

export function drawnGroundHeight(map: Heightmap, x: number, y: number): number {
  return drawnSurface(map, x, y, TOP_SURFACE);
}

export function drawnGroundHeightAtBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): number {
  return drawnSurface(map, x, y, band);
}
