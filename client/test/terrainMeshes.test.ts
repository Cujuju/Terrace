import { describe, expect, it } from 'vitest';
import {
  BufferAttribute,
  Group,
  type BufferGeometry,
  type Material,
} from 'three';
import type { MeshStandardNodeMaterial } from 'three/webgpu';
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
  CHUNK_ANSWER_BACKLOG_CAP,
  CHUNK_SPLICE_FRAME_BUDGET_MS,
  SLOT_SLACK_FACTOR,
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
  COMPONENTS_PER_COLOR,
  INITIAL_CHUNK_TRIANGLE_CAPACITY,
  VERTICES_PER_TRIANGLE,
} from '../src/terrain/vertexGrid.ts';
import { BAND_WORLD_HEIGHT, CELL_WORLD_SIZE } from '../src/config.ts';

const WORLD = NEIGHBOURHOOD_CELLS * 4;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;
const FLAT_CHUNK_VERTEX_COUNT = 2 * VERTICES_PER_TRIANGLE;

function chunkPayload(cx: number, cy: number, fill: number): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

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
      for (const name of ['position', /* 'normal', */ 'color'] as const) {
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

function sizedSource(sizes: Map<number, number>): ChunkBuildSource {
  const direct = createDirectChunkBuildSource();
  return {
    concurrency: 1,
    build(mirror, chunkIdx, generation): ChunkJobAnswer | null {
      const real = direct.build(mirror, chunkIdx, generation) as ChunkJobAnswer | null;
      const want = sizes.get(chunkIdx);
      if (real === null || want === undefined) return real;
      const positions = new Float32Array(want * 3);
      // const normals = new Int8Array(want * 3);
      const colors = new Uint8Array(want * 3);
      for (let v = 0; v < want; v++) {
        positions[v * 3] = chunkIdx + 1;
        positions[v * 3 + 1] = v + 1;
        positions[v * 3 + 2] = 1;
        // dead attribute: normals[v * 3] = 1;
        // dead attribute: normals[v * 3 + 1] = 2;
        // dead attribute: normals[v * 3 + 2] = 3;
        colors[v * 3] = 7;
        colors[v * 3 + 1] = 8;
        colors[v * 3 + 2] = 9;
      }
      return {
        ...real,
        vertexCount: want,
        positions,
        // normals,
        colors,
        bounds: new Float32Array([1, 1, 1, chunkIdx + 1, want, 1]),
      };
    },
    dispose(): void {},
  };
}

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
      expect(hole.offset % VERTICES_PER_TRIANGLE).toBe(0);
      expect(hole.length % VERTICES_PER_TRIANGLE).toBe(0);
      if (h > 0) {
        const previous = holes[h - 1]!;
        expect(previous.offset + previous.length).toBeLessThan(hole.offset);
      }
      expect(hole.offset + hole.length).toBeLessThan(liveEnd);
      total += hole.length;
    }
    expect(total).toBe(deadVertices);

    const live = new Uint8Array(liveEnd);
    const claimed = new Uint8Array(liveEnd);
    for (const hole of holes) claimed.fill(1, hole.offset, hole.offset + hole.length);
    for (const slot of slots) {
      expect(slot.offset % VERTICES_PER_TRIANGLE).toBe(0);
      expect(slot.count % VERTICES_PER_TRIANGLE).toBe(0);
      expect(slot.capacity % VERTICES_PER_TRIANGLE).toBe(0);
      expect(slot.capacity).toBeGreaterThanOrEqual(slot.count);
      expect(slot.offset + slot.capacity).toBeLessThanOrEqual(liveEnd);
      for (let v = slot.offset; v < slot.offset + slot.capacity; v++) {
        expect(claimed[v], `vertex ${v} is claimed twice`).toBe(0);
        claimed[v] = 1;
      }
      live.fill(1, slot.offset, slot.offset + slot.count);
    }
    expect(claimed.indexOf(0), 'a vertex under the live end belongs to no slot and no hole')
      .toBe(-1);
    const geometry = meshes.pickables()[s]!.geometry;
    for (const name of ['position', /* 'normal', */ 'color'] as const) {
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

function arenaChunks(count: number): ChunkPayload[] {
  const chunks: ChunkPayload[] = [];
  for (let i = 0; i < count; i++) {
    chunks.push(chunkPayload(i % SUPER_MESH_SPAN_CHUNKS, Math.floor(i / SUPER_MESH_SPAN_CHUNKS), 0));
  }
  return chunks;
}

function arenaSetup(count: number, sizes: Map<number, number>) {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror, undefined, sizedSource(sizes));
  const chunks = arenaChunks(count);
  const dirty = applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks });
  meshes.update([...dirty].sort((a, b) => a - b));
  return { mirror, group, meshes };
}

describe('createTerrainMeshes', () => {
  it('merges received chunks into one drawn mesh, and builds none for locked chunks', () => {
    const { group, meshes } = setup([chunkPayload(0, 0, 100), chunkPayload(1, 0, 100)]);
    expect(meshes.builtChunkCount()).toBe(2);
    expect(meshes.drawCallCount()).toBe(1);
    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()).toHaveLength(1);
  });

  it('ignores dirty indices for chunks that were never received', () => {
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
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);

    const mesh = meshes.pickables()[0];
    const geometryBefore = mesh.geometry;
    const positionBefore = plainAttribute(mesh.geometry, 'position');
    // const normalBefore = plainAttribute(mesh.geometry, 'normal');
    const colorBefore = plainAttribute(mesh.geometry, 'color');
    const positionArrayBefore = positionBefore.array;
    // const normalArrayBefore = normalBefore.array;
    const positionVersionBefore = positionBefore.version;
    // const normalVersionBefore = normalBefore.version;
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
    // expect(mesh.geometry.getAttribute('normal')).toBe(normalBefore);
    expect(mesh.geometry.getAttribute('color')).toBe(colorBefore);
    expect(mesh.geometry.getAttribute('position').array).toBe(positionArrayBefore);
    // expect(mesh.geometry.getAttribute('normal').array).toBe(normalArrayBefore);

    expect(positionBefore.version).toBeGreaterThan(positionVersionBefore);
    // expect(normalBefore.version).toBeGreaterThan(normalVersionBefore);
    expect(colorBefore.version).toBeGreaterThan(colorVersionBefore);
  });

  it('builds non-indexed geometry, so every triangle keeps its own crease', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 300)]);
    for (const mesh of meshes.pickables()) {
      expect(mesh.geometry.getIndex()).toBeNull();
    }
  });

  it('patches one chunk without disturbing the others, wherever the arena put them', () => {
    const chunks = [
      chunkPayload(0, 0, 0),
      chunkPayload(1, 0, 0),
      chunkPayload(2, 0, 0),
      chunkPayload(3, 0, 0),
    ];
    const built = setup(chunks);

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

    const freshMirror = createTerrainMirror(WORLD);
    applySnapshot(freshMirror, { type: 'snapshot', worldSize: WORLD, chunks });
    for (const diff of history) applyTerrainDiff(freshMirror, diff);
    const freshMeshes = createTerrainMeshes(new Group(), freshMirror);
    freshMeshes.update(freshMirror.received);

    expect(built.meshes.drawCallCount()).toBe(1);
    expectSlotsEqual(built.meshes, freshMeshes);
  });

  it('draws only the arena prefix of the buffers', () => {
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
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const geometry = meshes.pickables()[0].geometry;
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);

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

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 0 }],
      }),
    );
    const levelled = meshes.arenaStats()[0]!;
    expect(geometry.drawRange.count).toBe(levelled.liveEnd);
    expect(levelled.liveCount).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(levelled.paddingVertices).toBeGreaterThan(0);
    expect(levelled.liveEnd).toBe(levelled.liveCount + levelled.paddingVertices);

    meshes.settle({ assumeQuiet: true });
    const reclaimed = meshes.arenaStats()[0]!;
    expect(reclaimed.paddingVertices).toBe(0);
    expect(reclaimed.liveEnd).toBe(FLAT_CHUNK_VERTEX_COUNT);
    expect(geometry.drawRange.count).toBe(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('writes the new height into the patched chunk', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];

    meshes.update(
      applyTerrainDiff(mirror, {
        type: 'terrainDiff',
        cells: [{ x: 2, y: 3, h: 4 * BAND_HEIGHT }],
      }),
    );

    const position = mesh.geometry.getAttribute('position');
    let highest = -Infinity;
    for (let v = 0; v < mesh.geometry.drawRange.count; v++) {
      highest = Math.max(highest, position.getY(v));
    }
    expect(highest).toBeCloseTo(4 * BAND_WORLD_HEIGHT);
  });

  it('refreshes the bounding sphere so edited chunks stay pickable', () => {
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
    const lastChunk = WORLD / CHUNK_SIZE - 1;
    const { meshes } = setup([chunkPayload(lastChunk, lastChunk, 0)]);
    const sphere = meshes.pickables()[0].geometry.boundingSphere;
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
    expect(group.children).toHaveLength(1);
    expect(dirty.has(chunkIndex(WORLD, 0, 0))).toBe(true);
    const left = meshes.pickables()[0];
    expect(left.geometry.drawRange.count).toBeGreaterThan(FLAT_CHUNK_VERTEX_COUNT);
  });

  it('rebinds attributes when a chunk outgrows its buffers, keeping one geometry', () => {
    const { meshes, mirror, group } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const positionBefore = plainAttribute(mesh.geometry, 'position');

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

  function terrainMaterial(mesh: { material: Material | Material[] }): MeshStandardNodeMaterial {
    const material = mesh.material;
    if (Array.isArray(material)) throw new Error('expected a single material');
    return material as MeshStandardNodeMaterial;
  }

  it('carries the self-lit flag in the colour attribute alpha byte', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const attribute = plainAttribute(meshes.pickables()[0].geometry, 'color');
    expect(attribute.itemSize).toBe(COMPONENTS_PER_COLOR);
    expect(attribute.normalized).toBe(true);
    expect(attribute.array).toBeInstanceOf(Uint8Array);
    expect(attribute.count).toBe(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
  });

  it('re-uploads and rebinds the colour attribute, flag included, alongside the others', () => {
    const { meshes, mirror } = setup([chunkPayload(0, 0, 0)]);
    const mesh = meshes.pickables()[0];
    const before = plainAttribute(mesh.geometry, 'color');
    const versionBefore = before.version;

    meshes.update(
      applyTerrainDiff(mirror, { type: 'terrainDiff', cells: [{ x: 2, y: 3, h: 256 }] }),
    );
    expect(plainAttribute(mesh.geometry, 'color')).toBe(before);
    expect(before.version).toBeGreaterThan(versionBefore);

    const cells = [];
    for (let y = 0; y < CHUNK_SIZE; y++) {
      for (let x = 0; x < CHUNK_SIZE; x++) {
        cells.push({ x, y, h: Math.round(360 - 3 * ((x - 8) ** 2 + (y - 8) ** 2)) });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));
    const grown = plainAttribute(mesh.geometry, 'color');
    expect(grown).not.toBe(before);
    expect(grown.count).toBeGreaterThanOrEqual(mesh.geometry.drawRange.count);
  });

  it('composes the terrain colour and output slots instead of vertex colours', () => {
    const { meshes } = setup([chunkPayload(0, 0, 0)]);
    const material = terrainMaterial(meshes.pickables()[0]);
    expect(material.isNodeMaterial).toBe(true);
    expect(material.vertexColors).toBe(false);
    expect(material.colorNode).not.toBeNull();
    expect(material.outputNode).not.toBeNull();
  });

  it('drops every mesh on clear', () => {
    const { meshes, group } = setup([chunkPayload(0, 0, 0), chunkPayload(1, 1, 0)]);
    meshes.clear();
    expect(group.children).toHaveLength(0);
    expect(meshes.pickables()).toHaveLength(0);
  });
});

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
    const { meshes, clock } = scheduledSetup(
      FOUR_CHUNKS,
      CHUNK_SPLICE_FRAME_BUDGET_MS,
    );
    for (let built = 1; built <= 4; built++) {
      clock.frame();
      expect(meshes.builtChunkCount()).toBe(built);
      expect(meshes.pendingCount()).toBe(4 - built);
    }
    clock.frame();
    expect(meshes.builtChunkCount()).toBe(4);
  });

  it('always builds at least one chunk per frame, however over budget it is', () => {
    const { group, clock } = scheduledSetup(FOUR_CHUNKS, CHUNK_SPLICE_FRAME_BUDGET_MS * 10);
    clock.frame();
    expect(group.children).toHaveLength(1);
  });

  it('keeps drawing the previous mesh while a rebuild is queued', () => {
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

    expect(meshes.pendingCount()).toBe(1);
    expect(group.children).toHaveLength(1);
    expect(meshes.pickables()[0]).toBe(mesh);
    expect(mesh.geometry.drawRange.count).toBe(rangeBefore);

    clock.frame();
    expect(mesh.geometry.drawRange.count).toBeGreaterThan(rangeBefore);
  });

  it('builds a chunk once however many times it was dirtied first', () => {
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
    const { meshes } = scheduledSetup(FOUR_CHUNKS, 0);
    expect(meshes.pendingCount()).toBe(4);
    meshes.clear();
    expect(meshes.pendingCount()).toBe(0);
  });

  it('unsubscribes its frame handler on dispose', () => {
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

  const BACKLOG_SOURCE_CONCURRENCY = 3;
  const BACKLOG_STARVED_FRAMES = 12;
  const BACKLOG_CHUNK_ROWS = 4;

  function backlogSetup() {
    const direct = createDirectChunkBuildSource();
    const owed: (() => void)[] = [];
    let started = 0;
    let resolved = 0;
    const source: ChunkBuildSource = {
      concurrency: BACKLOG_SOURCE_CONCURRENCY,
      build(mirror, chunkIdx, generation) {
        started++;
        const answer = direct.build(mirror, chunkIdx, generation) as ChunkJobAnswer | null;
        return new Promise<ChunkJobAnswer | null>((resolve) => {
          owed.push(() => {
            resolved++;
            resolve(answer);
          });
        });
      },
      dispose(): void {},
    };

    const chunks: ChunkPayload[] = [];
    for (let cy = 0; cy < BACKLOG_CHUNK_ROWS; cy++) {
      for (let cx = 0; cx < WORLD / CHUNK_SIZE; cx++) chunks.push(chunkPayload(cx, cy, 100));
    }
    const mirror = createTerrainMirror(WORLD);
    const group = new Group();
    const clock = fakeScheduler(CHUNK_SPLICE_FRAME_BUDGET_MS);
    const meshes = createTerrainMeshes(group, mirror, clock.scheduling, source);
    meshes.update(applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks }));

    return {
      meshes,
      clock,
      inFlight: (): number => started - resolved,
      ready: (): number => resolved - meshes.loadTrace().chunksSpliced,
      async releaseAll(): Promise<void> {
        for (const finish of owed.splice(0)) finish();
        await new Promise<void>((resolve) => {
          setTimeout(resolve, 0);
        });
      },
    };
  }

  it('refills the build pool while spliced answers wait, and caps the answer backlog', async () => {
    const jobs = backlogSetup();

    jobs.clock.frame();
    expect(jobs.inFlight()).toBe(BACKLOG_SOURCE_CONCURRENCY);
    expect(jobs.ready()).toBe(0);

    await jobs.releaseAll();
    jobs.clock.frame();

    expect(jobs.meshes.loadTrace().chunksSpliced).toBe(1);
    expect(jobs.ready()).toBe(BACKLOG_SOURCE_CONCURRENCY - 1);
    expect(jobs.inFlight()).toBe(BACKLOG_SOURCE_CONCURRENCY);

    let maxReady = jobs.ready();
    for (let frame = 0; frame < BACKLOG_STARVED_FRAMES; frame++) {
      await jobs.releaseAll();
      jobs.clock.frame();
      maxReady = Math.max(maxReady, jobs.ready());
      expect(jobs.ready() + jobs.inFlight()).toBeLessThanOrEqual(CHUNK_ANSWER_BACKLOG_CAP);
    }
    expect(maxReady).toBeGreaterThan(BACKLOG_SOURCE_CONCURRENCY);
    expect(maxReady).toBeLessThanOrEqual(CHUNK_ANSWER_BACKLOG_CAP);
  });

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

    sizes.set(chunkIndex(WORLD, 0, 0), 3);
    meshes.update([chunkIndex(WORLD, 0, 0)]);
    clock.frame();
    expect(meshes.arenaStats()[0]).toMatchObject({
      paddingVertices: 297,
      deadVertices: 0,
      holeCount: 0,
    });
    meshes.settle({ assumeQuiet: true });
    expect(meshes.arenaStats()[0]).toMatchObject({ deadVertices: 297, holeCount: 1 });

    const sphereBefore = meshes.pickables()[0]!.geometry.boundingSphere!.clone();

    clock.frame();
    expect(meshes.arenaStats()[0]).toMatchObject({ deadVertices: 0, holeCount: 0 });
    const sphereAfter = meshes.pickables()[0]!.geometry.boundingSphere!;
    expect(sphereAfter.center.equals(sphereBefore.center)).toBe(true);
    expect(sphereAfter.radius).toBe(sphereBefore.radius);
  });

  it('converges to a hole-free arena within one sweep of idle frames', () => {
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
    expect(stats.liveEnd).toBe(stats.liveCount + stats.paddingVertices);
    expect(frames).toBeLessThan(MAX_SWEEP_FRAMES);
  });
});

function slackVertices(count: number): number {
  return Math.ceil((count * SLOT_SLACK_FACTOR) / VERTICES_PER_TRIANGLE) * VERTICES_PER_TRIANGLE;
}

describe('the vertex arena', () => {
  const RUN = 100 * VERTICES_PER_TRIANGLE;

  it('uploads only the chunk it spliced, however many runs follow it', () => {
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

    const geometry = meshes.pickables()[0]!.geometry;
    const attributes = (['position', /* 'normal', */ 'color'] as const).map((name) =>
      plainAttribute(geometry, name),
    );
    for (const attribute of attributes) attribute.clearUpdateRanges();

    let ranges: { start: number; count: number }[][] = [];
    meshes.onChunkDrawn(() => {
      ranges = attributes.map((attribute) => attribute.updateRanges.map((r) => ({ ...r })));
    });
    sizes.set(first, RUN * 2);
    meshes.update([first]);

    expect(meshes.arenaStats()[0]!.growths).toBe(growthsBefore);
    for (let a = 0; a < attributes.length; a++) {
      const stride = attributes[a]!.itemSize;
      expect(ranges[a], `${attributes[a]!.itemSize}-component attribute`).toEqual([
        { start: liveEndBefore * stride, count: slackVertices(RUN * 2) * stride },
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
    expect(stats.paddingVertices).toBeGreaterThan(0);
    expect(stats.liveEnd).toBe(stats.liveCount + stats.paddingVertices);
  });

  it('extends a run in place when it already ends at the live end', () => {
    const first = chunkIndex(WORLD, 0, 0);
    const sizes = new Map<number, number>([[first, RUN]]);
    const { meshes } = arenaSetup(1, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: RUN, holeCount: 0, growths: 0 });

    sizes.set(first, RUN * 3);
    const seen: ArenaLayout[] = [];
    meshes.onChunkDrawn(() => seen.push(meshes.arenaLayout()[0]!));
    meshes.update([first]);

    const capacity = slackVertices(RUN * 3);
    expect(seen[0]!.holes).toEqual([]);
    expect(seen[0]!.slots).toEqual([{ chunkIdx: first, offset: 0, count: RUN * 3, capacity }]);
    expect(meshes.arenaStats()[0]).toMatchObject({
      liveEnd: capacity,
      liveCount: RUN * 3,
      paddingVertices: capacity - RUN * 3,
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

    sizes.set(a, 3);
    const seen: ArenaLayout[] = [];
    const liveEnds: number[] = [];
    meshes.onChunkDrawn(() => {
      seen.push(meshes.arenaLayout()[0]!);
      liveEnds.push(meshes.arenaStats()[0]!.liveEnd);
    });
    meshes.update([a]);
    // A shrink keeps its capacity, so the hole b first-fits into opens only at settle.
    meshes.settle({ assumeQuiet: true });
    sizes.set(b, 450);
    meshes.update([b]);

    const capacity = slackVertices(450);
    const afterFirstFit = seen[1]!;
    expect(afterFirstFit.slots.find((slot) => slot.chunkIdx === b)).toEqual({
      chunkIdx: b,
      offset: 3,
      count: 450,
      capacity,
    });
    expect(afterFirstFit.holes).toEqual([{ offset: 3 + capacity, length: 900 - (3 + capacity) }]);
    expect(liveEnds).toEqual([1500, 1500]);
  });

  it('sizes an append from the run\'s COUNT, not from its delta', () => {
    const a = chunkIndex(WORLD, 0, 0);
    const b = chunkIndex(WORLD, 1, 0);
    const capacity = INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE;
    const sizes = new Map<number, number>([[a, 1500], [b, 1500]]);
    const { meshes } = arenaSetup(2, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: 3000, growths: 0 });

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
    const THREE_RUNS = RUN * 3;
    const REGROWN = 1005;
    const sizes = new Map<number, number>([
      [a, THREE_RUNS],
      [b, THREE_RUNS],
      [chunkIndex(WORLD, 2, 0), THREE_RUNS],
    ]);
    const { meshes } = arenaSetup(3, sizes);
    expect(meshes.arenaStats()[0]).toMatchObject({ liveEnd: THREE_RUNS * 3, growths: 0 });

    sizes.set(b, 3);
    const seen: ArenaLayout[] = [];
    meshes.onChunkDrawn(() => seen.push(meshes.arenaLayout()[0]!));
    meshes.update([b]);
    meshes.settle({ assumeQuiet: true });
    sizes.set(a, REGROWN);
    meshes.update([a]);

    const capacity = slackVertices(REGROWN);
    expect(THREE_RUNS * 3 + capacity).toBeGreaterThan(
      INITIAL_CHUNK_TRIANGLE_CAPACITY * VERTICES_PER_TRIANGLE,
    );
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
    expect(seen[1]!.slots.find((slot) => slot.chunkIdx === a)).toEqual({
      chunkIdx: a,
      offset: THREE_RUNS * 2 + 3,
      count: REGROWN,
      capacity,
    });
    expectHoleInvariants(meshes);
  });
});

describe('slot slack', () => {
  const START_VERTICES = 300;
  const STEP_GROWTH = 1.1;
  const IN_PLACE_STEPS = 3;
  /** Dearer than the stroke compaction budget, so no run moves while the stroke runs. */
  const UNMOVABLE_RUN_VERTICES =
    (Math.floor(
      ARENA_COMPACT_STROKE_BUDGET_MS / ARENA_TRANSFER_MS_PER_VERTEX / VERTICES_PER_TRIANGLE,
    ) +
      1) *
    VERTICES_PER_TRIANGLE;

  it('relocates once, then keeps a growing chunk in place until the terrain is quiet', () => {
    const grower = chunkIndex(WORLD, 0, 0);
    const tail = chunkIndex(WORLD, 2, 0);
    const sizes = new Map<number, number>([
      [grower, START_VERTICES],
      [chunkIndex(WORLD, 1, 0), UNMOVABLE_RUN_VERTICES],
      [tail, START_VERTICES],
    ]);
    const mirror = createTerrainMirror(WORLD);
    const clock = fakeScheduler(0);
    const meshes = createTerrainMeshes(new Group(), mirror, clock.scheduling, sizedSource(sizes));
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: arenaChunks(3),
    });
    meshes.update([...dirty].sort((a, b) => a - b));
    clock.frame();

    const slotOf = (chunkIdx: number) =>
      meshes.arenaLayout()[0]!.slots.find((slot) => slot.chunkIdx === chunkIdx)!;
    expect(slotOf(grower)).toMatchObject({ count: START_VERTICES, capacity: START_VERTICES });

    const offsets: number[] = [];
    const capacities: number[] = [];
    let vertices = START_VERTICES;
    for (let step = 0; step < IN_PLACE_STEPS; step++) {
      vertices = Math.round((vertices * STEP_GROWTH) / VERTICES_PER_TRIANGLE) *
        VERTICES_PER_TRIANGLE;
      sizes.set(grower, vertices);
      meshes.update([grower]);
      clock.frame();
      offsets.push(slotOf(grower).offset);
      capacities.push(slotOf(grower).capacity);
    }

    const relocated = slackVertices(START_VERTICES * STEP_GROWTH);
    expect(offsets[0]).not.toBe(0);
    expect(offsets).toEqual([offsets[0], offsets[0], offsets[0]]);
    expect(capacities).toEqual([relocated, relocated, relocated]);
    expect(vertices).toBeLessThanOrEqual(relocated);
    expect(meshes.arenaStats()[0]).toMatchObject({
      paddingVertices: relocated - vertices,
      deadVertices: START_VERTICES,
      holeCount: 1,
    });

    // Quiet: the padding goes back on the free list. This slot ends the arena, so the
    // live end swallows it rather than leaving a hole.
    meshes.settle({ assumeQuiet: true });
    const settled = meshes.arenaStats()[0]!;
    expect(settled.paddingVertices).toBe(0);
    expect(settled.deadVertices).toBe(START_VERTICES);
    expect(settled.holeCount).toBe(1);
    expect(settled.liveEnd).toBe(settled.liveCount + settled.deadVertices);
    expect(slotOf(grower)).toMatchObject({ count: vertices, capacity: vertices });
  });
});

const ARENA_ATTRIBUTES = ['position', /* 'normal', */ 'color'] as const;

interface AttributeShadow {
  attribute: BufferAttribute;
  bytes: Float64Array;
  version: number;
}

// Mirrors three's WebGLAttributes: a fresh attribute uploads whole, a dirtied one uploads
// its update ranges — or whole, if it has none — and clears them.
function gpuShadow(meshes: TerrainMeshes) {
  const shadows = new Map<string, AttributeShadow>();
  const copyWhole = (into: Float64Array, attribute: BufferAttribute): void => {
    for (let i = 0; i < attribute.array.length; i++) into[i] = attribute.array[i]!;
  };
  return {
    present(): void {
      const drawn = meshes.pickables();
      for (let s = 0; s < drawn.length; s++) {
        for (const name of ARENA_ATTRIBUTES) {
          const attribute = plainAttribute(drawn[s]!.geometry, name);
          const seen = shadows.get(`${s}:${name}`);
          if (seen === undefined || seen.attribute !== attribute) {
            const bytes = new Float64Array(attribute.array.length);
            copyWhole(bytes, attribute);
            shadows.set(`${s}:${name}`, { attribute, bytes, version: attribute.version });
            continue;
          }
          if (seen.version >= attribute.version) continue;
          seen.version = attribute.version;
          if (attribute.updateRanges.length === 0) copyWhole(seen.bytes, attribute);
          else {
            for (const range of attribute.updateRanges) {
              for (let i = range.start; i < range.start + range.count; i++) {
                seen.bytes[i] = attribute.array[i]!;
              }
            }
            attribute.clearUpdateRanges();
          }
        }
      }
    },
    verify(label: string): void {
      const layouts = meshes.arenaLayout();
      const stats = meshes.arenaStats();
      const drawn = meshes.pickables();
      for (let s = 0; s < drawn.length; s++) {
        const { liveEnd } = stats[s]!;
        expect(drawn[s]!.geometry.drawRange.count, `${label}: draw range`).toBe(liveEnd);
        const live = new Uint8Array(liveEnd);
        for (const slot of layouts[s]!.slots) {
          live.fill(1, slot.offset, slot.offset + slot.count);
        }
        for (const name of ARENA_ATTRIBUTES) {
          const attribute = plainAttribute(drawn[s]!.geometry, name);
          const bytes = shadows.get(`${s}:${name}`)!.bytes;
          const stride = attribute.itemSize;
          for (let v = 0; v < liveEnd; v++) {
            for (let c = 0; c < stride; c++) {
              const at = v * stride + c;
              if (bytes[at] !== attribute.array[at]) {
                expect.fail(
                  `${label}: super ${String(s)} ${name} vertex ${String(v)} is ` +
                    `${String(bytes[at])} on the GPU and ${String(attribute.array[at])} on the CPU`,
                );
              }
              if (live[v] === 0 && bytes[at] !== 0) {
                expect.fail(
                  `${label}: super ${String(s)} ${name} vertex ${String(v)} is in the draw ` +
                    `range and in no slot, but ${String(bytes[at])} on the GPU`,
                );
              }
            }
          }
        }
      }
    },
  };
}

describe('the GPU shadow of the arena', () => {
  const SHADOW_CHUNKS = 3;
  /** Dearer than the stroke compaction budget, so a hole under it outlives the frame. */
  const SHADOW_UNMOVABLE_RUN_VERTICES =
    (Math.floor(
      ARENA_COMPACT_STROKE_BUDGET_MS / ARENA_TRANSFER_MS_PER_VERTEX / VERTICES_PER_TRIANGLE,
    ) +
      1) *
    VERTICES_PER_TRIANGLE;
  const SHADOW_START_VERTICES = [1002, SHADOW_UNMOVABLE_RUN_VERTICES, 2004];
  const SHADOW_QUIET_FRAMES = 4;
  /** One chunk's ratio sequence, rotated per chunk so the three never move together. */
  const RATIO_ROTATION = 7;
  const STROKE_RATIOS = [
    1, 1.006, 1, 1.012, 0.994, 1.017, 1, 1.009, 1.015, 1, 1.004, 1.011,
    1.5, 1.002, 1, 1.013, 1.007, 1, 0.5, 1.018, 1, 1.006, 1.014, 1.001,
  ];

  const wholeTriangles = (vertices: number): number =>
    Math.max(VERTICES_PER_TRIANGLE, Math.round(vertices / VERTICES_PER_TRIANGLE) * VERTICES_PER_TRIANGLE);

  function shadowSetup(sizes: Map<number, number>) {
    const mirror = createTerrainMirror(WORLD);
    const group = new Group();
    const clock = fakeScheduler(0);
    const meshes = createTerrainMeshes(group, mirror, clock.scheduling, sizedSource(sizes));
    const dirty = applySnapshot(mirror, {
      type: 'snapshot',
      worldSize: WORLD,
      chunks: arenaChunks(SHADOW_CHUNKS),
    });
    meshes.update([...dirty].sort((a, b) => a - b));
    return { meshes, clock };
  }

  it('keeps the GPU byte-for-byte equal to the CPU below the live end, all stroke long', () => {
    const at = (chunk: number): number => chunkIndex(WORLD, chunk, 0);
    const sizes = new Map<number, number>();
    for (let c = 0; c < SHADOW_CHUNKS; c++) sizes.set(at(c), SHADOW_START_VERTICES[c]!);
    const { meshes, clock } = shadowSetup(sizes);
    const gpu = gpuShadow(meshes);

    clock.frame();
    gpu.present();
    gpu.verify('load');

    for (let intent = 0; intent < STROKE_RATIOS.length; intent++) {
      const dirty: number[] = [];
      for (let c = 0; c < SHADOW_CHUNKS; c++) {
        const ratio = STROKE_RATIOS[(intent + c * RATIO_ROTATION) % STROKE_RATIOS.length]!;
        sizes.set(at(c), wholeTriangles(sizes.get(at(c))! * ratio));
        dirty.push(at(c));
      }
      meshes.update(dirty);
      clock.frame();
      gpu.present();
      gpu.verify(`intent ${String(intent)}`);
    }

    for (let pass = 0; pass < SHADOW_QUIET_FRAMES; pass++) {
      meshes.settle({ assumeQuiet: true });
      clock.frame();
      gpu.present();
      gpu.verify(`quiet ${String(pass)}`);
    }
    expect(meshes.arenaStats()[0]!.growths).toBeGreaterThan(0);
  });
});

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
  const drainMicrotasks = (): Promise<void> =>
    new Promise<void>((resolve) => {
      setTimeout(resolve, 0);
    });
  return {
    source,
    hold(): void {
      holding = true;
    },
    async release(): Promise<void> {
      for (const job of held.splice(0)) job.resolve(job.answer);
      await drainMicrotasks();
    },
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
  meshes.update([...dirty].sort((a, b) => a - b));
  return { mirror, group, meshes, clock, held };
}

function capacityVertices(meshes: TerrainMeshes, s: number): number {
  return plainAttribute(meshes.pickables()[s]!.geometry, 'position').array.length / 3;
}

function expectedHeadroom(largestRunVertices: number): number {
  return Math.max(
    ARENA_HEADROOM_RUN_MULTIPLE * largestRunVertices,
    ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
  );
}

describe('headroom at settle', () => {
  const ORIGIN = chunkIndex(WORLD, 0, 0);
  const NEIGHBOUR = chunkIndex(WORLD, 1, 0);
  const OTHER_SUPER = chunkIndex(WORLD, SUPER_MESH_SPAN_CHUNKS, 0);
  const SMALL_RUN = 1000 * VERTICES_PER_TRIANGLE;
  const LARGE_RUN = 30_000 * VERTICES_PER_TRIANGLE;

  function stream(clock: ReturnType<typeof settleScheduler>): void {
    clock.frame();
    clock.frame();
    clock.frame();
  }

  it('grows on a FRAME, with no explicit settle() call', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    expect(meshes.arenaStats()[0]!.growths).toBe(0);

    clock.advance(TERRAIN_QUIET_MS);
    clock.frame();

    expect(meshes.arenaStats()[0]!.growths).toBe(1);
    expect(capacityVertices(meshes, 0) - meshes.arenaStats()[0]!.liveEnd).toBeGreaterThanOrEqual(
      expectedHeadroom(SMALL_RUN),
    );
  });

  it('is NOT settled by flush(), however quiet the terrain has gone', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    clock.advance(TERRAIN_QUIET_MS);

    meshes.flush();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);

    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(1);
  });

  it('settle({ assumeQuiet }) skips the clock, so a harness can name the moment', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);

    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);

    meshes.settle({ assumeQuiet: true });
    expect(meshes.arenaStats()[0]!.growths).toBe(1);
  });

  it('settle({ assumeQuiet }) still refuses a super-mesh with a chunk queued', () => {
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
    expect(meshes.pendingCount()).toBeGreaterThan(0);

    meshes.settle({ assumeQuiet: true });
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
  });

  it('grows a quiet super-mesh that is under its headroom, to at least the floor', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);
    const before = meshes.arenaStats()[0]!;
    expect(before.growths).toBe(0);
    expect(capacityVertices(meshes, 0) - before.liveEnd).toBeLessThan(
      expectedHeadroom(SMALL_RUN),
    );

    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();

    const after = meshes.arenaStats()[0]!;
    expect(after.growths).toBe(1);
    expect(ARENA_HEADROOM_RUN_MULTIPLE * SMALL_RUN).toBeLessThan(
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );
    expect(capacityVertices(meshes, 0) - after.liveEnd).toBeGreaterThanOrEqual(
      ARENA_HEADROOM_FLOOR_TRIANGLES * VERTICES_PER_TRIANGLE,
    );
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
    meshes.settle();
    expect(total()).toBe(2);
  });

  it('does not grow before TERRAIN_QUIET_MS has passed since the last update', () => {
    const sizes = new Map<number, number>([[ORIGIN, SMALL_RUN]]);
    const { meshes, clock, mirror } = settleSetup([chunkPayload(0, 0, 0)], sizes);
    stream(clock);

    clock.advance(TERRAIN_QUIET_MS - 1);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);

    clock.advance(1);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(1);

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
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
    expect(capacityVertices(meshes, 0) - meshes.arenaStats()[0]!.liveEnd).toBeLessThan(
      expectedHeadroom(SMALL_RUN),
    );

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
    await held.lose();
    expect(meshes.pendingCount()).toBeGreaterThan(0);

    clock.advance(TERRAIN_QUIET_MS);
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(0);
  });

  it('counts a growth taken during a splice as a STROKE growth', () => {
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
    const THIRD = chunkIndex(WORLD, 2, 0);
    const chunks = [chunkPayload(0, 0, 0), chunkPayload(1, 0, 0), chunkPayload(2, 0, 0)];
    const TOO_DEAR_TO_MOVE_RUN =
      (Math.floor(
        ARENA_COMPACT_IDLE_BUDGET_MS / ARENA_TRANSFER_MS_PER_VERTEX / VERTICES_PER_TRIANGLE,
      ) +
        1) *
      VERTICES_PER_TRIANGLE;
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
    const reference = build();
    expect(meshes.arenaStats()[0]).toMatchObject({
      holeCount: 0,
      paddingVertices: SMALL_RUN,
    });
    expect(meshes.arenaStats()[0]!.liveEnd).toBeGreaterThan(
      meshes.arenaStats()[0]!.liveCount,
    );

    const streamed = meshes.arenaStats()[0]!.growths;
    const streamedInSplice = meshes.arenaStats()[0]!.strokeGrowths;
    clock.advance(TERRAIN_QUIET_MS);
    // The first quiet settle reclaims the slack; the growth is the settle after it.
    meshes.settle();
    expect(meshes.arenaStats()[0]).toMatchObject({
      holeCount: 1,
      paddingVertices: 0,
      growths: streamed,
    });
    meshes.settle();
    expect(meshes.arenaStats()[0]!.growths).toBe(streamed + 1);
    expect(meshes.arenaStats()[0]!.strokeGrowths).toBe(streamedInSplice);

    expectSlotsEqual(meshes, reference.meshes);
    expectHoleInvariants(meshes);
    expect(meshes.pickables()[0]!.geometry.drawRange.count).toBe(
      meshes.arenaStats()[0]!.liveEnd,
    );
  });
});
