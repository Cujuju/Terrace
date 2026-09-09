import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  MAX_HEIGHT,
  MAX_SPANS_PER_COLUMN,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_NEAR_N,
} from "./constants.ts";
import { cellIndex, type Heightmap } from "./grid.ts";
import {
  OPEN_COLUMN_SAMPLE,
  columnSampleAtBand,
  spanCount,
} from "./columns.ts";

/** Lattice corners per cell. Every drawn level's corners lie on this lattice. */
export const DRAWN_GROUND_LATTICE_N = TERRAIN_LOD_NEAR_N;

const SUBCELL_DENOM = 2 * DRAWN_GROUND_LATTICE_N;

/** A corner numerator is the bilinear height times this. */
export const DRAWN_GROUND_BLEND_DENOM = SUBCELL_DENOM * SUBCELL_DENOM;

const BAND_BLEND_DENOM = DRAWN_GROUND_BLEND_DENOM * BAND_HEIGHT;

/** A query coordinate is floored to this many steps per cell before any test. */
export const DRAWN_GROUND_COORD_DENOM = 1024;

const FIXPOINT_STEPS_PER_SPAN = 4;

export const DRAWN_GROUND_FIXPOINT_STEPS =
  FIXPOINT_STEPS_PER_SPAN * MAX_SPANS_PER_COLUMN;

/** Sub-cell corners in perimeter order; the next corner closes each edge. */
const CORNER_X = [0, 0, 1, 1] as const;
const CORNER_Y = [0, 1, 1, 0] as const;
const CORNERS = 4;
const MAX_CROSSINGS = CORNERS;
/** Corners plus two thresholds' crossings, the most a tread's boundary can hold. */
const MAX_TREAD_POINTS = CORNERS + 2 * MAX_CROSSINGS;

/** Lowest sample any corner can carry: the open-column sentinel sits below bedrock. */
const LOWEST_SAMPLE = OPEN_COLUMN_SAMPLE;

const COORD_STEPS_PER_LATTICE =
  DRAWN_GROUND_COORD_DENOM / DRAWN_GROUND_LATTICE_N;

if (
  !Number.isInteger(COORD_STEPS_PER_LATTICE) ||
  COORD_STEPS_PER_LATTICE % 2 !== 0 ||
  TERRAIN_LOD_NEAR_N % TERRAIN_LOD_FAR_N !== 0
) {
  throw new Error(
    "drawn ground levels must nest inside the coordinate lattice",
  );
}

{
  const edgeDenom = DRAWN_GROUND_BLEND_DENOM * (MAX_HEIGHT - LOWEST_SAMPLE);
  const subcellSteps = DRAWN_GROUND_COORD_DENOM / TERRAIN_LOD_FAR_N;
  if (2 * edgeDenom * edgeDenom * subcellSteps > Number.MAX_SAFE_INTEGER) {
    throw new Error(
      "drawn ground side tests would leave the exact integer range",
    );
  }
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

type CellSample = (x: number, y: number) => number;

function topSample(map: Heightmap): CellSample {
  return (x, y) => map.cells[cellIndex(map, x, y)]!;
}

function bandSample(map: Heightmap, band: number): CellSample {
  return (x, y) => columnSampleAtBand(map, x, y, band);
}

/** Exact bilinear numerator at lattice corner (lx, ly), over DRAWN_GROUND_BLEND_DENOM. */
function cornerNumerator(
  size: number,
  sample: CellSample,
  lx: number,
  ly: number,
): number {
  const qx = 2 * lx - DRAWN_GROUND_LATTICE_N;
  const qy = 2 * ly - DRAWN_GROUND_LATTICE_N;
  const baseX = floorDiv(qx, SUBCELL_DENOM);
  const baseY = floorDiv(qy, SUBCELL_DENOM);
  const fx = qx - baseX * SUBCELL_DENOM;
  const fy = qy - baseY * SUBCELL_DENOM;
  const x0 = clampCell(size, baseX);
  const x1 = clampCell(size, baseX + 1);
  const y0 = clampCell(size, baseY);
  const y1 = clampCell(size, baseY + 1);
  return (
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * sample(x0, y0) +
    fx * (SUBCELL_DENOM - fy) * sample(x1, y0) +
    (SUBCELL_DENOM - fx) * fy * sample(x0, y1) +
    fx * fy * sample(x1, y1)
  );
}

function bandOfNumerator(numerator: number): number {
  return floorDiv(numerator, BAND_BLEND_DENOM);
}

/** Four corner numerators of one sub-cell, in perimeter order. */
type SubcellField = [number, number, number, number];

function subcellField(
  size: number,
  sample: CellSample,
  lx0: number,
  ly0: number,
  stride: number,
): SubcellField {
  return [
    cornerNumerator(size, sample, lx0, ly0),
    cornerNumerator(size, sample, lx0, ly0 + stride),
    cornerNumerator(size, sample, lx0 + stride, ly0 + stride),
    cornerNumerator(size, sample, lx0 + stride, ly0),
  ];
}

function lowBand(field: SubcellField): number {
  return bandOfNumerator(Math.min(field[0], field[1], field[2], field[3]));
}

function highBand(field: SubcellField): number {
  return bandOfNumerator(Math.max(field[0], field[1], field[2], field[3]));
}

interface Crossing {
  /** Edge from corner `edge` to the next corner. */
  edge: number;
  /** Position along the edge is num / den, den > 0. */
  num: number;
  den: number;
}

type Pair = readonly [number, number];

interface Chords {
  /** Crossings in perimeter order; only the first `count` are live. */
  readonly crossings: readonly Crossing[];
  count: number;
  /** Crossing index pairs; the forward arc from the first to the second is the chord's arc. */
  pairs: readonly Pair[];
  /** Whether each chord's arc holds corners at or above the threshold. */
  arcHigh: boolean;
}

const NO_PAIRS: readonly Pair[] = [];

/** Crossing pairings for a four-crossing saddle: arcs around corners 1 and 3, or 2 and 0. */
const SADDLE_PAIRS_ODD: readonly Pair[] = [
  [0, 1],
  [2, 3],
];
const SADDLE_PAIRS_EVEN: readonly Pair[] = [
  [1, 2],
  [3, 0],
];
const SINGLE_PAIR: readonly Pair[] = [[0, 1]];

function createChords(): Chords {
  return {
    crossings: Array.from({ length: MAX_CROSSINGS }, () => ({
      edge: 0,
      num: 0,
      den: 1,
    })),
    count: 0,
    pairs: NO_PAIRS,
    arcHigh: true,
  };
}

const NO_CHORDS: Chords = createChords();

/** Threshold-`band` isoline chords of a sub-cell field, written into `into`. */
function chordsAt(field: SubcellField, band: number, into: Chords): Chords {
  const threshold = band * BAND_BLEND_DENOM;
  let count = 0;
  for (let edge = 0; edge < CORNERS; edge++) {
    const here = field[edge]!;
    const next = field[(edge + 1) % CORNERS]!;
    if (here < threshold === next < threshold) continue;
    const crossing = into.crossings[count++]!;
    crossing.edge = edge;
    const num = threshold - here;
    const den = next - here;
    crossing.num = den < 0 ? -num : num;
    crossing.den = den < 0 ? -den : den;
  }
  into.count = count;
  if (count === 0) {
    into.pairs = NO_PAIRS;
    into.arcHigh = true;
    return into;
  }
  if (count === 2) {
    const firstArcCorner = (into.crossings[0]!.edge + 1) % CORNERS;
    into.pairs = SINGLE_PAIR;
    into.arcHigh = field[firstArcCorner]! >= threshold;
    return into;
  }
  // A saddle: the centre decides whether the high corners join through it.
  const centreHigh =
    field[0] + field[1] + field[2] + field[3] >= CORNERS * threshold;
  const arcHigh = !centreHigh;
  const corner1High = field[1] >= threshold;
  into.pairs = corner1High === arcHigh ? SADDLE_PAIRS_ODD : SADDLE_PAIRS_EVEN;
  into.arcHigh = arcHigh;
  return into;
}

/** Crossing position scaled by its denominator: (x, y) = (xNum, yNum) / den. */
function crossingXNum(c: Crossing): number {
  const from = CORNER_X[c.edge]!;
  const to = CORNER_X[(c.edge + 1) % CORNERS]!;
  return from * c.den + (to - from) * c.num;
}

function crossingYNum(c: Crossing): number {
  const from = CORNER_Y[c.edge]!;
  const to = CORNER_Y[(c.edge + 1) % CORNERS]!;
  return from * c.den + (to - from) * c.num;
}

function crossingsCoincide(a: Crossing, b: Crossing): boolean {
  return (
    crossingXNum(a) * b.den === crossingXNum(b) * a.den &&
    crossingYNum(a) * b.den === crossingYNum(b) * a.den
  );
}

function pointIsCrossing(
  a: Crossing,
  px: number,
  py: number,
  steps: number,
): boolean {
  return (
    px * a.den === crossingXNum(a) * steps &&
    py * a.den === crossingYNum(a) * steps
  );
}

/** Sign of (b − a) × (p − a), p = (px, py) / steps. Exact: a's whole coordinate divides its denominator out. */
function chordSide(
  a: Crossing,
  b: Crossing,
  px: number,
  py: number,
  steps: number,
): number {
  const ax = crossingXNum(a);
  const ay = crossingYNum(a);
  const bx = crossingXNum(b);
  const by = crossingYNum(b);
  const edgeRunsAlongY = CORNER_X[a.edge] === CORNER_X[(a.edge + 1) % CORNERS];
  if (edgeRunsAlongY) {
    const x0 = CORNER_X[a.edge]!;
    return (
      (bx - x0 * b.den) * (py * a.den - ay * steps) -
      (by * a.den - ay * b.den) * (px - x0 * steps)
    );
  }
  const y0 = CORNER_Y[a.edge]!;
  return (
    (bx * a.den - ax * b.den) * (py - y0 * steps) -
    (by - y0 * b.den) * (px * a.den - ax * steps)
  );
}

/** Whether the threshold-`band` cap covers (px, py) / steps of the sub-cell. On a chord counts as covered. */
const COVER_SCRATCH = createChords();

function capCovers(
  field: SubcellField,
  band: number,
  px: number,
  py: number,
  steps: number,
): boolean {
  const chords = chordsAt(field, band, COVER_SCRATCH);
  if (chords.count === 0) return field[0] >= band * BAND_BLEND_DENOM;
  for (const [ia, ib] of chords.pairs) {
    const a = chords.crossings[ia]!;
    const b = chords.crossings[ib]!;
    if (crossingsCoincide(a, b)) {
      if (pointIsCrossing(a, px, py, steps)) return true;
      if (!chords.arcHigh) return false;
    } else if (chords.arcHigh) {
      if (chordSide(a, b, px, py, steps) >= 0) return true;
    } else if (chordSide(a, b, px, py, steps) > 0) return false;
  }
  return !chords.arcHigh;
}

/** Highest band whose cap covers the point; the field's bands bound the search. */
function bandAtPoint(
  field: SubcellField,
  px: number,
  py: number,
  steps: number,
): number {
  const lo = lowBand(field);
  for (let band = highBand(field); band > lo; band--) {
    if (capCovers(field, band, px, py, steps)) return band;
  }
  return lo;
}

interface Query {
  /** Lattice corner of the sub-cell's low corner. */
  readonly lx0: number;
  readonly ly0: number;
  /** Lattice corners per sub-cell edge at this level. */
  readonly stride: number;
  /** Point inside the sub-cell, over `steps`. */
  readonly px: number;
  readonly py: number;
  readonly steps: number;
}

function queryAt(size: number, level: number, x: number, y: number): Query {
  const stride = DRAWN_GROUND_LATTICE_N / level;
  const steps = COORD_STEPS_PER_LATTICE * stride;
  const qx = Math.floor(clampCoord(size, x) * DRAWN_GROUND_COORD_DENOM);
  const qy = Math.floor(clampCoord(size, y) * DRAWN_GROUND_COORD_DENOM);
  const sx = floorDiv(qx, steps);
  const sy = floorDiv(qy, steps);
  return {
    lx0: sx * stride,
    ly0: sy * stride,
    stride,
    px: qx - sx * steps,
    py: qy - sy * steps,
    steps,
  };
}

function queryField(size: number, sample: CellSample, q: Query): SubcellField {
  return subcellField(size, sample, q.lx0, q.ly0, q.stride);
}

/** Whether any cell a sub-cell's corners blend from carries more than one span. */
function queryIsLayered(map: Heightmap, q: Query): boolean {
  if (map.columnSpans.size === 0) return false;
  const first = (l: number): number =>
    floorDiv(2 * l - DRAWN_GROUND_LATTICE_N, SUBCELL_DENOM);
  const x0 = clampCell(map.size, first(q.lx0));
  const x1 = clampCell(map.size, first(q.lx0 + q.stride) + 1);
  const y0 = clampCell(map.size, first(q.ly0));
  const y1 = clampCell(map.size, first(q.ly0 + q.stride) + 1);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (spanCount(map, x, y) !== 1) return true;
    }
  }
  return false;
}

/** A layered sub-cell keeps the lattice rule: one settled band, read at its centre. */
function settleAtCentre(map: Heightmap, q: Query, seed: number): number {
  const centre = q.steps / 2;
  let band = seed;
  for (let step = 0; step < DRAWN_GROUND_FIXPOINT_STEPS; step++) {
    const next = bandAtPoint(
      queryField(map.size, bandSample(map, band), q),
      centre,
      centre,
      q.steps,
    );
    if (next === band) break;
    band = next;
  }
  return band;
}

function heightAtLevel(
  map: Heightmap,
  level: number,
  x: number,
  y: number,
): number {
  const q = queryAt(map.size, level, x, y);
  const top = queryField(map.size, topSample(map), q);
  if (!queryIsLayered(map, q))
    return bandAtPoint(top, q.px, q.py, q.steps) * BAND_HEIGHT;
  const centre = q.steps / 2;
  return (
    settleAtCentre(map, q, bandAtPoint(top, centre, centre, q.steps)) *
    BAND_HEIGHT
  );
}

export function drawnGroundCoversBand(
  map: Heightmap,
  x: number,
  y: number,
  band: number,
): boolean {
  const q = queryAt(map.size, DRAWN_GROUND_LATTICE_N, x, y);
  const field = queryField(map.size, bandSample(map, band), q);
  if (band <= lowBand(field)) return true;
  if (band > highBand(field)) return false;
  if (!queryIsLayered(map, q))
    return capCovers(field, band, q.px, q.py, q.steps);
  const centre = q.steps / 2;
  return capCovers(field, band, centre, centre, q.steps);
}

export function drawnGroundHeight(
  map: Heightmap,
  x: number,
  y: number,
): number {
  return heightAtLevel(map, DRAWN_GROUND_LATTICE_N, x, y);
}

/** Whether a near sub-cell's corners blend from any cell with more than one span. */
export function drawnGroundSubcellIsLayered(
  map: Heightmap,
  subX: number,
  subY: number,
): boolean {
  return queryIsLayered(map, {
    lx0: subX,
    ly0: subY,
    stride: 1,
    px: 0,
    py: 0,
    steps: 1,
  });
}

/** Height of the surface a chunk drawn at the far level shows. */
export function drawnGroundFarHeight(
  map: Heightmap,
  x: number,
  y: number,
): number {
  return heightAtLevel(map, TERRAIN_LOD_FAR_N, x, y);
}

export interface DrawnGroundPoint {
  /** Cell coordinates. */
  readonly x: number;
  readonly y: number;
}

export interface DrawnGroundTread {
  readonly band: number;
  /** Closed boundary polygons in perimeter order; a saddle can split a tread in two. */
  readonly pieces: readonly (readonly DrawnGroundPoint[])[];
}

export interface DrawnGroundRiser {
  /** The riser climbs from `band − 1` to `band`. */
  readonly band: number;
  readonly from: DrawnGroundPoint;
  readonly to: DrawnGroundPoint;
}

export interface DrawnGroundSubcell {
  readonly lowBand: number;
  readonly highBand: number;
  readonly treads: readonly DrawnGroundTread[];
  readonly risers: readonly DrawnGroundRiser[];
}

interface BoundaryPoint {
  readonly x: number;
  readonly y: number;
  /** Index into the tread's crossing list, or −1 for a corner. */
  readonly crossing: number;
}

interface TreadCrossing {
  readonly partner: number;
  /** Whether the perimeter just past this point lies inside the tread. */
  readonly forwardInside: boolean;
  readonly x: number;
  readonly y: number;
}

function crossingPoint(c: Crossing): DrawnGroundPoint {
  return { x: crossingXNum(c) / c.den, y: crossingYNum(c) / c.den };
}

/** Rational order along an edge. */
function crossingBefore(a: Crossing, b: Crossing): boolean {
  return a.num * b.den < b.num * a.den;
}

/** Boundary polygons of the tread between `band` (inclusive) and the next threshold above it. */
function treadPieces(
  field: SubcellField,
  band: number,
  above: Chords,
  below: Chords,
): (readonly DrawnGroundPoint[])[] {
  const crossings: TreadCrossing[] = [];
  const indexOf = new Map<Crossing, number>();
  const register = (chords: Chords, arcInside: boolean): void => {
    for (const [ia, ib] of chords.pairs) {
      const a = chords.crossings[ia]!;
      const b = chords.crossings[ib]!;
      const base = crossings.length;
      indexOf.set(a, base);
      indexOf.set(b, base + 1);
      crossings.push({
        partner: base + 1,
        forwardInside: arcInside,
        ...crossingPoint(a),
      });
      crossings.push({
        partner: base,
        forwardInside: !arcInside,
        ...crossingPoint(b),
      });
    }
  };
  register(below, below.arcHigh);
  register(above, !above.arcHigh);
  const boundary: BoundaryPoint[] = [];
  for (let edge = 0; edge < CORNERS; edge++) {
    if (bandOfNumerator(field[edge]!) === band) {
      boundary.push({ x: CORNER_X[edge]!, y: CORNER_Y[edge]!, crossing: -1 });
    }
    const onEdge = [
      ...below.crossings.slice(0, below.count),
      ...above.crossings.slice(0, above.count),
    ].filter((c) => c.edge === edge);
    onEdge.sort((a, b) =>
      crossingBefore(a, b) ? -1 : crossingBefore(b, a) ? 1 : 0,
    );
    for (const c of onEdge) {
      const index = indexOf.get(c)!;
      boundary.push({
        x: crossings[index]!.x,
        y: crossings[index]!.y,
        crossing: index,
      });
    }
  }
  const slotOf = new Map<number, number>();
  boundary.forEach((p, slot) => {
    if (p.crossing >= 0) slotOf.set(p.crossing, slot);
  });
  const visited = new Uint8Array(boundary.length);
  const pieces: (readonly DrawnGroundPoint[])[] = [];
  const startable = (slot: number): boolean => {
    const p = boundary[slot]!;
    return p.crossing < 0 || crossings[p.crossing]!.forwardInside;
  };
  for (let start = 0; start < boundary.length; start++) {
    if (visited[start] || !startable(start)) continue;
    const piece: DrawnGroundPoint[] = [];
    let slot = start;
    for (let guard = 0; guard < MAX_TREAD_POINTS; guard++) {
      visited[slot] = 1;
      const p = boundary[slot]!;
      piece.push({ x: p.x, y: p.y });
      if (p.crossing >= 0 && !crossings[p.crossing]!.forwardInside) {
        slot = slotOf.get(crossings[p.crossing]!.partner)!;
        if (slot === start) break;
        visited[slot] = 1;
        const partner = boundary[slot]!;
        piece.push({ x: partner.x, y: partner.y });
      }
      slot = (slot + 1) % boundary.length;
      if (slot === start) break;
    }
    pieces.push(piece);
  }
  return pieces;
}

/** The treads and risers one near-level sub-cell draws, in cell coordinates. Top surface only. */
export function drawnGroundSubcell(
  map: Heightmap,
  subX: number,
  subY: number,
): DrawnGroundSubcell {
  const field = subcellField(map.size, topSample(map), subX, subY, 1);
  const lo = lowBand(field);
  const hi = highBand(field);
  const toCell = (p: DrawnGroundPoint): DrawnGroundPoint => ({
    x: (subX + p.x) / DRAWN_GROUND_LATTICE_N,
    y: (subY + p.y) / DRAWN_GROUND_LATTICE_N,
  });
  const chordsByBand: Chords[] = [];
  for (let band = lo; band <= hi + 1; band++) {
    chordsByBand.push(
      band === lo ? NO_CHORDS : chordsAt(field, band, createChords()),
    );
  }
  const treads: DrawnGroundTread[] = [];
  const risers: DrawnGroundRiser[] = [];
  for (let band = lo; band <= hi; band++) {
    const below = chordsByBand[band - lo]!;
    const above = band === hi ? NO_CHORDS : chordsByBand[band - lo + 1]!;
    treads.push({
      band,
      pieces: treadPieces(field, band, above, below).map((piece) =>
        piece.map(toCell),
      ),
    });
    if (band === lo) continue;
    for (const [ia, ib] of below.pairs) {
      risers.push({
        band,
        from: toCell(crossingPoint(below.crossings[ia]!)),
        to: toCell(crossingPoint(below.crossings[ib]!)),
      });
    }
  }
  return { lowBand: lo, highBand: hi, treads, risers };
}

const NEAR_SUBCELLS_PER_CHUNK = CHUNK_SIZE * DRAWN_GROUND_LATTICE_N;
const NEAR_LATTICE_PER_CHUNK = NEAR_SUBCELLS_PER_CHUNK + 1;
const FAR_STRIDE = DRAWN_GROUND_LATTICE_N / TERRAIN_LOD_FAR_N;

/** Top-surface corner numerators over a chunk's lattice, row-major, one row past the chunk. */
function chunkLattice(map: Heightmap, cx: number, cy: number): Int32Array {
  const sample = topSample(map);
  const lx0 = cx * NEAR_SUBCELLS_PER_CHUNK;
  const ly0 = cy * NEAR_SUBCELLS_PER_CHUNK;
  const out = new Int32Array(NEAR_LATTICE_PER_CHUNK * NEAR_LATTICE_PER_CHUNK);
  for (let j = 0; j < NEAR_LATTICE_PER_CHUNK; j++) {
    for (let i = 0; i < NEAR_LATTICE_PER_CHUNK; i++) {
      out[j * NEAR_LATTICE_PER_CHUNK + i] = cornerNumerator(
        map.size,
        sample,
        lx0 + i,
        ly0 + j,
      );
    }
  }
  return out;
}

function latticeField(
  lattice: Int32Array,
  i: number,
  j: number,
  stride: number,
): SubcellField {
  const row = NEAR_LATTICE_PER_CHUNK;
  return [
    lattice[j * row + i]!,
    lattice[(j + stride) * row + i]!,
    lattice[(j + stride) * row + i + stride]!,
    lattice[j * row + i + stride]!,
  ];
}

function chunkIsLayered(map: Heightmap, cx: number, cy: number): boolean {
  if (map.columnSpans.size === 0) return false;
  const x0 = clampCell(map.size, cx * CHUNK_SIZE - 1);
  const y0 = clampCell(map.size, cy * CHUNK_SIZE - 1);
  const x1 = clampCell(map.size, (cx + 1) * CHUNK_SIZE);
  const y1 = clampCell(map.size, (cy + 1) * CHUNK_SIZE);
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) {
      if (spanCount(map, x, y) !== 1) return true;
    }
  }
  return false;
}

/** Bands each near sub-cell of a chunk spans (high − low), row-major. Top surface only. */
export function drawnGroundChunkBandSpans(
  map: Heightmap,
  cx: number,
  cy: number,
): Uint16Array {
  const lattice = chunkLattice(map, cx, cy);
  const out = new Uint16Array(
    NEAR_SUBCELLS_PER_CHUNK * NEAR_SUBCELLS_PER_CHUNK,
  );
  for (let j = 0; j < NEAR_SUBCELLS_PER_CHUNK; j++) {
    for (let i = 0; i < NEAR_SUBCELLS_PER_CHUNK; i++) {
      const field = latticeField(lattice, i, j, 1);
      out[j * NEAR_SUBCELLS_PER_CHUNK + i] = highBand(field) - lowBand(field);
    }
  }
  return out;
}

/** Worst gap, at near sub-cell centres, between a chunk's near and far surfaces. */
export function drawnGroundLodError(
  map: Heightmap,
  cx: number,
  cy: number,
): number {
  let worst = 0;
  const note = (near: number, far: number): void => {
    const gap = near > far ? near - far : far - near;
    if (gap > worst) worst = gap;
  };
  if (chunkIsLayered(map, cx, cy)) {
    for (let j = 0; j < NEAR_SUBCELLS_PER_CHUNK; j++) {
      const y =
        (cy * NEAR_SUBCELLS_PER_CHUNK + j + 0.5) / DRAWN_GROUND_LATTICE_N;
      for (let i = 0; i < NEAR_SUBCELLS_PER_CHUNK; i++) {
        const x =
          (cx * NEAR_SUBCELLS_PER_CHUNK + i + 0.5) / DRAWN_GROUND_LATTICE_N;
        note(drawnGroundHeight(map, x, y), drawnGroundFarHeight(map, x, y));
      }
    }
    return worst;
  }
  const lattice = chunkLattice(map, cx, cy);
  const nearSteps = COORD_STEPS_PER_LATTICE;
  const farSteps = COORD_STEPS_PER_LATTICE * FAR_STRIDE;
  const centre = nearSteps / 2;
  for (let j = 0; j < NEAR_SUBCELLS_PER_CHUNK; j++) {
    const fj = j - (j % FAR_STRIDE);
    for (let i = 0; i < NEAR_SUBCELLS_PER_CHUNK; i++) {
      const fi = i - (i % FAR_STRIDE);
      const near = bandAtPoint(
        latticeField(lattice, i, j, 1),
        centre,
        centre,
        nearSteps,
      );
      const far = bandAtPoint(
        latticeField(lattice, fi, fj, FAR_STRIDE),
        (i - fi) * nearSteps + centre,
        (j - fj) * nearSteps + centre,
        farSteps,
      );
      note(near, far);
    }
  }
  return worst * BAND_HEIGHT;
}
