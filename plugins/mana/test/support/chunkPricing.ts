import { chunksPerEdge, chunksWithinSweep, revealReachCells, type StrokeSweep } from '@terrace/shared';

/** Counts only core reveal chunks, independently of the write-bound admission receipt. */
export function openedChunkCount(
  worldSize: number,
  sweep: StrokeSweep,
  isOpen: (cx: number, cy: number) => boolean,
): number {
  const edge = chunksPerEdge(worldSize);
  return chunksWithinSweep(worldSize, sweep, revealReachCells(sweep.radius))
    .filter((index) => !isOpen(index % edge, Math.floor(index / edge))).length;
}
