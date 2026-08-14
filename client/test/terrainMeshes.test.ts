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
import { HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

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
    // identities change, an edit is reallocating GPU resources per sculpt.
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);

    const mesh = meshes.pickables()[0];
    const geometryBefore = mesh.geometry;
    const positionBefore = plainAttribute(mesh.geometry, 'position');
    const colorBefore = plainAttribute(mesh.geometry, 'color');
    const indexBefore = mesh.geometry.getIndex();
    const positionArrayBefore = positionBefore.array;
    // `needsUpdate` on a BufferAttribute is a setter with no getter — reading
    // it yields undefined. `version`, which it increments, is the observable
    // that actually drives the GPU re-upload.
    const positionVersionBefore = positionBefore.version;
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
    expect(mesh.geometry.getAttribute('color')).toBe(colorBefore);
    expect(mesh.geometry.getIndex()).toBe(indexBefore);
    // Same backing typed array — rewritten, not replaced.
    expect(mesh.geometry.getAttribute('position').array).toBe(positionArrayBefore);

    // And both attributes were flagged for re-upload, or the GPU would keep
    // showing the stale buffer.
    expect(positionBefore.version).toBeGreaterThan(positionVersionBefore);
    expect(colorBefore.version).toBeGreaterThan(colorVersionBefore);
  });

  it('writes the new height into the patched vertex', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );

    const vertsPerEdge = CHUNK_SIZE + 1;
    const position = mesh.geometry.getAttribute('position');
    const vertexIndex = 3 * vertsPerEdge + 2;
    expect(position.getY(vertexIndex)).toBeCloseTo(256 * HEIGHT_WORLD_SCALE);
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
    // The pre-existing neighbour was re-patched too, so the seam closes.
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});
