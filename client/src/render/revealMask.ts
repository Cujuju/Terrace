import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
  type Material,
} from 'three';
import {
  CELL_WORLD_SIZE,
  CHUNK_SIZE,
  chunksPerEdge,
  chunkIndex,
} from '@terrace/shared';
import type { TerrainMirror } from '../terrain/mirror.ts';
import { applyShaderEffect, glslFloat } from './shaderSplice.ts';

export function revealedAtCell(mirror: TerrainMirror, x: number, y: number): boolean {
  const size = mirror.map.size;
  if (!(x >= 0 && y >= 0 && x < size && y < size)) return false;
  return mirror.received.has(
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
  );
}

export const REVEAL_MASK_RECEIVED_BYTE = 255;

export const REVEAL_CLIP_THRESHOLD = 0.5;

export interface RevealClipUniforms {
  readonly uRevealMask: { value: DataTexture };
  readonly uRevealChunksPerEdge: { value: number };
  readonly uWorldUnitsPerChunk: { value: number };
}

export interface RevealMask {
  uniforms(): RevealClipUniforms;
  sync(mirror: TerrainMirror): void;
  applyRevealClip(material: Material, label: string): void;
  dispose(): void;
}

export const REVEAL_CLIP_UNIFORMS_GLSL = `uniform sampler2D uRevealMask;
uniform float uRevealChunksPerEdge;
uniform float uWorldUnitsPerChunk;
varying vec2 vRevealXZ;
#define REVEAL_CLIP_THRESHOLD ${glslFloat(REVEAL_CLIP_THRESHOLD)}`;

export const REVEAL_CLIP_VERTEX_GLSL = `vRevealXZ = world.xz;`;

export const REVEAL_CLIP_FRAGMENT_GLSL = `vec2 revealUv = vRevealXZ / ( uRevealChunksPerEdge * uWorldUnitsPerChunk );
    if ( any( lessThan( revealUv, vec2( 0.0 ) ) ) || any( greaterThan( revealUv, vec2( 1.0 ) ) ) ) discard;
    if ( texture2D( uRevealMask, revealUv ).r < REVEAL_CLIP_THRESHOLD ) discard;`;

const REVEAL_CLIP_FRAGMENT_ANCHOR = '#include <clipping_planes_fragment>';

const REVEAL_CLIP_EFFECT_KEY = 'revealClip';

function emptyMask(worldSize: number): DataTexture {
  const edge = chunksPerEdge(worldSize);
  const texture = new DataTexture(
    new Uint8Array(edge * edge),
    edge,
    edge,
    RedFormat,
    UnsignedByteType,
  );
  texture.minFilter = LinearFilter;
  texture.magFilter = LinearFilter;
  texture.wrapS = ClampToEdgeWrapping;
  texture.wrapT = ClampToEdgeWrapping;
  texture.needsUpdate = true;
  return texture;
}

export function createRevealMask(worldSize: number): RevealMask {
  const worldUnitsPerChunk = CHUNK_SIZE * CELL_WORLD_SIZE;

  const uniforms: RevealClipUniforms = {
    uRevealMask: { value: emptyMask(worldSize) },
    uRevealChunksPerEdge: { value: chunksPerEdge(worldSize) },
    uWorldUnitsPerChunk: { value: worldUnitsPerChunk },
  };

  return {
    uniforms: () => uniforms,

    sync(mirror: TerrainMirror): void {
      const edge = chunksPerEdge(mirror.map.size);
      if (edge !== uniforms.uRevealChunksPerEdge.value) {
        uniforms.uRevealMask.value.dispose();
        uniforms.uRevealMask.value = emptyMask(mirror.map.size);
        uniforms.uRevealChunksPerEdge.value = edge;
      }
      const texture = uniforms.uRevealMask.value;
      const data = texture.image.data as Uint8Array;
      let changed = false;
      for (let i = 0; i < data.length; i++) {
        const byte = mirror.received.has(i) ? REVEAL_MASK_RECEIVED_BYTE : 0;
        if (data[i] === byte) continue;
        data[i] = byte;
        changed = true;
      }
      if (changed) texture.needsUpdate = true;
    },

    applyRevealClip(material: Material, label: string): void {
      applyShaderEffect(material, {
        key: REVEAL_CLIP_EFFECT_KEY,
        label,
        uniforms: { ...uniforms },
        declarations: () => REVEAL_CLIP_UNIFORMS_GLSL,
        worldPositionVertexGlsl: REVEAL_CLIP_VERTEX_GLSL,
        fragmentAnchor: REVEAL_CLIP_FRAGMENT_ANCHOR,
        fragmentGlsl: REVEAL_CLIP_FRAGMENT_GLSL,
        fragmentInsertion: 'after',
      });
    },

    dispose(): void {
      uniforms.uRevealMask.value.dispose();
    },
  };
}
