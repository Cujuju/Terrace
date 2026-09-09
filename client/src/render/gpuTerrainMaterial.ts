import {
  BufferAttribute,
  DoubleSide,
  InstancedBufferGeometry,
  MeshLambertMaterial,
  type IUniform,
} from 'three';
import {
  CELL_CENTRE_OFFSET_CELLS,
  CHUNK_SIZE,
  TERRAIN_LOD_FAR_N,
  TERRAIN_LOD_NEAR_N,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { glslFloat, spliceShader } from './shaderSplice.ts';
import { applyGroundShade } from './groundShade.ts';
import { GPU_TERRAIN_FIELD_GLSL } from './gpuTerrainField.ts';
import {
  BAND_LUT_CLIFF_ROW,
  BAND_LUT_MIN_BAND,
  BAND_LUT_TERRAIN_ROW,
  BAND_LUT_WIDTH,
} from './gpuTerrainTextures.ts';

const KIND_TREAD = 0;
const KIND_RISER = 1;
const KIND_CURTAIN = 2;

const CORNERS_PER_QUAD = 4;
const TRIANGLES_PER_QUAD = 2;
const VERTICES_PER_TRIANGLE = 3;

/** Sub-cell corners, and the edges between them, in perimeter order. */
const SUBCELL_EDGES = 4;

/** Roles per slot: a quad's four corners; a fan triangle uses the first three. */
const ROLE_STRIDE = 4;

/** A saddle threshold has two chords, so a riser slot needs two quads. */
const RISER_CHORDS_PER_THRESHOLD = 2;

/** Base class: a sub-cell spanning one threshold. Wider spans go to an overlay. */
export const BASE_CLASS_STEPS = 1;

/** Layered sub-cells draw a flat cap and four skirts, so they need the smallest class. */
export const LAYERED_OVERLAY_CLASS = 2;

/**
 * Boundary points cap at six when one threshold crosses the sub-cell and eight
 * when two do; a piece of n points fans into n - 2 triangles.
 */
const TREAD_FAN_TRIS_BASE = 4;
const TREAD_FAN_TRIS_OVERLAY = 6;

function treadFanTriangles(steps: number): number {
  return steps === BASE_CLASS_STEPS ? TREAD_FAN_TRIS_BASE : TREAD_FAN_TRIS_OVERLAY;
}

/** Smallest overlay class that draws a sub-cell spanning `bands` thresholds. */
export function overlayClassCap(bands: number): number {
  let cap = LAYERED_OVERLAY_CLASS;
  while (cap < bands) cap *= 2;
  return cap;
}

/** Subdivisions a chunk can be drawn at; a curtain must reach any of them. */
const LOD_LEVELS = [TERRAIN_LOD_NEAR_N, TERRAIN_LOD_FAR_N] as const;

const LATTICE_STRIDES = LOD_LEVELS.map((level) => TERRAIN_LOD_NEAR_N / level);

/** Corners the coarsest level puts across the finest level's sub-cell edge, plus its far end. */
const MAX_CURTAIN_SAMPLES = Math.max(...LATTICE_STRIDES) / Math.min(...LATTICE_STRIDES) + 1;

/** Riser-lip width in device pixels, standing in for the LineSegments overlay. */
const RISER_LIP_PIXELS = 1.4;

/** Band-edge isoline width in device pixels, for the smooth-terrace variant. */
const ISOLINE_PIXELS = 1.2;

/** How far a band edge darkens the surface under it. */
const BAND_EDGE_DARKEN = 0.45;

/** Floor on a screen-space edge width, so a flat-on surface keeps a hairline. */
const MIN_EDGE_WIDTH = 1e-5;

/** No band could ever sit here, so a curtain's search starts above every corner. */
const NO_BAND_CEILING = 1 << 20;

/** Vertices that carry no tread band: risers, curtains and every spare slot. */
export const GPU_TERRAIN_NON_TREAD_BAND = -(1 << 20);

const MATERIAL_LABEL = 'gpu terrain';

const PROGRAM_CACHE_KEY = 'terrace-gpu-terrain';

export const SUBDIVISION_UNIFORM = 'uSubdiv';

export const CLASS_STEPS_UNIFORM = 'uSteps';

export const DRAWS_LAYERED_UNIFORM = 'uDrawsLayered';

export const PALETTE_UNIFORM = 'uPalette';

export const SMOOTH_UNIFORM = 'uSmooth';

export interface ChunkTemplate {
  readonly geometry: InstancedBufferGeometry;
  readonly trianglesPerChunk: number;
}

/**
 * One instance's sub-cells: `steps + 1` tread fans, `steps` riser slots and,
 * on every chunk-border edge, one curtain per tread.
 */
export function createChunkTemplate(
  subdivision: number,
  steps: number = BASE_CLASS_STEPS,
  cells: number = CHUNK_SIZE,
): ChunkTemplate {
  const span = Math.round(cells * subdivision);
  const subCells = span * span;
  const fanTris = treadFanTriangles(steps);
  const treadSlots = steps + 1;
  const riserQuads = steps * RISER_CHORDS_PER_THRESHOLD;
  // Every border of the instance carries `span` sub-cell edges.
  const curtainQuads = SUBCELL_EDGES * span * treadSlots;
  const triangles =
    subCells * (treadSlots * fanTris + riserQuads * TRIANGLES_PER_QUAD) +
    curtainQuads * TRIANGLES_PER_QUAD;
  const vertices =
    subCells * (treadSlots * fanTris * VERTICES_PER_TRIANGLE + riserQuads * CORNERS_PER_QUAD) +
    curtainQuads * CORNERS_PER_QUAD;

  const lattice = new Float32Array(vertices * 3);
  const corners = new Float32Array(vertices * 2);
  const indices = new Uint32Array(triangles * VERTICES_PER_TRIANGLE);
  let vertex = 0;
  let cursor = 0;
  const push = (i: number, j: number, kind: number, slot: number, part: number, role: number): number => {
    lattice[vertex * 3] = i;
    lattice[vertex * 3 + 1] = kind;
    lattice[vertex * 3 + 2] = j;
    corners[vertex * 2] = slot;
    corners[vertex * 2 + 1] = part * ROLE_STRIDE + role;
    return vertex++;
  };
  const triangle = (i: number, j: number, kind: number, slot: number, part: number): void => {
    const base = push(i, j, kind, slot, part, 0);
    push(i, j, kind, slot, part, 1);
    push(i, j, kind, slot, part, 2);
    indices[cursor++] = base;
    indices[cursor++] = base + 1;
    indices[cursor++] = base + 2;
  };
  const quad = (i: number, j: number, kind: number, slot: number, part: number): void => {
    const base = push(i, j, kind, slot, part, 0);
    push(i, j, kind, slot, part, 1);
    push(i, j, kind, slot, part, 2);
    push(i, j, kind, slot, part, 3);
    indices[cursor++] = base;
    indices[cursor++] = base + 1;
    indices[cursor++] = base + 2;
    indices[cursor++] = base;
    indices[cursor++] = base + 2;
    indices[cursor++] = base + 3;
  };
  // Edge e runs from corner e to corner (e + 1) % 4, corners in perimeter order.
  const borderEdges = (i: number, j: number): number[] => {
    const edges: number[] = [];
    if (i === 0) edges.push(0);
    if (j === span - 1) edges.push(1);
    if (i === span - 1) edges.push(2);
    if (j === 0) edges.push(3);
    return edges;
  };
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      for (let slot = 0; slot < treadSlots; slot++) {
        for (let k = 0; k < fanTris; k++) triangle(i, j, KIND_TREAD, slot, k);
      }
      for (let slot = 1; slot <= steps; slot++) {
        for (let chord = 0; chord < RISER_CHORDS_PER_THRESHOLD; chord++) {
          quad(i, j, KIND_RISER, slot, chord);
        }
      }
      for (const edge of borderEdges(i, j)) {
        for (let slot = 0; slot < treadSlots; slot++) quad(i, j, KIND_CURTAIN, slot, edge);
      }
    }
  }

  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(lattice, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  // three flat-shades a lit material whose geometry has no normal attribute;
  // the shader writes the real normal, so this placeholder only opts out.
  geometry.setAttribute('normal', new BufferAttribute(new Float32Array(vertices * 3), 3));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, trianglesPerChunk: triangles };
}

const COMMON_GLSL = `
uniform sampler2D ${PALETTE_UNIFORM};
uniform float ${SUBDIVISION_UNIFORM};
uniform float ${SMOOTH_UNIFORM};
const float CELL_WORLD_SIZE = ${glslFloat(CELL_WORLD_SIZE)};
const float HEIGHT_WORLD_SCALE = ${glslFloat(HEIGHT_WORLD_SCALE)};
const float CELL_CENTRE_OFFSET_CELLS = ${glslFloat(CELL_CENTRE_OFFSET_CELLS)};
const float CHUNK_CELLS = ${glslFloat(CHUNK_SIZE)};
const int BAND_LUT_MIN_BAND = ${BAND_LUT_MIN_BAND};
const int BAND_LUT_WIDTH = ${BAND_LUT_WIDTH};
${GPU_TERRAIN_FIELD_GLSL}
// Cell i's centre is world i * CELL_WORLD_SIZE, and its coord is i + 0.5.
vec2 cellCoordToWorld(vec2 cellCoord) {
  return (cellCoord - CELL_CENTRE_OFFSET_CELLS) * CELL_WORLD_SIZE;
}
// rgb is the band's colour for that row; a is 1 where the row is self-lit.
vec4 bandEntry(int band, float row) {
  int stop = clamp(band - BAND_LUT_MIN_BAND, 0, BAND_LUT_WIDTH - 1);
  return texture(${PALETTE_UNIFORM}, vec2((float(stop) + 0.5) / float(BAND_LUT_WIDTH), row));
}
`;

const VARYINGS_GLSL = `
varying vec3 vTerrainColor;
varying vec2 vFieldCell;
varying float vIsRiser;
varying float vBandFloat;
varying float vSelfLit;
`;

export const GPU_TERRAIN_VERTEX_ATTRIBUTES_GLSL = `
attribute vec2 aCorner;
attribute vec2 aChunk;
`;

const CURTAIN_LEVELS_GLSL = LATTICE_STRIDES.map(
  (stride) => `  lowest = min(lowest, lowestBandAlongEdge(pA, pB, ${stride}));`,
).join('\n');

export const GPU_TERRAIN_VERTEX_HEAD_GLSL = `
${VARYINGS_GLSL}
${COMMON_GLSL}
uniform int ${CLASS_STEPS_UNIFORM};
uniform int ${DRAWS_LAYERED_UNIFORM};
const int KIND_TREAD = ${KIND_TREAD};
const int KIND_RISER = ${KIND_RISER};
const int ROLE_STRIDE = ${ROLE_STRIDE};
const int MAX_CURTAIN_SAMPLES = ${MAX_CURTAIN_SAMPLES};
const int NO_BAND_CEILING = ${NO_BAND_CEILING};
const int NON_TREAD_BAND = ${GPU_TERRAIN_NON_TREAD_BAND};
// Outward horizontal direction of edge e, in cell coordinates.
const vec2 EDGE_OUTWARD[4] =
  vec2[4](vec2(-1.0, 0.0), vec2(0.0, 1.0), vec2(1.0, 0.0), vec2(0.0, -1.0));

// Analytic gradient of the sub-cell's bilinear field, in numerator per sub-cell.
vec2 subcellGradient(int field[4], vec2 local) {
  float f0 = float(field[0]);
  float f1 = float(field[1]);
  float f2 = float(field[2]);
  float f3 = float(field[3]);
  return vec2(mix(f3 - f0, f2 - f1, local.y), mix(f1 - f0, f2 - f3, local.x));
}

// The point where edge e's numerator reaches the threshold, as chordsAt places it.
vec2 edgeCrossing(int edge, int here, int next, int threshold) {
  int num = threshold - here;
  int den = next - here;
  if (den < 0) { num = -num; den = -den; }
  vec2 from = FIELD_CORNER_POS[edge];
  vec2 to = FIELD_CORNER_POS[(edge + 1) % FIELD_CORNERS];
  return from + (to - from) * (float(num) / float(den));
}

bool onChunkBorder(ivec2 subIndex, int edge) {
  int span = int(CHUNK_CELLS * ${SUBDIVISION_UNIFORM} + 0.5);
  int ix = subIndex.x - (subIndex.x / span) * span;
  int iy = subIndex.y - (subIndex.y / span) * span;
  if (edge == 0) return ix == 0;
  if (edge == 1) return iy == span - 1;
  if (edge == 2) return ix == span - 1;
  return iy == 0;
}

// Lowest band a level of lattice that stride can show along the border edge pA-pB.
int lowestBandAlongEdge(ivec2 pA, ivec2 pB, int stride) {
  ivec2 low = min(pA, pB);
  ivec2 high = max(pA, pB);
  ivec2 from = ivec2(
    floorDivPositive(low.x, stride) * stride,
    floorDivPositive(low.y, stride) * stride
  );
  ivec2 advance = ivec2(high.x > low.x ? stride : 0, high.y > low.y ? stride : 0);
  int lowest = NO_BAND_CEILING;
  for (int k = 0; k < MAX_CURTAIN_SAMPLES; k++) {
    ivec2 at = from + advance * k;
    lowest = min(lowest, bandOfNumerator(cornerNumerator(at.x, at.y, FIELD_SAMPLE_TOP, 0)));
    if (at.x >= high.x && at.y >= high.y) break;
  }
  return lowest;
}

// World Y no neighbouring level can draw above, along a chunk-border edge.
float lowestSurfaceAlongEdge(ivec2 pA, ivec2 pB) {
  int lowest = NO_BAND_CEILING;
${CURTAIN_LEVELS_GLSL}
  return float(lowest * FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE;
}
`;

export const GPU_TERRAIN_VERTEX_BODY_GLSL = `
  vec2 subIJ = vec2(position.x, position.z);
  int kind = int(position.y + 0.5);
  int slot = int(aCorner.x + 0.5);
  int packed = int(aCorner.y + 0.5);
  int part = packed / ROLE_STRIDE;
  int role = packed - part * ROLE_STRIDE;

  int stride = LATTICE_N / int(${SUBDIVISION_UNIFORM} + 0.5);
  ivec2 subIndex = ivec2(aChunk * ${SUBDIVISION_UNIFORM} + subIJ + 0.5);
  int lx0 = subIndex.x * stride;
  int ly0 = subIndex.y * stride;
  vec2 originCell = vec2(subIndex) / ${SUBDIVISION_UNIFORM};
  float pitch = 1.0 / ${SUBDIVISION_UNIFORM};

  int field[4];
  subcellField(lx0, ly0, stride, FIELD_SAMPLE_TOP, 0, field);
  int lowBand = fieldLowBand(field);
  int highBand = fieldHighBand(field);
  bool layered = subcellIsLayered(lx0, ly0, stride);

  vec2 local = vec2(0.0);
  float worldY = 0.0;
  vec3 nrm = vec3(0.0, 1.0, 0.0);
  int treadBand = NON_TREAD_BAND;
  vIsRiser = 0.0;
  vBandFloat = 0.0;
  vSelfLit = 0.0;
  vTerrainColor = vec3(1.0);

  // The base pass owns single-threshold sub-cells; the rest go to an overlay class.
  bool mine = layered ? ${DRAWS_LAYERED_UNIFORM} == 1 : highBand - lowBand <= ${CLASS_STEPS_UNIFORM};

  if (mine && layered) {
    // The lattice rule: one settled band, flat across the sub-cell, four skirts.
    int capHeight = drawnGroundHeight(originCell + pitch * 0.5);
    float capY = float(capHeight) * HEIGHT_WORLD_SCALE;
    if (kind == KIND_TREAD && slot == 0 && part < 2) {
      int corner = part == 0
        ? (role == 0 ? 0 : (role == 1 ? 1 : 2))
        : (role == 0 ? 0 : (role == 1 ? 2 : 3));
      local = FIELD_CORNER_POS[corner];
      worldY = capY;
      vec4 capEntry = bandEntry(bandOfHeight(capHeight), ${glslFloat(BAND_LUT_TERRAIN_ROW)});
      vTerrainColor = capEntry.rgb;
      vSelfLit = capEntry.a;
    } else if (kind == KIND_RISER && slot >= 1 && slot <= 2) {
      int edge = (slot - 1) * 2 + part;
      vec2 outward = EDGE_OUTWARD[edge];
      float neighbourY =
        float(drawnGroundHeight(originCell + pitch * 0.5 + outward * pitch)) * HEIGHT_WORLD_SCALE;
      float skirtLow = min(capY, neighbourY);
      if (onChunkBorder(subIndex, edge)) {
        ivec2 pA = ivec2(
          lx0 + int(FIELD_CORNER_POS[edge].x) * stride,
          ly0 + int(FIELD_CORNER_POS[edge].y) * stride
        );
        int nextCorner = (edge + 1) % FIELD_CORNERS;
        ivec2 pB = ivec2(
          lx0 + int(FIELD_CORNER_POS[nextCorner].x) * stride,
          ly0 + int(FIELD_CORNER_POS[nextCorner].y) * stride
        );
        skirtLow = min(skirtLow, lowestSurfaceAlongEdge(pA, pB));
      }
      vec2 p0 = FIELD_CORNER_POS[edge];
      vec2 p1 = FIELD_CORNER_POS[(edge + 1) % FIELD_CORNERS];
      local = (role == 0 || role == 3) ? p0 : p1;
      worldY = role < 2 ? skirtLow : capY;
      nrm = vec3(outward.x, 0.0, outward.y);
      vIsRiser = 1.0;
      vBandFloat = worldY / (float(FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE);
    }
  } else if (mine && kind == KIND_TREAD) {
    int band = lowBand + slot;
    if (band <= highBand) {
      Chords below = noChords();
      Chords above = noChords();
      if (slot != 0) below = chordsAt(field, band);
      if (band != highBand) above = chordsAt(field, band + 1);
      TreadFan fan = treadPieces(field, band, above, below);
      local = treadFanVertex(fan, part, role);
      worldY = float(band * FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE;
      treadBand = band;
      vec4 treadEntry = bandEntry(band, ${glslFloat(BAND_LUT_TERRAIN_ROW)});
      vTerrainColor = treadEntry.rgb;
      vSelfLit = treadEntry.a;
    }
  } else if (mine && kind == KIND_RISER) {
    int band = lowBand + slot;
    Chords chords = noChords();
    if (band <= highBand) chords = chordsAt(field, band);
    if (part < chords.pairCount) {
      vec2 qa = crossingPoint(chords, chords.pairA[part]);
      vec2 qb = crossingPoint(chords, chords.pairB[part]);
      // Winding follows the sub-cell's downhill direction, as the prototype does.
      vec2 mid = (qa + qb) * 0.5;
      vec2 grad = subcellGradient(field, mid);
      vec2 down = length(grad) > 0.0 ? -normalize(grad) : vec2(1.0, 0.0);
      vec2 run = qb - qa;
      if (dot(vec2(-run.y, run.x), down) < 0.0) { vec2 held = qa; qa = qb; qb = held; }
      local = (role == 0 || role == 3) ? qa : qb;
      worldY = float((role < 2 ? band - 1 : band) * FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE;
      vec2 here = subcellGradient(field, local);
      vec2 facing = length(here) > 0.0 ? -normalize(here) : down;
      nrm = vec3(facing.x, 0.0, facing.y);
      vIsRiser = 1.0;
      vBandFloat = worldY / (float(FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE);
    }
  } else if (mine) {
    // Curtain: the tread's arc on a chunk-border edge, dropped to the lowest
    // band the neighbouring level can show there.
    int band = lowBand + slot;
    int edge = part;
    int here = field[edge];
    int next = field[(edge + 1) % FIELD_CORNERS];
    int lowNumerator = min(here, next);
    int highNumerator = max(here, next);
    int thresholdA = band * BAND_BLEND_DENOM;
    int thresholdB = (band + 1) * BAND_BLEND_DENOM;
    bool arc =
      band <= highBand &&
      highNumerator >= thresholdA &&
      lowNumerator < thresholdB &&
      onChunkBorder(subIndex, edge);
    if (arc) {
      vec2 from = FIELD_CORNER_POS[edge];
      vec2 to = FIELD_CORNER_POS[(edge + 1) % FIELD_CORNERS];
      vec2 p0 = lowNumerator >= thresholdA
        ? (next > here ? from : to)
        : edgeCrossing(edge, here, next, thresholdA);
      vec2 p1 = highNumerator < thresholdB
        ? (next > here ? to : from)
        : edgeCrossing(edge, here, next, thresholdB);
      ivec2 pA = ivec2(lx0 + int(from.x) * stride, ly0 + int(from.y) * stride);
      ivec2 pB = ivec2(lx0 + int(to.x) * stride, ly0 + int(to.y) * stride);
      float treadY = float(band * FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE;
      float curtainLow = min(lowestSurfaceAlongEdge(pA, pB), treadY);
      local = (role == 0 || role == 3) ? p0 : p1;
      worldY = role < 2 ? curtainLow : treadY;
      vec2 outward = EDGE_OUTWARD[edge];
      nrm = vec3(outward.x, 0.0, outward.y);
      vIsRiser = 1.0;
      vBandFloat = worldY / (float(FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE);
    }
  }

  vec2 fieldCell = originCell + local * pitch;
  vec2 planar = cellCoordToWorld(fieldCell);
  vec3 pos = vec3(planar.x, worldY, planar.y);
  vFieldCell = fieldCell;
`;

const FRAGMENT_HEAD_GLSL = `
${VARYINGS_GLSL}
${COMMON_GLSL}
vec3 darkenAtEdge(vec3 base, float bands, float pixels) {
  float width = fwidth(bands) * pixels;
  float edge = 1.0 - smoothstep(
    0.0,
    max(width, ${glslFloat(MIN_EDGE_WIDTH)}),
    min(fract(bands), 1.0 - fract(bands))
  );
  return mix(base, base * ${glslFloat(BAND_EDGE_DARKEN)}, edge);
}
`;

const FRAGMENT_COLOR_GLSL = `
  vec3 terrain = vTerrainColor;
  float terrainSelfLit = vSelfLit;
  if (vIsRiser > 0.5) {
    vec4 riserEntry = bandEntry(int(ceil(vBandFloat)), ${glslFloat(BAND_LUT_CLIFF_ROW)});
    terrain = darkenAtEdge(riserEntry.rgb, vBandFloat, ${glslFloat(RISER_LIP_PIXELS)});
    terrainSelfLit = riserEntry.a;
  } else if (${SMOOTH_UNIFORM} > 0.5) {
    float bands = smoothHeight(vFieldCell) / float(FIELD_BAND_HEIGHT);
    vec4 smoothEntry = bandEntry(int(floor(bands)), ${glslFloat(BAND_LUT_TERRAIN_ROW)});
    terrain = darkenAtEdge(smoothEntry.rgb, bands, ${glslFloat(ISOLINE_PIXELS)});
    terrainSelfLit = smoothEntry.a;
  }
  diffuseColor.rgb *= terrain;
`;

const SELF_LIT_FRAGMENT_ANCHOR = '#include <opaque_fragment>';

const SELF_LIT_FRAGMENT_GLSL =
  'outgoingLight = mix( outgoingLight, diffuseColor.rgb, terrainSelfLit );';

export function createGpuTerrainMaterial(
  uniforms: Record<string, IUniform>,
): MeshLambertMaterial {
  const material = new MeshLambertMaterial({ side: DoubleSide });
  material.onBeforeCompile = (shader) => {
    Object.assign(shader.uniforms, uniforms);
    shader.vertexShader = spliceShader(
      spliceShader(
        GPU_TERRAIN_VERTEX_ATTRIBUTES_GLSL + GPU_TERRAIN_VERTEX_HEAD_GLSL + shader.vertexShader,
        '#include <beginnormal_vertex>',
        `${GPU_TERRAIN_VERTEX_BODY_GLSL}\n  vec3 objectNormal = nrm;`,
        MATERIAL_LABEL,
      ),
      '#include <begin_vertex>',
      'vec3 transformed = pos;',
      MATERIAL_LABEL,
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        FRAGMENT_HEAD_GLSL + shader.fragmentShader,
        '#include <color_fragment>',
        FRAGMENT_COLOR_GLSL,
        MATERIAL_LABEL,
      ),
      SELF_LIT_FRAGMENT_ANCHOR,
      `${SELF_LIT_FRAGMENT_GLSL}\n    ${SELF_LIT_FRAGMENT_ANCHOR}`,
      MATERIAL_LABEL,
    );
  };
  material.customProgramCacheKey = () => PROGRAM_CACHE_KEY;
  applyGroundShade(material, MATERIAL_LABEL);
  return material;
}
