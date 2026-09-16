import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  FloatType,
  Mesh,
  NearestFilter,
  RGBAFormat,
  RedFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  type Object3D,
} from 'three';
import { MeshPhysicalNodeMaterial, type UniformNode } from 'three/webgpu';
import {
  diffuseColor,
  float,
  fwidth,
  ivec2,
  max,
  mix,
  positionWorld,
  select,
  texture,
  textureLoad,
  uniform,
  vec2,
  vec3,
} from 'three/tsl';
import {
  CHUNK_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  MAX_BRUSH_RADIUS,
  chunksPerEdge,
  drawnLevelThreshold,
} from '@terrace/shared';
import {
  CELL_WORLD_SIZE,
  SEA_SURFACE_WORLD_Y,
} from '../config.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  WATER_CURVE_BYTES_PER_TEXEL,
  WATER_SELF_LIGHT_RADIANCE,
  WATER_SHADE_FLOOR_MIX,
  WATER_TRENCH_TINT,
  WATER_DEEP_TINT,
  WATER_SHALLOW_TINT,
  createShoreFieldBuffer,
  createWaterCurveBuffer,
  shoreFieldChunkRect,
  writeShoreFieldTexels,
  writeWaterCurveTexels,
} from '../terrain/waterDepth.ts';
import { compose } from './materialSlots.ts';
import { applyGroundShade } from './groundShade.ts';
import { makeBanded } from './water/waterBands.ts';

export const WATER_COLOR = 0x2f6f9e;
const WATER_ROUGHNESS = 0.9;
const WATER_METALNESS = 0;

const VERTICES_PER_CHUNK_QUAD = 4;
const INDICES_PER_CHUNK_QUAD = 6;

export interface Water {
  setWorldSize(worldSize: number): void;
  sync(mirror: TerrainMirror): void;
  refresh(mirror: TerrainMirror, dirty: Iterable<number>): void;
  dispose(): void;
}

function createCurveTexture(worldSize: number): { texture: DataTexture; buffer: Uint8Array } {
  const buffer = createWaterCurveBuffer(worldSize);
  const texture = new DataTexture(buffer, worldSize, worldSize, RGBAFormat, UnsignedByteType);
  texture.generateMipmaps = false;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return { texture, buffer };
}

function createShoreFieldTexture(worldSize: number): { texture: DataTexture; buffer: Float32Array } {
  const buffer = createShoreFieldBuffer(worldSize);
  const texture = new DataTexture(buffer, worldSize, worldSize, RedFormat, FloatType);
  texture.generateMipmaps = false;
  texture.minFilter = NearestFilter;
  texture.magFilter = NearestFilter;
  texture.needsUpdate = true;
  return { texture, buffer };
}

const TEXEL_CENTRE_CELLS = 0.5;

// Land at or above this raw height draws band 0: the shoreline the land caps march.
const SHORE_FIELD_THRESHOLD = drawnLevelThreshold(0) - DRAWN_GROUND_BAND_BIAS;

// Keeps a flat field's zero screen derivative from dividing by zero.
const MIN_SHORE_EDGE_WIDTH = 1e-6;

// The shared drawn field: corner samples blended bilinearly, as drawnCornerNumerator does.
function shoreCoverage(
  fieldTexture: DataTexture,
  worldSizeCells: UniformNode<'float', number>,
) {
  const cell = positionWorld.xz.div(CELL_WORLD_SIZE);
  const corner = cell.floor();
  const t = cell.sub(corner);
  const lastCell = worldSizeCells.sub(1);
  const tap = (dx: number, dz: number) =>
    textureLoad(fieldTexture, ivec2(corner.add(vec2(dx, dz)).clamp(0, lastCell))).r;
  const field = mix(mix(tap(0, 0), tap(1, 0), t.x), mix(tap(0, 1), tap(1, 1), t.x), t.y);
  // Wet below the threshold; one screen pixel of fade on the wet side keeps the exact shore dry.
  const wetDepth = float(SHORE_FIELD_THRESHOLD).sub(field);
  return wetDepth.div(max(fwidth(wetDepth), MIN_SHORE_EDGE_WIDTH)).clamp(0, 1);
}

function tintOf(shadeMix: ReturnType<typeof texture>['b']) {
  const trenchSide = mix(
    vec3(...WATER_TRENCH_TINT),
    vec3(...WATER_DEEP_TINT),
    shadeMix.div(WATER_SHADE_FLOOR_MIX).clamp(0, 1),
  );
  const ordinarySide = mix(
    vec3(...WATER_DEEP_TINT),
    vec3(...WATER_SHALLOW_TINT),
    shadeMix.sub(WATER_SHADE_FLOOR_MIX).div(1 - WATER_SHADE_FLOOR_MIX).clamp(0, 1),
  );
  return select(shadeMix.lessThan(WATER_SHADE_FLOOR_MIX), trenchSide, ordinarySide);
}

function makeDepthAware(
  material: MeshPhysicalNodeMaterial,
  curveTexture: DataTexture,
  fieldTexture: DataTexture,
  worldSizeCells: UniformNode<'float', number>,
): void {
  const depthUv = positionWorld.xz
    .div(CELL_WORLD_SIZE)
    .add(TEXEL_CENTRE_CELLS)
    .div(worldSizeCells);
  const curves = texture(curveTexture, depthUv);
  compose(material, 'color', (previous) => previous.mul(tintOf(curves.b)));
  const coverage = shoreCoverage(fieldTexture, worldSizeCells);
  compose(material, 'opacity', (previous) => previous.mul(curves.r).mul(coverage));
  compose(material, 'emissive', (previous) =>
    previous.add(diffuseColor.rgb.mul(WATER_SELF_LIGHT_RADIANCE)),
  );
  // The GLSL scaled totalSpecular, which has no slot; F0 is the nearest hook.
  material.specularColorNode = vec3(curves.g);
}

export interface WaterOptions {}

export const WATER_DRAW_OBJECTS = 1;

const MAX_BRUSH_FOOTPRINT_CHUNKS =
  (Math.ceil((MAX_BRUSH_RADIUS * 2 + 1) / CHUNK_SIZE) + 1) ** 2;
const COALESCED_SCULPT_STEPS = 4;
const MAX_RANGED_REFRESH_CHUNKS = MAX_BRUSH_FOOTPRINT_CHUNKS * COALESCED_SCULPT_STEPS;

export function createWater(
  parent: Object3D,
  initialWorldSize: number,
  options: WaterOptions = {},
): Water {
  const { texture: curveTexture, buffer: initialCurveBuffer } =
    createCurveTexture(initialWorldSize);
  let curveBuffer = initialCurveBuffer;
  const { texture: fieldTexture, buffer: initialFieldBuffer } =
    createShoreFieldTexture(initialWorldSize);
  let fieldBuffer = initialFieldBuffer;
  const worldSizeCells = uniform(initialWorldSize);
  const dirtyChunkScratch: number[] = [];

  const material = new MeshPhysicalNodeMaterial({
    color: WATER_COLOR,
    transparent: true,
    roughness: WATER_ROUGHNESS,
    metalness: WATER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
  });
  makeDepthAware(material, curveTexture, fieldTexture, worldSizeCells);
  applyGroundShade(material, 'water');
  makeBanded(material);

  const geometry = new BufferGeometry();
  const mesh = new Mesh(geometry, material);
  mesh.visible = false;
  parent.add(mesh);
  const surfaceY = SEA_SURFACE_WORLD_Y;

  let quadCapacity = 0;
  let positions = new Float32Array(0);
  let normals = new Float32Array(0);
  let indices = new Uint32Array(0);

  const growTo = (quads: number): void => {
    if (quads <= quadCapacity) return;
    let capacity = quadCapacity === 0 ? 1 : quadCapacity;
    while (capacity < quads) capacity *= 2;
    quadCapacity = capacity;
    positions = new Float32Array(capacity * VERTICES_PER_CHUNK_QUAD * 3);
    normals = new Float32Array(capacity * VERTICES_PER_CHUNK_QUAD * 3);
    indices = new Uint32Array(capacity * INDICES_PER_CHUNK_QUAD);
    for (let vertex = 0; vertex < capacity * VERTICES_PER_CHUNK_QUAD; vertex++) {
      normals[vertex * 3 + 1] = 1;
    }
    for (let quad = 0; quad < capacity; quad++) {
      const v = quad * VERTICES_PER_CHUNK_QUAD;
      const i = quad * INDICES_PER_CHUNK_QUAD;
      indices[i] = v;
      indices[i + 1] = v + 2;
      indices[i + 2] = v + 1;
      indices[i + 3] = v + 1;
      indices[i + 4] = v + 2;
      indices[i + 5] = v + 3;
    }
    geometry.dispose();
    geometry.setAttribute('position', new BufferAttribute(positions, 3));
    geometry.setAttribute('normal', new BufferAttribute(normals, 3));
    geometry.setIndex(new BufferAttribute(indices, 1));
  };

  const setWorldSize = (worldSize: number): void => {
    curveBuffer = createWaterCurveBuffer(worldSize);
    curveTexture.image = { data: curveBuffer, width: worldSize, height: worldSize };
    curveTexture.clearUpdateRanges();
    curveTexture.needsUpdate = true;
    fieldBuffer = createShoreFieldBuffer(worldSize);
    fieldTexture.image = { data: fieldBuffer, width: worldSize, height: worldSize };
    fieldTexture.clearUpdateRanges();
    fieldTexture.needsUpdate = true;
    worldSizeCells.value = worldSize;
  };

  setWorldSize(initialWorldSize);

  return {
    setWorldSize,
    sync(mirror: TerrainMirror): void {
      const chunkCols = chunksPerEdge(mirror.map.size);
      const chunkWorldSpan = CHUNK_SIZE * CELL_WORLD_SIZE;
      growTo(mirror.received.size);
      let quad = 0;
      let minX = Infinity;
      let minZ = Infinity;
      let maxX = -Infinity;
      let maxZ = -Infinity;
      for (const chunkIdx of [...mirror.received].sort((a, b) => a - b)) {
        const x0 = (chunkIdx % chunkCols) * chunkWorldSpan;
        const z0 = Math.floor(chunkIdx / chunkCols) * chunkWorldSpan;
        const x1 = x0 + chunkWorldSpan;
        const z1 = z0 + chunkWorldSpan;
        const v = quad * VERTICES_PER_CHUNK_QUAD * 3;
        positions[v] = x0; positions[v + 1] = surfaceY; positions[v + 2] = z0;
        positions[v + 3] = x1; positions[v + 4] = surfaceY; positions[v + 5] = z0;
        positions[v + 6] = x0; positions[v + 7] = surfaceY; positions[v + 8] = z1;
        positions[v + 9] = x1; positions[v + 10] = surfaceY; positions[v + 11] = z1;
        if (x0 < minX) minX = x0;
        if (z0 < minZ) minZ = z0;
        if (x1 > maxX) maxX = x1;
        if (z1 > maxZ) maxZ = z1;
        quad++;
      }
      const positionAttribute = geometry.getAttribute('position') as BufferAttribute | undefined;
      if (positionAttribute) positionAttribute.needsUpdate = true;
      geometry.setDrawRange(0, quad * INDICES_PER_CHUNK_QUAD);
      if (quad === 0) {
        mesh.visible = false;
        return;
      }
      const centreX = (minX + maxX) / 2;
      const centreZ = (minZ + maxZ) / 2;
      geometry.boundingSphere = new Sphere(
        new Vector3(centreX, surfaceY, centreZ),
        Math.hypot(maxX - centreX, maxZ - centreZ),
      );
      geometry.boundingBox = new Box3(
        new Vector3(minX, surfaceY, minZ),
        new Vector3(maxX, surfaceY, maxZ),
      );
      mesh.visible = quad > 0;
    },
    refresh(mirror: TerrainMirror, dirty: Iterable<number>): void {
      dirtyChunkScratch.length = 0;
      for (const chunkIdx of dirty) dirtyChunkScratch.push(chunkIdx);
      if (dirtyChunkScratch.length === 0) return;
      const worldSize = worldSizeCells.value;
      writeWaterCurveTexels(curveBuffer, worldSize, mirror, dirtyChunkScratch);
      writeShoreFieldTexels(fieldBuffer, worldSize, mirror, dirtyChunkScratch);
      if (dirtyChunkScratch.length > MAX_RANGED_REFRESH_CHUNKS) {
        curveTexture.clearUpdateRanges();
        fieldTexture.clearUpdateRanges();
      } else {
        const chunkCols = chunksPerEdge(worldSize);
        for (const chunkIdx of dirtyChunkScratch) {
          const x0 = (chunkIdx % chunkCols) * CHUNK_SIZE;
          const y0 = Math.floor(chunkIdx / chunkCols) * CHUNK_SIZE;
          for (let y = y0; y < y0 + CHUNK_SIZE; y++) {
            curveTexture.addUpdateRange(
              (y * worldSize + x0) * WATER_CURVE_BYTES_PER_TEXEL,
              CHUNK_SIZE * WATER_CURVE_BYTES_PER_TEXEL,
            );
          }
          const rect = shoreFieldChunkRect(worldSize, chunkIdx);
          for (let y = rect.y0; y <= rect.y1; y++) {
            fieldTexture.addUpdateRange(y * worldSize + rect.x0, rect.x1 - rect.x0 + 1);
          }
        }
      }
      curveTexture.needsUpdate = true;
      fieldTexture.needsUpdate = true;
    },
    dispose(): void {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      curveTexture.dispose();
      fieldTexture.dispose();
    },
  };
}
