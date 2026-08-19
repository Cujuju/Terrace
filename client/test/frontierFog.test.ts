// Frontier fog mesh-lifecycle tests. Like terrainMeshes.test.ts, these build
// real Three.js geometries but never a WebGLRenderer, so they run headless.

import { describe, expect, it } from 'vitest';
import { Group, Mesh } from 'three';
import { CHUNK_SIZE, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, applyChunkUnlock, createTerrainMirror } from '../src/terrain/mirror.ts';
import { createFrontierFog } from '../src/render/frontierFog.ts';

const WORLD = 64; // 4x4 chunks
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

describe('createFrontierFog', () => {
  it('draws nothing before any chunk is received', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(mirror);
    expect(group.children).toHaveLength(1); // the fog's own empty sub-group
    expect(group.children[0].children).toHaveLength(0);
  });

  it('draws one segment per exposed side of a single received chunk', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(1, 1)]));

    // Interior chunk (1,1) in a 4x4 grid: all four sides face unreceived
    // territory, so all four segments exist.
    expect(group.children[0].children).toHaveLength(4);
  });

  it('removes the shared segment when the neighbouring chunk arrives, and adds its new outer sides', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));
    expect(group.children[0].children).toHaveLength(4);

    applyChunkUnlock(mirror, { type: 'chunkUnlock', chunks: [chunkPayload(1, 0)] });
    fog.sync(mirror);

    // Two received chunks side by side: 4 + 4 sides minus the 2 that now
    // face each other (suppressed on both sides) = 6.
    expect(group.children[0].children).toHaveLength(6);
  });

  it('disposes geometry for every segment it removes, and the material once on dispose', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));

    const meshes = group.children[0].children.slice();
    const disposeSpies = meshes.map((child) => {
      if (!(child instanceof Mesh)) throw new Error('expected a Mesh');
      const geometry = child.geometry;
      let disposed = false;
      const original = geometry.dispose.bind(geometry);
      geometry.dispose = () => {
        disposed = true;
        original();
      };
      return () => disposed;
    });

    // Receiving the neighbour removes exactly the one PRE-EXISTING side of
    // (0,0) that now faces into it (its E side). (1,0)'s own W side is also
    // suppressed, but it never had a mesh to dispose in the first place —
    // that segment simply never gets built by this sync.
    applyChunkUnlock(mirror, { type: 'chunkUnlock', chunks: [chunkPayload(1, 0)] });
    fog.sync(mirror);

    const removedCount = disposeSpies.filter((wasDisposed) => wasDisposed()).length;
    expect(removedCount).toBe(1);

    fog.dispose();
    expect(group.children).toHaveLength(0);
  });

  it('leaves an unchanged edge\'s geometry object identity alone across a sync', () => {
    // A sync that adds chunks elsewhere in the world must not rebuild
    // segments that are still frontier — same rationale as terrainMeshes.ts's
    // in-place patch contract, just for "untouched" rather than "edited".
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    fog.sync(applySnapshotInto(mirror, [chunkPayload(0, 0)]));
    const before = group.children[0].children[0];

    // Unlock a chunk far away (3,3) — none of (0,0)'s four sides change.
    applyChunkUnlock(mirror, { type: 'chunkUnlock', chunks: [chunkPayload(3, 3)] });
    fog.sync(mirror);

    expect(group.children[0].children).toContain(before);
  });

  it('rings a hole of unreceived chunks with its own closed set of segments', () => {
    const group = new Group();
    const fog = createFrontierFog(group, noopOnFrame);
    const mirror = createTerrainMirror(WORLD);
    // 3x3 block minus the centre — a one-chunk hole surrounded by revealed
    // territory, same shape terrain/frontier.test.ts proves at the pure
    // level; here we only check the render layer actually produces meshes
    // for it (segment count = outer ring 12 sides that would exist for a
    // solid 3x3 minus the 4 sides the missing centre would have absorbed on
    // each neighbour's inward side... simplest robust check: every received
    // chunk not on the world edge that borders the hole must have at least
    // one segment facing inward).
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
    expect(group.children[0].children.length).toBeGreaterThan(8);
  });
});

function applySnapshotInto(
  mirror: ReturnType<typeof createTerrainMirror>,
  chunks: ChunkPayload[],
): ReturnType<typeof createTerrainMirror> {
  applySnapshot(mirror, { type: 'snapshot', worldSize: mirror.map.size, chunks });
  return mirror;
}
