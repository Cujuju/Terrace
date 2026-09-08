import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { CHUNK_SIZE, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, applyChunkUnlock, createTerrainMirror } from '../src/terrain/mirror.ts';
import {
  INDICES_PER_SEGMENT,
  VERTICES_PER_SEGMENT,
  createFrontierFog,
} from '../src/render/frontierFog.ts';
import { SUPER_MESH_SPAN_CHUNKS } from '../src/render/terrainMeshes.ts';

const WORLD_CHUNKS = 4;
const WORLD = CHUNK_SIZE * WORLD_CHUNKS;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill = 0): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

function noopOnFrame(): () => void {
  return () => {};
}

function fogGroup(parent: Group): Group {
  const child = parent.children[0];
  if (!(child instanceof Group)) throw new Error('expected the fog sub-group');
  return child;
}

function drawnSlots(parent: Group): string[] {
  const slots: string[] = [];
  for (const child of fogGroup(parent).children) {
    if (!(child instanceof Mesh)) throw new Error('expected a Mesh');
    const geometry = child.geometry;
    const index = geometry.getIndex();
    if (index === null) throw new Error('expected indexed fog geometry');
    const positions = geometry.getAttribute('position');
    const liveSlots = geometry.drawRange.count / INDICES_PER_SEGMENT;
    expect(Number.isInteger(liveSlots)).toBe(true);
    for (let slot = 0; slot < liveSlots; slot++) {
      const first = slot * VERTICES_PER_SEGMENT;
      const vertices: string[] = [];
      for (let v = first; v < first + VERTICES_PER_SEGMENT; v++) {
        vertices.push(`${positions.getX(v)},${positions.getY(v)},${positions.getZ(v)}`);
      }
      slots.push(vertices.join('|'));
    }
  }
  return slots.sort();
}

describe('createFrontierFog', () => {
  it('draws nothing before any chunk is received', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(mirror);
    expect(fog.segmentCount()).toBe(0);
    expect(fog.drawCallCount()).toBe(0);
    expect(fogGroup(group).children).toHaveLength(0);
  });

  it('draws one segment per exposed side of a single received chunk', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(1, 1)]));

    expect(fog.segmentCount()).toBe(4);
  });

  it('removes the shared segment when the neighbouring chunk arrives, and adds its new outer sides', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));
    expect(fog.segmentCount()).toBe(4);

    applyChunkUnlock(mirror, { type: 'chunkUnlock', chunks: [chunkPayload(1, 0)] });
    fog.sync(mirror);

    expect(fog.segmentCount()).toBe(6);
  });

  it('draws the same geometry however the segments got there', () => {
    const chunks = [chunkPayload(0, 0), chunkPayload(1, 0)];

    const grown = new Group();
    const grownFog = createFrontierFog(grown, noopOnFrame);
    const growing = createTerrainMirror(WORLD);
    grownFog.sync(applySnapshotInto(growing, [chunkPayload(0, 0)]));
    applyChunkUnlock(growing, { type: 'chunkUnlock', chunks: [chunkPayload(1, 0)] });
    grownFog.sync(growing);

    const fresh = new Group();
    const freshFog = createFrontierFog(fresh, noopOnFrame);
    freshFog.sync(applySnapshotInto(createTerrainMirror(WORLD), chunks));

    expect(grownFog.segmentCount()).toBe(freshFog.segmentCount());
    expect(drawnSlots(grown)).toEqual(drawnSlots(fresh));
  });

  it('draws every segment of a block through ONE mesh, and drops the mesh when the block empties', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    expect(WORLD_CHUNKS).toBeLessThanOrEqual(SUPER_MESH_SPAN_CHUNKS);
    const all: ChunkPayload[] = [];
    for (let cy = 0; cy < WORLD_CHUNKS; cy++) {
      for (let cx = 0; cx < WORLD_CHUNKS; cx++) all.push(chunkPayload(cx, cy));
    }
    fog.sync(applySnapshotInto(mirror, all));

    expect(fog.segmentCount()).toBe(WORLD_CHUNKS * 4);
    expect(fog.drawCallCount()).toBe(1);
    expect(fogGroup(group).children).toHaveLength(1);

    fog.sync(createTerrainMirror(WORLD));
    expect(fog.segmentCount()).toBe(0);
    expect(fog.drawCallCount()).toBe(0);
    expect(fogGroup(group).children).toHaveLength(0);
  });

  it('splits into one mesh per chunk-grid block the frontier crosses', () => {
    const blocks = 2;
    const chunkCols = SUPER_MESH_SPAN_CHUNKS * blocks;
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(CHUNK_SIZE * chunkCols);
    const all: ChunkPayload[] = [];
    for (let cy = 0; cy < chunkCols; cy++) {
      for (let cx = 0; cx < chunkCols; cx++) all.push(chunkPayload(cx, cy));
    }
    fog.sync(applySnapshotInto(mirror, all));

    expect(fog.segmentCount()).toBe(chunkCols * 4);
    expect(fog.drawCallCount()).toBe(blocks * blocks);
  });

  it('keeps its meshes across a sync that changes nothing about them', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));
    const before = fogGroup(group).children[0];
    const geometryBefore = (before as Mesh).geometry;

    applyChunkUnlock(mirror, { type: 'chunkUnlock', chunks: [chunkPayload(3, 3)] });
    fog.sync(mirror);

    expect(fogGroup(group).children).toContain(before);
    expect((before as Mesh).geometry).toBe(geometryBefore);
  });

  it('disposes every mesh it drew on dispose', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));

    const disposed: boolean[] = [];
    for (const child of fogGroup(group).children) {
      const geometry = (child as Mesh).geometry;
      const at = disposed.push(false) - 1;
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposed[at] = true;
        original();
      };
    }
    expect(disposed.length).toBeGreaterThan(0);

    fog.dispose();
    expect(disposed.every(Boolean)).toBe(true);
    expect(group.children).toHaveLength(0);
  });

  it('rings a hole of unreceived chunks with its own closed set of segments', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(
      applySnapshotInto(mirror, [
        chunkPayload(0, 0), chunkPayload(1, 0), chunkPayload(2, 0),
        chunkPayload(0, 1),                     chunkPayload(2, 1),
        chunkPayload(0, 2), chunkPayload(1, 2), chunkPayload(2, 2),
      ]),
    );

    expect(fog.segmentCount()).toBeGreaterThan(8);
  });

  it('grows past its initial slot capacity without losing a segment', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    const all: ChunkPayload[] = [];
    for (let cy = 0; cy < WORLD_CHUNKS; cy++) {
      for (let cx = 0; cx < WORLD_CHUNKS; cx++) all.push(chunkPayload(cx, cy));
    }
    fog.sync(applySnapshotInto(mirror, all));

    const mesh = fogGroup(group).children[0] as Mesh;
    const index = mesh.geometry.getIndex();
    if (index === null) throw new Error('expected indexed fog geometry');
    const drawn = mesh.geometry.drawRange.count;
    expect(drawn).toBeGreaterThan(0);
    const positions = mesh.geometry.getAttribute('position');
    let maxIndex = 0;
    for (let i = 0; i < drawn; i++) maxIndex = Math.max(maxIndex, index.getX(i));
    expect(maxIndex).toBeLessThan(positions.count);
    expect(maxIndex + 1).toBe(fog.segmentCount() * VERTICES_PER_SEGMENT);
    expect(drawn).toBe(fog.segmentCount() * INDICES_PER_SEGMENT);
  });
});

function applySnapshotInto(
  mirror: ReturnType<typeof createTerrainMirror>,
  chunks: ChunkPayload[],
): ReturnType<typeof createTerrainMirror> {
  applySnapshot(mirror, { type: 'snapshot', worldSize: mirror.map.size, chunks });
  return mirror;
}
