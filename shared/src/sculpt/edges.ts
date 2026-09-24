import { MIN_BRUSH_RADIUS } from '../constants.ts';
import {
  bandFloorHeight,
  bandLevelHeight,
  DRAWN_GROUND_BAND_BIAS,
  drawnBandOfSample,
} from '../bands.ts';
import { columnCoversBand } from '../columns.ts';
import { cellIndex, cellX, cellY, inBounds, type Heightmap } from '../grid.ts';
import { footprintRadiusSquared } from './footprint.ts';
import { clampHeight, graspedCeiling, writeGraspedCeiling } from './grasp.ts';
import type { SculptOperation } from './options.ts';

// Edge-aware writes (docs/plans/edge-aware-brushes.md): a cell keeps its band;
// its in-band height encodes its distance to the nearest band edge.

/** Tools whose writes re-encode the cells around their rings. */
export const EDGE_AWARE_TOOLS: readonly SculptOperation[] = ['drag'];

/** Height units per cell of edge distance: a band's midpoint is one cell from its edges. */
export const EDGE_UNITS_PER_CELL = DRAWN_GROUND_BAND_BIAS;

/** Rings and cell distances are squared radii in quarter cells², so a half-cell ring stays whole. */
const QUARTERS_PER_CELL_SQUARED = 4;

/** A one-cell brush's outline sits halfway to its neighbours, where the grid put it. */
const SINGLE_CELL_RING_QUARTERS = 1;

/** Fixed-point steps per cell for a distance; the rounding error stays below a height unit's 1/32. */
const EDGE_FIXED_POINT = 256;

const HALF_FIXED_SQUARED = (EDGE_FIXED_POINT / 2) * (EDGE_FIXED_POINT / 2);

/** One cell past the outermost ring, a cell's own edge distance saturates. */
export const EDGE_REGION_MARGIN_CELLS = 1;

/** Integer square root of a quarter-cell² value, in fixed-point cells. */
function fixedRadius(quarters: number): number {
  return Math.floor(Math.sqrt(quarters * HALF_FIXED_SQUARED));
}

/** The ring a brush disc of `radius` draws: the circle its footprint predicate names. */
export function footprintRingQuarters(radius: number): number {
  return radius === MIN_BRUSH_RADIUS
    ? SINGLE_CELL_RING_QUARTERS
    : QUARTERS_PER_CELL_SQUARED * footprintRadiusSquared(radius);
}

/**
 * A brush's exact outline: rings around the nearest of its centres (a stamp
 * has one, a drag leg one per line cell), where the written band may step.
 */
export interface EdgeShape {
  readonly centres: readonly (readonly [number, number])[];
  /** Squared radii in quarter cells², ascending. */
  readonly rings: readonly number[];
  /** A raise steps bands down outward across a ring; a lower steps them up. */
  readonly raising: boolean;
  /**
   * True: `write` shifts cells whole bands with their neighbours, so a moved
   * cell keeps its prior edge distance. False: heights `write` set stand off-ring.
   */
  readonly keepsPriorEdges: boolean;
  /** The span of column `i` the brush wrote, or null for none. */
  readonly spanOf: (map: Heightmap, i: number) => number | null;
}

/** A decision reads the eight neighbours, one cell out. */
const NEIGHBOUR_REACH_CELLS = 1;

const NEIGHBOUR_OFFSETS: readonly (readonly [number, number])[] = [
  [-1, -1], [0, -1], [1, -1],
  [-1, 0], [1, 0],
  [-1, 1], [0, 1], [1, 1],
];

/** A grid cell with no span for the brush to write, or outside its region. */
const UNSURVEYED = -0x80000000;

/** The brush's region and one cell around it: every cell a decision reads. */
interface Survey {
  readonly x0: number;
  readonly y0: number;
  readonly width: number;
  readonly height: number;
  readonly quarters: Int32Array;
  /** The written span's ceiling before `write`, or UNSURVEYED outside the region. */
  readonly before: Int32Array;
}

/** Beyond every centre's square: no decision reads the cell. */
const UNREACHED_QUARTERS = 0x7fffffff;

function ceilingOf(map: Heightmap, shape: EdgeShape, i: number): number | null {
  const k = shape.spanOf(map, i);
  return k === null ? null : graspedCeiling(map, i, k);
}

/** Bands apart that a written cell and an unmoved neighbour still share one edge. */
const ADJACENT_BAND_STEP = 1;

function writtenBandAt(map: Heightmap, shape: EdgeShape, x: number, y: number): number | null {
  const ceiling = ceilingOf(map, shape, cellIndex(map, x, y));
  return ceiling === null ? null : drawnBandOfSample(ceiling);
}

/** Top-band cache markers: a layered column asks its spans; off the map there is no neighbour. */
const LAYERED = -0x80000000;
const OUT_OF_MAP = LAYERED + 1;

function survey(map: Heightmap, shape: EdgeShape): Survey {
  const outer = shape.rings[shape.rings.length - 1]!;
  const reachFixed = fixedRadius(outer) + EDGE_REGION_MARGIN_CELLS * EDGE_FIXED_POINT;
  const margin = Math.ceil(reachFixed / EDGE_FIXED_POINT) + NEIGHBOUR_REACH_CELLS;
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const [cx, cy] of shape.centres) {
    if (cx < minX) minX = cx;
    if (cy < minY) minY = cy;
    if (cx > maxX) maxX = cx;
    if (cy > maxY) maxY = cy;
  }
  const x0 = minX - margin;
  const y0 = minY - margin;
  const width = maxX + margin - x0 + 1;
  const height = maxY + margin - y0 + 1;
  const quarters = new Int32Array(width * height).fill(UNREACHED_QUARTERS);
  const before = new Int32Array(width * height).fill(UNSURVEYED);
  // Each centre's square of `margin` holds every cell within reach of it, and their neighbours.
  for (const [cx, cy] of shape.centres) {
    for (let dy = -margin; dy <= margin; dy++) {
      const row = (cy + dy - y0) * width + cx - x0;
      for (let dx = -margin; dx <= margin; dx++) {
        const q = QUARTERS_PER_CELL_SQUARED * (dx * dx + dy * dy);
        if (q < quarters[row + dx]!) quarters[row + dx] = q;
      }
    }
  }
  for (let gy = 0; gy < height; gy++) {
    for (let gx = 0; gx < width; gx++) {
      const g = gy * width + gx;
      const x = x0 + gx;
      const y = y0 + gy;
      // fixedRadius(q) < reachFixed, squared through so no root is taken per cell.
      if (!inBounds(map, x, y) || quarters[g]! * HALF_FIXED_SQUARED >= reachFixed * reachFixed) continue;
      const i = cellIndex(map, x, y);
      // A one-span column's only ceiling is its cell; `write` cannot grasp it otherwise.
      const ceiling = map.columnSpans.has(i) ? ceilingOf(map, shape, i) : map.cells[i]!;
      if (ceiling !== null) before[g] = ceiling;
    }
  }
  return { x0, y0, width, height, quarters, before };
}

function toUnits(fixed: number): number {
  const units = Math.floor((EDGE_UNITS_PER_CELL * fixed + EDGE_FIXED_POINT / 2) / EDGE_FIXED_POINT);
  return units < EDGE_UNITS_PER_CELL ? units : EDGE_UNITS_PER_CELL;
}

/** Distance to the band edge below `height`'s own band, saturated at one cell. */
function decodedLower(height: number, band: number): number {
  const offset = height - bandFloorHeight(band);
  return offset < EDGE_UNITS_PER_CELL ? offset : EDGE_UNITS_PER_CELL;
}

/** Distance to the next band's edge above `height`, saturated at one cell. */
function decodedUpper(height: number, band: number): number {
  const offset = bandFloorHeight(band + 1) - height;
  return offset < EDGE_UNITS_PER_CELL ? offset : EDGE_UNITS_PER_CELL;
}

/** The in-band height that places `band`'s nearest edge `lower` or `upper` units away. */
export function encodeEdgeHeight(band: number, lower: number, upper: number): number {
  if (lower >= EDGE_UNITS_PER_CELL && upper >= EDGE_UNITS_PER_CELL) return bandLevelHeight(band);
  if (lower <= upper) return bandFloorHeight(band) + lower;
  return bandFloorHeight(band + 1) - (upper > 1 ? upper : 1);
}

/**
 * Runs `write`, then re-encodes cells near the rings. An edge `write` made
 * across a ring sits on it; any other keeps the cell's prior distance.
 */
export function writeWithEdges(
  map: Heightmap,
  shape: EdgeShape,
  changed: Set<number>,
  write: () => void,
): void {
  const grid = survey(map, shape);
  write();

  const { x0, y0, width, height, quarters, before } = grid;
  const ringFixed = shape.rings.map(fixedRadius);
  // Only a cell `write` moved to another band can stand inside a written edge.
  const moved = new Uint8Array(width * height);
  let movedX0 = width;
  let movedY0 = height;
  let movedX1 = -1;
  let movedY1 = -1;
  for (const i of changed) {
    const gx = cellX(map.size, i) - x0;
    const gy = cellY(map.size, i) - y0;
    if (gx < 0 || gy < 0 || gx >= width || gy >= height) continue;
    const g = gy * width + gx;
    const was = before[g]!;
    if (was === UNSURVEYED) continue;
    const now = ceilingOf(map, shape, i);
    if (now === null || drawnBandOfSample(now) === drawnBandOfSample(was)) continue;
    moved[g] = 1;
    if (gx < movedX0) movedX0 = gx;
    if (gy < movedY0) movedY0 = gy;
    if (gx > movedX1) movedX1 = gx;
    if (gy > movedY1) movedY1 = gy;
  }
  if (movedX1 < 0) return;
  // Only a moved cell or its neighbour is decided; each reads its neighbours' bands once more out.
  const fromX = Math.max(NEIGHBOUR_REACH_CELLS, movedX0 - NEIGHBOUR_REACH_CELLS);
  const fromY = Math.max(NEIGHBOUR_REACH_CELLS, movedY0 - NEIGHBOUR_REACH_CELLS);
  const toX = Math.min(width - 1 - NEIGHBOUR_REACH_CELLS, movedX1 + NEIGHBOUR_REACH_CELLS);
  const toY = Math.min(height - 1 - NEIGHBOUR_REACH_CELLS, movedY1 + NEIGHBOUR_REACH_CELLS);
  const top = new Int32Array(width * height);
  for (let gy = fromY - NEIGHBOUR_REACH_CELLS; gy <= toY + NEIGHBOUR_REACH_CELLS; gy++) {
    for (let gx = fromX - NEIGHBOUR_REACH_CELLS; gx <= toX + NEIGHBOUR_REACH_CELLS; gx++) {
      const x = x0 + gx;
      const y = y0 + gy;
      if (!inBounds(map, x, y)) {
        top[gy * width + gx] = OUT_OF_MAP;
        continue;
      }
      const i = cellIndex(map, x, y);
      top[gy * width + gx] = map.columnSpans.has(i) ? LAYERED : drawnBandOfSample(map.cells[i]!);
    }
  }
  const rings = shape.rings;
  const neighbourStep = NEIGHBOUR_OFFSETS.map(([ox, oy]) => oy * width + ox);
  const decidedWidth = toX - fromX + 1;
  const writeCell = new Int32Array(decidedWidth * (toY - fromY + 1));
  const writeSpan = new Int32Array(writeCell.length);
  const writeHeight = new Int32Array(writeCell.length);
  let writeCount = 0;
  for (let gy = fromY; gy <= toY; gy++) {
    for (let gx = fromX; gx <= toX; gx++) {
      const g = gy * width + gx;
      const was = before[g]!;
      if (was === UNSURVEYED) continue;
      const selfMoved = moved[g] === 1;
      let nearMoved = selfMoved;
      for (let n = 0; n < neighbourStep.length && !nearMoved; n++) nearMoved = moved[g + neighbourStep[n]!] === 1;
      if (!nearMoved) continue;

      const x = x0 + gx;
      const y = y0 + gy;
      const i = cellIndex(map, x, y);
      const k = shape.spanOf(map, i);
      if (k === null) continue;
      const h = graspedCeiling(map, i, k);
      const band = drawnBandOfSample(h);
      const ownQuarters = quarters[g]!;
      const ownFixed = fixedRadius(ownQuarters);

      let ringLower = EDGE_UNITS_PER_CELL;
      let ringUpper = EDGE_UNITS_PER_CELL;
      let onRing = false;
      let otherLower = false;
      let otherUpper = false;
      for (let n = 0; n < neighbourStep.length; n++) {
        const ng = g + neighbourStep[n]!;
        const t = top[ng]!;
        if (t === OUT_OF_MAP) continue;
        let lower: boolean;
        let upper: boolean;
        if (t === LAYERED) {
          const [ox, oy] = NEIGHBOUR_OFFSETS[n]!;
          lower = !columnCoversBand(map, x + ox, y + oy, band);
          upper = !lower && columnCoversBand(map, x + ox, y + oy, band + 1);
        } else {
          lower = band > t;
          upper = !lower && band + 1 <= t;
        }
        if (!lower && !upper) continue;

        const nq = quarters[ng]!;
        const selfInner = ownQuarters < nq;
        const inner = selfInner ? ownQuarters : nq;
        let ring = -1;
        if (ownQuarters !== nq) {
          for (let r = 0; r < rings.length; r++) {
            if (rings[r]! > inner) {
              ring = r;
              break;
            }
          }
        }
        const straddles = ring >= 0 && rings[ring]! <= (selfInner ? nq : ownQuarters);
        // The inner cell sits higher on a raise, lower on a lower.
        const innerHigher = selfInner ? lower : upper;
        const innerMoved = selfInner ? selfMoved : moved[ng] === 1;
        // An unmoved cell more than a band from what the stroke wrote is another layer's ground.
        if (!selfMoved && innerMoved && !selfInner) {
          const [ox, oy] = NEIGHBOUR_OFFSETS[n]!;
          const writtenBand = writtenBandAt(map, shape, x + ox, y + oy);
          if (writtenBand === null || writtenBand - band > ADJACENT_BAND_STEP || band - writtenBand > ADJACENT_BAND_STEP) {
            continue;
          }
        }
        if (!(straddles && innerHigher === shape.raising && innerMoved)) {
          if (lower) otherLower = true;
          else otherUpper = true;
          continue;
        }
        // Both cells measure to the ring just outside the inner one: the band steps there.
        const edgeFixed = ringFixed[ring]!;
        const units = toUnits(selfInner ? edgeFixed - ownFixed : ownFixed - edgeFixed);
        onRing = true;
        if (lower) ringLower = units < ringLower ? units : ringLower;
        else ringUpper = units < ringUpper ? units : ringUpper;
      }
      if (!onRing && !(selfMoved && shape.keepsPriorEdges)) continue;

      const prior = shape.keepsPriorEdges ? was : h;
      const priorBand = drawnBandOfSample(prior);
      const keptLower = otherLower ? decodedLower(prior, priorBand) : EDGE_UNITS_PER_CELL;
      const keptUpper = otherUpper ? decodedUpper(prior, priorBand) : EDGE_UNITS_PER_CELL;
      const next = clampHeight(
        encodeEdgeHeight(
          band,
          keptLower < ringLower ? keptLower : ringLower,
          keptUpper < ringUpper ? keptUpper : ringUpper,
        ),
      );
      if (next !== h && drawnBandOfSample(next) === band) {
        writeCell[writeCount] = i;
        writeSpan[writeCount] = k;
        writeHeight[writeCount] = next;
        writeCount++;
      }
    }
  }
  // Every decision reads the map as `write` left it; only then does anything move.
  for (let w = 0; w < writeCount; w++) {
    writeGraspedCeiling(map, writeCell[w]!, writeSpan[w]!, writeHeight[w]!);
    changed.add(writeCell[w]!);
  }
}
