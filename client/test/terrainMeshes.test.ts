// Mesh-management tests. These construct real Three.js geometries but never a
// WebGLRenderer, so they run headless — BufferGeometry, BufferAttribute and
// Mesh are plain data structures. Actual rendering is verified manually
// (design doc §8 "Testing").

import { describe, expect, it } from 'vitest';
import { BufferAttribute, Group, type BufferGeometry } from 'three';
import { CHUNK_SIZE, chunkIndex, type ChunkPayload } from '@terrace/shared';
import {
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
} from '../src/terrain/mirror.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import {
  CHUNK_INDEX_COUNT,
  INDICES_PER_QUAD,
  TOP_QUADS_PER_CHUNK,
  VERTICES_PER_QUAD,
} from '../src/terrain/vertexGrid.ts';
import { HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
/** A chunk with no cliffs draws its 256 top faces and nothing more. */
const FLAT_CHUNK_INDEX_COUNT = TOP_QUADS_PER_CHUNK * INDICES_PER_QUAD;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/**
 * `getAttribute` is typed as BufferAttribute | InterleavedBufferAttribute.
 * Chunk geometries only ever use the plain kind, so narrow once here rather
 * than casting at every assertion.
 */
function plainAttribute(geometry: BufferGeometry, name: string): BufferAttribute {
  const attribute = geometry.getAttribute(name);
  if (!(attribute instanceof BufferAttribute)) {
    throw new Error(`expected a plain BufferAttribute for "${name}"`);
  }
  return attribute;
}

function setup(chunks: ChunkPayload[]) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror);
  meshes.update(
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks }),
  );
  return { mirror, group, meshes };
}

describe('createTerrainMeshes', () => {
  it('creates one mesh per received chunk and none for locked chunks', () => {
    const { group, meshes } = setup([chunkPayload(0, 0, 100), chunkPayload(1, 0, 100)]);
    expect(group.children).toHaveLength(2);
    expect(meshes.pickables()).toHaveLength(2);
  });

  it('ignores dirty indices for chunks that were never received', () => {
    // This is how locked terrain stays invisible: a diff may name a chunk we
    // do not hold, and it must not conjure a mesh for it.
    const { group, meshes, mirror } = setup([chunkPayload(0, 0, 100)]);
    expect(group.children).toHaveLength(1);

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 40, y: 40, h: 500 }],
      }),
    );
    expect(group.children).toHaveLength(1);
  });

  it('patches vertex buffers IN PLACE, never rebuilding geometry', () => {
    // The client performance contract (design doc §8). If any of these object
    // identities change, an edit is reallocating GPU resources per sculpt —
    // and this still has to hold now that the emitted quad count VARIES with
    // the terrain, which is exactly what the preallocate-and-draw-a-prefix
    // strategy buys.
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);

    const mesh = meshes.pickables()[0];
    const geometryBefore = mesh.geometry;
    const positionBefore = plainAttribute(mesh.geometry, 'position');
    const normalBefore = plainAttribute(mesh.geometry, 'normal');
    const colorBefore = plainAttribute(mesh.geometry, 'color');
    const indexBefore = mesh.geometry.getIndex();
    const positionArrayBefore = positionBefore.array;
    const normalArrayBefore = normalBefore.array;
    // `needsUpdate` on a BufferAttribute is a setter with no getter — reading
    // it yields undefined. `version`, which it increments, is the observable
    // that actually drives the GPU re-upload.
    const positionVersionBefore = positionBefore.version;
    const normalVersionBefore = normalBefore.version;
    const colorVersionBefore = colorBefore.version;

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );

    expect(group.children).toHaveLength(1);
    expect(mesh.geometry).toBe(geometryBefore);
    expect(mesh.geometry.getAttribute('position')).toBe(positionBefore);
    expect(mesh.geometry.getAttribute('normal')).toBe(normalBefore);
    expect(mesh.geometry.getAttribute('color')).toBe(colorBefore);
    expect(mesh.geometry.getIndex()).toBe(indexBefore);
    // Same backing typed arrays — rewritten, not replaced.
    expect(mesh.geometry.getAttribute('position').array).toBe(positionArrayBefore);
    expect(mesh.geometry.getAttribute('normal').array).toBe(normalArrayBefore);

    // And every attribute was flagged for re-upload, or the GPU would keep
    // showing the stale buffer.
    expect(positionBefore.version).toBeGreaterThan(positionVersionBefore);
    expect(normalBefore.version).toBeGreaterThan(normalVersionBefore);
    expect(colorBefore.version).toBeGreaterThan(colorVersionBefore);
  });

  it('shares one index attribute across every chunk mesh', () => {
    // Quad k owns vertices 4k..4k+3 in every chunk in every world state, so
    // the indices are world-independent and need not be per mesh.
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    const [first, second] = meshes.pickables();
    expect(first.geometry.getIndex()).toBe(second.geometry.getIndex());
    expect(first.geometry.getIndex()?.count).toBe(CHUNK_INDEX_COUNT);
  });

  it('gives each chunk its OWN normals, since wall normals differ per chunk', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    const [first, second] = meshes.pickables();
    expect(first.geometry.getAttribute('normal')).not.toBe(
      second.geometry.getAttribute('normal'),
    );
  });

  it('draws only the emitted prefix of the buffers', () => {
    // A flat chunk emits no walls at all, so the draw range must cut the whole
    // worst-case wall tail rather than rasterising it.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.start).toBe(0);
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_INDEX_COUNT);
    expect(geometry.drawRange.count).toBeLessThan(CHUNK_INDEX_COUNT);
  });

  it('grows and shrinks the draw range as sculpting adds and removes cliffs', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_INDEX_COUNT);

    // Raising one interior cell by four bands cuts four cliff faces around it.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );
    const raised = geometry.drawRange.count;
    expect(raised).toBe(FLAT_CHUNK_INDEX_COUNT + 4 * INDICES_PER_QUAD);
    expect(raised).toBeLessThanOrEqual(CHUNK_INDEX_COUNT);

    // Level it again and the walls — and the range — go away.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 0 }],
      }),
    );
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_INDEX_COUNT);
  });

  it('writes the new height into the patched cell top face', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );

    // Top faces occupy fixed slots: cell (i,j) is quad j*CHUNK_SIZE + i, and
    // quad k starts at vertex 4k. All four of its corners are level.
    const topQuad = 3 * CHUNK_SIZE + 2;
    const position = mesh.geometry.getAttribute('position');
    for (let v = 0; v < VERTICES_PER_QUAD; v++) {
      expect(position.getY(topQuad * VERTICES_PER_QUAD + v)).toBeCloseTo(
        256 * HEIGHT_WORLD_SCALE,
      );
    }
  });

  it('refreshes the bounding sphere so edited chunks stay pickable', () => {
    // A stale bound makes a raised mountain fail both frustum culling and the
    // raycaster's sphere test — it would vanish and stop being clickable.
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const radiusBefore = mesh.geometry.boundingSphere?.radius ?? 0;

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 8, y: 8, h: 1024 }],
      }),
    );

    expect(mesh.geometry.boundingSphere?.radius ?? 0).toBeGreaterThan(radiusBefore);
  });

  it('keeps the bounding sphere tight around a distant chunk', () => {
    // The unused tail is collapsed onto a vertex inside the chunk precisely so
    // that computeBoundingSphere — which ignores the draw range — cannot be
    // dragged back toward the world origin by dead vertices.
    const { meshes } = setup([chunkPayload(3, 3, 0)]);
    const sphere = meshes.pickables()[0].geometry.boundingSphere;
    // A 16×16 flat chunk: half-diagonal of a 16-cell square is ~11.3.
    expect(sphere?.radius ?? 0).toBeLessThan(CHUNK_SIZE);
    expect(sphere?.center.x ?? 0).toBeGreaterThan(WORLD - CHUNK_SIZE - 1);
  });

  it('adds a mesh when a chunk is unlocked later', () => {
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    expect(group.children).toHaveLength(1);

    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, 300)],
    });
    meshes.update(dirty);

    expect(group.children).toHaveLength(2);
    // The pre-existing neighbour was re-patched too, so the border wall
    // between the two chunks is rebuilt against the newly revealed heights.
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
    const left = meshes.pickables()[0];
    expect(left.geometry.drawRange.count).toBe(
      FLAT_CHUNK_INDEX_COUNT + CHUNK_SIZE * INDICES_PER_QUAD,
    );
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});
