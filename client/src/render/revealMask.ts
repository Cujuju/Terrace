import {
  ClampToEdgeWrapping,
  DataTexture,
  LinearFilter,
  RedFormat,
  UnsignedByteType,
} from 'three';
import type { NodeMaterial } from 'three/webgpu';
import { compose, discard } from './materialSlots.ts';
import { float, positionWorld, smoothstep, texture, uniform } from 'three/tsl';
import {
  CELL_WORLD_SIZE,
  CHUNK_SIZE,
  chunksPerEdge,
  chunkIndex,
} from '@terrace/shared';
import type { TerrainMirror } from '../terrain/mirror.ts';

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
  applyRevealClip(material: NodeMaterial, label: string): void;
  dispose(): void;
}

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
  const maskNode = texture(uniforms.uRevealMask.value);
  const spanNode = uniform(uniforms.uRevealChunksPerEdge.value * worldUnitsPerChunk);

  return {
    uniforms: () => uniforms,

    sync(mirror: TerrainMirror): void {
      const edge = chunksPerEdge(mirror.map.size);
      if (edge !== uniforms.uRevealChunksPerEdge.value) {
        uniforms.uRevealMask.value.dispose();
        uniforms.uRevealMask.value = emptyMask(mirror.map.size);
        uniforms.uRevealChunksPerEdge.value = edge;
        maskNode.value = uniforms.uRevealMask.value;
        spanNode.value = edge * worldUnitsPerChunk;
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

    applyRevealClip(material: NodeMaterial, label: string): void {
      material.name = label;
      const revealUv = positionWorld.xz.div(spanNode);
      // One chunk inside the world border, in reveal-UV units: the sky feathers out
      // over the rim instead of slicing where a disc overhangs the map edge.
      const feather = float(worldUnitsPerChunk).div(spanNode);
      const edgeX = smoothstep(0, feather, revealUv.x).mul(
        float(1).sub(smoothstep(float(1).sub(feather), 1, revealUv.x)),
      );
      const edgeY = smoothstep(0, feather, revealUv.y).mul(
        float(1).sub(smoothstep(float(1).sub(feather), 1, revealUv.y)),
      );
      compose(material, 'opacity', (previous) => previous.mul(edgeX.mul(edgeY)));
      discard(material, maskNode.sample(revealUv).r.lessThan(REVEAL_CLIP_THRESHOLD));
      material.needsUpdate = true;
    },

    dispose(): void {
      uniforms.uRevealMask.value.dispose();
    },
  };
}
