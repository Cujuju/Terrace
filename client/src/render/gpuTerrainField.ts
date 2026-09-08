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

const QUANTISE_DENOM = BLEND_DENOM * BAND_HEIGHT;

export const HEIGHT_SAMPLER_UNIFORM = 'uHeight';

export const SIZE_CELLS_UNIFORM = 'uSizeCells';

export const CHUNK_SPAN_BLOCK_SAMPLER_UNIFORM = 'uChunkSpanBlock';

export const COLUMN_SPAN_SAMPLER_UNIFORM = 'uColumnSpans';

export const WORLD_HAS_SPANS_UNIFORM = 'uWorldHasSpans';

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
const int QUANTISE_DENOM = ${QUANTISE_DENOM};
const int FIELD_BAND_HEIGHT = ${BAND_HEIGHT};
const int FIELD_CHUNK_CELLS = ${CHUNK_SIZE};
const int FIELD_MAX_SPANS = ${MAX_SPANS_PER_COLUMN};
const int FIELD_BEDROCK_FLOOR = ${BEDROCK_FLOOR};
const int FIELD_OPEN_COLUMN_SAMPLE = ${OPEN_COLUMN_SAMPLE};
const int FIELD_FIXPOINT_STEPS = ${DRAWN_GROUND_FIXPOINT_STEPS};

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

// shared/src/columns.ts columnSampleAtBand, over the packed span rows.
int columnSampleAtBand(int cx, int cy, int block, int band) {
  int threshold = band * FIELD_BAND_HEIGHT;
  int below = FIELD_OPEN_COLUMN_SAMPLE;
  bool layered = false;
  if (block != 0) {
    int column =
      ((cy - (cy / FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS +
        (cx - (cx / FIELD_CHUNK_CELLS) * FIELD_CHUNK_CELLS)) * FIELD_MAX_SPANS;
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

int blendBand(int fx, int fy, int h00, int h10, int h01, int h11) {
  int numerator =
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * h00 +
    fx * (SUBCELL_DENOM - fy) * h10 +
    (SUBCELL_DENOM - fx) * fy * h01 +
    fx * fy * h11;
  return floorDivPositive(numerator, QUANTISE_DENOM);
}

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
