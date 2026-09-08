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

const KIND_CAP = 0;
const KIND_SKIRT_X = 1;
const KIND_SKIRT_Z = 2;
const KIND_LOW_EDGE_X = 3;
const KIND_LOW_EDGE_Z = 4;
const QUAD_KINDS = [KIND_CAP, KIND_SKIRT_X, KIND_SKIRT_Z] as const;
const LOW_EDGE_KINDS = [KIND_LOW_EDGE_X, KIND_LOW_EDGE_Z] as const;

const CORNERS_PER_QUAD = 4;
const INDICES_PER_QUAD = 6;
const TRIANGLES_PER_QUAD = 2;

/** Subdivisions a chunk can be drawn at; a boundary wall must reach any of them. */
const LOD_LEVELS = [TERRAIN_LOD_NEAR_N, TERRAIN_LOD_FAR_N] as const;

/** Far-side caps one wall can face, when the far side is the finest level. */
const MAX_BOUNDARY_SAMPLES = Math.ceil(Math.max(...LOD_LEVELS) / Math.min(...LOD_LEVELS));

/** Riser-lip width in device pixels, standing in for the LineSegments overlay. */
const RISER_LIP_PIXELS = 1.4;

/** Band-edge isoline width in device pixels, for the smooth-terrace variant. */
const ISOLINE_PIXELS = 1.2;

/** How far a band edge darkens the surface under it. */
const BAND_EDGE_DARKEN = 0.45;

/** Floor on a screen-space edge width, so a flat-on surface keeps a hairline. */
const MIN_EDGE_WIDTH = 1e-5;

const MATERIAL_LABEL = 'gpu terrain';

const PROGRAM_CACHE_KEY = 'terrace-gpu-terrain';

export interface ChunkTemplate {
  readonly geometry: InstancedBufferGeometry;
  readonly trianglesPerChunk: number;
}

export function createChunkTemplate(subdivision: number): ChunkTemplate {
  const span = CHUNK_SIZE * subdivision;
  const subCells = span * span;
  const quads = subCells * QUAD_KINDS.length + span * LOW_EDGE_KINDS.length;
  const lattice = new Float32Array(quads * CORNERS_PER_QUAD * 3);
  const corners = new Float32Array(quads * CORNERS_PER_QUAD * 2);
  const indices = new Uint32Array(quads * INDICES_PER_QUAD);
  let vertex = 0;
  let cursor = 0;
  const push = (i: number, j: number, kind: number, cu: number, cv: number): number => {
    lattice[vertex * 3] = i;
    lattice[vertex * 3 + 1] = kind;
    lattice[vertex * 3 + 2] = j;
    corners[vertex * 2] = cu;
    corners[vertex * 2 + 1] = cv;
    return vertex++;
  };
  const quad = (i: number, j: number, kind: number): void => {
    const base = push(i, j, kind, 0, 0);
    push(i, j, kind, 1, 0);
    push(i, j, kind, 1, 1);
    push(i, j, kind, 0, 1);
    indices[cursor++] = base;
    indices[cursor++] = base + 1;
    indices[cursor++] = base + 2;
    indices[cursor++] = base;
    indices[cursor++] = base + 2;
    indices[cursor++] = base + 3;
  };
  for (let j = 0; j < span; j++) {
    for (let i = 0; i < span; i++) {
      for (const kind of QUAD_KINDS) quad(i, j, kind);
    }
  }
  // A sub-cell's skirt sits at its high edge, so the chunk's low edges get their own.
  for (let k = 0; k < span; k++) {
    quad(0, k, KIND_LOW_EDGE_X);
    quad(k, 0, KIND_LOW_EDGE_Z);
  }
  const geometry = new InstancedBufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(lattice, 3));
  geometry.setAttribute('aCorner', new BufferAttribute(corners, 2));
  geometry.setIndex(new BufferAttribute(indices, 1));
  return { geometry, trianglesPerChunk: quads * TRIANGLES_PER_QUAD };
}

const COMMON_GLSL = `
uniform sampler2D uPalette;
uniform float uSubdiv;
uniform float uSmooth;
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
  return texture(uPalette, vec2((float(stop) + 0.5) / float(BAND_LUT_WIDTH), row));
}
`;

const VARYINGS_GLSL = `
varying vec3 vTerrainColor;
varying vec2 vFieldCell;
varying float vIsRiser;
varying float vBandFloat;
varying float vSelfLit;
`;

const BOUNDARY_LEVELS_GLSL = LOD_LEVELS.map(
  (level) => `      lowest = min(lowest, lowestCapAtLevel(face, away, crossDir, ${glslFloat(level)}));`,
).join('\n');

const VERTEX_HEAD_GLSL = `
attribute vec2 aCorner;
attribute vec2 aChunk;
${VARYINGS_GLSL}
${COMMON_GLSL}
const int MAX_BOUNDARY_SAMPLES = ${MAX_BOUNDARY_SAMPLES};
// Lowest cap a neighbour drawn at this level could put against this wall's span.
float lowestCapAtLevel(vec2 face, vec2 away, vec2 crossDir, float level) {
  float pitch = 1.0 / level;
  float across = dot(face, crossDir);
  float first = floor((across - 0.5 / uSubdiv) * level) * pitch + 0.5 * pitch;
  vec2 origin = face + away * (0.5 * pitch) + crossDir * (first - across);
  int count = int(max(1.0, level / uSubdiv));
  float lowest = float(drawnGroundHeight(origin)) * HEIGHT_WORLD_SCALE;
  for (int k = 1; k < MAX_BOUNDARY_SAMPLES; k++) {
    if (k >= count) break;
    vec2 at = origin + crossDir * (pitch * float(k));
    lowest = min(lowest, float(drawnGroundHeight(at)) * HEIGHT_WORLD_SCALE);
  }
  return lowest;
}
`;

const VERTEX_BODY_GLSL = `
  vec2 subIJ = vec2(position.x, position.z);
  float kind = position.y;
  vec2 centre = aChunk + (subIJ + 0.5) / uSubdiv;
  int heightHere = drawnGroundHeight(centre);
  vec3 pos;
  vec3 nrm;
  vIsRiser = 0.0;
  vBandFloat = 0.0;
  vSelfLit = 0.0;
  if (kind < 0.5) {
    vec2 corner = aChunk + (subIJ + aCorner.yx) / uSubdiv;
    vec2 capXZ = cellCoordToWorld(corner);
    pos = vec3(capXZ.x, float(heightHere) * HEIGHT_WORLD_SCALE, capXZ.y);
    nrm = vec3(0.0, 1.0, 0.0);
    vFieldCell = corner;
    vec4 capEntry = bandEntry(bandOfHeight(heightHere), ${glslFloat(BAND_LUT_TERRAIN_ROW)});
    vTerrainColor = capEntry.rgb;
    vSelfLit = capEntry.a;
  } else {
    float lowEdge = kind > ${glslFloat((KIND_SKIRT_Z + KIND_LOW_EDGE_X) / 2)} ? 1.0 : 0.0;
    float axis = kind - float(${KIND_SKIRT_X}) - float(${KIND_LOW_EDGE_X - KIND_SKIRT_X}) * lowEdge;
    vec2 stepDir = axis < 0.5 ? vec2(1.0, 0.0) : vec2(0.0, 1.0);
    float outward = lowEdge > 0.5 ? -1.0 : 1.0;
    vec2 away = stepDir * outward;
    float yHere = float(heightHere) * HEIGHT_WORLD_SCALE;
    float yLo;
    float yHi;
    float facing;
    if (lowEdge > 0.5 || dot(subIJ, stepDir) > CHUNK_CELLS * uSubdiv - 1.5) {
      // The wall hangs from this chunk's own cap, so it never rises above the ground.
      vec2 crossDir = vec2(stepDir.y, stepDir.x);
      vec2 face = centre + away * (0.5 / uSubdiv);
      float lowest = yHere;
${BOUNDARY_LEVELS_GLSL}
      yLo = lowest;
      yHi = yHere;
      facing = outward;
    } else {
      float yNext = float(drawnGroundHeight(centre + away / uSubdiv)) * HEIGHT_WORLD_SCALE;
      yLo = min(yHere, yNext);
      yHi = max(yHere, yNext);
      facing = yHere > yNext ? 1.0 : -1.0;
    }
    float along = axis < 0.5
      ? (facing > 0.0 ? 1.0 - aCorner.x : aCorner.x)
      : (facing > 0.0 ? aCorner.x : 1.0 - aCorner.x);
    vec2 edge =
      aChunk + (subIJ + stepDir * (1.0 - lowEdge) + along * (1.0 - stepDir)) / uSubdiv;
    float y = mix(yLo, yHi, aCorner.y);
    vec2 wall = cellCoordToWorld(edge);
    pos = vec3(wall.x, y, wall.y);
    nrm = vec3(stepDir.x * facing, 0.0, stepDir.y * facing);
    vFieldCell = edge;
    vBandFloat = y / (float(FIELD_BAND_HEIGHT) * HEIGHT_WORLD_SCALE);
    vIsRiser = 1.0;
    vTerrainColor = vec3(1.0);
  }
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
  } else if (uSmooth > 0.5) {
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
        VERTEX_HEAD_GLSL + shader.vertexShader,
        '#include <beginnormal_vertex>',
        `${VERTEX_BODY_GLSL}\n  vec3 objectNormal = nrm;`,
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
