import { CHUNK_SIZE } from '@terrace/shared';

export interface FootprintWorld {
  readonly worldSize: number;
  isChunkUnlocked(cx: number, cy: number): boolean;
}

export function footprintUnlocked(
  world: FootprintWorld,
  x: number,
  y: number,
  radius: number,
): boolean {
  const minX = x - radius;
  const maxX = x + radius;
  const minY = y - radius;
  const maxY = y + radius;
  if (minX < 0 || minY < 0 || maxX >= world.worldSize || maxY >= world.worldSize) return false;

  const minCx = Math.floor(minX / CHUNK_SIZE);
  const maxCx = Math.floor(maxX / CHUNK_SIZE);
  const minCy = Math.floor(minY / CHUNK_SIZE);
  const maxCy = Math.floor(maxY / CHUNK_SIZE);
  for (let cy = minCy; cy <= maxCy; cy++) {
    for (let cx = minCx; cx <= maxCx; cx++) {
      if (!world.isChunkUnlocked(cx, cy)) return false;
    }
  }
  return true;
}
