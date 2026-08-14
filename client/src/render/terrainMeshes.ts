// Per-chunk terrain meshes and the in-place vertex patch path.
//
// CRITICAL CODE — this is the client performance contract (design doc §8):
// "mesh updates must patch vertex buffers in place — never rebuild geometry
// per edit". A chunk's BufferGeometry, its attributes and their backing
// Float32Arrays are allocated once, when the chunk's data first arrives, and
// live until the world is replaced. Applying a terrain diff rewrites the
// affected chunks' position/colour arrays and flips `needsUpdate`; it never
// touches the index buffer, never allocates, and never re-adds anything to the
// scene graph.
//
// DRAW-CALL TRADEOFF, known and accepted for v1: one mesh per 16×16 chunk
// means a fully revealed 512² world would be 1024 draw calls. That is a lot,
// but (a) worlds start with a handful of unlocked chunks and grow slowly by
// design (§3.4), and (b) per-chunk meshes are what make streaming and
// locked-chunk omission trivial — a chunk we have never received simply has no
// mesh, so it cannot be drawn, picked, or peeked at. The Phase 2+ fix, if
// measurement demands one, is to merge chunks into larger super-meshes (or one
// buffer with per-chunk sub-ranges) while keeping the same patch path; nothing
// outside this file depends on the one-mesh-per-chunk choice.

import {
  BufferAttribute,
  BufferGeometry,
  Color,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  SRGBColorSpace,
  type Group,
} from 'three';
import { chunksPerEdge } from '@terrace/shared';
import { TERRAIN_PALETTE, type Rgb } from '../terrain/bandColors.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  CHUNK_VERTEX_COUNT,
  buildChunkIndices,
  createChunkColorBuffer,
  createChunkPositionBuffer,
  writeChunkVertexData,
} from '../terrain/vertexGrid.ts';

/** Terrain is dielectric; a little roughness variation is not worth a map. */
const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/**
 * Three's working colour space is linear; the palette in bandColors.ts is
 * sRGB (that is how the hex values were chosen). Converting the nine palette
 * entries ONCE here, rather than per vertex per patch, is the whole reason
 * bandColors separates "which entry" from "the entry".
 */
function toLinearPalette(palette: readonly Rgb[]): readonly Rgb[] {
  const scratch = new Color();
  return palette.map((entry) => {
    scratch.setRGB(entry[0], entry[1], entry[2], SRGBColorSpace);
    return [scratch.r, scratch.g, scratch.b] as Rgb;
  });
}

interface ChunkMesh {
  mesh: Mesh;
  positions: Float32Array;
  colors: Float32Array;
  positionAttribute: BufferAttribute;
  colorAttribute: BufferAttribute;
}

export interface TerrainMeshes {
  /**
   * Creates any missing meshes and re-patches the given chunks. Indices for
   * chunks the mirror has not received are ignored — that is the mechanism by
   * which locked terrain stays invisible.
   */
  update(dirty: Iterable<number>): void;
  /** Drops every mesh — used when a fresh join replaces the world. */
  clear(): void;
  /** Meshes the raycaster should test. */
  pickables(): Mesh[];
  dispose(): void;
}

export function createTerrainMeshes(
  group: Group,
  mirror: TerrainMirror,
): TerrainMeshes {
  const worldSize = mirror.map.size;
  const chunkCols = chunksPerEdge(worldSize);
  const linearPalette = toLinearPalette(TERRAIN_PALETTE);

  // Every chunk has identical topology, so one index attribute and one
  // (constant, upward) normal attribute are shared by all of them. The normals
  // are never recomputed after an edit and never need to be: the material is
  // flat-shaded, and Three's FLAT_SHADED path derives the face normal from
  // screen-space derivatives in the fragment shader, ignoring this attribute.
  // It exists only so the shader's `normal` input is bound.
  const sharedIndex = new BufferAttribute(buildChunkIndices(), 1);
  const upwardNormals = new Float32Array(CHUNK_VERTEX_COUNT * 3);
  for (let v = 1; v < upwardNormals.length; v += 3) upwardNormals[v] = 1;
  const sharedNormals = new BufferAttribute(upwardNormals, 3);

  const material = new MeshStandardMaterial({
    vertexColors: true,
    flatShading: true,
    roughness: TERRAIN_ROUGHNESS,
    metalness: TERRAIN_METALNESS,
    // Terrain is a closed-ish surface but the camera can dip toward the
    // horizon and see the underside of a far terrace; DoubleSide costs nothing
    // here (no shadows, no transparency) and avoids the holes that would show.
    side: DoubleSide,
  });

  const meshes = new Map<number, ChunkMesh>();

  const createChunkMesh = (chunkIdx: number): ChunkMesh => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;

    const positions = createChunkPositionBuffer();
    const colors = createChunkColorBuffer();
    writeChunkVertexData(mirror, cx, cy, positions, colors, linearPalette);

    const positionAttribute = new BufferAttribute(positions, 3);
    const colorAttribute = new BufferAttribute(colors, 3);
    // Both attributes are rewritten on every edit that touches this chunk.
    positionAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setAttribute('normal', sharedNormals);
    geometry.setIndex(sharedIndex);
    geometry.computeBoundingSphere();

    const mesh = new Mesh(geometry, material);
    group.add(mesh);

    return { mesh, positions, colors, positionAttribute, colorAttribute };
  };

  const patch = (chunkIdx: number, entry: ChunkMesh): void => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;
    // In place: same arrays, same attributes, same geometry, same mesh.
    writeChunkVertexData(mirror, cx, cy, entry.positions, entry.colors, linearPalette);
    entry.positionAttribute.needsUpdate = true;
    entry.colorAttribute.needsUpdate = true;
    // Heights changed, so the culling/raycast bound is stale. O(vertices) on
    // 289 vertices — cheap, and skipping it makes edited chunks vanish at
    // certain camera angles and stop being clickable.
    entry.mesh.geometry.computeBoundingSphere();
  };

  const disposeEntry = (entry: ChunkMesh): void => {
    group.remove(entry.mesh);
    // Disposing a geometry releases the GPU buffers of every attribute it
    // holds, including the shared index/normal ones. That is safe here because
    // meshes are only ever removed by clear(), which removes ALL of them at
    // once and is followed by a whole new TerrainMeshes instance with its own
    // shared attributes — no surviving mesh is left pointing at a released
    // buffer. (Three would re-upload one anyway; this just avoids the churn.)
    entry.mesh.geometry.dispose();
  };

  const clear = (): void => {
    for (const entry of meshes.values()) disposeEntry(entry);
    meshes.clear();
  };

  return {
    update(dirty: Iterable<number>): void {
      for (const chunkIdx of dirty) {
        if (!mirror.received.has(chunkIdx)) continue;
        const existing = meshes.get(chunkIdx);
        if (existing === undefined) {
          meshes.set(chunkIdx, createChunkMesh(chunkIdx));
        } else {
          patch(chunkIdx, existing);
        }
      }
    },
    clear,
    pickables(): Mesh[] {
      return Array.from(meshes.values(), (entry) => entry.mesh);
    },
    dispose(): void {
      clear();
      material.dispose();
    },
  };
}
