import { CHUNK_SIZE, NEIGHBOURHOOD_CELLS, chunksPerEdge } from '@terrace/shared';
import type { World } from './world.ts';

export const INITIAL_UNLOCK_CHUNK_SPAN =
  (5 * NEIGHBOURHOOD_CELLS) / CHUNK_SIZE;

export interface InitialUnlockFootprint {
  readonly startChunk: number;
  readonly spanChunks: number;
}

export function initialUnlockFootprint(size: number): InitialUnlockFootprint {
  const edge = chunksPerEdge(size);
  const spanChunks = Math.min(INITIAL_UNLOCK_CHUNK_SPAN, edge);
  return { startChunk: Math.floor((edge - spanChunks) / 2), spanChunks };
}

export function applyInitialUnlock(world: World): void {
  const edge = chunksPerEdge(world.size);
  const { startChunk: start, spanChunks: span } = initialUnlockFootprint(world.size);

  for (let cy = start; cy < start + span; cy++) {
    for (let cx = start; cx < start + span; cx++) {
      world.unlockChunk(cx, cy);
    }
  }

  const centreChunk = Math.floor(edge / 2);
  if (!world.isChunkUnlocked(Math.min(centreChunk, edge - 1), Math.min(centreChunk, edge - 1))) {
    throw new Error(
      `initial unlock left the world centre locked (chunk edge=${edge}, span=${span}) — unlock geometry bug`,
    );
  }
}

export function applyInitialUnlockForToken(world: World, token: string): void {
  const { startChunk: start, spanChunks: span } = initialUnlockFootprint(world.size);

  for (let cy = start; cy < start + span; cy++) {
    for (let cx = start; cx < start + span; cx++) {
      world.seedChunkForToken(token, cx, cy);
    }
  }
}
