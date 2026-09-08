import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  FULL_BRUSH_RADIUS,
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
  sweepSteps: number = 1,
): number {
  return Math.ceil(
    (manaPerBandCell * sculptDisplacementUnits(radius, tool) * sweepSteps) / BAND_HEIGHT,
  );
}

export function chunkUnlockPenalty(
  manaPerBandCell: number,
  radius: number,
  profile: SculptProfile,
  tool: SculptTool,
): number {
  const full = sculptManaCost(manaPerBandCell, FULL_BRUSH_RADIUS, profile, tool);
  const own = sculptManaCost(manaPerBandCell, radius, profile, tool);
  return full > own ? full - own : 0;
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
