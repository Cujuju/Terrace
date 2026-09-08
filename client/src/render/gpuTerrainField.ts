import { BAND_HEIGHT, TERRAIN_LOD_NEAR_N } from '@terrace/shared';

const SUBCELL_DENOM = 2 * TERRAIN_LOD_NEAR_N;

const BLEND_DENOM = SUBCELL_DENOM * SUBCELL_DENOM;

const QUANTISE_DENOM = BLEND_DENOM * BAND_HEIGHT;

export const HEIGHT_SAMPLER_UNIFORM = 'uHeight';

export const SIZE_CELLS_UNIFORM = 'uSizeCells';

/**
 * Mirrors shared/src/drawnGround.ts in GLSL integer arithmetic. Any change to
 * that file must land here too; client/scripts/gpuTerrainParity.mjs is the gate.
 */
export const GPU_TERRAIN_FIELD_GLSL = `
uniform highp isampler2D ${HEIGHT_SAMPLER_UNIFORM};
uniform int ${SIZE_CELLS_UNIFORM};

const int LATTICE_N = ${TERRAIN_LOD_NEAR_N};
const int SUBCELL_DENOM = ${SUBCELL_DENOM};
const int QUANTISE_DENOM = ${QUANTISE_DENOM};
const int FIELD_BAND_HEIGHT = ${BAND_HEIGHT};

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
  int numerator =
    (SUBCELL_DENOM - fx) * (SUBCELL_DENOM - fy) * cellHeight(x0, y0) +
    fx * (SUBCELL_DENOM - fy) * cellHeight(x1, y0) +
    (SUBCELL_DENOM - fx) * fy * cellHeight(x0, y1) +
    fx * fy * cellHeight(x1, y1);
  return floorDivPositive(numerator, QUANTISE_DENOM) * FIELD_BAND_HEIGHT;
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
