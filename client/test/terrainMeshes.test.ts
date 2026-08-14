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
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  VERTICES_PER_TRIANGLE,
} from '../src/terrain/vertexGrid.ts';
import { BAND_WORLD_HEIGHT } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
/**
 * A chunk with one band and no contour is two triangles: its whole domain, at
 * that band's height. That is the smallest geometry the builder can emit, and
 * the draw range has to cut everything after it.
 */
const FLAT_CHUNK_VERTEX_COUNT = 2 * VERTICES_PER_TRIANGLE;

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
    // and this still has to hold now that the emitted triangle count VARIES
    // widely with the terrain, which is exactly what the working-capacity
    // strategy buys (a chunk only ever rebinds when it outgrows its buffers,
    // and this edit is nowhere near that).
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);

    const mesh = meshes.pickables()[0];
    const geometryBefore = mesh.geometry;
    const positionBefore = plainAttribute(mesh.geometry, 'position');
    const normalBefore = plainAttribute(mesh.geometry, 'normal');
    const colorBefore = plainAttribute(mesh.geometry, 'color');
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
    // Same backing typed arrays — rewritten, not replaced.
    expect(mesh.geometry.getAttribute('position').array).toBe(positionArrayBefore);
    expect(mesh.geometry.getAttribute('normal').array).toBe(normalArrayBefore);

    // And every attribute was flagged for re-upload, or the GPU would keep
    // showing the stale buffer.
    expect(positionBefore.version).toBeGreaterThan(positionVersionBefore);
    expect(normalBefore.version).toBeGreaterThan(normalVersionBefore);
    expect(colorBefore.version).toBeGreaterThan(colorVersionBefore);
  });

  it('builds non-indexed geometry, so every triangle keeps its own crease', () => {
    // Flat shading needs unshared vertices at every cap/skirt boundary, so no
    // vertex is ever reused — an index buffer that never shares is pure
    // overhead, and there is none.
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    for (const mesh of meshes.pickables()) {
      expect(mesh.geometry.getIndex()).toBeNull();
    }
  });

  it('gives each chunk its OWN normals, since skirt normals differ per chunk', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    const [first, second] = meshes.pickables();
    expect(first.geometry.getAttribute('normal')).not.toBe(
      second.geometry.getAttribute('normal'),
    );
  });

  it('draws only the emitted prefix of the buffers', () => {
    // A flat chunk is two triangles; the draw range must cut the rest of the
    // capacity rather than rasterising it. On non-indexed geometry the range
    // counts vertices.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.start).toBe(0);
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(geometry.drawRange.count).toBeLessThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('grows and shrinks the draw range as sculpting adds and removes terraces', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);

    // Raising one interior cell four bands cuts a stepped column around it.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );
    const raised = geometry.drawRange.count;
    expect(raised).toBeGreaterThan(FLAT_CHUNK_VERTEX_COUNT);
    expect(raised).toBeLessThanOrEqual(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );

    // Level it again and the column — and the range — go away.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 0 }],
      }),
    );
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('writes the new height into the patched chunk', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 256 }],
      }),
    );

    // Somewhere in the live range there is now a cap at four bands up — the
    // top of the column the sculpt raised.
    const position = mesh.geometry.getAttribute('position');
    let highest = -Infinity;
    for (let v = 0; v < mesh.geometry.drawRange.count; v++) {
      highest = Math.max(highest, position.getY(v));
    }
    expect(highest).toBeCloseTo(4 * BAND_WORLD_HEIGHT);
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
    // The pre-existing neighbour was re-patched too, so the terrace that now
    // runs up to the seam is rebuilt against the newly revealed heights.
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
    const left = meshes.pickables()[0];
    expect(left.geometry.drawRange.count).toBeGreaterThan(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('rebinds attributes when a chunk outgrows its buffers, keeping one geometry', () => {
    // Growth is the one path that reallocates. It must swap in fresh
    // attributes, dispose the geometry it replaced, and leave the mesh in the
    // scene exactly once.
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const positionBefore = plainAttribute(mesh.geometry, 'position');

    // A chunk-wide hill: several bands of contour, past the starting capacity.
    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));

    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()[0]).toBe(mesh);
    expect(mesh.geometry.getAttribute('position')).not.toBe(positionBefore);
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
    expect(mesh.geometry.getAttribute('position').count).toBeGreaterThanOrEqual(
      mesh.geometry.drawRange.count,
    );
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});
