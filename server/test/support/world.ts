import {
  chunkIndex,
  chunksPerEdge,
  createChunkMask,
  createHeightmap,
  unlockChunk,
} from '@terrace/shared';
import { World } from '../../src/world/world.ts';

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
