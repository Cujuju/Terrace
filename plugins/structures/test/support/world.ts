// Test worlds with real terrain.
//
// The shipped harness (server/test/support/harness.ts) only builds FLAT
// worlds — every cell at height 0, i.e. entirely water — on which nothing
// this plugin does is observable. This adds the one thing structures needs: a
// height field with dry, flat land in it, built through the same World.restore
// path a snapshot uses.
//
// A COPY of flora's equivalent helper, not an import: a plugin must build and
// test with every other plugin deleted.

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
