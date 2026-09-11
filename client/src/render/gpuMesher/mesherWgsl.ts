import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CELL_WORLD_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  DRAWN_GROUND_CENTRE_CLEARANCE,
  DRAWN_GROUND_COORD_DENOM,
  DRAWN_GROUND_CROSSING_MIDPOINT,
  DRAWN_GROUND_SIMPLIFY_EPSILON,
  ISOLINE_SAMPLES_PER_CELL,
  ISOLINE_SOLVE_DENOM,
  OPEN_COLUMN_SAMPLE,
  SHEER_RISE_HEIGHT_UNITS_PER_CELL,
  SHEER_WALL_SPREAD_CELLS,
} from '@terrace/shared';
import { BAND_WORLD_HEIGHT } from '../../config.ts';
import {
  SEABED_CAP_SINK,
  SEABED_RISER_BORDER_WORLD_HEIGHT,
} from '../../terrain/capEmission.ts';
import { LATTICE_PER_CHUNK, SHORE_EDGE_CROSSING } from '../../terrain/contours.ts';
import {
  BAND_LUT_OFFSET,
  LUT_BORDER_BASE,
  LUT_CAP_BASE,
  LUT_CEILING_INNER_BASE,
  LUT_CEILING_LOWEST_BASE,
  LUT_CLIFF_BASE,
  LUT_SHORE_CAP,
  LUT_SHORE_CLIFF,
  SHORE_THRESHOLD,
} from './bandLut.ts';
import {
  POSITION_XZ_UNITS_PER_WORLD_UNIT,
  POSITION_Y_UNITS_PER_WORLD_UNIT,
} from './gpuChunkAnswer.ts';
import {
  MARCH_CORNER_REFS,
  MARCH_MAX_POLYS,
  MARCH_MAX_POLY_REFS,
  MARCH_REF_BASE,
  MARCH_SADDLE_10_SPLIT_CASE,
  MARCH_SADDLE_5_SPLIT_CASE,
} from './marchingTable.ts';
import {
  CHUNK_STATS_VERTEX_COUNT,
  CHUNK_STATS_WORDS,
  ENTRY_HEADER_WORDS,
  ENTRY_LAYERED,
  ENTRY_LOCAL_ORIGIN_X_UNITS,
  ENTRY_LOCAL_ORIGIN_Z_UNITS,
  ENTRY_LOWEST_BAND,
  ENTRY_ORIGIN_X_CELLS,
  ENTRY_ORIGIN_Z_CELLS,
  ENTRY_VERTEX_LIMIT,
  LIP_WORDS,
  SPAN_COUNT_SHIFT,
  SPAN_OFFSET_MASK,
  SQUARES_PER_CHUNK,
  WINDOW_LATTICE_SAMPLES,
  WINDOW_SPAN_PAIRS,
} from './terrainGpuInputs.ts';

export const WORKGROUP_THREADS = 64;

/** A chunk is split across workgroups so every square gets its own thread. */
export const WORKGROUPS_PER_CHUNK = Math.max(
  1,
  Math.ceil(SQUARES_PER_CHUNK / WORKGROUP_THREADS),
);

export const MESHER_ENTRY_POINT = 'meshChunk';

export const MODE_COUNT = 0;
export const MODE_EMIT = 1;

/** capEmission.ts marches the ceiling field on cell-edge midpoints. */
const CEILING_EDGE_CROSSING = 0.5;

const CEILING_INSIDE = 1;
const CEILING_OUTSIDE = 0;

/** Below any real band, so no band level ever collides with the shoreline level. */
const SHORE_LEVEL = -1000000;

const VERTICES_PER_QUAD = 6;

/** Refs the polyline can hold: the case's own refs plus refined isoline points. */
const MAX_POLYLINE = 16;

const SNORM16_MIN_UNITS = -32768;
const SNORM16_MAX_UNITS = 32767;

const POSITION_WORDS_PER_VERTEX = 2;

function wgslI32(value: number): string {
  if (!Number.isInteger(value)) throw new RangeError(`${value} is not an i32 literal`);
  return `${value}`;
}

function wgslF32(value: number): string {
  if (!Number.isFinite(value)) throw new RangeError(`${value} is not an f32 literal`);
  const text = Number.isInteger(value) ? `${value}.0` : `${value}`;
  return text.includes('e') || text.includes('E') ? value.toFixed(20) : text;
}

function bandHeightShift(): number {
  const shift = Math.log2(BAND_HEIGHT);
  if (!Number.isInteger(shift)) {
    throw new RangeError(`BAND_HEIGHT ${BAND_HEIGHT} is not a power of two`);
  }
  return shift;
}

export function buildMesherWgsl(): string {
  const shift = bandHeightShift();
  const squaresPerWorkgroup = SQUARES_PER_CHUNK / WORKGROUPS_PER_CHUNK;

  return `
const ISOLINE_SOLVE_SHIFT : u32 = ${wgslI32(Math.log2(ISOLINE_SOLVE_DENOM))}u;
const ISOLINE_SOLVE_DENOM : i32 = ${wgslI32(ISOLINE_SOLVE_DENOM)};
const SOLVE_PER_COORD_UNIT : i32 = ${wgslI32(ISOLINE_SOLVE_DENOM / DRAWN_GROUND_COORD_DENOM)};
const ISOLINE_NO_CROSSING : i32 = -1;
const BAND_HEIGHT : i32 = ${wgslI32(BAND_HEIGHT)};
const BAND_HEIGHT_SHIFT : u32 = ${wgslI32(shift)}u;
const BAND_BIAS : i32 = ${wgslI32(DRAWN_GROUND_BAND_BIAS)};
const COORD_DENOM : i32 = ${wgslI32(DRAWN_GROUND_COORD_DENOM)};
const BEDROCK_FLOOR : i32 = ${wgslI32(BEDROCK_FLOOR)};
const OPEN_COLUMN_SAMPLE : i32 = ${wgslI32(OPEN_COLUMN_SAMPLE)};
const SPAN_COUNT_SHIFT : u32 = ${wgslI32(SPAN_COUNT_SHIFT)}u;
const SPAN_OFFSET_MASK : u32 = ${wgslI32(SPAN_OFFSET_MASK)}u;
const WINDOW_SPAN_PAIRS : i32 = ${wgslI32(WINDOW_SPAN_PAIRS)};
const CELL_WORLD_SIZE : f32 = ${wgslF32(CELL_WORLD_SIZE)};
const BAND_WORLD_HEIGHT : f32 = ${wgslF32(BAND_WORLD_HEIGHT)};
const SEABED_CAP_SINK : f32 = ${wgslF32(SEABED_CAP_SINK)};
const SEABED_RIM_HEIGHT : f32 = ${wgslF32(SEABED_RISER_BORDER_WORLD_HEIGHT)};
const SHORE_THRESHOLD : i32 = ${wgslI32(SHORE_THRESHOLD)};
const SHORE_EDGE_CROSSING : f32 = ${wgslF32(SHORE_EDGE_CROSSING)};
const SHORE_LEVEL : i32 = ${wgslI32(SHORE_LEVEL)};
const CEILING_EDGE_CROSSING : f32 = ${wgslF32(CEILING_EDGE_CROSSING)};
const CEILING_INSIDE : i32 = ${wgslI32(CEILING_INSIDE)};
const CEILING_OUTSIDE : i32 = ${wgslI32(CEILING_OUTSIDE)};
const BAND_LUT_OFFSET : i32 = ${wgslI32(BAND_LUT_OFFSET)};
const LUT_CAP_BASE : i32 = ${wgslI32(LUT_CAP_BASE)};
const LUT_CLIFF_BASE : i32 = ${wgslI32(LUT_CLIFF_BASE)};
const LUT_BORDER_BASE : i32 = ${wgslI32(LUT_BORDER_BASE)};
const LUT_CEILING_LOWEST_BASE : i32 = ${wgslI32(LUT_CEILING_LOWEST_BASE)};
const LUT_CEILING_INNER_BASE : i32 = ${wgslI32(LUT_CEILING_INNER_BASE)};
const LUT_SHORE_CAP : i32 = ${wgslI32(LUT_SHORE_CAP)};
const LUT_SHORE_CLIFF : i32 = ${wgslI32(LUT_SHORE_CLIFF)};
const CHUNK_CELLS : i32 = ${wgslI32(LATTICE_PER_CHUNK - 1)};
const CHUNK_LATTICE : i32 = ${wgslI32(LATTICE_PER_CHUNK)};
const LATTICE_CELLS : u32 = ${wgslI32(WINDOW_LATTICE_SAMPLES)}u;
const SQUARES_PER_CHUNK : u32 = ${wgslI32(SQUARES_PER_CHUNK)}u;
const WORKGROUP_THREADS : u32 = ${wgslI32(WORKGROUP_THREADS)}u;
const WORKGROUPS_PER_CHUNK : u32 = ${wgslI32(WORKGROUPS_PER_CHUNK)}u;
const SQUARES_PER_WORKGROUP : u32 = ${wgslI32(squaresPerWorkgroup)}u;
const ENTRY_HEADER_WORDS : i32 = ${wgslI32(ENTRY_HEADER_WORDS)};
const CHUNK_STATS_WORDS : u32 = ${wgslI32(CHUNK_STATS_WORDS)}u;
const CHUNK_STATS_VERTEX_COUNT : u32 = ${wgslI32(CHUNK_STATS_VERTEX_COUNT)}u;
const LIP_WORDS : u32 = ${wgslI32(LIP_WORDS)}u;
const MAX_POLYS : i32 = ${wgslI32(MARCH_MAX_POLYS)};
const MAX_POLY_REFS : i32 = ${wgslI32(MARCH_MAX_POLY_REFS)};
const MARCH_REF_BASE : i32 = ${wgslI32(MARCH_REF_BASE)};
const CORNER_REFS : i32 = ${wgslI32(MARCH_CORNER_REFS)};
const SADDLE_5_SPLIT_CASE : i32 = ${wgslI32(MARCH_SADDLE_5_SPLIT_CASE)};
const SADDLE_10_SPLIT_CASE : i32 = ${wgslI32(MARCH_SADDLE_10_SPLIT_CASE)};
const ISOLINE_SAMPLES_PER_CELL : i32 = ${wgslI32(ISOLINE_SAMPLES_PER_CELL)};
const CROSSING_CLEARANCE : f32 = ${wgslF32(DRAWN_GROUND_CENTRE_CLEARANCE)};
const SIMPLIFY_EPSILON : f32 = ${wgslF32(DRAWN_GROUND_SIMPLIFY_EPSILON)};
const CROSSING_MIDPOINT : f32 = ${wgslF32(DRAWN_GROUND_CROSSING_MIDPOINT)};
const SHEER_RISE_HEIGHT_UNITS_PER_CELL : f32 = ${wgslF32(SHEER_RISE_HEIGHT_UNITS_PER_CELL)};
const SHEER_WALL_SPREAD_CELLS : f32 = ${wgslF32(SHEER_WALL_SPREAD_CELLS)};
const MAX_POLYLINE : u32 = ${wgslI32(MAX_POLYLINE)}u;
const VERTICES_PER_QUAD : u32 = ${wgslI32(VERTICES_PER_QUAD)}u;
const POSITION_XZ_UNITS : f32 = ${wgslF32(POSITION_XZ_UNITS_PER_WORLD_UNIT)};
const POSITION_Y_UNITS : f32 = ${wgslF32(POSITION_Y_UNITS_PER_WORLD_UNIT)};
const POSITION_UNITS_MIN : i32 = ${wgslI32(SNORM16_MIN_UNITS)};
const POSITION_UNITS_MAX : i32 = ${wgslI32(SNORM16_MAX_UNITS)};
const POSITION_WORDS : u32 = ${wgslI32(POSITION_WORDS_PER_VERTEX)}u;
const LOW_HALF_MASK : i32 = 0xffff;
const HIGH_HALF_SHIFT : u32 = 16u;
const MODE_EMIT : i32 = ${wgslI32(MODE_EMIT)};

struct Params {
  mode : i32,
  entry : i32,
  batchBase : i32,
  lipCapacity : u32,
};

@group(0) @binding(0) var<storage, read> lattice : array<i32>;
@group(0) @binding(1) var<storage, read> latticeDesc : array<u32>;
@group(0) @binding(2) var<storage, read> spanPairs : array<i32>;
@group(0) @binding(3) var<storage, read> entries : array<i32>;
@group(0) @binding(4) var<storage, read_write> squareBase : array<u32>;
@group(0) @binding(5) var<storage, read_write> chunkStats : array<atomic<u32>>;
@group(0) @binding(6) var<storage, read> marchTable : array<i32>;
@group(0) @binding(7) var<storage, read> lut : array<vec4f>;
@group(0) @binding(8) var<uniform> params : Params;
@group(0) @binding(9) var<storage, read_write> lips : array<u32>;
@group(0) @binding(10) var<storage, read_write> lipCounter : array<atomic<u32>>;
@group(0) @binding(11) var<storage, read> batchList : array<i32>;
@group(1) @binding(0) var<storage, read_write> outPositions : array<u32>;
@group(1) @binding(1) var<storage, read_write> outColors : array<u32>;

var<workgroup> cellHeight : array<i32, LATTICE_CELLS>;
var<workgroup> cellDesc : array<u32, LATTICE_CELLS>;

var<private> chunkLayered : bool;
var<private> chunkLowestBand : i32;
var<private> originCellX : i32;
var<private> originCellZ : i32;
var<private> entryPairBase : i32;
var<private> localOriginX : f32;
var<private> localOriginZ : f32;
var<private> emitEnabled : bool;
var<private> emitLimit : u32;
var<private> lipEntry : u32;

var<private> cornerHeight : array<i32, 4>;
var<private> crossing : array<vec2f, 4>;
var<private> corner : array<vec2f, 4>;
var<private> candidate : array<vec2f, ${wgslI32(ISOLINE_SAMPLES_PER_CELL - 1)}>;
var<private> line : array<vec2f, MAX_POLYLINE>;
var<private> lineIsContour : array<bool, MAX_POLYLINE>;

// floor(a * 2^16 / d) for 0 <= a < d by restoring division; every step stays exact in i32.
fn scaledQuotient(a : i32, d : i32) -> vec2i {
  var rem = a;
  var q = 0;
  for (var bit = 0u; bit < ISOLINE_SOLVE_SHIFT; bit++) {
    rem = rem * 2;
    q = q * 2;
    if (rem >= d) { rem -= d; q += 1; }
  }
  return vec2i(q, rem);
}

// drawnIsolineAt: the field is linear along the solve axis, so the bisection
// collapses to one exact division.
fn isolineUnits(nw : i32, ne : i32, sw : i32, se : i32, threshold : i32,
                fixedUnits : i32, alongX : bool) -> i32 {
  let fixedScaled = fixedUnits * SOLVE_PER_COORD_UNIT;
  let targetHeight = threshold - BAND_BIAS;
  var lowNear = nw;
  var lowFar = ne;
  var highNear = sw;
  var highFar = se;
  if (!alongX) {
    lowFar = sw;
    highNear = ne;
  }
  let other = ISOLINE_SOLVE_DENOM - fixedScaled;
  let a = lowNear * other + lowFar * fixedScaled - targetHeight * ISOLINE_SOLVE_DENOM;
  let b = highNear * other + highFar * fixedScaled - targetHeight * ISOLINE_SOLVE_DENOM;
  let insideLow = a >= 0;
  if (insideLow == (b >= 0)) { return ISOLINE_NO_CROSSING; }
  let c = b - a;
  if (insideLow) { return scaledQuotient(a, -c).x; }
  let solved = scaledQuotient(-a, c);
  return select(solved.x, solved.x + 1, solved.y != 0);
}

fn quantizeToBand(h : i32) -> i32 { return (h >> BAND_HEIGHT_SHIFT) << BAND_HEIGHT_SHIFT; }
fn drawnBandOfSample(h : i32) -> i32 { return (h + BAND_BIAS) >> BAND_HEIGHT_SHIFT; }

fn spanCountOf(local : i32) -> i32 {
  let packedCount = i32(cellDesc[local] >> SPAN_COUNT_SHIFT);
  return select(packedCount, 1, packedCount == 0);
}
fn spanFloor(local : i32, k : i32) -> i32 {
  let desc = cellDesc[local];
  if (desc == 0u) { return BEDROCK_FLOOR; }
  return spanPairs[(entryPairBase + i32(desc & SPAN_OFFSET_MASK) + k) * 2];
}
fn spanCeiling(local : i32, k : i32) -> i32 {
  let desc = cellDesc[local];
  if (desc == 0u) { return cellHeight[local]; }
  return spanPairs[(entryPairBase + i32(desc & SPAN_OFFSET_MASK) + k) * 2 + 1];
}
fn spanLowestBandHeight(floorHeight : i32) -> i32 {
  let q = quantizeToBand(floorHeight);
  return select(q + BAND_HEIGHT, q, q == floorHeight);
}
fn isSpanDrawn(floorHeight : i32, ceiling : i32) -> bool {
  return spanLowestBandHeight(floorHeight) <= quantizeToBand(ceiling);
}

fn columnSampleAtBand(local : i32, band : i32) -> i32 {
  let threshold = band * BAND_HEIGHT;
  let count = spanCountOf(local);
  var below = OPEN_COLUMN_SAMPLE;
  for (var k = 0; k < count; k++) {
    let floorHeight = spanFloor(local, k);
    let ceiling = spanCeiling(local, k);
    if (!isSpanDrawn(floorHeight, ceiling)) { continue; }
    let capHeight = quantizeToBand(ceiling);
    if (floorHeight <= threshold && threshold <= capHeight) { return ceiling; }
    if (capHeight < threshold) { below = ceiling; }
  }
  return below;
}

// columnCoversBand: spanIndexCoveringBand's test, which skips the isSpanDrawn filter.
fn columnCoversBand(local : i32, band : i32) -> bool {
  let threshold = band * BAND_HEIGHT;
  let count = spanCountOf(local);
  for (var k = 0; k < count; k++) {
    if (spanFloor(local, k) <= threshold && threshold <= quantizeToBand(spanCeiling(local, k))) {
      return true;
    }
  }
  return false;
}

// The field a level marches on: the plain cell height, or the column's sample at
// that band once the chunk holds a layered column.
fn levelHeight(local : i32, band : i32) -> i32 {
  if (!chunkLayered) { return cellHeight[local]; }
  return columnSampleAtBand(local, band);
}

fn crossingFraction(outsideHeight : i32, insideHeight : i32, threshold : i32) -> f32 {
  let rise = f32(insideHeight - outsideHeight);
  if (!(rise > 0.0)) { return CROSSING_MIDPOINT; }
  let exact = f32(threshold - BAND_BIAS - outsideHeight) / rise;
  var s = exact;
  if (rise > SHEER_RISE_HEIGHT_UNITS_PER_CELL) {
    s = CROSSING_MIDPOINT + (exact - CROSSING_MIDPOINT) * SHEER_WALL_SPREAD_CELLS;
  }
  return clamp(s, CROSSING_CLEARANCE, 1.0 - CROSSING_CLEARANCE);
}

fn capYOfBand(band : i32) -> f32 {
  return select(f32(band) * BAND_WORLD_HEIGHT, -SEABED_CAP_SINK, band == 0);
}
fn levelCapY(level : i32) -> f32 {
  return select(capYOfBand(level), 0.0, level == SHORE_LEVEL);
}
fn levelCapRgba(level : i32) -> u32 {
  let slot = select(LUT_CAP_BASE + level + BAND_LUT_OFFSET, LUT_SHORE_CAP, level == SHORE_LEVEL);
  return pack4x8unorm(lut[slot]);
}
fn ceilingRgba(band : i32, isLowest : bool) -> u32 {
  let base = select(LUT_CEILING_INNER_BASE, LUT_CEILING_LOWEST_BASE, isLowest);
  return pack4x8unorm(lut[base + band + BAND_LUT_OFFSET]);
}

// Positions are i16 units from the super-mesh centre; y lands on an exact band step.
fn writeVertex(at : u32, p : vec2f, y : f32, rgba : u32) {
  if (!emitEnabled || at >= emitLimit) { return; }
  let ux = i32(round((p.x * CELL_WORLD_SIZE - localOriginX) * POSITION_XZ_UNITS));
  let uz = i32(round((p.y * CELL_WORLD_SIZE - localOriginZ) * POSITION_XZ_UNITS));
  let uy = i32(round(y * POSITION_Y_UNITS));
  let qx = u32(clamp(ux, POSITION_UNITS_MIN, POSITION_UNITS_MAX) & LOW_HALF_MASK);
  let qy = u32(clamp(uy, POSITION_UNITS_MIN, POSITION_UNITS_MAX) & LOW_HALF_MASK);
  let qz = u32(clamp(uz, POSITION_UNITS_MIN, POSITION_UNITS_MAX) & LOW_HALF_MASK);
  outPositions[at * POSITION_WORDS + 0u] = qx | (qy << HIGH_HALF_SHIFT);
  outPositions[at * POSITION_WORDS + 1u] = qz;
  outColors[at] = rgba;
}

// A counted slot the emit pass did not fill collapses to a degenerate triangle.
fn writeZeroVertex(at : u32) {
  outPositions[at * POSITION_WORDS + 0u] = 0u;
  outPositions[at * POSITION_WORDS + 1u] = 0u;
  outColors[at] = 0u;
}

fn writeTriangle(at : u32, a : vec2f, b : vec2f, c : vec2f, y : f32, rgba : u32) {
  writeVertex(at + 0u, a, y, rgba);
  writeVertex(at + 1u, b, y, rgba);
  writeVertex(at + 2u, c, y, rgba);
}

// emitSkirtQuad's vertex order, without its pick inset.
fn writeRiser(at : u32, p : vec2f, q : vec2f, topY : f32, botY : f32, rgba : u32) {
  writeVertex(at + 0u, p, topY, rgba);
  writeVertex(at + 1u, q, topY, rgba);
  writeVertex(at + 2u, q, botY, rgba);
  writeVertex(at + 3u, p, topY, rgba);
  writeVertex(at + 4u, q, botY, rgba);
  writeVertex(at + 5u, p, botY, rgba);
}

fn riserQuadsPerSegment(level : i32) -> u32 {
  if (level == SHORE_LEVEL) { return 1u; }
  return select(1u, 2u, lut[LUT_BORDER_BASE + level + BAND_LUT_OFFSET].w > 0.5);
}

fn emitRiser(at : u32, p : vec2f, q : vec2f, level : i32, belowY : f32) {
  let topY = levelCapY(level);
  if (level == SHORE_LEVEL) {
    writeRiser(at, p, q, topY, belowY, pack4x8unorm(lut[LUT_SHORE_CLIFF]));
    return;
  }
  let slot = level + BAND_LUT_OFFSET;
  let cliff = lut[LUT_CLIFF_BASE + slot];
  let border = lut[LUT_BORDER_BASE + slot];
  if (border.w > 0.5) {
    let rim = topY - SEABED_RIM_HEIGHT;
    writeRiser(at, p, q, topY, rim, pack4x8unorm(vec4f(border.xyz, cliff.w)));
    writeRiser(at + VERTICES_PER_QUAD, p, q, rim, belowY, pack4x8unorm(cliff));
    return;
  }
  writeRiser(at, p, q, topY, belowY, pack4x8unorm(cliff));
}

fn refPosition(r : i32) -> vec2f {
  if (r < CORNER_REFS) { return corner[r]; }
  return crossing[r - CORNER_REFS];
}

// traceIsoline: up to ISOLINE_SAMPLES_PER_CELL - 1 points on the true isoline
// between two edge crossings, thinned by contourSmoothing's dropCollinear test.
fn buildPolyline(polyCase : i32, polyIndex : i32, threshold : i32, refine : bool) -> u32 {
  let base = (polyCase * MAX_POLYS + polyIndex) * MAX_POLY_REFS;
  let count = marchTable[polyCase * MAX_POLYS + polyIndex];
  let origin = corner[0];
  var n = 0u;
  for (var v = 0; v < count; v++) {
    if (n >= MAX_POLYLINE) { break; }
    let here = marchTable[MARCH_REF_BASE + base + v];
    let next = marchTable[MARCH_REF_BASE + base + (v + 1) % count];
    let a = refPosition(here);
    let isContour = here >= CORNER_REFS && next >= CORNER_REFS;
    line[n] = a;
    lineIsContour[n] = isContour;
    n += 1u;
    if (!isContour || !refine) { continue; }
    let b = refPosition(next);
    let localA = a - origin;
    let localB = b - origin;
    let span = abs(localB - localA);
    if (span.x + span.y < f32(ISOLINE_SAMPLES_PER_CELL) / f32(COORD_DENOM)) { continue; }
    let alongX = span.x >= span.y;
    let chordSquared = dot(localB - localA, localB - localA);
    var advanced = 0.0;
    var candidates = 0;
    for (var k = 1; k < ISOLINE_SAMPLES_PER_CELL; k++) {
      let t = f32(k) / f32(ISOLINE_SAMPLES_PER_CELL);
      let mid = localA + (localB - localA) * t;
      let fixedUnits = clamp(i32(round(select(mid.y, mid.x, alongX) * f32(COORD_DENOM))),
        0, COORD_DENOM);
      let units = isolineUnits(cornerHeight[0], cornerHeight[1], cornerHeight[3],
        cornerHeight[2], threshold, fixedUnits, alongX);
      if (units <= 0 || units >= ISOLINE_SOLVE_DENOM) { continue; }
      let solved = f32(units) / f32(ISOLINE_SOLVE_DENOM);
      let fixedCoord = f32(fixedUnits) / f32(COORD_DENOM);
      let point = select(vec2f(solved, fixedCoord), vec2f(fixedCoord, solved), alongX);
      let along = dot(point - localA, localB - localA) / chordSquared;
      if (!(along > advanced) || !(along < 1.0)) { continue; }
      advanced = along;
      candidate[candidates] = point;
      candidates += 1;
    }
    var prev = localA;
    for (var c = 0; c < candidates; c++) {
      let hereP = candidate[c];
      let nextP = select(localB, candidate[min(c + 1, candidates - 1)], c + 1 < candidates);
      let area = abs((hereP.x - prev.x) * (nextP.y - prev.y)
        - (hereP.y - prev.y) * (nextP.x - prev.x));
      let chordLength = length(nextP - prev);
      if (chordLength > 0.0 && area / chordLength < SIMPLIFY_EPSILON) { continue; }
      if (n + 1u >= MAX_POLYLINE) { break; }
      prev = hereP;
      line[n] = origin + hereP;
      lineIsContour[n] = true;
      n += 1u;
    }
  }
  return n;
}

// A square clipped by one contour is convex; only an inward bulge from the
// isoline refinement can make it concave, and only then is a vertex fan wrong.
fn polygonIsConvex(n : u32) -> bool {
  var sign = 0.0;
  for (var v = 0u; v < n; v++) {
    let a = line[v];
    let b = line[(v + 1u) % n];
    let c = line[(v + 2u) % n];
    let turn = (b.x - a.x) * (c.y - b.y) - (b.y - a.y) * (c.x - b.x);
    if (turn == 0.0) { continue; }
    if (sign == 0.0) { sign = turn; } else if (sign * turn < 0.0) { return false; }
  }
  return true;
}

// flip reverses the polyline: caps wind as emitCapTriangle does, ceilings as
// emitCeilingTriangle does. flatShading reads the winding, so it is load bearing.
fn emitPolygon(at : u32, n : u32, y : f32, rgba : u32, flip : bool) -> u32 {
  var cursor = at;
  if (n == 3u) {
    writeTriangle(cursor, line[0], select(line[1], line[2], flip),
      select(line[2], line[1], flip), y, rgba);
    cursor += 3u;
  } else if (n > 3u && polygonIsConvex(n)) {
    for (var v = 1u; v + 1u < n; v++) {
      let b = line[v];
      let c = line[v + 1u];
      writeTriangle(cursor, line[0], select(b, c, flip), select(c, b, flip), y, rgba);
      cursor += 3u;
    }
  } else if (n > 3u) {
    // Fanned from the centroid: a vertex fan would span an inward bulge and push
    // the cap over the top of its own riser.
    var centre = vec2f(0.0, 0.0);
    for (var v = 0u; v < n; v++) { centre += line[v]; }
    centre /= f32(n);
    for (var v = 0u; v < n; v++) {
      let b = line[v];
      let c = line[(v + 1u) % n];
      writeTriangle(cursor, centre, select(b, c, flip), select(c, b, flip), y, rgba);
      cursor += 3u;
    }
  }
  return cursor - at;
}

fn emitRisers(at : u32, n : u32, level : i32, belowY : f32) -> u32 {
  let riserVerts = riserQuadsPerSegment(level) * VERTICES_PER_QUAD;
  var cursor = at;
  for (var v = 0u; v < n; v++) {
    if (!lineIsContour[v]) { continue; }
    emitRiser(cursor, line[v], line[(v + 1u) % n], level, belowY);
    cursor += riserVerts;
  }
  return cursor - at;
}

// emitLipSegments: every non-seam loop edge of a band level, whether or not that
// level draws a riser. A GPU contour edge is never a seam segment.
fn appendLips(n : u32, band : i32) {
  if (emitEnabled) { return; }
  for (var v = 0u; v < n; v++) {
    if (!lineIsContour[v]) { continue; }
    let a = line[v] * CELL_WORLD_SIZE;
    let b = line[(v + 1u) % n] * CELL_WORLD_SIZE;
    let at = atomicAdd(&lipCounter[0], 1u);
    if (at >= params.lipCapacity) { continue; }
    let o = at * LIP_WORDS;
    lips[o + 0u] = lipEntry;
    lips[o + 1u] = bitcast<u32>(band);
    lips[o + 2u] = bitcast<u32>(a.x);
    lips[o + 3u] = bitcast<u32>(a.y);
    lips[o + 4u] = bitcast<u32>(b.x);
    lips[o + 5u] = bitcast<u32>(b.y);
  }
}

// Crossings run along the canonical edge direction (north to south, west to
// east), so two squares sharing an edge produce the same f32 point.
fn computeCrossings(mask : i32, useFixed : bool, fixedCrossing : f32, threshold : i32) {
  var lowOf = array<i32, 4>(0, 1, 3, 0);
  var highOf = array<i32, 4>(1, 2, 2, 3);
  for (var side = 0; side < 4; side++) {
    let to = (side + 1) % 4;
    let inFrom = (mask & (1 << u32(side))) != 0;
    if (inFrom == ((mask & (1 << u32(to))) != 0)) { continue; }
    let a = lowOf[side];
    let b = highOf[side];
    var t = fixedCrossing;
    if (!useFixed) {
      if ((mask & (1 << u32(b))) != 0) {
        t = crossingFraction(cornerHeight[a], cornerHeight[b], threshold);
      } else {
        t = 1.0 - crossingFraction(cornerHeight[b], cornerHeight[a], threshold);
      }
    }
    crossing[side] = mix(corner[a], corner[b], t);
  }
}

fn saddleCase(mask : i32, bias : i32, threshold : i32) -> i32 {
  if (mask != 5 && mask != 10) { return mask; }
  let sum = cornerHeight[0] + cornerHeight[1] + cornerHeight[2] + cornerHeight[3];
  let joined = sum + 4 * bias >= 4 * threshold;
  let splitCase = select(SADDLE_10_SPLIT_CASE, SADDLE_5_SPLIT_CASE, mask == 5);
  return select(splitCase, mask, joined);
}

fn emitLevel(level : i32, localRef : array<i32, 4>, at : u32) -> u32 {
  let isShore = level == SHORE_LEVEL;
  let threshold = select(level * BAND_HEIGHT, SHORE_THRESHOLD, isShore);
  let bias = select(BAND_BIAS, 0, isShore);
  let sampleBand = select(level, 0, isShore);
  var mask = 0;
  for (var c = 0; c < 4; c++) {
    cornerHeight[c] = levelHeight(localRef[c], sampleBand);
    if (cornerHeight[c] + bias >= threshold) { mask |= 1 << u32(c); }
  }
  if (mask == 0) { return 0u; }
  computeCrossings(mask, isShore, SHORE_EDGE_CROSSING, threshold);
  let polyCase = saddleCase(mask, bias, threshold);
  let withRiser = level != chunkLowestBand;
  let capY = levelCapY(level);
  let belowY = select(capYOfBand(level - 1), capYOfBand(0), isShore);
  let rgba = levelCapRgba(level);
  var cursor = at;
  for (var p = 0; p < MAX_POLYS; p++) {
    if (marchTable[polyCase * MAX_POLYS + p] == 0) { continue; }
    let n = buildPolyline(polyCase, p, threshold, !isShore);
    cursor += emitPolygon(cursor, n, capY, rgba, true);
    if (withRiser) { cursor += emitRisers(cursor, n, level, belowY); }
    if (!isShore) { appendLips(n, sampleBand); }
  }
  return cursor - at;
}

// marchCeiling: the band a column covers but the band below does not, marched on
// cell-edge midpoints with no refinement and no risers.
fn emitCeilingLevel(band : i32, localRef : array<i32, 4>, at : u32) -> u32 {
  var mask = 0;
  for (var c = 0; c < 4; c++) {
    let solid = columnCoversBand(localRef[c], band) && !columnCoversBand(localRef[c], band - 1);
    cornerHeight[c] = select(CEILING_OUTSIDE, CEILING_INSIDE, solid);
    if (cornerHeight[c] >= CEILING_INSIDE) { mask |= 1 << u32(c); }
  }
  if (mask == 0) { return 0u; }
  computeCrossings(mask, true, CEILING_EDGE_CROSSING, CEILING_INSIDE);
  let polyCase = saddleCase(mask, 0, CEILING_INSIDE);
  let isLowest = band == chunkLowestBand;
  let undersideY = select(capYOfBand(band - 1), capYOfBand(band), isLowest);
  let rgba = ceilingRgba(band, isLowest);
  var cursor = at;
  for (var p = 0; p < MAX_POLYS; p++) {
    if (marchTable[polyCase * MAX_POLYS + p] == 0) { continue; }
    let n = buildPolyline(polyCase, p, CEILING_INSIDE, false);
    cursor += emitPolygon(cursor, n, undersideY, rgba, false);
  }
  return cursor - at;
}

fn emitSquare(square : i32, base : u32) -> u32 {
  let lx = square % CHUNK_CELLS;
  let lz = square / CHUNK_CELLS;
  let nw = lz * CHUNK_LATTICE + lx;
  var localRef = array<i32, 4>(nw, nw + 1, nw + CHUNK_LATTICE + 1, nw + CHUNK_LATTICE);
  let westX = f32(originCellX + lx);
  let eastX = f32(originCellX + lx + 1);
  let northZ = f32(originCellZ + lz);
  let southZ = f32(originCellZ + lz + 1);
  corner[0] = vec2f(westX, northZ);
  corner[1] = vec2f(eastX, northZ);
  corner[2] = vec2f(eastX, southZ);
  corner[3] = vec2f(westX, southZ);

  var lowCorner = drawnBandOfSample(cellHeight[localRef[0]]);
  var highCorner = lowCorner;
  for (var c = 1; c < 4; c++) {
    let band = drawnBandOfSample(cellHeight[localRef[c]]);
    lowCorner = min(lowCorner, band);
    highCorner = max(highCorner, band);
  }
  // A layered chunk re-enters lower bands through columnSampleAtBand, so it marches
  // from the chunk floor; an unlayered square's lower levels only cover it whole.
  let lo = select(lowCorner, chunkLowestBand, chunkLayered);

  var cursor = base;
  for (var level = lo; level <= highCorner; level++) {
    cursor += emitLevel(level, localRef, cursor);
    if (chunkLayered) { cursor += emitCeilingLevel(level, localRef, cursor); }
    // The shipped mesher slots its shoreline level directly after band 0.
    if (level == 0) { cursor += emitLevel(SHORE_LEVEL, localRef, cursor); }
  }
  return cursor - base;
}

@compute @workgroup_size(${wgslI32(WORKGROUP_THREADS)})
fn ${MESHER_ENTRY_POINT}(@builtin(workgroup_id) wid : vec3u,
                         @builtin(local_invocation_index) tid : u32) {
  let emit = params.mode == MODE_EMIT;
  let part = wid.x % WORKGROUPS_PER_CHUNK;
  let entry = select(batchList[params.batchBase + i32(wid.x / WORKGROUPS_PER_CHUNK)],
    params.entry, emit);
  let latticeBase = u32(entry) * LATTICE_CELLS;
  for (var at = tid; at < LATTICE_CELLS; at += WORKGROUP_THREADS) {
    cellHeight[at] = lattice[latticeBase + at];
    cellDesc[at] = latticeDesc[latticeBase + at];
  }
  workgroupBarrier();

  let header = entry * ENTRY_HEADER_WORDS;
  chunkLayered = entries[header + ${wgslI32(ENTRY_LAYERED)}] != 0;
  chunkLowestBand = entries[header + ${wgslI32(ENTRY_LOWEST_BAND)}];
  originCellX = entries[header + ${wgslI32(ENTRY_ORIGIN_X_CELLS)}];
  originCellZ = entries[header + ${wgslI32(ENTRY_ORIGIN_Z_CELLS)}];
  localOriginX = f32(entries[header + ${wgslI32(ENTRY_LOCAL_ORIGIN_X_UNITS)}]) / POSITION_XZ_UNITS;
  localOriginZ = f32(entries[header + ${wgslI32(ENTRY_LOCAL_ORIGIN_Z_UNITS)}]) / POSITION_XZ_UNITS;
  entryPairBase = entry * WINDOW_SPAN_PAIRS;
  emitEnabled = emit;
  lipEntry = u32(entry);
  let chunkVertexLimit = u32(entries[header + ${wgslI32(ENTRY_VERTEX_LIMIT)}]);
  let squareSlot = u32(entry) * SQUARES_PER_CHUNK;

  for (var s = part * SQUARES_PER_WORKGROUP + tid;
       s < (part + 1u) * SQUARES_PER_WORKGROUP;
       s += WORKGROUP_THREADS) {
    if (!emit) {
      emitLimit = 0u;
      let needed = emitSquare(i32(s), 0u);
      squareBase[squareSlot + s] = needed;
      atomicAdd(&chunkStats[u32(entry) * CHUNK_STATS_WORDS + CHUNK_STATS_VERTEX_COUNT], needed);
      continue;
    }
    let isLast = s + 1u >= SQUARES_PER_CHUNK;
    let base = squareBase[squareSlot + s];
    let nextSlot = select(squareSlot + s + 1u, squareSlot + s, isLast);
    let limit = select(squareBase[nextSlot], chunkVertexLimit, isLast);
    emitLimit = limit;
    let wrote = emitSquare(i32(s), base);
    for (var v = base + wrote; v < limit; v++) { writeZeroVertex(v); }
  }
}
`;
}
