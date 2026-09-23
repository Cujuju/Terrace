import { BEDROCK_BAND, columnCoversBand } from '../columns.ts';
import { drawnBandOfSample } from '../bands.ts';
import { cellIndex, type Heightmap } from '../grid.ts';
import { clampHeight } from './grasp.ts';
import { EDGE_UNITS_PER_CELL, encodeEdgeHeight } from './edges.ts';

// In-band recompute for terrain with no exact shape (genesis, old saves): a band's
// outline is the half level of its coverage after one 3x3 binomial blur.

/** [1, 2, 1] squared: a coverage sum runs 0..16, so the outline sits at 8. */
const BLUR_WEIGHTS: readonly number[] = [1, 2, 1, 2, 4, 2, 1, 2, 1];
const BLUR_TOTAL = 16;
const BLUR_HALF = BLUR_TOTAL / 2;

/** A cell always stays one step of the blur clear of the outline on its own side. */
const BLUR_OWN_SIDE_MARGIN = 1;

/** A cell keeps the half cell the grid gave it, so no terrace, path or hole narrows. */
export const SMOOTHED_EDGE_MIN_UNITS = EDGE_UNITS_PER_CELL / 2;

/** Distances run in fixed point; a diagonal neighbour is sqrt(2) of them away. */
const DISTANCE_FIXED_POINT = 256;
const DIAGONAL_FIXED = Math.floor(Math.SQRT2 * DISTANCE_FIXED_POINT);

const NEIGHBOURS: readonly (readonly [number, number, number])[] = [
  [-1, -1, DIAGONAL_FIXED], [0, -1, DISTANCE_FIXED_POINT], [1, -1, DIAGONAL_FIXED],
  [-1, 0, DISTANCE_FIXED_POINT], [1, 0, DISTANCE_FIXED_POINT],
  [-1, 1, DIAGONAL_FIXED], [0, 1, DISTANCE_FIXED_POINT], [1, 1, DIAGONAL_FIXED],
];

function clampCell(v: number, size: number): number {
  return v < 0 ? 0 : v > size - 1 ? size - 1 : v;
}

/** A one-span column covers bedrock up to its top: read directly, the common case. */
function covers(map: Heightmap, x: number, y: number, band: number): boolean {
  const i = cellIndex(map, x, y);
  if (map.columnSpans.has(i)) return columnCoversBand(map, x, y, band);
  return band >= BEDROCK_BAND && band <= drawnBandOfSample(map.cells[i]!);
}

/** Band `band`'s coverage around (x, y), blurred; the world edge repeats its border cells. */
function blurredCoverage(map: Heightmap, x: number, y: number, band: number): number {
  let sum = 0;
  let w = 0;
  for (let dy = -1; dy <= 1; dy++) {
    for (let dx = -1; dx <= 1; dx++) {
      const weight = BLUR_WEIGHTS[w++]!;
      if (covers(map, clampCell(x + dx, map.size), clampCell(y + dy, map.size), band)) sum += weight;
    }
  }
  return sum;
}

/**
 * Units from (x, y) to band `band`'s blurred outline, measured toward the nearest
 * neighbour on the other side. `inside` names the cell's own side.
 */
function outlineDistance(map: Heightmap, x: number, y: number, band: number, inside: boolean): number {
  let own = -1;
  let best = EDGE_UNITS_PER_CELL;
  for (const [dx, dy, length] of NEIGHBOURS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= map.size || ny >= map.size) continue;
    if (covers(map, nx, ny, band) === inside) continue;
    if (own < 0) {
      const raw = blurredCoverage(map, x, y, band);
      own = inside
        ? Math.max(raw, BLUR_HALF + BLUR_OWN_SIDE_MARGIN)
        : Math.min(raw, BLUR_HALF - BLUR_OWN_SIDE_MARGIN);
    }
    const otherRaw = blurredCoverage(map, nx, ny, band);
    const other = inside
      ? Math.min(otherRaw, BLUR_HALF - BLUR_OWN_SIDE_MARGIN)
      : Math.max(otherRaw, BLUR_HALF + BLUR_OWN_SIDE_MARGIN);
    const toward = inside ? own - BLUR_HALF : BLUR_HALF - own;
    const across = inside ? own - other : other - own;
    const denominator = across * DISTANCE_FIXED_POINT;
    const units = Math.floor(
      (EDGE_UNITS_PER_CELL * toward * length + denominator / 2) / denominator,
    );
    if (units < best) best = units;
  }
  return best < SMOOTHED_EDGE_MIN_UNITS ? SMOOTHED_EDGE_MIN_UNITS : best;
}

/**
 * Re-encodes every one-span cell in the rectangle from the band layout alone.
 * Bands never change; layered columns keep their heights.
 */
export function encodeSmoothedEdges(
  map: Heightmap,
  minX: number,
  minY: number,
  maxX: number,
  maxY: number,
  changed?: Set<number>,
): void {
  const x0 = Math.max(0, minX);
  const y0 = Math.max(0, minY);
  const x1 = Math.min(map.size - 1, maxX);
  const y1 = Math.min(map.size - 1, maxY);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      const i = cellIndex(map, x, y);
      if (map.columnSpans.has(i)) continue;
      const h = map.cells[i]!;
      const band = drawnBandOfSample(h);
      const next = clampHeight(
        encodeEdgeHeight(
          band,
          outlineDistance(map, x, y, band, true),
          outlineDistance(map, x, y, band + 1, false),
        ),
      );
      // Writes only move heights within their bands, so later cells still read the same layout.
      if (next === h || drawnBandOfSample(next) !== band) continue;
      map.cells[i] = next;
      changed?.add(i);
    }
  }
}

/** Units from a cell at `from` to where the level field crosses `threshold` toward `to`. */
function crossingUnits(from: number, to: number, threshold: number, length: number): number {
  const toward = from > to ? from - threshold : threshold - from;
  const across = from > to ? from - to : to - from;
  const denominator = across * DISTANCE_FIXED_POINT;
  return Math.floor((EDGE_UNITS_PER_CELL * toward * length + denominator / 2) / denominator);
}

/**
 * Re-encodes every one-span cell from a continuous level field: `level[i] / levelOne`
 * is its drawn band plus position within it. Edges land where the interpolated field crosses.
 */
export function encodeLevelEdges(
  map: Heightmap,
  level: Int32Array,
  levelOne: number,
  changed?: Set<number>,
): void {
  const size = map.size;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = cellIndex(map, x, y);
      if (map.columnSpans.has(i)) continue;
      const h = map.cells[i]!;
      const band = drawnBandOfSample(h);
      const v = level[i]!;
      if (Math.floor(v / levelOne) !== band) continue;
      let lower = EDGE_UNITS_PER_CELL;
      let upper = EDGE_UNITS_PER_CELL;
      for (const [dx, dy, length] of NEIGHBOURS) {
        const nx = x + dx;
        const ny = y + dy;
        if (nx < 0 || ny < 0 || nx >= size || ny >= size) continue;
        const w = level[cellIndex(map, nx, ny)]!;
        const other = Math.floor(w / levelOne);
        if (other < band) {
          const units = crossingUnits(v, w, band * levelOne, length);
          if (units < lower) lower = units;
        } else if (other > band) {
          const units = crossingUnits(v, w, (band + 1) * levelOne, length);
          if (units < upper) upper = units;
        }
      }
      const next = clampHeight(encodeEdgeHeight(band, lower, upper));
      if (next === h || drawnBandOfSample(next) !== band) continue;
      map.cells[i] = next;
      changed?.add(i);
    }
  }
}
