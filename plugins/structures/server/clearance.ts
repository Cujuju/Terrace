import {
  STRUCTURE_SEPARATION_CELLS,
  STRUCTURE_SEPARATION_CELLS_SQUARED,
  structureKey,
} from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import type { StructuresWorld } from './suitability.ts';

function isWithinSeparation(dx: number, dy: number): boolean {
  return dx * dx + dy * dy < STRUCTURE_SEPARATION_CELLS_SQUARED;
}

export function hasBuildingWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
): boolean {
  for (let dy = -STRUCTURE_SEPARATION_CELLS; dy <= STRUCTURE_SEPARATION_CELLS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -STRUCTURE_SEPARATION_CELLS; dx <= STRUCTURE_SEPARATION_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (!isWithinSeparation(dx, dy)) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      const record = live.get(structureKey(nx, ny));
      if (record !== undefined && record.tier > 0) return true;
    }
  }
  return false;
}

export function livingCellsWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
): number[] {
  const keys: number[] = [];
  for (let dy = -STRUCTURE_SEPARATION_CELLS; dy <= STRUCTURE_SEPARATION_CELLS; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -STRUCTURE_SEPARATION_CELLS; dx <= STRUCTURE_SEPARATION_CELLS; dx++) {
      if (dx === 0 && dy === 0) continue;
      if (!isWithinSeparation(dx, dy)) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      const key = structureKey(nx, ny);
      const record = live.get(key);
      if (record === undefined || record.tier > 0) continue;
      keys.push(key);
    }
  }
  return keys;
}
