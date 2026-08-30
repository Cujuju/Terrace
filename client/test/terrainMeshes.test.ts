// Mesh-management tests. These construct real Three.js geometries but never a
// WebGLRenderer, so they run headless — BufferGeometry, BufferAttribute and
// Mesh are plain data structures. Actual rendering is verified manually
// (design doc §8 "Testing").

import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  Group,
  ShaderLib,
  type BufferGeometry,
  type Material,
  type MeshStandardMaterial,
} from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  NEIGHBOURHOOD_CELLS,
  chunkIndex,
  type ChunkPayload,
} from '@terrace/shared';
import {
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
} from '../src/terrain/mirror.ts';
import {
  ARENA_COMPACT_IDLE_BUDGET_MS,
  ARENA_COMPACT_STROKE_BUDGET_MS,
  ARENA_HEADROOM_FLOOR_TRIANGLES,
  ARENA_HEADROOM_RUN_MULTIPLE,
  ARENA_TRANSFER_MS_PER_VERTEX,
  CHUNK_SPLICE_FRAME_BUDGET_MS,
  SUPER_MESH_SPAN_CHUNKS,
  TERRAIN_QUIET_MS,
  createTerrainMeshes,
  type ArenaLayout,
  type TerrainMeshes,
} from '../src/render/terrainMeshes.ts';
import {
  createDirectChunkBuildSource,
  type ChunkBuildSource,
} from '../src/render/chunkBuildSource.ts';
import type { ChunkJobAnswer } from '../src/terrain/chunkJob.ts';
import {
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  VERTICES_PER_TRIANGLE,
} from '../src/terrain/vertexGrid.ts';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../src/config.ts';

// Four NEIGHBOURHOODS to a side — 64 world units, the ground this suite has
// always covered. Counted that way rather than in chunks because its subject
// is a distance in the WORLD, and the 2026-08-21 re-sample shrank a chunk to a
// quarter of the neighbourhood it used to be (shared's CHUNK_SPAN).
const WORLD = NEIGHBOURHOOD_CELLS * 4;
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

/**
 * Every slot of `patched` holds, vertex for vertex and attribute for
 * attribute, exactly what the same chunk's slot holds in `reference`.
 *
 * PER SLOT, NOT PER BUFFER POSITION: the arena places a run wherever it fits,
 * so two builds of the same world may lay the same geometry out differently
 * and still both be right. What may never differ is a chunk's own run.
 */
function expectSlotsEqual(patched: TerrainMeshes, reference: TerrainMeshes): void {
  const patchedLayouts = patched.arenaLayout();
  const referenceLayouts = reference.arenaLayout();
  expect(patchedLayouts).toHaveLength(referenceLayouts.length);
  for (let s = 0; s < patchedLayouts.length; s++) {
    const patchedGeometry = patched.pickables()[s]!.geometry;
    const referenceGeometry = reference.pickables()[s]!.geometry;
    const referenceSlots = new Map(
      referenceLayouts[s]!.slots.map((slot) => [slot.chunkIdx, slot]),
    );
    expect(patchedLayouts[s]!.slots.length).toBe(referenceSlots.size);
    for (const slot of patchedLayouts[s]!.slots) {
      const mirrorSlot = referenceSlots.get(slot.chunkIdx);
      expect(mirrorSlot, `chunk ${slot.chunkIdx} is missing from the reference`).toBeDefined();
      expect(slot.count, `chunk ${slot.chunkIdx} vertex count`).toBe(mirrorSlot!.count);
      for (const name of ['position', 'normal', 'color', 'selfLit'] as const) {
        const a = plainAttribute(patchedGeometry, name);
        const b = plainAttribute(referenceGeometry, name);
        const stride = a.itemSize;
        for (let v = 0; v < slot.count; v++) {
          for (let c = 0; c < stride; c++) {
            expect(
              a.array[(slot.offset + v) * stride + c],
              `chunk ${slot.chunkIdx} ${name}[${v}][${c}]`,
            ).toBe(b.array[(mirrorSlot!.offset + v) * stride + c]);
          }
        }
      }
    }
  }
}

/**
 * A build source that answers with runs of an EXACT, caller-chosen vertex
 * count.
 *
 * WHY A FAKE SOURCE RATHER THAN CONTRIVED TERRAIN. The arena's placement rules
 * turn on arithmetic between a run's old count, its new count, the free list
 * and the buffer capacity — "grow past the slack but not past the delta",
 * "a run too dear to move inside the stroke budget". Reaching those cases
 * through the marcher would mean hunting for heights that happen to emit a
 * particular number of triangles, which pins the test to the CONTOUR PIPELINE
 * rather than to the placement contract it is about. The vertex data is still
 * a real answer's — only its length is dictated — and every value written is
 * non-zero, so "the hole is zeroed" stays an observable rather than a
 * coincidence.
 */
function sizedSource(sizes: Map<number, number>): ChunkBuildSource {
  const direct = createDirectChunkBuildSource();
  return {
    concurrency: 1,
    build(mirror, chunkIdx, generation): ChunkJobAnswer | null {
      const real = direct.build(mirror, chunkIdx, generation) as ChunkJobAnswer | null;
      const want = sizes.get(chunkIdx);
      if (real === null || want === undefined) return real;
      const positions = new Float32Array(want * 3);
      const normals = new Int8Array(want * 3);
      const colors = new Uint8Array(want * 3);
      const selfLit = new Uint8Array(want);
      for (let v = 0; v < want; v++) {
        positions[v * 3] = chunkIdx + 1;
        positions[v * 3 + 1] = v + 1;
        positions[v * 3 + 2] = 1;
        normals[v * 3] = 1;
        normals[v * 3 + 1] = 2;
        normals[v * 3 + 2] = 3;
        colors[v * 3] = 7;
        colors[v * 3 + 1] = 8;
        colors[v * 3 + 2] = 9;
        selfLit[v] = 1;
      }
      return {
        ...real,
        vertexCount: want,
        positions,
        normals,
        colors,
        selfLit,
        bounds: new Float32Array([1, 1, 1, chunkIdx + 1, want, 1]),
      };
    },
    dispose(): void {},
  };
}

/**
 * Asserts every invariant the free list carries (plan §3c), against the buffers
 * as they actually stand.
 */
function expectHoleInvariants(meshes: TerrainMeshes): void {
  const layouts = meshes.arenaLayout();
  const stats = meshes.arenaStats();
  for (let s = 0; s < layouts.length; s++) {
    const { slots, holes } = layouts[s]!;
    const { liveEnd, deadVertices } = stats[s]!;
    let total = 0;
    for (let h = 0; h < holes.length; h++) {
      const hole = holes[h]!;
      expect(hole.length, 'a zero-length hole is not a hole').toBeGreaterThan(0);
      // ALIGNED, which is what makes the degenerate-triangle argument true: a
      // hole that split a triangle would leave a live sliver drawing garbage.
      expect(hole.offset % VERTICES_PER_TRIANGLE).toBe(0);
      expect(hole.length % VERTICES_PER_TRIANGLE).toBe(0);
      // Sorted AND coalesced: adjacency would mean two entries where the list
      // must hold one.
      if (h > 0) {
        const previous = holes[h - 1]!;
        expect(previous.offset + previous.length).toBeLessThan(hole.offset);
      }
      // The retreat rule: a hole that reached `liveEnd` must have left the draw
      // range instead of sitting in the list.
      expect(hole.offset + hole.length).toBeLessThan(liveEnd);
      total += hole.length;
    }
    // No leaked remainder: dead space IS the free list, not merely covered by it.
    expect(total).toBe(deadVertices);

    // And every vertex outside a live run is zero in all four attributes.
    const live = new Uint8Array(liveEnd);
    for (const slot of slots) {
      expect(slot.offset % VERTICES_PER_TRIANGLE).toBe(0);
      expect(slot.count % VERTICES_PER_TRIANGLE).toBe(0);
      expect(slot.offset + slot.count).toBeLessThanOrEqual(liveEnd);
      live.fill(1, slot.offset, slot.offset + slot.count);
    }
    const geometry = meshes.pickables()[s]!.geometry;
    for (const name of ['position', 'normal', 'color', 'selfLit'] as const) {
      const attribute = plainAttribute(geometry, name);
      const stride = attribute.itemSize;
      for (let v = 0; v < liveEnd; v++) {
        if (live[v] === 1) continue;
        for (let c = 0; c < stride; c++) {
          expect(attribute.array[v * stride + c], `dead ${name} vertex ${v}`).toBe(0);
        }
      }
    }
  }
}

/** The first `count` chunks of the SUPER_MESH_SPAN_CHUNKS square at the origin. */
function arenaChunks(count: number): ChunkPayload[] {
  const chunks: ChunkPayload[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(chunkPayload(i % SUPER_MESH_SPAN_CHUNKS, Math.floor(i / SUPER_MESH_SPAN_CHUNKS), 0));
  }
  return chunks;
}

/** A world of `count` chunks, all inside super-mesh 0, built to exact sizes. */
function arenaSetup(count: number, sizes: Map<number, number>) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror, undefined, sizedSource(sizes));
  const chunks = arenaChunks(count);
  const dirty = applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  // ORDERED EXPLICITLY, not from the diff's Set: the drain order is the queue's
  // insertion order, and these tests assert which run is placed where.
  meshes.update([...dirty].sort((a, b) => a - b));
  return { mirror, group, meshes };
}

describe('createTerrainMeshes', () => {
  it('merges received chunks into one drawn mesh, and builds none for locked chunks', () => {
    // COUNTED IN CHUNKS, NOT MESHES (2026-08-21). The mesh count stopped
    // answering "which chunks were built" when chunks stopped being the draw
    // quantum; both of these chunks are inside one SUPER_MESH_SPAN_CHUNKS
    // block, so the renderer submits them together. That merge IS the
    // behaviour under test here — one draw call carrying two chunks.
    const { group, meshes } = setup([chunkPayload(0, 0, 100), chunkPayload(1, 0, 100)]);
    expect(meshes.builtChunkCount()).toBe(2);
    expect(meshes.drawCallCount()).toBe(1);
    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()).toHaveLength(1);
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

  it('patches one chunk without disturbing the others, wherever the arena put them', () => {
    // THE FAILURE MODE THE MERGE INTRODUCES, and the reason this replaced a
    // test that compared two chunks' normal attributes for identity. Chunks do
    // not own an attribute each: they own a RUN inside a shared one.
    //
    // RESTATED FOR THE ARENA (2026-08-28). The runs used to be packed in
    // chunk-index order, so "the same buffer, vertex for vertex" was a fair
    // oracle. Under the arena a run is placed wherever it fits and moved by the
    // compactor, so the layout of a spliced super-mesh legitimately differs
    // from a from-scratch build's. The EQUIVALENCE survives, restated PER SLOT:
    // for every chunk, its own run of all four attributes must equal that
    // chunk's run in a from-scratch build over the same heights.
    //
    // This is the test that catches a bad copyWithin length, a x3/x1 unit slip
    // on `selfLit`, or zeroing one vertex too many; the upload-size test below
    // cannot see any of those.
    const chunks = [
      chunkPayload(0, 0, 0),
      chunkPayload(1, 0, 0),
      chunkPayload(2, 0, 0),
      chunkPayload(3, 0, 0),
    ];
    const built = setup(chunks);

    // A HISTORY WITH ALL THREE EVENTS IN IT: a grow that cannot extend in place
    // (chunk 0 has runs after it), a shrink that opens a hole, and — because
    // two chunks are dirtied in the same pass — a first-fit reuse of that hole,
    // followed by the compaction `flush` ends with.
    const history = [
      { type: 'terrainDiff' as const, cells: [{ x: 2, y: 3, h: 4 * BAND_HEIGHT }] },
      { type: 'terrainDiff' as const, cells: [{ x: 2, y: 3, h: 0 }] },
      {
        type: 'terrainDiff' as const,
        cells: [
          { x: 2, y: 3, h: 6 * BAND_HEIGHT },
          { x: CHUNK_SIZE + 4, y: 5, h: 5 * BAND_HEIGHT },
          { x: 2 * CHUNK_SIZE + 6, y: 7, h: 3 * BAND_HEIGHT },
        ],
      },
      {
        type: 'terrainDiff' as const,
        cells: [
          { x: 2, y: 3, h: 0 },
          { x: CHUNK_SIZE + 4, y: 5, h: 8 * BAND_HEIGHT },
        ],
      },
    ];

    // The arena's own events, observed as they happen: `onChunkDrawn` fires
    // after a splice and BEFORE the frame's compaction, which is the only
    // moment a hole is visible from outside.
    let sawHole = false;
    let sawRunMoveDown = false;
    let previous = new Map<number, number>();
    const noteLayout = (): void => {
      const layout = built.meshes.arenaLayout()[0]!;
      if (layout.holes.length > 0) sawHole = true;
      for (const slot of layout.slots) {
        const before = previous.get(slot.chunkIdx);
        if (before !== undefined && slot.offset < before) sawRunMoveDown = true;
      }
      previous = new Map(layout.slots.map((slot) => [slot.chunkIdx, slot.offset]));
    };
    built.meshes.onChunkDrawn(noteLayout);
    for (const diff of history) {
      built.meshes.update(applyTerrainDiff(built.mirror, diff));
      noteLayout();
    }
    expect(sawHole).toBe(true);
    expect(sawRunMoveDown).toBe(true);

    // The same world, reached in one build instead of five.
    const freshMirror = createTerrainMirror(WORLD);
    applySnapshot(freshMirror, { type: 'snapshot', worldSize: WORLD, chunks });
    for (const diff of history) applyTerrainDiff(freshMirror, diff);
    const freshMeshes = createTerrainMeshes(new Group(), freshMirror);
    freshMeshes.update(freshMirror.received);

    expect(built.meshes.drawCallCount()).toBe(1);
    expectSlotsEqual(built.meshes, freshMeshes);
  });

  it('draws only the arena prefix of the buffers', () => {
    // A flat chunk is two triangles; the draw range must cut the rest of the
    // capacity rather than rasterising it. On non-indexed geometry the range
    // counts vertices, and the prefix it covers is the arena's EXTENT
    // (`liveEnd`) rather than the sum of the slot counts — the two are the same
    // number here only because a single hole-free run has nothing dead in it.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    const stats = meshes.arenaStats()[0]!;
    expect(geometry.drawRange.start).toBe(0);
    expect(geometry.drawRange.count).toBe(stats.liveEnd);
    expect(stats.liveEnd).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(geometry.drawRange.count).toBeLessThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('keeps the draw range over every live vertex as sculpting adds and removes terraces', () => {
    // WHAT THE DRAW RANGE IS FOR, under the arena: it must cover every live
    // vertex — `liveEnd`, which is at least the sum of the slot counts and is
    // more than it exactly when the arena holds holes. A range set to the COUNT
    // sum would truncate the arena and cut live geometry off the end.
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
    const grown = meshes.arenaStats()[0]!;
    expect(raised).toBe(grown.liveEnd);
    expect(grown.liveEnd).toBeGreaterThanOrEqual(grown.liveCount);

    // Level it again and the column — and the range — go away. The retreat
    // rule is what makes this exact: the shrink's hole ends at `liveEnd`, so it
    // leaves the draw range rather than being uploaded as zeroes.
    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 0 }],
      }),
    );
    const levelled = meshes.arenaStats()[0]!;
    expect(geometry.drawRange.count).toBe(levelled.liveEnd);
    expect(levelled.liveEnd).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(levelled.liveCount).toBe(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('writes the new height into the patched chunk', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        // Four bands up — the assertion below reads this as a band count, so it
        // must be stated as one (it was the literal 256, four bands only at 64).
        cells: [{ x: 2, y: 3, h: 4 * BAND_HEIGHT }],
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
    const lastChunk = WORLD / CHUNK_SIZE - 1;
    const { meshes } = setup([chunkPayload(lastChunk, lastChunk, 0)]);
    const sphere = meshes.pickables()[0].geometry.boundingSphere;
    // A flat chunk's half-diagonal is CHUNK_SIZE·√2/2 of a cell, and the sphere
    // is measured in WORLD units — the conversion the 2026-08-21 re-sample made
    // real (CELL_WORLD_SIZE was 1 before it).
    const chunkWorldSpan = CHUNK_SIZE * CELL_WORLD_SIZE;
    expect(sphere?.radius ?? 0).toBeLessThan(chunkWorldSpan);
    expect(sphere?.center.x ?? 0).toBeGreaterThan(
      (WORLD - CHUNK_SIZE - 1) * CELL_WORLD_SIZE,
    );
  });

  it('adds a chunk\'s geometry when it is unlocked later', () => {
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    expect(meshes.builtChunkCount()).toBe(1);

    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(1, 0, 300)],
    });
    meshes.update(dirty);

    expect(meshes.builtChunkCount()).toBe(2);
    // Still ONE drawn mesh: the new chunk joins the neighbour's super-mesh
    // rather than adding a draw call of its own.
    expect(group.children).toHaveLength(1);
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

  // -------------------------------------------------------------------------
  // SELF-LIT SEABED RIMS (owner, 2026-08-14). The geometry builder flags the
  // underwater cut faces (asserted in vertexGrid.test.ts); this is the other
  // half of that contract — the material has to be wired to honour the flag,
  // and the wiring is a string patch against three's stock shader, which is
  // exactly the kind of thing that fails silently on a dependency upgrade.
  // -------------------------------------------------------------------------

  /** The one shader-patching material every chunk mesh shares. */
  function terrainMaterial(mesh: { material: Material | Material[] }): MeshStandardMaterial {
    const material = mesh.material;
    if (Array.isArray(material)) throw new Error('expected a single material');
    return material as MeshStandardMaterial;
  }

  it('binds the self-lit flag as a normalised one-byte attribute', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const attribute = plainAttribute(meshes.pickables()[0].geometry, 'selfLit');
    expect(attribute.itemSize).toBe(1);
    // Normalised, so the builder's 0/255 bytes arrive in the shader as 0.0/1.0
    // and the injected mix() needs no scaling of its own.
    expect(attribute.normalized).toBe(true);
    expect(attribute.array).toBeInstanceOf(Uint8Array);
    expect(attribute.count).toBe(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('re-uploads and rebinds the flag alongside the other attributes', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const before = plainAttribute(mesh.geometry, 'selfLit');
    const versionBefore = before.version;

    meshes.update(
      applyTerrainDiff(mirror, { type: 'terrainDiff', cells: [{ x: 2, y: 3, h: 256 }] }),
    );
    expect(plainAttribute(mesh.geometry, 'selfLit')).toBe(before);
    expect(before.version).toBeGreaterThan(versionBefore);

    // And on the growth path it must be replaced too, or the flags would keep
    // addressing the old, shorter buffer.
    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));
    const grown = plainAttribute(mesh.geometry, 'selfLit');
    expect(grown).not.toBe(before);
    expect(grown.count).toBeGreaterThanOrEqual(mesh.geometry.drawRange.count);
  });

  it('patches the terrain shader so a flagged vertex is shaded unlit', () => {
    // Run the material's own onBeforeCompile over three's REAL stock shader for
    // MeshStandardMaterial. This is the regression guard: if a three upgrade
    // moves the anchors, the patch must not quietly no-op and leave every
    // underwater outline dark again.
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const material = terrainMaterial(meshes.pickables()[0]);
    const shader = {
      uniforms: {},
      vertexShader: ShaderLib.physical.vertexShader,
      fragmentShader: ShaderLib.physical.fragmentShader,
    };
    material.onBeforeCompile(shader as never, null as never);

    expect(shader.vertexShader).toContain('attribute float selfLit;');
    expect(shader.vertexShader).toContain('vSelfLit = selfLit;');
    expect(shader.fragmentShader).toContain('varying float vSelfLit;');
    // The mix has to sit BEFORE <opaque_fragment>, where outgoingLight is
    // already assembled and tone mapping, colour space and fog have not run —
    // a rim must still fog with distance, it just must not go dark for facing
    // away from the sun.
    const mixAt = shader.fragmentShader.indexOf(
      'outgoingLight = mix( outgoingLight, diffuseColor.rgb, vSelfLit );',
    );
    const opaqueAt = shader.fragmentShader.indexOf('#include <opaque_fragment>');
    const fogAt = shader.fragmentShader.indexOf('#include <fog_fragment>');
    expect(mixAt).toBeGreaterThan(-1);
    expect(mixAt).toBeLessThan(opaqueAt);
    expect(opaqueAt).toBeLessThan(fogAt);
  });

  it('refuses to silently no-op when three moves an anchor', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const material = terrainMaterial(meshes.pickables()[0]);
    expect(() =>
      material.onBeforeCompile(
        { uniforms: {}, vertexShader: 'void main() {}', fragmentShader: '' } as never,
        null as never,
      ),
    ).toThrow(/shader patch failed/);
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});

// -----------------------------------------------------------------------------
// MULTI-FRAME MESHING (issue #47). The tests above all run the no-scheduler
// path, which drains inside `update` — that is the documented behaviour when
// there is no frame loop to defer to, and it is what keeps them meaningful as
// tests of the BUILDER. These drive the other path: a fake frame hook and a
// fake clock, so "how much did this frame do" is asserted rather than raced.
// -----------------------------------------------------------------------------

/**
 * A frame loop under the test's control, plus the clock the drain budget is
 * measured against.
 *
 * `costPerBuildMs` is how far the clock jumps each time the builder reads it.
 * `now` is read twice per build (once before the first, once after each), so a
 * cost at or above the budget makes every build the frame's last — which is how
 * a "this chunk is heavier than the whole budget" frame is simulated without
 * needing terrain that actually takes that long.
 */
function fakeScheduler(costPerBuildMs: number) {
  const handlers = new Set<(dt: number) => void>();
  let clockMs = 0;
  return {
    scheduling: {
      onFrame(handler: (dt: number) => void): () => void {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      now: (): number => {
        const read = clockMs;
        clockMs += costPerBuildMs;
        return read;
      },
    },
    frame(): void {
      for (const handler of handlers) handler(1 / 60);
    },
    handlerCount: (): number => handlers.size,
  };
}

function scheduledSetup(chunks: ChunkPayload[], costPerBuildMs: number) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const clock = fakeScheduler(costPerBuildMs);
  const meshes = createTerrainMeshes(group, mirror, clock.scheduling);
  const dirty = applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  meshes.update(dirty);
  return { mirror, group, meshes, clock };
}

describe('multi-frame chunk meshing', () => {
  const FOUR_CHUNKS = [
    chunkPayload(0, 0, 100),
    chunkPayload(1, 0, 100),
    chunkPayload(0, 1, 100),
    chunkPayload(1, 1, 100),
  ];

  it('builds nothing until a frame runs', () => {
    const { group, meshes } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(meshes.pendingCount()).toBe(4);
    expect(group.children).toHaveLength(0);
  });

  it('drains the whole queue in one frame when the work fits the budget', () => {
    const { meshes, clock } = scheduledSetup(FOUR_CHUNKS, 0);
    clock.frame();
    expect(meshes.builtChunkCount()).toBe(4);
    expect(meshes.pendingCount()).toBe(0);
  });

  it('spreads the queue across frames when it does not', () => {
    // Every build costs the whole budget, so each frame gets exactly one.
    const { meshes, clock } = scheduledSetup(
      FOUR_CHUNKS,
      CHUNK_SPLICE_FRAME_BUDGET_MS,
    );
    for (let built = 1; built <= 4; built++) {
      clock.frame();
      expect(meshes.builtChunkCount()).toBe(built);
      expect(meshes.pendingCount()).toBe(4 - built);
    }
    // And it stops once there is nothing left rather than spinning.
    clock.frame();
    expect(meshes.builtChunkCount()).toBe(4);
  });

  it('always builds at least one chunk per frame, however over budget it is', () => {
    // FORWARD PROGRESS. A chunk costing many times the budget must still be
    // built, or the queue stalls on it forever and the terrain freezes behind
    // it. Ten times the budget per build, and a frame still makes progress.
    const { group, clock } = scheduledSetup(FOUR_CHUNKS, CHUNK_SPLICE_FRAME_BUDGET_MS * 10);
    clock.frame();
    expect(group.children).toHaveLength(1);
  });

  it('keeps drawing the previous mesh while a rebuild is queued', () => {
    // The whole reason deferral is invisible: a chunk waiting its turn is
    // STALE, never absent. If it vanished for a frame the queue would read as
    // a flicker and the tradeoff would not be worth making.
    const { meshes, mirror, group, clock } = scheduledSetup(
      [chunkPayload(0, 0, 0)],
      CHUNK_SPLICE_FRAME_BUDGET_MS,
    );
    clock.frame();
    const mesh = meshes.pickables()[0];
    const rangeBefore = mesh.geometry.drawRange.count;

    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));

    // Queued, not built: same mesh, still in the scene, still drawing the old
    // flat geometry.
    expect(meshes.pendingCount()).toBe(1);
    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()[0]).toBe(mesh);
    expect(mesh.geometry.drawRange.count).toBe(rangeBefore);

    clock.frame();
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(rangeBefore);
  });

  it('builds a chunk once however many times it was dirtied first', () => {
    // A held stroke re-dirties the same chunk ~8 times a second; the queue must
    // collapse that to one build against the newest heights.
    const { meshes, mirror, clock } = scheduledSetup([chunkPayload(0, 0, 0)], 0);
    clock.frame();

    for (let repeat = 0; repeat < 8; repeat++) {
      meshes.update(
        applyTerrainDiff(mirror, {
          type: 'terrainDiff',
          cells: [{ x: 4, y: 4, h: 100 + repeat }],
        }),
      );
    }
    expect(meshes.pendingCount()).toBe(1);
  });

  it('drops the queue when the world is replaced', () => {
    // Indices name chunks of the world being thrown away; draining them
    // against its replacement would build geometry nobody asked for.
    const { meshes } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(meshes.pendingCount()).toBe(4);
    meshes.clear();
    expect(meshes.pendingCount()).toBe(0);
  });

  it('unsubscribes its frame handler on dispose', () => {
    // resetWorld disposes the old meshes and creates new ones on every rejoin,
    // so a handler that outlived its owner would accumulate one dead drain per
    // reconnect, each holding a whole world's meshes alive.
    const { meshes, clock } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(clock.handlerCount()).toBe(1);
    meshes.dispose();
    expect(clock.handlerCount()).toBe(0);
  });

  it('flush builds everything regardless of budget', () => {
    const { meshes } = scheduledSetup(FOUR_CHUNKS, CHUNK_SPLICE_FRAME_BUDGET_MS * 10);
    meshes.flush();
    expect(meshes.builtChunkCount()).toBe(4);
    expect(meshes.pendingCount()).toBe(0);
  });

  // ---------------------------------------------------------------------------
  // COMPACTION. Its own seam on the frame hook, with its own budget — the only
  // block in this file that has a frame hook to hang it on. `drain` returns
  // early on a settled frame, so anything placed "after the splices" inside it
  // would never run on the frames that matter.
  // ---------------------------------------------------------------------------

  /**
   * A run too dear to move inside the stroke budget and cheap enough for the
   * idle one — 1.14 ms against 1.0 and 3.0. Stated as a vertex count because
   * that is what the arena moves; the assertions below re-derive the two
   * milliseconds from ARENA_TRANSFER_MS_PER_VERTEX so the fixture cannot drift
   * away from the constants it is chosen against.
   */
  const DEAR_RUN_VERTICES = 60000;

  function compactionSetup() {
    const sizes = new Map<number, number>([
      [chunkIndex(WORLD, 0, 0), 300],
      [chunkIndex(WORLD, 1, 0), DEAR_RUN_VERTICES],
      [chunkIndex(WORLD, 2, 0), 300],
    ]);
    const mirror = createTerrainMirror(WORLD);
    const group = new Group();
    const clock = fakeScheduler(0);
    const meshes = createTerrainMeshes(group, mirror, clock.scheduling, sizedSource(sizes));
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: [chunkPayload(0, 0, 0), chunkPayload(1, 0, 0), chunkPayload(2, 0, 0)],
    });
    meshes.update([...dirty].sort((a, b) => a - b));
    clock.frame();
    return { meshes, clock, sizes };
  }

  it('will not move a run it cannot afford on a frame that spliced, and moves it when idle', () => {
    expect(DEAR_RUN_VERTICES * ARENA_TRANSFER_MS_PER_VERTEX).toBeGreaterThan(
      ARENA_COMPACT_STROKE_BUDGET_MS,
    );
    expect(DEAR_RUN_VERTICES * ARENA_TRANSFER_MS_PER_VERTEX).toBeLessThanOrEqual(
      ARENA_COMPACT_IDLE_BUDGET_MS,
    );

    const { meshes, clock, sizes } = compactionSetup();
    expect(meshes.arenaStats()[0]).toMatchObject({
      liveEnd: DEAR_RUN_VERTICES + 600,
      deadVertices: 0,
    });

    // A stroke step shrinks the first chunk, opening a hole the dear run sits
    // behind. SPLICED frame: the move does not fit, and skipping it is correct
    // — a half-moved live run would draw garbage.
    sizes.set(chunkIndex(WORLD, 0, 0), 3);
    meshes.update([chunkIndex(WORLD, 0, 0)]);
    clock.frame();
    expect(meshes.arenaStats()[0]).toMatchObject({ deadVertices: 297, holeCount: 1 });

    // COMPACTION MUST NOT TOUCH A SLOT'S BOUNDS: a move changes where a run
    // lives, not what it contains, so the culling sphere is the same sphere.
    const sphereBefore = meshes.pickables()[0]!.geometry.boundingSphere!.clone();

    // IDLE frame: nothing to splice, three times the budget, and the arena
    // closes up.
    clock.frame();
    expect(meshes.arenaStats()[0]).toMatchObject({ deadVertices: 0, holeCount: 0 });
    const sphereAfter = meshes.pickables()[0]!.geometry.boundingSphere!;
    expect(sphereAfter.center.equals(sphereBefore.center)).toBe(true);
    expect(sphereAfter.radius).toBe(sphereBefore.radius);
  });

  it('converges to a hole-free arena within one sweep of idle frames', () => {
    // CONVERGENCE, NOT A HOLE CONSTANT (plan §3d): one full sweep is at most
    // one move per run, so a super-mesh of SUPER_MESH_SPAN_CHUNKS² chunks
    // retires every hole in at most that many moves less one.
    const { meshes, clock, sizes } = compactionSetup();
    for (let step = 0; step < 5; step++) {
      sizes.set(chunkIndex(WORLD, 0, 0), 300 + step * 3);
      sizes.set(chunkIndex(WORLD, 2, 0), 300 + (5 - step) * 3);
      meshes.update([chunkIndex(WORLD, 0, 0), chunkIndex(WORLD, 2, 0)]);
      clock.frame();
    }

    const MAX_SWEEP_FRAMES = SUPER_MESH_SPAN_CHUNKS ** 2 - 1;
    let frames = 0;
    while (meshes.arenaStats()[0]!.deadVertices > 0 && frames < MAX_SWEEP_FRAMES) {
      clock.frame();
      frames++;
    }
    const stats = meshes.arenaStats()[0]!;
    expect(stats.deadVertices).toBe(0);
    expect(stats.holeCount).toBe(0);
    expect(stats.liveEnd).toBe(stats.liveCount);
    expect(frames).toBeLessThan(MAX_SWEEP_FRAMES);
  });
});

// -----------------------------------------------------------------------------
// THE VERTEX ARENA (docs/plans/vertex-arena-no-tail-move.md). The contract:
// A SPLICE'S UPLOAD IS BOUNDED BY THE CHUNK IT SPLICES — and, during
// compaction, by one moved run — never by the super-mesh. Everything below
// is a statement about that bound or about the free list that makes it
// possible; none of it is a statement about a particular callsite.
// -----------------------------------------------------------------------------

describe('the vertex arena', () => {
  /** 100 triangles — a run size, chosen only so the arithmetic below is legible. */
  const RUN = 100 * VERTICES_PER_TRIANGLE;

  it('uploads only the chunk it spliced, however many runs follow it', () => {
    // THE MEASURED DEFECT, as a test (plan §1): the packed layout uploaded
    // `[slot.offset, liveVertices)` — this chunk and all 63 runs after it,
    // ~19 MB on the owner's busiest super-mesh, twice per stroke step. The
    // arena appends the regrown run and frees the old one, so the upload is
    // two runs' worth whatever sits between them.
    const sizes = new Map<number, number>();
    const chunkCount = SUPER_MESH_SPAN_CHUNKS ** 2;
    for (const payload of arenaChunks(chunkCount)) {
      sizes.set(chunkIndex(WORLD, payload.cx, payload.cy), RUN);
    }
    const { meshes } = arenaSetup(chunkCount, sizes);
    const first = chunkIndex(WORLD, 0, 0);
    const layoutBefore = meshes.arenaLayout()[0]!;
    expect(layoutBefore.slots).toHaveLength(chunkCount);
    const liveEndBefore = meshes.arenaStats()[0]!.liveEnd;
    const growthsBefore = meshes.arenaStats()[0]!.growths;
    const offsetBefore = layoutBefore.slots.find((slot) => slot.chunkIdx === first)!.offset;

    // EXPLICITLY CLEARED, and that is what makes the assertion observable: the
    // headless suite has no WebGLRenderer, so nothing ever drains the ranges
    // three would have uploaded, and they would otherwise accumulate from the
    // initial build.
    const geometry = meshes.pickables()[0]!.geometry;
    const attributes = (['position', 'normal', 'color', 'selfLit'] as const).map((name) =>
      plainAttribute(geometry, name),
    );
    for (const attribute of attributes) attribute.clearUpdateRanges();

    // Captured DURING the pass: `flush` compacts once every answer is spliced,
    // and compaction adds ranges of its own (bounded by one run plus one hole,
    // which is the other half of the contract). What this test pins is the
    // splice's own upload.
    let ranges: { start: number; count: number }[][] = [];
    meshes.onChunkDrawn(() => {
      ranges = attributes.map((attribute) => attribute.updateRanges.map((r) => ({ ...r })));
    });
    sizes.set(first, RUN * 2);
    meshes.update([first]);

    // No reallocation, so ranges were honoured rather than skipped (§3e).
    expect(meshes.arenaStats()[0]!.growths).toBe(growthsBefore);
    for (let a = 0; a < attributes.length; a++) {
      const stride = attributes[a]!.itemSize;
      // Two ranges, DISJOINT: the new run at the old live end, and the old run
      // being zeroed. Never one range spanning everything between them.
      expect(ranges[a], `${attributes[a]!.itemSize}-component attribute`).toEqual([
        { start: liveEndBefore * stride, count: RUN * 2 * stride },
        { start: offsetBefore * stride, count: RUN * stride },
      ]);
    }
  });

  it('holds every free-list invariant through an arbitrary splice history', () => {
    const sizes = new Map<number, number>([
      [chunkIndex(WORLD, 0, 0), RUN * 4],
      [chunkIndex(WORLD, 1, 0), RUN * 2],
      [chunkIndex(WORLD, 2, 0), RUN * 3],
      [chunkIndex(WORLD, 3, 0), RUN],
    ]);
    const { meshes } = arenaSetup(4, sizes);
    meshes.onChunkDrawn(() => expectHoleInvariants(meshes));

    const history: [number, number][][] = [
      [[0, RUN], [2, RUN * 6]],
      [[1, RUN * 5], [3, RUN * 2]],
      [[0, RUN * 7]],
      [[2, RUN], [1, RUN], [3, RUN * 4]],
      [[3, RUN * 9], [0, RUN * 2]],
    ];
    for (const step of history) {
      const dirty: number[] = [];
      for (const [chunk, count] of step) {
        const idx = chunkIndex(WORLD, chunk, 0);
        sizes.set(idx, count);
        dirty.push(idx);
      }
      meshes.update(dirty);
      expectHoleInvariants(meshes);
    }
  });

  it('leaves no hole behind once flush has built everything', () => {
    // `flush` means "build everything now"; under the arena it also means "and
    // leave no holes", which is what the six preview harnesses and every
    // no-scheduler caller get (plan §3d).
    const sizes = new Map<number, number>([
      [chunkIndex(WORLD, 0, 0), RUN * 3],
      [chunkIndex(WORLD, 1, 0), RUN * 3],
      [chunkIndex(WORLD, 2, 0), RUN * 3],
    ]);
    const { meshes } = arenaSetup(3, sizes);
    sizes.set(chunkIndex(WORLD, 0, 0), RUN);
    sizes.set(chunkIndex(WORLD, 1, 0), RUN * 5);
    meshes.update([chunkIndex(WORLD, 0, 0), chunkIndex(WORLD, 1, 0)]);

    const stats = meshes.arenaStats()[0]!;
    expect(stats.deadVertices).toBe(0);
    expect(stats.holeCount).toBe(0);
    expect(stats.liveEnd).toBe(stats.liveCount);
  });

  it('extends a run in place when it already ends at the live end', () => {
    // THE COMMON CASE for a one-chunk super-mesh — every `setup()` above, every
    // preview harness. Without it a regrow would re-append the only run on
    // every step and leave a hole where it had just been.
    const first = chunkIndex(WORLD, 0, 0);
    const sizes = new Map<number, number>([[first, RUN]]);
    const { meshes } = arenaSetup(1, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: RUN, holeCount: 0, growths: 0 });

    sizes.set(first, RUN * 3);
    const seen: ArenaLayout[] = [];
    meshes.onChunkDrawn(() => seen.push(meshes.arenaLayout()[0]!));
    meshes.update([first]);

    // No hole, and `liveEnd` moved by the DELTA rather than by the count.
    expect(seen[0]!.holes).toEqual([]);
    expect(seen[0]!.slots).toEqual([{ chunkIdx: first, offset: 0, count: RUN * 3 }]);
    expect(meshes.arenaStats()[0]).toMatchObject({
      liveEnd: RUN * 3,
      liveCount: RUN * 3,
      holeCount: 0,
      growths: 0,
    });
  });

  it('first-fits the lowest hole that fits, splits the surplus, and leaves the live end alone', () => {
    const a = chunkIndex(WORLD, 0, 0);
    const b = chunkIndex(WORLD, 1, 0);
    const sizes = new Map<number, number>([
      [a, 600],
      [b, 300],
      [chunkIndex(WORLD, 2, 0), 300],
      [chunkIndex(WORLD, 3, 0), 300],
    ]);
    const { meshes } = arenaSetup(4, sizes);
    expect(meshes.arenaStats()[0]!.liveEnd).toBe(1500);

    // A shrinks to 3, opening a 597-vertex hole at 3; B then grows to 450,
    // which fits that hole with 147 to spare and must NOT extend the arena.
    sizes.set(a, 3);
    sizes.set(b, 450);
    const seen: ArenaLayout[] = [];
    const liveEnds: number[] = [];
    meshes.onChunkDrawn(() => {
      seen.push(meshes.arenaLayout()[0]!);
      liveEnds.push(meshes.arenaStats()[0]!.liveEnd);
    });
    meshes.update([a, b]);

    const afterFirstFit = seen[1]!;
    expect(afterFirstFit.slots.find((slot) => slot.chunkIdx === b)).toEqual({
      chunkIdx: b,
      offset: 3,
      count: 450,
    });
    // The 147-vertex surplus of the split hole and the 300 vertices B vacated
    // are ADJACENT — 453+147 === 600 — so the free list holds them as one
    // entry. Two entries here would mean the coalescing invariant had lapsed.
    expect(afterFirstFit.holes).toEqual([{ offset: 453, length: 447 }]);
    // The arena did not extend: a first-fit reuses dead space, it does not add any.
    expect(liveEnds).toEqual([1500, 1500]);
  });

  it('sizes an append from the run\'s COUNT, not from its delta', () => {
    // THE REGRESSION THE PACKED LAYOUT WOULD HAVE LEFT BEHIND. Packed, a regrow
    // needed `delta` more vertices, because the run stayed where it was. An
    // append needs `count` more — the whole run is written past the live end —
    // and a capacity test still phrased in `delta` lets `set()` run off the
    // buffer and throw RangeError inside the frame hook.
    const a = chunkIndex(WORLD, 0, 0);
    const b = chunkIndex(WORLD, 1, 0);
    const capacity = INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE;
    const sizes = new Map<number, number>([[a, 1500], [b, 1500]]);
    const { meshes } = arenaSetup(2, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: 3000, growths: 0 });

    // delta = 60, which fits the 72 vertices of slack; count = 1560, which does
    // not. The buffers must grow.
    sizes.set(a, 1560);
    expect(3000 + 1560).toBeGreaterThan(capacity);
    expect(3000 + 60).toBeLessThanOrEqual(capacity);
    expect(() => meshes.update([a])).not.toThrow();

    expect(meshes.arenaStats()[0]!.growths).toBe(1);
    expect(meshes.arenaStats()[0]!.liveCount).toBe(1560 + 1500);
    expectHoleInvariants(meshes);
  });

  it('compacts before it grows, so a fragmented arena reuses its own dead space', () => {
    const a = chunkIndex(WORLD, 0, 0);
    const b = chunkIndex(WORLD, 1, 0);
    const sizes = new Map<number, number>([
      [a, 1002],
      [b, 1002],
      [chunkIndex(WORLD, 2, 0), 1002],
    ]);
    const { meshes } = arenaSetup(3, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: 3006, growths: 0 });

    // B shrinks to 3, freeing 999; A then grows to 1050 — too big for that hole
    // to first-fit, and too big to append at 3006 without doubling a 3072-vertex
    // buffer. Compacting first retires the hole, drops `liveEnd` to 2007, and
    // the append then fits with 15 vertices to spare.
    sizes.set(b, 3);
    sizes.set(a, 1050);
    const seen: ArenaLayout[] = [];
    meshes.onChunkDrawn(() => seen.push(meshes.arenaLayout()[0]!));
    meshes.update([b, a]);

    expect(meshes.arenaStats()[0]!.growths).toBe(0);
    expect(seen[1]!.slots.find((slot) => slot.chunkIdx === a)).toEqual({
      chunkIdx: a,
      offset: 2007,
      count: 1050,
    });
    expectHoleInvariants(meshes);
  });
});

// -----------------------------------------------------------------------------
// HEADROOM AT SETTLE (issue #229, docs/plans/frame-budget-growth-and-draw-calls.md
// part A). The contract: WHEN THE TERRAIN IS QUIET, EVERY SUPER-MESH HOLDS AT
// LEAST `headroom(sm)` OF FREE CAPACITY, AND CAPACITY IS ONLY EVER GROWN WHILE
// THE TERRAIN IS QUIET. Slack used to be an accident of where the doubling
// ladder stopped, so whether a stroke reallocated — one full `bufferData` of the
// whole super-mesh, inside the stroke — was decided by streaming order.
//
// None of these is a statement about a callsite: they are about the rule
// (`headroom`), the gate (quiet), the pace (one super-mesh per call) and the
// backstop that counts what the rule failed to prevent (`strokeGrowths`).
// -----------------------------------------------------------------------------

/**
 * A frame loop and a clock the test moves BY HAND.
 *
 * Distinct from `fakeScheduler` above, whose clock advances on every read so a
 * per-build budget can be simulated. What these tests assert is the QUIET
 * WINDOW — a rule about how long it has been since the last `update` — so the
 * clock has to stand still until the test says otherwise.
 */
function settleScheduler() {
  const handlers = new Set<(dt: number) => void>();
  let clockMs = 0;
  return {
    scheduling: {
      onFrame(handler: (dt: number) => void): () => void {
        handlers.add(handler);
        return () => handlers.delete(handler);
      },
      now: (): number => clockMs,
    },
    advance(ms: number): void {
      clockMs += ms;
    },
    frame(): void {
      for (const handler of handlers) handler(1 / 60);
    },
  };
}

/**
 * `sizedSource` with the answer withheld, so a chunk can be parked in the two
 * queue states a test cannot otherwise reach: `build` returns a PROMISE while
 * holding, which leaves the chunk in `inFlight`, and settling that promise with
 * the source's `null` failure value is what moves it into `retry`.
 */
function heldSource(sizes: Map<number, number>) {
  const inner = sizedSource(sizes);
  const held: {
    resolve: (answer: ChunkJobAnswer | null) => void;
    answer: ChunkJobAnswer | null;
  }[] = [];
  let holding = false;
  const source: ChunkBuildSource = {
    concurrency: 2,
    build(mirror, chunkIdx, generation) {
      const answer = inner.build(mirror, chunkIdx, generation) as ChunkJobAnswer | null;
      if (!holding) return answer;
      return new Promise<ChunkJobAnswer | null>((resolve) => {
        held.push({ resolve, answer });
      });
    },
    dispose(): void {},
  };
  /**
   * A macrotask, not `await Promise.resolve()`: the answer travels through the
   * mesh set's own `.then` before it is spliced, and one microtask is not
   * reliably enough of that chain.
   */
  const drainMicrotasks = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  return {
    source,
    hold(): void {
      holding = true;
    },
    /** Answers every held job with the geometry it built. */
    async release(): Promise<void> {
      for (const job of held.splice(0)) job.resolve(job.answer);
      await drainMicrotasks();
    },
    /** Answers every held job with `null` — the source's "this build produced nothing". */
    async lose(): Promise<void> {
      for (const job of held.splice(0)) job.resolve(null);
      await drainMicrotasks();
    },
  };
}

function settleSetup(chunks: ChunkPayload[], sizes: Map<number, number>) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const clock = settleScheduler();
  const held = heldSource(sizes);
  const meshes = createTerrainMeshes(group, mirror, clock.scheduling, held.source);
  const dirty = applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  // ORDERED EXPLICITLY, exactly as `arenaSetup` does and for the same reason.
  meshes.update([...dirty].sort((a, b) => a - b));
  return { mirror, group, meshes, clock, held };
}

/**
 * Capacity of super-mesh `s` in VERTICES, read off the buffer three would
 * upload rather than from module internals: the position attribute IS the
 * allocation, and `liveEnd` is only the part of it that draws.
 */
function capacityVertices(meshes: TerrainMeshes, s: number): number {
  return plainAttribute(meshes.pickables()[s]!.geometry, 'position').array.length / 3;
}

/** The rule under test, restated: 2 × the largest run, floored. */
function expectedHeadroom(largestRunVertices: number): number {
  return Math.max(
    ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices,
    ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
  );
}

describe('headroom at settle', () => {
  const ORIGIN = chunkIndex(WORLD, 0, 0);
  const NEIGHBOUR = chunkIndex(WORLD, 1, 0);
  /** The first chunk of the NEXT super-mesh — SUPER_MESH_SPAN_CHUNKS along. */
  const OTHER_SUPER = chunkIndex(WORLD, SUPER_MESH_SPAN_CHUNKS, 0);
  /** Small enough that the floor, not the run, decides the headroom. */
  const SMALL_RUN = 1000 * VERTICES_PER_TRIANGLE;
  /**
   * Large enough that 2 × it clears the floor by a whole rung of the doubling
   * ladder, so the floor and the run rule cannot both be satisfied by the same
   * allocation and the test can tell which one ran.
   */
  const LARGE_RUN = 30_000 * VERTICES_PER_TRIANGLE;

  /**
   * Builds every queued chunk. Two frames because the source's concurrency is
   * two and a frame submits before it splices.
   */
  function stream(clock: ReturnType<typeof settleScheduler>): void {
    clock.frame();
    clock.frame();
    clock.frame();
  }

  it('grows a quiet super-mesh that is under its headroom, to at least the floor', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    const before = meshes.arenaStats()[0]!;
    expect(before.growths).toBe(0);
    // The defect this fixes: the ladder left less slack than one regrow needs.
    expect(capacityVertices(meshes, 0) - before.liveEnd).toBeLessThan(
      expectedHeadroom(SMALL_RUN),
    );

    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();

    const after = meshes.arenaStats()[0]!;
    expect(after.growths).toBe(1);
    // 2 × SMALL_RUN is far under the floor, so this is the floor's doing.
    expect(ARENA_HEADROOM_RUN_MULTIPLE * SMALL_RUN).toBeLessThan(
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );
    expect(capacityVertices(meshes, 0) - after.liveEnd).toBeGreaterThanOrEqual(
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );
    // A settle growth is not a stroke growth — that is the whole point.
    expect(after.strokeGrowths).toBe(0);
  });

  it('sizes headroom from the largest run when twice it clears the floor', () => {
    const sizes = new Map<number, number>([[ORIGIN, LARGE_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();

    const stats = meshes.arenaStats()[0]!;
    const headroom = expectedHeadroom(LARGE_RUN);
    expect(headroom).toBe(ARENA_HEADROOM_RUN_MULTIPLE * LARGE_RUN);
    expect(capacityVertices(meshes, 0) - stats.liveEnd).toBeGreaterThanOrEqual(headroom);
    // And the floor alone would not have got there: the run rule is what ran.
    expect(capacityVertices(meshes, 0)).toBeGreaterThan(
      stats.liveEnd + ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );
  });

  it('leaves a super-mesh that already has its headroom alone', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    const grown = meshes.arenaStats()[0]!.growths;
    const geometry = meshes.pickables()[0]!.geometry;
    const capacity = capacityVertices(meshes, 0);

    meshes.settle();
    meshes.settle();

    expect(meshes.arenaStats()[0]!.growths).toBe(grown);
    expect(capacityVertices(meshes, 0)).toBe(capacity);
    // Not merely the same size — the same geometry, unrebound.
    expect(meshes.pickables()[0]!.geometry).toBe(geometry);
  });

  it('grows at most one super-mesh per settle()', () => {
    const sizes = new Map<number, number>([
      [ORIGIN, SMALL_RUN],
      [OTHER_SUPER, SMALL_RUN],
    ]);
    const { meshes, clock } = settleSetup(
      [chunkPayload(0, 0, 0), chunkPayload(SUPER_MESH_SPAN_CHUNKS, 0, 0)],
      sizes,
    );
    stream(clock);
    expect(meshes.drawCallCount()).toBe(2);
    clock.advance(TERRAIN_QUIET_MS);

    const total = (): number =>
      meshes.arenaStats().reduce((sum, stats) => sum + stats.growths, 0);
    expect(total()).toBe(0);
    meshes.settle();
    expect(total()).toBe(1);
    meshes.settle();
    expect(total()).toBe(2);
    // Both have their headroom now; a third call grows nothing.
    meshes.settle();
    expect(total()).toBe(2);
  });

  it('does not grow before TERRAIN_QUIET_MS has passed since the last update', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock, mirror } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);

    // One millisecond short of the window is still a stroke in progress.
    clock.advance(TERRAIN_QUIET_MS - 1);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);

    clock.advance(1);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(1);

    // And a fresh update re-opens the window: the next stroke step must not
    // find a growth pass running between its intents.
    meshes.update(
      applyTerrainDiff(mirror, { type: 'terrainDiff', cells: [{ x: 2, y: 3, h: 256 }] }),
    );
    stream(clock);
    const afterUpdate = meshes.arenaStats()[0]!.growths;
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(afterUpdate);
  });

  it('is not quiet while a chunk of that super-mesh is still in flight', async () => {
    const sizes = new Map<number, number>([
      [ORIGIN, SMALL_RUN],
      [NEIGHBOUR, SMALL_RUN],
    ]);
    const { meshes, clock, held, mirror } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    expect(meshes.builtChunkCount()).toBe(1);

    // A second chunk of the SAME super-mesh, with its answer withheld.
    held.hold();
    meshes.update(
      applySnapshot(mirror, {
        type: 'snapshot',
        worldSize: WORLD,
        chunks: [chunkPayload(0, 0, 0), chunkPayload(1, 0, 0)],
      }),
    );
    clock.frame();
    expect(meshes.pendingCount()).toBeGreaterThan(0);

    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    // Not merely "no growth counted": the super-mesh is still short, which is
    // what makes the refusal the quiet gate's doing rather than a coincidence.
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
    expect(capacityVertices(meshes, 0) - meshes.arenaStats()[0]!.liveEnd).toBeLessThan(
      expectedHeadroom(SMALL_RUN),
    );

    // Answered, and the queue is empty: the same super-mesh now gets it.
    await held.release();
    clock.frame();
    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    const stats = meshes.arenaStats()[0]!;
    expect(capacityVertices(meshes, 0) - stats.liveEnd).toBeGreaterThanOrEqual(
      expectedHeadroom(SMALL_RUN),
    );
  });

  it('is not quiet while a chunk of that super-mesh is waiting to be retried', async () => {
    const sizes = new Map<number, number>([
      [ORIGIN, SMALL_RUN],
      [NEIGHBOUR, SMALL_RUN],
    ]);
    const { meshes, clock, held, mirror } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);

    held.hold();
    meshes.update(
      applySnapshot(mirror, {
        type: 'snapshot',
        worldSize: WORLD,
        chunks: [chunkPayload(0, 0, 0), chunkPayload(1, 0, 0)],
      }),
    );
    clock.frame();
    // A lost build: the chunk goes to `retry` and is folded back into the queue
    // at the top of the next pass. It is still "not yet drawn".
    await held.lose();
    expect(meshes.pendingCount()).toBeGreaterThan(0);

    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
  });

  it('counts a growth taken during a splice as a STROKE growth', () => {
    // The backstop, not the rule: a stroke longer than its headroom still
    // grows, and what the contract owes is that the growth is COUNTED.
    const a = chunkIndex(WORLD, 0, 0);
    const b = chunkIndex(WORLD, 1, 0);
    const sizes = new Map<number, number>([
      [a, 1500],
      [b, 1500],
    ]);
    const { meshes } = arenaSetup(2, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ growths: 0, strokeGrowths: 0 });

    sizes.set(a, 1560);
    meshes.update([a]);

    expect(meshes.arenaStats()[0]).toMatchObject({ growths: 1, strokeGrowths: 1 });
  });

  it('preserves every run when it grows on settle(), holes and all', () => {
    // A HOLE UNDER THE GROWTH, deliberately. `settle` reallocates directly —
    // it does not take the append path's compaction sweep first — so it is a
    // way to reach `ensureSuperCapacity` with the arena FRAGMENTED, and the
    // four preserving copies there are written in `liveEnd` (the extent) for
    // exactly this case: copying `liveCount` (the sum of the runs) would drop
    // every live vertex above the hole.
    const THIRD = chunkIndex(WORLD, 2, 0);
    const chunks = [chunkPayload(0, 0, 0), chunkPayload(1, 0, 0), chunkPayload(2, 0, 0)];
    /**
     * A run the compactor cannot afford to move on an idle frame — one whole
     * triangle past ARENA_COMPACT_IDLE_BUDGET_MS at ARENA_TRANSFER_MS_PER_VERTEX.
     * WITHOUT IT THERE IS NO HOLE TO GROW OVER: the frame hook compacts after
     * every drain, and a hole under a movable run is closed on the next frame.
     */
    const TOO_DEAR_TO_MOVE_RUN =
      (Math.floor(
        ARENA_COMPACT_IDLE_BUDGET_MS / ARENA_TRANSFER_MS_PER_VERTEX / VERTICES_PER_TRIANGLE,
      ) +
        1) *
      VERTICES_PER_TRIANGLE;
    /**
     * Three runs, then the middle one shrinks — which opens a hole below the
     * third run rather than at the live end, so it stays on the free list
     * instead of retreating.
     */
    const build = () => {
      const sizes = new Map<number, number>([
        [ORIGIN, SMALL_RUN],
        [NEIGHBOUR, SMALL_RUN * 2],
        [THIRD, TOO_DEAR_TO_MOVE_RUN],
      ]);
      const world = settleSetup(chunks, sizes);
      stream(world.clock);
      sizes.set(NEIGHBOUR, SMALL_RUN);
      world.meshes.update([NEIGHBOUR]);
      stream(world.clock);
      return world;
    };
    const { meshes, clock } = build();
    // The same world, with the same history, never settled — the oracle.
    const reference = build();
    expect(meshes.arenaStats()[0]!.holeCount).toBe(1);
    expect(meshes.arenaStats()[0]!.liveEnd).toBeGreaterThan(
      meshes.arenaStats()[0]!.liveCount,
    );

    // A delta, not an absolute: the stream itself climbs the doubling ladder,
    // and those growths are streaming cost, off the stroke and accepted.
    const streamed = meshes.arenaStats()[0]!.growths;
    const streamedInSplice = meshes.arenaStats()[0]!.strokeGrowths;
    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(streamed + 1);
    // And settle's growth is not charged to the splice path.
    expect(meshes.arenaStats()[0]!.strokeGrowths).toBe(streamedInSplice);

    expectSlotsEqual(meshes, reference.meshes);
    expectHoleInvariants(meshes);
    // The draw range still covers the EXTENT, hole included — a range cut back
    // to the count sum would leave the third run undrawn.
    expect(meshes.pickables()[0]!.geometry.drawRange.count).toBe(
      meshes.arenaStats()[0]!.liveEnd,
    );
  });
});
