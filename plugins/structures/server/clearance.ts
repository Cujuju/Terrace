import {
  MAX_STRUCTURE_TIER,
  lotSeparationCells,
  structureKey,
  type StructureTier,
} from '../protocol.ts';
import type { LiveCellRecord } from './life.ts';
import { CAMP_TIER, type StructuresWorld } from './suitability.ts';

function isWithinSeparation(dx: number, dy: number, separation: number): boolean {
  return dx * dx + dy * dy < separation * separation;
}

function forEachWithinReach(
  world: StructuresWorld,
  x: number,
  y: number,
  tier: StructureTier,
  visit: (dx: number, dy: number, nx: number, ny: number) => boolean,
): boolean {
  // The widest lot sits on the top tier, so this reach covers every pairing.
  const reach = lotSeparationCells(tier, MAX_STRUCTURE_TIER);
  for (let dy = -reach; dy <= reach; dy++) {
    const ny = y + dy;
    if (ny < 0 || ny >= world.worldSize) continue;
    for (let dx = -reach; dx <= reach; dx++) {
      if (dx === 0 && dy === 0) continue;
      const nx = x + dx;
      if (nx < 0 || nx >= world.worldSize) continue;
      if (visit(dx, dy, nx, ny)) return true;
    }
  }
  return false;
}

export function hasBuildingWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
  tier: StructureTier = CAMP_TIER,
): boolean {
  return forEachWithinReach(world, x, y, tier, (dx, dy, nx, ny) => {
    const record = live.get(structureKey(nx, ny));
    return record !== undefined && record.tier > CAMP_TIER &&
      isWithinSeparation(dx, dy, lotSeparationCells(tier, record.tier));
  });
}

export interface UpgradeLot {
  readonly blocked: boolean;
  readonly absorbed: readonly number[];
}

/**
 * Surveys the lot an upgrade to `nextTier` claims. A building of the upgrader's tier or
 * higher blocks it; camps and lower-tier buildings inside the lot are absorbed.
 */
export function surveyUpgradeLot(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
  currentTier: StructureTier,
  nextTier: StructureTier,
): UpgradeLot {
  const absorbed: number[] = [];
  const blocked = forEachWithinReach(world, x, y, nextTier, (dx, dy, nx, ny) => {
    const key = structureKey(nx, ny);
    const record = live.get(key);
    if (record === undefined) return false;
    if (!isWithinSeparation(dx, dy, lotSeparationCells(nextTier, record.tier))) return false;
    if (record.tier > CAMP_TIER && record.tier >= currentTier) return true;
    absorbed.push(key);
    return false;
  });
  return { blocked, absorbed: blocked ? [] : absorbed };
}
