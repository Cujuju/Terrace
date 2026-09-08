import {
  Box3,
  BufferAttribute,
  BufferGeometry,
  DataTexture,
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  NearestFilter,
  RGBAFormat,
  Sphere,
  UnsignedByteType,
  Vector3,
  type Object3D,
} from 'three';
import {
  CHUNK_SIZE,
  MAX_BRUSH_RADIUS,
  chunksPerEdge,
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
  createWaterCurveBuffer,
  writeWaterCurveTexels,
} from '../terrain/waterDepth.ts';
import { spliceShader } from './shaderSplice.ts';
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

function glslFloat(value: number): string {
  return value.toFixed(6);
}

function glslVec3(value: readonly [number, number, number]): string {
  return `vec3( ${value.map(glslFloat).join(', ')} )`;
}

function makeDepthAware(
  material: MeshStandardMaterial,
  curveTexture: DataTexture,
  worldSizeUniform: { value: number },
): void {
  material.onBeforeCompile = (shader) => {
    shader.uniforms.uWaterCurves = { value: curveTexture };
    shader.uniforms.uWorldSizeCells = worldSizeUniform;
    shader.vertexShader = spliceShader(
      spliceShader(
        shader.vertexShader,
        '#include <common>',
        '#include <common>\nvarying vec2 vWaterCellXZ;',
        'water',
      ),
      '#include <begin_vertex>',
      `#include <begin_vertex>\nvWaterCellXZ = ( modelMatrix * vec4( transformed, 1.0 ) ).xz / ${glslFloat(CELL_WORLD_SIZE)};`,
      'water',
    );
    shader.fragmentShader = spliceShader(
      spliceShader(
        spliceShader(
          shader.fragmentShader,
          '#include <common>',
          '#include <common>\nvarying vec2 vWaterCellXZ;\nuniform sampler2D uWaterCurves;\nuniform float uWorldSizeCells;',
          'water',
        ),
        'vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;',
        'vec3 totalSpecular = reflectedLight.directSpecular + reflectedLight.indirectSpecular;\ntotalSpecular *= texture2D( uWaterCurves, wDepthUv ).g;',
        'water',
      ),
      '#include <color_fragment>',
      [
        '#include <color_fragment>',
        'vec2 wDepthUv = ( vWaterCellXZ + 0.5 ) / uWorldSizeCells;',
        'float wDepthAlpha = texture2D( uWaterCurves, wDepthUv ).r;',
        'float wShadeMix = texture2D( uWaterCurves, wDepthUv ).b;',
        `float wFloorMix = ${glslFloat(WATER_SHADE_FLOOR_MIX)};`,
        `vec3 wTrenchSide = mix( ${glslVec3(WATER_TRENCH_TINT)}, ${glslVec3(
          WATER_DEEP_TINT,
        )}, clamp( wShadeMix / wFloorMix, 0.0, 1.0 ) );`,
        `vec3 wOrdinarySide = mix( ${glslVec3(WATER_DEEP_TINT)}, ${glslVec3(
          WATER_SHALLOW_TINT,
        )}, clamp( ( wShadeMix - wFloorMix ) / ( 1.0 - wFloorMix ), 0.0, 1.0 ) );`,
        'diffuseColor.rgb *= wShadeMix < wFloorMix ? wTrenchSide : wOrdinarySide;',
      ].join('\n'),
      'water',
    );
    shader.fragmentShader = spliceShader(
      shader.fragmentShader,
      '#include <emissivemap_fragment>',
      `#include <emissivemap_fragment>\ntotalEmissiveRadiance += diffuseColor.rgb * ${glslFloat(
        WATER_SELF_LIGHT_RADIANCE,
      )};`,
      'water',
    );
    shader.fragmentShader = spliceShader(
      shader.fragmentShader,
      '#include <opaque_fragment>',
      'diffuseColor.a *= wDepthAlpha;\n#include <opaque_fragment>',
      'water',
    );
  };
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
  const worldSizeUniform = { value: initialWorldSize };
  const dirtyChunkScratch: number[] = [];

  const material = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    roughness: WATER_ROUGHNESS,
    metalness: WATER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
  });
  makeDepthAware(material, curveTexture, worldSizeUniform);
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
    worldSizeUniform.value = worldSize;
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
      const worldSize = worldSizeUniform.value;
      writeWaterCurveTexels(curveBuffer, worldSize, mirror, dirtyChunkScratch);
      if (dirtyChunkScratch.length > MAX_RANGED_REFRESH_CHUNKS) {
        curveTexture.clearUpdateRanges();
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
        }
      }
      curveTexture.needsUpdate = true;
    },
    dispose(): void {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
      curveTexture.dispose();
    },
  };
}
