// Test worlds with REAL TERRAIN.
//
// The shipped harness beside this one (./harness.ts) only builds FLAT worlds —
// every cell at height 0, i.e. entirely shallow water and entirely band 0. That
// is a perfectly good case and several suites use it, but nothing that depends
// on ground is observable on it: no basin deep enough for a lair, no shore, no
// band high enough to snow on, no hillside.
//
// WHY IT IS HERE. Five plugin suites (flora, monsters, structures, weather,
// wildlife) each carried a byte-identical copy of the builder below, every one
// of them with a header explaining that it was a COPY and not an import,
// because a plugin's tests must not fail when a DIFFERENT plugin is
// uninstalled or refactored. That argument is about a plugin depending on a
// NEIGHBOUR: this file is core's own test support, which every plugin suite
// already reaches for (`server/test/support/harness.ts`), and it is deleted
// only when the server is.

import {
  chunkIndex,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  unlockChunk,
} from '@terrace/shared';
import { World } from '../../src/world/world.ts';

/**
 * Builds a world whose height at each cell comes from `heightOf`, with every
 * chunk unlocked unless `isChunkLocked` says otherwise.
 *
 * Built through the same `World.restore` path a snapshot uses, so a suite is
 * testing the world a save produces rather than one only tests can make.
 */
export function worldWithTerrain(
  size: number,
  heightOf: (x: number, y: number) => number,
  isChunkLocked: (cx: number, cy: number) => boolean = () => false,
): World {
  const map = createHeightmap(size);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      map.cells[y * size + x] = heightOf(x, y);
    }
  }

  const mask = createChunkMask(size);
  const chunkEdge = chunksPerEdge(size);
  for (let cy = 0; cy < chunkEdge; cy++) {
    for (let cx = 0; cx < chunkEdge; cx++) {
      if (isChunkLocked(cx, cy)) continue;
      unlockChunk(mask, chunkIndex(size, cx, cy));
    }
  }

  return World.restore(size, map.cells, mask);
}
