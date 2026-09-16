import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  chunksPerEdge,
  revealChunkIndices,
  sculptDisplacementUnits,
} from '@terrace/shared';
import type { SculptProfile, SculptTool } from '@terrace/shared';

export function sculptManaCost(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
  depthBands: number,
  sweepSteps: number = 1,
): number {
  const base = Math.ceil(
    (manaPerBandCell * sculptDisplacementUnits(radius, tool, profile, depthBands) * sweepSteps) /
      BAND_HEIGHT,
  );
  return tool === 'carve' ? Math.ceil(base / 4) : base;
}

/**
 * Flat and perk-free: one chunk of frontier costs what a radius-2 hard stamp
 * costs, about 2% of raising that chunk's cells one band. Retune here.
 */
export const CHUNK_UNLOCK_MANA = 2;

/** The unlock half of a price: what the frontier a stroke opens costs. */
export function chunkUnlockFee(openedChunks: number): number {
  return openedChunks * CHUNK_UNLOCK_MANA;
}

export function openedChunkCount(
  worldSize: number,
  x: number,
  y: number,
  radius: number,
  isOpen: (cx: number, cy: number) => boolean,
): number {
  const cols = chunksPerEdge(worldSize);
  let opened = 0;
  for (const index of revealChunkIndices(worldSize, x, y, radius)) {
    if (!isOpen(index % cols, Math.floor(index / cols))) opened++;
  }
  return opened;
}

export function chunkOriginCell(cx: number, cy: number): { x: number; y: number } {
  return { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE };
}
