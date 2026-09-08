import { bandOf, isWater } from '@terrace/shared';
import { STRUCTURE_SURVEY_RADIUS_CELLS, structureKey } from '../protocol.ts';
import { hasReservedStructureCells, isReservedStructureCell } from './reservations.ts';

export const FLATNESS_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> = [
  [1, 0],
  [-1, 0],
  [0, 1],
  [0, -1],
];

export interface StructuresWorld {
  readonly worldSize: number;
  readonly chunksPerEdge: number;
  heightAt(x: number, y: number): number;
  isChunkUnlocked(cx: number, cy: number): boolean;
  isCellUnlocked(x: number, y: number): boolean;
}

export function isFlatEnough(world: StructuresWorld, x: number, y: number): boolean {
  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of FLATNESS_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    if (bandOf(world.heightAt(nx, ny)) !== band) return false;
  }
  return true;
}

export const FOOTPRINT_CHECK_RADIUS_CELLS = STRUCTURE_SURVEY_RADIUS_CELLS;

export const FOOTPRINT_NEIGHBOR_OFFSETS: ReadonlyArray<readonly [number, number]> =
  (() => {
    const offsets: Array<readonly [number, number]> = [];
    for (let dy = -FOOTPRINT_CHECK_RADIUS_CELLS; dy <= FOOTPRINT_CHECK_RADIUS_CELLS; dy++) {
      for (let dx = -FOOTPRINT_CHECK_RADIUS_CELLS; dx <= FOOTPRINT_CHECK_RADIUS_CELLS; dx++) {
        if (dx === 0 && dy === 0) continue;
        offsets.push([dx, dy] as const);
      }
    }
    return offsets;
  })();

export function hasClearFootprint(world: StructuresWorld, x: number, y: number): boolean {
  const band = bandOf(world.heightAt(x, y));
  for (const [dx, dy] of FOOTPRINT_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) return false;
    if (bandOf(neighborHeight) !== band) return false;
  }
  return true;
}

export function isBuildableCell(world: StructuresWorld, x: number, y: number): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  if (isWater(world.heightAt(x, y))) return false;
  if (hasReservedStructureCells() && isReservedStructureCell(structureKey(x, y))) return false;
  return isFlatEnough(world, x, y) && hasClearFootprint(world, x, y);
}
