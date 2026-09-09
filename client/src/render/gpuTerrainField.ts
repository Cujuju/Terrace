import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  DRAWN_GROUND_FIXPOINT_STEPS,
  MAX_SPANS_PER_COLUMN,
  OPEN_COLUMN_SAMPLE,
  TERRAIN_LOD_NEAR_N,
} from '@terrace/shared';

const SUBCELL_DENOM = 2 * TERRAIN_LOD_NEAR_N;

const BLEND_DENOM = SUBCELL_DENOM * SUBCELL_DENOM;

const BAND_BLEND_DENOM = BLEND_DENOM * BAND_HEIGHT;

/** Corners of a sub-cell, and the most crossings one threshold can put on them. */
const FIELD_CORNERS = 4;

/** Corners plus two thresholds' crossings, the most a tread's boundary can hold. */
const MAX_TREAD_POINTS = FIELD_CORNERS + 2 * FIELD_CORNERS;

/** Two saddles give four chords, so a tread cannot split past four arcs. */
const MAX_TREAD_PIECES = 4;

/** Two thresholds' crossings; each chord registers both of its ends. */
const MAX_TREAD_CROSSINGS = 2 * FIELD_CORNERS;

export const HEIGHT_SAMPLER_UNIFORM = 'uHeight';

export const SIZE_CELLS_UNIFORM = 'uSizeCells';

export const CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM = 'uChunkSpanBlock';

export const COLUMN_SPAN_SAMPLER_UNIFORM = 'uColumnSpans';

export const WORLD_HAS_SPANS_UNIFORM = 'uWorldHasSpans';

/** `cellSample` mode: read the top surface, as `topSample` does. */
export const FIELD_SAMPLE_TOP = 0;

/** `cellSample` mode: read the column at a band, as `bandSample` does. */
export const FIELD_SAMPLE_AT_BAND = 1;

/**
 * Mirrors shared/src/drawnGround.ts in GLSL integer arithmetic. Any change to
 * that file must land here too; client/scripts/gpuTerrainParity.mjs is the gate.
 */
export const GPU_TERRAIN_FIELD_GLSL = `
uniform highp isampler2D ${HEIGHT_SAMPLER_UNIFORM};
uniform highp isampler2D ${CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM};
uniform highp isampler2D ${COLUMN_SPAN_SAMPLER_UNIFORM};
uniform int ${SIZE_CELLS_UNIFORM};
uniform int ${WORLD_HAS_SPANS_UNIFORM};

const int LATTICE_N = ${TERRAIN_LOD_NEAR_N};
const int SUBCELL_DENOM = ${SUBCELL_DENOM};
const int BAND_BLEND_DENOM = ${BAND_BLEND_DENOM};
const int FIELD_BAND_HEIGHT = ${BAND_HEIGHT};
const int FIELD_CHUNK_CELLS = ${CHUNK_SIZE};
const int FIELD_MAX_SPANS = ${MAX_SPANS_PER_COLUMN};
const int FIELD_BEDROCK_FLOOR = ${BEDROCK_FLOOR};
const int FIELD_OPEN_COLUMN_SAMPLE = ${OPEN_COLUMN_SAMPLE};
const int FIELD_FIXPOINT_STEPS = ${DRAWN_GROUND_FIXPOINT_STEPS};
const int FIELD_CORNERS = ${FIELD_CORNERS};
const int MAX_TREAD_POINTS = ${MAX_TREAD_POINTS};
const int MAX_TREAD_PIECES = ${MAX_TREAD_PIECES};
const int MAX_TREAD_CROSSINGS = ${MAX_TREAD_CROSSINGS};
const int FIELD_SAMPLE_TOP = ${FIELD_SAMPLE_TOP};

// Sub-cell corners in perimeter order; the next corner closes each edge.
const vec2 FIELD_CORNER_POS[4] =
  vec2[4](vec2(0.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 1.0), vec2(1.0, 0.0));

// GLSL int division truncates toward zero; this floors toward minus infinity.
int floorDivPositive(int a, int b) {
  int sign = a < 0 ? -1 : 1;
  int q = sign * ((sign * a) / b);
  return q * b > a ? q - 1 : q;
}

int cellHeight(int cx, int cy) {
  return texelFetch(${HEIGHT_SAMPLER_UNIFORM}, ivec2(cx, cy), 0).r;
}

int clampCell(int i) {
  return clamp(i, 0, ${SIZE_CELLS_UNIFORM} - 1);
}

int latticeOffset(float coord) {
  return 2 * int(floor(coord * float(LATTICE_N))) + 1 - LATTICE_N;
}

int bandOfHeight(int height) {
  return floorDivPositive(height, FIELD_BAND_HEIGHT);
}

int quantiseToBand(int height) {
  return floorDivPositive(height, FIELD_BAND_HEIGHT) * FIELD_BAND_HEIGHT;
}

// Zero when every column in the chunk holds one span; otherwise its row plus one.
int chunkSpanBlock(int cx, int cy) {
  return texelFetch(
    ${CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM},
    ivec2(cx / FIELD_CHUNK_CELLS, cy / FIELD_CHUNK_CELLS),
    0
  ).r;
}

// First texel of a cell's span list inside its chunk's packed row.
int columnSpanBase(int cx, int cy) {
  return
    ((cy - (cy / FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS +
      (cx - (cx / FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS)) * FIELD_MAX_SPANS;
}

// shared/src/columns.ts columnSampleAtBand, over the packed span rows.
int columnSampleAtBand(int cx, int cy, int block, int band) {
  int threshold = band * FIELD_BAND_HEIGHT;
  int below = FIELD_OPEN_COLUMN_SAMPLE;
  bool layered = false;
  if (block != 0) {
    int column = columnSpanBase(cx, cy);
    for (int k = 0; k < FIELD_MAX_SPANS; k++) {
      ivec2 span = texelFetch(
        ${COLUMN_SPAN_SAMPLER_UNIFORM},
        ivec2(column + k, block - 1),
        0
      ).rg;
      if (span.y <= span.x) break;
      layered = true;
      int cap = quantiseToBand(span.y);
      int lowest = quantiseToBand(span.x);
      if (lowest != span.x) lowest += FIELD_BAND_HEIGHT;
      if (lowest > cap) continue;
      if (span.x <= threshold && threshold <= cap) return span.y;
      if (cap < threshold) below = span.y;
    }
  }
  if (layered) return below;
  return threshold < FIELD_BEDROCK_FLOOR ? FIELD_OPEN_COLUMN_SAMPLE : cellHeight(cx, cy);
}

// shared/src/columns.ts spanCount, asked as the only question callers have.
bool cellHasOneSpan(int cx, int cy) {
  int block = chunkSpanBlock(cx, cy);
  if (block == 0) return true;
  ivec2 second = texelFetch(
    ${COLUMN_SPAN_SAMPLER_UNIFORM},
    ivec2(columnSpanBase(cx, cy) + 1, block - 1),
    0
  ).rg;
  return second.y <= second.x;
}

// drawnGround.ts topSample / bandSample, chosen by mode so cornerNumerator
// serves both the top surface and the layered fixpoint.
int cellSample(int cx, int cy, int mode, int band) {
  if (mode == FIELD_SAMPLE_TOP) return cellHeight(cx, cy);
  return columnSampleAtBand(cx, cy, chunkSpanBlock(cx, cy), band);
}

// The cell a lattice corner's blend starts from.
int latticeFirstCell(int l) {
  return floorDivPositive(2 * l - LATTICE_N, SUBCELL_DENOM);
}

// Exact bilinear numerator at lattice corner (lx, ly), over BLEND_DENOM.
int cornerNumerator(int lx, int ly, int mode, int band) {
  int qx = 2 * lx - LATTICE_N;
  int qy = 2 * ly - LATTICE_N;
  int baseX = floorDivPositive(qx, SUBCELL_DENOM);
  int baseY = floorDivPositive(qy, SUBCELL_DENOM);
  int fx = qx - baseX * SUBCELL_DENOM;
  int fy = qy - baseY * SUBCELL_DENOM;
  int x0 = clampCell(baseX);
  int x1 = clampCell(baseX + 1);
  int y0 = clampCell(baseY);
  int y1 = clampCell(baseY + 1);
  return
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * cellSample(x0, y0, mode, band) +
    fx * (SUBCELL_DENOM - fy) * cellSample(x1, y0, mode, band) +
    (SUBCELL_DENOM - fx) * fy * cellSample(x0, y1, mode, band) +
    fx * fy * cellSample(x1, y1, mode, band);
}

int bandOfNumerator(int numerator) {
  return floorDivPositive(numerator, BAND_BLEND_DENOM);
}

// Four corner numerators of one sub-cell, in perimeter order.
void subcellField(int lx0, int ly0, int stride, int mode, int band, out int field[4]) {
  field[0] = cornerNumerator(lx0, ly0, mode, band);
  field[1] = cornerNumerator(lx0, ly0 + stride, mode, band);
  field[2] = cornerNumerator(lx0 + stride, ly0 + stride, mode, band);
  field[3] = cornerNumerator(lx0 + stride, ly0, mode, band);
}

int fieldLowBand(int field[4]) {
  return bandOfNumerator(min(min(field[0], field[1]), min(field[2], field[3])));
}

int fieldHighBand(int field[4]) {
  return bandOfNumerator(max(max(field[0], field[1]), max(field[2], field[3])));
}

// drawnGround.ts queryIsLayered: any cell the corners blend from with >1 span.
bool subcellIsLayered(int lx0, int ly0, int stride) {
  if (${WORLD_HAS_SPANS_UNIFORM} == 0) return false;
  int x0 = clampCell(latticeFirstCell(lx0));
  int x1 = clampCell(latticeFirstCell(lx0 + stride) + 1);
  int y0 = clampCell(latticeFirstCell(ly0));
  int y1 = clampCell(latticeFirstCell(ly0 + stride) + 1);
  int blocks =
    chunkSpanBlock(x0, y0) | chunkSpanBlock(x1, y0) |
    chunkSpanBlock(x0, y1) | chunkSpanBlock(x1, y1);
  if (blocks == 0) return false;
  for (int y = y0; y <= y1; y++) {
    for (int x = x0; x <= x1; x++) {
      if (!cellHasOneSpan(x, y)) return true;
    }
  }
  return false;
}

struct Chords {
  int count;
  int edges[4];
  int nums[4];
  int dens[4];
  int pairA[2];
  int pairB[2];
  int pairCount;
  bool arcHigh;
};

Chords noChords() {
  Chords c;
  c.count = 0;
  c.pairCount = 0;
  c.arcHigh = true;
  for (int i = 0; i < FIELD_CORNERS; i++) {
    c.edges[i] = 0;
    c.nums[i] = 0;
    c.dens[i] = 1;
  }
  c.pairA[0] = 0;
  c.pairA[1] = 0;
  c.pairB[0] = 0;
  c.pairB[1] = 0;
  return c;
}

// drawnGround.ts chordsAt: threshold-band isoline chords of a sub-cell field.
Chords chordsAt(int field[4], int band) {
  Chords c = noChords();
  int threshold = band * BAND_BLEND_DENOM;
  int count = 0;
  for (int edge = 0; edge < FIELD_CORNERS; edge++) {
    int here = field[edge];
    int next = field[(edge + 1) % FIELD_CORNERS];
    if ((here < threshold) == (next < threshold)) continue;
    c.edges[count] = edge;
    int num = threshold - here;
    int den = next - here;
    c.nums[count] = den < 0 ? -num : num;
    c.dens[count] = den < 0 ? -den : den;
    count++;
  }
  c.count = count;
  if (count == 0) return c;
  if (count == 2) {
    int firstArcCorner = (c.edges[0] + 1) % FIELD_CORNERS;
    c.pairCount = 1;
    c.pairA[0] = 0;
    c.pairB[0] = 1;
    c.arcHigh = field[firstArcCorner] >= threshold;
    return c;
  }
  // A saddle: the centre decides whether the high corners join through it.
  bool centreHigh =
    field[0] + field[1] + field[2] + field[3] >= FIELD_CORNERS * threshold;
  bool arcHigh = !centreHigh;
  bool corner1High = field[1] >= threshold;
  c.pairCount = 2;
  if (corner1High == arcHigh) {
    c.pairA[0] = 0; c.pairB[0] = 1;
    c.pairA[1] = 2; c.pairB[1] = 3;
  } else {
    c.pairA[0] = 1; c.pairB[0] = 2;
    c.pairA[1] = 3; c.pairB[1] = 0;
  }
  c.arcHigh = arcHigh;
  return c;
}

// drawnGround.ts crossingPoint, in the sub-cell's local (x, y).
vec2 crossingPoint(Chords c, int i) {
  int edge = c.edges[i];
  vec2 from = FIELD_CORNER_POS[edge];
  vec2 to = FIELD_CORNER_POS[(edge + 1) % FIELD_CORNERS];
  return from + (to - from) * (float(c.nums[i]) / float(c.dens[i]));
}

// Index of the crossing chordsAt put on that edge, or -1.
int crossingOnEdge(Chords c, int edge) {
  for (int i = 0; i < c.count; i++) {
    if (c.edges[i] == edge) return i;
  }
  return -1;
}

struct TreadFan {
  vec2 points[MAX_TREAD_POINTS];
  int pieceStart[MAX_TREAD_PIECES];
  int pieceLen[MAX_TREAD_PIECES];
  int pieceCount;
};

// drawnGround.ts treadPieces: boundary polygons of the tread between a band and
// the next threshold above it, walked into one flat point list per piece.
TreadFan treadPieces(int field[4], int band, Chords above, Chords below) {
  TreadFan fan;
  fan.pieceCount = 0;
  for (int i = 0; i < MAX_TREAD_POINTS; i++) fan.points[i] = vec2(0.0);
  for (int i = 0; i < MAX_TREAD_PIECES; i++) {
    fan.pieceStart[i] = 0;
    fan.pieceLen[i] = 0;
  }

  // register(below, below.arcHigh) then register(above, !above.arcHigh).
  int tcPartner[MAX_TREAD_CROSSINGS];
  bool tcForward[MAX_TREAD_CROSSINGS];
  int tcSlot[MAX_TREAD_CROSSINGS];
  int belowIndex[4];
  int aboveIndex[4];
  for (int i = 0; i < FIELD_CORNERS; i++) {
    belowIndex[i] = -1;
    aboveIndex[i] = -1;
  }
  int tcCount = 0;
  for (int p = 0; p < below.pairCount; p++) {
    belowIndex[below.pairA[p]] = tcCount;
    belowIndex[below.pairB[p]] = tcCount + 1;
    tcPartner[tcCount] = tcCount + 1;
    tcForward[tcCount] = below.arcHigh;
    tcPartner[tcCount + 1] = tcCount;
    tcForward[tcCount + 1] = !below.arcHigh;
    tcCount += 2;
  }
  for (int p = 0; p < above.pairCount; p++) {
    aboveIndex[above.pairA[p]] = tcCount;
    aboveIndex[above.pairB[p]] = tcCount + 1;
    tcPartner[tcCount] = tcCount + 1;
    tcForward[tcCount] = !above.arcHigh;
    tcPartner[tcCount + 1] = tcCount;
    tcForward[tcCount + 1] = above.arcHigh;
    tcCount += 2;
  }

  vec2 bPos[MAX_TREAD_POINTS];
  int bCrossing[MAX_TREAD_POINTS];
  int bCount = 0;
  for (int edge = 0; edge < FIELD_CORNERS; edge++) {
    if (bandOfNumerator(field[edge]) == band && bCount < MAX_TREAD_POINTS) {
      bPos[bCount] = FIELD_CORNER_POS[edge];
      bCrossing[bCount] = -1;
      bCount++;
    }
    int bi = crossingOnEdge(below, edge);
    int ai = crossingOnEdge(above, edge);
    // Both thresholds share the edge's denominator, so num alone orders them.
    bool aboveFirst = bi >= 0 && ai >= 0 && above.nums[ai] < below.nums[bi];
    for (int pass = 0; pass < 2; pass++) {
      bool takeBelow = (pass == 0) != aboveFirst;
      int index = takeBelow ? bi : ai;
      if (index < 0 || bCount >= MAX_TREAD_POINTS) continue;
      if (takeBelow) {
        bPos[bCount] = crossingPoint(below, index);
        bCrossing[bCount] = belowIndex[index];
      } else {
        bPos[bCount] = crossingPoint(above, index);
        bCrossing[bCount] = aboveIndex[index];
      }
      bCount++;
    }
  }
  if (bCount == 0) return fan;
  for (int i = 0; i < bCount; i++) {
    if (bCrossing[i] >= 0) tcSlot[bCrossing[i]] = i;
  }

  bool visited[MAX_TREAD_POINTS];
  for (int i = 0; i < MAX_TREAD_POINTS; i++) visited[i] = false;
  int written = 0;
  for (int start = 0; start < bCount; start++) {
    if (visited[start]) continue;
    int startCrossing = bCrossing[start];
    if (startCrossing >= 0 && !tcForward[startCrossing]) continue;
    if (fan.pieceCount == MAX_TREAD_PIECES) break;
    int begin = written;
    int slot = start;
    for (int guard = 0; guard < MAX_TREAD_POINTS; guard++) {
      visited[slot] = true;
      if (written < MAX_TREAD_POINTS) fan.points[written++] = bPos[slot];
      int crossing = bCrossing[slot];
      if (crossing >= 0 && !tcForward[crossing]) {
        slot = tcSlot[tcPartner[crossing]];
        if (slot == start) break;
        visited[slot] = true;
        if (written < MAX_TREAD_POINTS) fan.points[written++] = bPos[slot];
      }
      slot = (slot + 1) % bCount;
      if (slot == start) break;
    }
    fan.pieceStart[fan.pieceCount] = begin;
    fan.pieceLen[fan.pieceCount] = written - begin;
    fan.pieceCount++;
  }
  return fan;
}

// Vertex role of fan triangle tri, or the first point when the slot is spare.
vec2 treadFanVertex(TreadFan fan, int tri, int role) {
  int seen = 0;
  for (int p = 0; p < MAX_TREAD_PIECES; p++) {
    if (p >= fan.pieceCount) break;
    int tris = fan.pieceLen[p] - 2;
    if (tris <= 0) continue;
    if (tri < seen + tris) {
      int local = tri - seen;
      int offset = role == 0 ? 0 : (role == 1 ? local + 1 : local + 2);
      return fan.points[fan.pieceStart[p] + offset];
    }
    seen += tris;
  }
  return fan.points[0];
}

int blendBand(int fx, int fy, int h00, int h10, int h01, int h11) {
  int numerator =
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * h00 +
    fx * (SUBCELL_DENOM - fy) * h10 +
    (SUBCELL_DENOM - fx) * fy * h01 +
    fx * fy * h11;
  return floorDivPositive(numerator, BAND_BLEND_DENOM);
}

// The lattice rule at a sub-cell centre. Layered sub-cells draw a flat cap from
// it, and every curtain and skirt drops to it; the contour path never calls it.
int drawnGroundHeight(vec2 cell) {
  int qx = latticeOffset(cell.x);
  int qy = latticeOffset(cell.y);
  int baseX = floorDivPositive(qx, SUBCELL_DENOM);
  int baseY = floorDivPositive(qy, SUBCELL_DENOM);
  int fx = qx - baseX * SUBCELL_DENOM;
  int fy = qy - baseY * SUBCELL_DENOM;
  int x0 = clampCell(baseX);
  int x1 = clampCell(baseX + 1);
  int y0 = clampCell(baseY);
  int y1 = clampCell(baseY + 1);
  int band = blendBand(
    fx, fy,
    cellHeight(x0, y0), cellHeight(x1, y0), cellHeight(x0, y1), cellHeight(x1, y1)
  );
  if (${WORLD_HAS_SPANS_UNIFORM} != 0) {
    int b00 = chunkSpanBlock(x0, y0);
    int b10 = chunkSpanBlock(x1, y0);
    int b01 = chunkSpanBlock(x0, y1);
    int b11 = chunkSpanBlock(x1, y1);
    if ((b00 | b10 | b01 | b11) != 0) {
      for (int step = 0; step < FIELD_FIXPOINT_STEPS; step++) {
        int next = blendBand(
          fx, fy,
          columnSampleAtBand(x0, y0, b00, band),
          columnSampleAtBand(x1, y0, b10, band),
          columnSampleAtBand(x0, y1, b01, band),
          columnSampleAtBand(x1, y1, b11, band)
        );
        if (next == band) break;
        band = next;
      }
    }
  }
  return band * FIELD_BAND_HEIGHT;
}

// The unquantised field, from the same integer fetches, for fragment colouring.
float smoothHeight(vec2 cell) {
  vec2 texel = cell - 0.5;
  vec2 base = floor(texel);
  vec2 frac = texel - base;
  int x0 = clampCell(int(base.x));
  int x1 = clampCell(int(base.x) + 1);
  int y0 = clampCell(int(base.y));
  int y1 = clampCell(int(base.y) + 1);
  float h00 = float(cellHeight(x0, y0));
  float h10 = float(cellHeight(x1, y0));
  float h01 = float(cellHeight(x0, y1));
  float h11 = float(cellHeight(x1, y1));
  return mix(mix(h00, h10, frac.x), mix(h01, h11, frac.x), frac.y);
}
`;
