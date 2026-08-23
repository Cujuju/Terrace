// Frontier fog mesh-lifecycle tests. Like terrainMeshes.test.ts, these build
// real Three.js geometries but never a WebGLRenderer, so they run headless.
//
// WHAT THESE ASSERT ON, AND WHY IT MOVED (2026-08-22). A frontier edge used to
// be a Mesh, so `group.children[0].children.length` was the segment count. The
// merge (GH #73) packs segments into super-meshes, and the two questions came
// apart: the LIFECYCLE contract is about segments (`segmentCount`), the
// PERFORMANCE contract is about meshes (`drawCallCount`). Every count below
// names which one it means rather than reading the scene graph and hoping.

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

// Four chunks to a side, whatever a chunk is sampled at — the 2026-08-21
// re-sample moved the cell figure and left the geometry this suite asserts on
// exactly where it was.
const WORLD_CHUNKS = 4;
const WORLD = CHUNK_SIZE * WORLD_CHUNKS;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

function chunkPayload(cx: number, cy: number, fill = 0): ChunkPayload {
  return { cx, cy, heights: new Array<number>(CELLS_PER_CHUNK).fill(fill) };
}

/** A no-op frame-callback registry: these tests drive `sync` directly and
 *  never need a real animation loop. Returns the unregister function every
 *  Viewport.onFrame caller expects. */
function noopOnFrame(): () => void {
  return () => {};
}

/** The fog's own sub-group — the one thing it adds to the parent. */
function fogGroup(parent: Group): Group {
  const child = parent.children[0];
  if (!(child instanceof Group)) throw new Error('expected the fog sub-group');
  return child;
}

/**
 * Every drawn slot's vertex positions, one string per slot, sorted.
 *
 * Sorted because a slot's index in the buffers is an implementation detail the
 * swap-remove deliberately shuffles; what must hold is that the SET of drawn
 * geometry is right. Only the live prefix is read — the draw range is what the
 * renderer submits, and the slots past it hold stale data by design.
 */
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

    // Interior chunk (1,1) in a 4x4 grid: all four sides face unreceived
    // territory, so all four segments exist.
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

    // Two received chunks side by side: 4 + 4 sides minus the 2 that now
    // face each other (suppressed on both sides) = 6.
    expect(fog.segmentCount()).toBe(6);
  });

  it('draws the same geometry however the segments got there', () => {
    // THE SWAP-REMOVE CONTRACT. Freeing a slot moves the last live segment
    // into it, so a fog that reached a state by adding and removing must draw
    // exactly what a fog built straight into that state draws. This is the
    // test that fails if a swap forgets to move the vertex data with the
    // occupant, or leaves a removed segment inside the draw range.
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
    // The whole point of the merge: the draw-call count follows the chunk-grid
    // BLOCKS the frontier passes through, not the number of frontier edges.
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    // A 4-chunk world is one SUPER_MESH_SPAN_CHUNKS block, so every segment of
    // a fully received world lands in the same mesh.
    expect(WORLD_CHUNKS).toBeLessThanOrEqual(SUPER_MESH_SPAN_CHUNKS);
    const all: ChunkPayload[] = [];
    for (let cy = 0; cy < WORLD_CHUNKS; cy++) {
      for (let cx = 0; cx < WORLD_CHUNKS; cx++) all.push(chunkPayload(cx, cy));
    }
    fog.sync(applySnapshotInto(mirror, all));

    // A fully received world's frontier is its outer rim: one side per chunk
    // along each of the four edges.
    expect(fog.segmentCount()).toBe(WORLD_CHUNKS * 4);
    expect(fog.drawCallCount()).toBe(1);
    expect(fogGroup(group).children).toHaveLength(1);

    // Replacing the world with an empty one strands every segment; the block
    // loses its last occupant and stops costing a draw call at all.
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

    // The rim of a fully revealed world passes through every one of the four
    // blocks, and through nothing else — so four meshes for 4 x 16 = 64 edges.
    expect(fog.segmentCount()).toBe(chunkCols * 4);
    expect(fog.drawCallCount()).toBe(blocks * blocks);
  });

  it('keeps its meshes across a sync that changes nothing about them', () => {
    // A sync that adds chunks elsewhere in the world must not rebuild the
    // geometry of segments that are still frontier — same rationale as
    // terrainMeshes.ts's in-place patch contract, just for "untouched" rather
    // than "edited".
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));
    const before = fogGroup(group).children[0];
    const geometryBefore = (before as Mesh).geometry;

    // Unlock a chunk far away (3,3) — none of (0,0)'s four sides change.
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
    // 3x3 block minus the centre — a one-chunk hole surrounded by revealed
    // territory, same shape terrain/frontier.test.ts proves at the pure
    // level; here we only check the render layer actually produces geometry
    // for it.
    fog.sync(
      applySnapshotInto(mirror, [
        chunkPayload(0, 0), chunkPayload(1, 0), chunkPayload(2, 0),
        chunkPayload(0, 1),                     chunkPayload(2, 1),
        chunkPayload(0, 2), chunkPayload(1, 2), chunkPayload(2, 2),
      ]),
    );

    // A closed ring around a hole plus the outer boundary is drawn: no
    // segment count assertion here (that is terrain/frontier.test.ts's job)
    // — just that SOME geometry was produced and it is non-trivial.
    expect(fog.segmentCount()).toBeGreaterThan(8);
  });

  it('grows past its initial slot capacity without losing a segment', () => {
    // One block holds far more than INITIAL_SEGMENT_CAPACITY segments as soon
    // as the frontier is anything but a short edge, so the doubling path runs
    // on ordinary worlds — this pins that growing rebinds the buffers with
    // every existing slot's data intact rather than starting the block over.
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
    // Every drawn index addresses a vertex that exists, and none of them reach
    // past the live prefix into a stale slot.
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
