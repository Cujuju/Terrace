import { drawnBandOfSample, isWater } from '@terrace/shared';
import {
  STRUCTURE_FOOTPRINT_RADIUS_CELLS,
  structureKey,
  type StructureTier,
} from '../protocol.ts';
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
  const band = drawnBandOfSample(world.heightAt(x, y));
  for (const [dx, dy] of FLATNESS_NEIGHBOR_OFFSETS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    if (drawnBandOfSample(world.heightAt(nx, ny)) !== band) return false;
  }
  return true;
}

/** A new settlement is a camp, so the cell scan surveys the camp's footprint. */
export const CAMP_TIER: StructureTier = 0;

function squareOffsets(radius: number): ReadonlyArray<readonly [number, number]> {
  const offsets: Array<readonly [number, number]> = [];
  for (let dy = -radius; dy <= radius; dy++) {
    for (let dx = -radius; dx <= radius; dx++) {
      if (dx === 0 && dy === 0) continue;
      offsets.push([dx, dy] as const);
    }
  }
  return offsets;
}

const FOOTPRINT_OFFSETS_BY_TIER: ReadonlyArray<ReadonlyArray<readonly [number, number]>> =
  STRUCTURE_FOOTPRINT_RADIUS_CELLS.map(squareOffsets);

export function hasClearFootprint(
  world: StructuresWorld,
  x: number,
  y: number,
  tier: StructureTier = CAMP_TIER,
): boolean {
  const band = drawnBandOfSample(world.heightAt(x, y));
  for (const [dx, dy] of FOOTPRINT_OFFSETS_BY_TIER[tier]!) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= world.worldSize || ny >= world.worldSize) return false;
    const neighborHeight = world.heightAt(nx, ny);
    if (isWater(neighborHeight)) return false;
    if (drawnBandOfSample(neighborHeight) !== band) return false;
  }
  return true;
}

export function isBuildableCell(
  world: StructuresWorld,
  x: number,
  y: number,
  tier: StructureTier = CAMP_TIER,
): boolean {
  if (!Number.isInteger(x) || !Number.isInteger(y)) return false;
  if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) return false;
  if (!world.isCellUnlocked(x, y)) return false;
  if (isWater(world.heightAt(x, y))) return false;
  if (hasReservedStructureCells() && isReservedStructureCell(structureKey(x, y))) return false;
  return isFlatEnough(world, x, y) && hasClearFootprint(world, x, y, tier);
}
