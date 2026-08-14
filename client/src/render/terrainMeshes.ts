// Per-chunk terrain meshes and the in-place vertex patch path.
//
// CRITICAL CODE — this is the client performance contract (design doc §8):
// "mesh updates must patch vertex buffers in place — never rebuild geometry
// per edit". A chunk's BufferGeometry, its attributes and their backing
// Float32Arrays are allocated once, when the chunk's data first arrives, and
// live until the world is replaced. Applying a terrain diff rewrites the
// affected chunks' position/normal/colour arrays and flips `needsUpdate`; it
// never touches the index buffer, never allocates, and never re-adds anything
// to the scene graph.
//
// VARIABLE GEOMETRY, FIXED BUFFERS. Since the terraced surface grew true
// vertical cliffs (terrain/vertexGrid.ts) a chunk's quad count is no longer
// constant: it is 256 top faces plus one wall per edge whose two cells sit in
// different bands, so it moves every time somebody sculpts. Two ways to carry
// that, and this module takes the first:
//
//   CHOSEN — preallocate the worst case and draw a prefix. Buffers are sized
//   for MAX_QUADS_PER_CHUNK (768 quads = 3072 vertices), the emitted quads are
//   packed from slot 0, and `setDrawRange(0, indexCount)` cuts the unused tail.
//   A patch is then pure array writes: no allocation, no attribute or geometry
//   objects created, no GPU buffer deleted and recreated. Cost per patch is
//   ~37k float stores (≈3072 vertices × 9 components, plus collapsing the
//   tail) — tens of microseconds. A held sculpt fires an intent every
//   SCULPT_REPEAT_INTERVAL_MS (≈8/s) and each one dirties a handful of chunks,
//   so the whole steady-state load is well under a tenth of one 16.6 ms frame,
//   and it produces no garbage for the collector to trip over mid-stroke.
//
//   REJECTED — rebuild the chunk's BufferGeometry on patch. It would size
//   exactly to the terrain, but it allocates three typed arrays, three
//   BufferAttributes and a BufferGeometry per patched chunk per intent, and
//   disposing the old geometry makes the driver delete and recreate that
//   chunk's GPU buffers ~30 times a second during a held stroke. That is
//   precisely the churn the §8 no-rebuild rule exists to forbid, and the
//   frame-time cost of a driver-side buffer respec is exactly the kind of
//   spike that shows up as a stutter under a held brush rather than as a lower
//   average frame rate.
//
//   MEMORY, known and accepted: 3072 vertices × 3 attributes × 3 components ×
//   4 bytes = 108 KB per chunk, against ~7 KB for the Phase 1 vertex grid. A
//   fully revealed 512² world (1024 chunks) would hold ~108 MB of terrain
//   attributes. That is the PATHOLOGICAL bound — it assumes every cell in the
//   world differs in band from both of its neighbours — and it lands at the
//   same world scale where §8 already accepts 1024 draw calls. If measurement
//   ever demands it, the fix is per-chunk capacity that grows on demand
//   (chunks that hold few walls keep small buffers, and only a chunk that
//   outgrows its capacity reallocates, which is rare and not on the hot path);
//   dropping the normal attribute, which flat shading ignores, would recover
//   another third. Neither is needed at the scales worlds actually run at.
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
import { CLIFF_PALETTE, TERRAIN_PALETTE, type Rgb } from '../terrain/bandColors.ts';
import type { TerrainMirror } from '../terrain/mirror.ts';
import {
  buildChunkIndices,
  createChunkGeometryBuffers,
  writeChunkVertexData,
  type ChunkGeometryBuffers,
  type ChunkPalettes,
} from '../terrain/vertexGrid.ts';

/** Terrain is dielectric; a little roughness variation is not worth a map. */
const TERRAIN_ROUGHNESS = 0.95;
const TERRAIN_METALNESS = 0;

/**
 * Three's working colour space is linear; the palettes in bandColors.ts are
 * sRGB (that is how the hex values were chosen). Converting the nine palette
 * entries ONCE here, rather than per vertex per patch, is the whole reason
 * bandColors separates "which entry" from "the entry". The cliff ramp goes
 * through the same door: it is derived from the top ramp in sRGB (where the
 * darken factor was judged by eye) and converted here, never per face.
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
  buffers: ChunkGeometryBuffers;
  positionAttribute: BufferAttribute;
  normalAttribute: BufferAttribute;
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
  const palettes: ChunkPalettes = {
    top: toLinearPalette(TERRAIN_PALETTE),
    cliff: toLinearPalette(CLIFF_PALETTE),
  };

  // Quad k always owns vertices 4k..4k+3 in every chunk in every world state,
  // so the index buffer is world-independent and one attribute serves every
  // mesh. A chunk with fewer quads narrows its draw range instead of owning
  // its own indices.
  //
  // Normals, unlike Phase 1's, are NOT shared: a wall's outward normal is ±X
  // or ±Z depending on which of its two cells stands higher, so it is per
  // chunk and rewritten on every patch. Three's FLAT_SHADED path happens to
  // derive the face normal from screen-space derivatives and ignore the
  // attribute, but the geometry should describe itself honestly rather than
  // depend on one material flag staying set.
  const sharedIndex = new BufferAttribute(buildChunkIndices(), 1);

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

  /**
   * Rewrites one chunk's geometry in place and re-syncs everything downstream
   * of the vertex data: the GPU upload flags, the draw range (the quad count
   * moves whenever a sculpt adds or removes a cliff), and the bound.
   */
  const writeChunk = (chunkIdx: number, entry: ChunkMesh): void => {
    const cx = chunkIdx % chunkCols;
    const cy = (chunkIdx - cx) / chunkCols;

    // In place: same arrays, same attributes, same geometry, same mesh.
    const counts = writeChunkVertexData(mirror, cx, cy, entry.buffers, palettes);

    entry.positionAttribute.needsUpdate = true;
    entry.normalAttribute.needsUpdate = true;
    entry.colorAttribute.needsUpdate = true;

    // The live prefix of the shared index buffer. Three honours drawRange in
    // BOTH the renderer and Mesh.raycast, so the unused tail is neither drawn
    // nor pickable — verified against three 0.185 src/objects/Mesh.js.
    entry.mesh.geometry.setDrawRange(0, counts.indexCount);

    // Heights changed, so the culling/raycast bound is stale. Skipping it makes
    // edited chunks vanish at certain camera angles and stop being clickable.
    // computeBoundingSphere ignores drawRange and reads the whole attribute,
    // which is exactly why writeChunkVertexData collapses the unused tail onto
    // a vertex inside this chunk instead of leaving it stale or zeroed.
    entry.mesh.geometry.computeBoundingSphere();
  };

  const createChunkMesh = (chunkIdx: number): ChunkMesh => {
    const buffers = createChunkGeometryBuffers();

    const positionAttribute = new BufferAttribute(buffers.positions, 3);
    const normalAttribute = new BufferAttribute(buffers.normals, 3);
    const colorAttribute = new BufferAttribute(buffers.colors, 3);
    // All three attributes are rewritten on every edit that touches this chunk.
    positionAttribute.setUsage(DynamicDrawUsage);
    normalAttribute.setUsage(DynamicDrawUsage);
    colorAttribute.setUsage(DynamicDrawUsage);

    const geometry = new BufferGeometry();
    geometry.setAttribute('position', positionAttribute);
    geometry.setAttribute('normal', normalAttribute);
    geometry.setAttribute('color', colorAttribute);
    geometry.setIndex(sharedIndex);

    const mesh = new Mesh(geometry, material);
    const entry: ChunkMesh = {
      mesh,
      buffers,
      positionAttribute,
      normalAttribute,
      colorAttribute,
    };
    // One code path fills the buffers and sets the draw range, whether the
    // chunk is new or being re-patched — a mesh created with a stale (default,
    // Infinity) draw range would draw its whole worst-case tail on frame one.
    writeChunk(chunkIdx, entry);

    group.add(mesh);
    return entry;
  };

  const disposeEntry = (entry: ChunkMesh): void => {
    group.remove(entry.mesh);
    // Disposing a geometry releases the GPU buffers of every attribute it
    // holds, including the shared index one. That is safe here because
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
          writeChunk(chunkIdx, existing);
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
