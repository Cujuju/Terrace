// Test worlds with real terrain.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT worlds,
// which for this plugin means "no ground high enough to snow on anywhere" — a
// perfectly good case, and one this suite uses, but not the only one. This adds
// the one thing the snow siting test needs: a height field, built through the
// same World.restore path a snapshot uses.
//
// This is the wildlife plugin's test/support/world.ts, restated rather than
// imported: a plugin's test suite depending on another plugin's fixtures would
// be the same cross-plugin coupling the shipped code refuses.

import {
  chunkIndex,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  unlockChunk,
} from '@terrace/shared';
import { World } from '../../../../server/src/world/world.ts';

/**
 * Builds a world whose height at each cell comes from `heightOf`, with every
 * chunk unlocked unless `isChunkLocked` says otherwise.
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
