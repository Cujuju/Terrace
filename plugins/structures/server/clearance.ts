import { MAX_FOOTPRINT_RADIUS_CELLS, footprintRadiusOfKind, structureKey } from '../protocol.ts';
import { categoryAt, chainStepOf } from '../settlementRules.ts';
import type { LiveCellRecord } from './life.ts';
import { FOUNDING_FOOTPRINT_RADIUS_CELLS, type StructuresWorld } from './suitability.ts';

/**
 * Chain step 0 is camp-grade: packed as the settlement pattern, absorbed by any upgrade around
 * it. Step, not tier: a chain may repeat a tier.
 */
export const CAMP_GRADE_STEP = 0;

/** How far along its ground's chain a building stands. Ground with no category (water) reads as camp-grade. */
export function chainStepAt(world: StructuresWorld, x: number, y: number, kind: number): number {
  const category = categoryAt(world, x, y);
  return category === null ? CAMP_GRADE_STEP : chainStepOf(category, kind);
}

/** Each footprint's edge cell surveys half a cell, so neighbouring footprints keep a whole cell between them. */
const FOOTPRINT_EDGE_CELLS = 1;

function separationCells(radiusCells: number, other: LiveCellRecord): number {
  return radiusCells + footprintRadiusOfKind(other.kind) + FOOTPRINT_EDGE_CELLS;
}

function forEachWithinReach(
  world: StructuresWorld,
  x: number,
  y: number,
  radiusCells: number,
  visit: (dx: number, dy: number, nx: number, ny: number) => boolean,
): boolean {
  const reach = radiusCells + MAX_FOOTPRINT_RADIUS_CELLS + FOOTPRINT_EDGE_CELLS;
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

function within(dx: number, dy: number, separation: number): boolean {
  return dx * dx + dy * dy < separation * separation;
}

/** Is any building (above camp grade) too close to a footprint of `radiusCells` anchored here? */
export function hasBuildingWithinSeparation(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
  radiusCells: number = FOUNDING_FOOTPRINT_RADIUS_CELLS,
): boolean {
  return forEachWithinReach(world, x, y, radiusCells, (dx, dy, nx, ny) => {
    const record = live.get(structureKey(nx, ny));
    return record !== undefined && within(dx, dy, separationCells(radiusCells, record)) &&
      chainStepAt(world, nx, ny, record.kind) > CAMP_GRADE_STEP;
  });
}

export interface UpgradeLot {
  readonly blocked: boolean;
  readonly absorbed: readonly number[];
}

/**
 * Surveys the ground an upgrade into `nextKind` claims. A building at the upgrader's chain step
 * or further blocks it; camps and buildings at earlier steps inside it are absorbed.
 */
export function surveyUpgradeLot(
  live: ReadonlyMap<number, LiveCellRecord>,
  world: StructuresWorld,
  x: number,
  y: number,
  currentStep: number,
  nextKind: number,
): UpgradeLot {
  const radiusCells = footprintRadiusOfKind(nextKind);
  const absorbed: number[] = [];
  const blocked = forEachWithinReach(world, x, y, radiusCells, (dx, dy, nx, ny) => {
    const key = structureKey(nx, ny);
    const record = live.get(key);
    if (record === undefined || !within(dx, dy, separationCells(radiusCells, record))) return false;
    const step = chainStepAt(world, nx, ny, record.kind);
    if (step > CAMP_GRADE_STEP && step >= currentStep) return true;
    absorbed.push(key);
    return false;
  });
  return { blocked, absorbed: blocked ? [] : absorbed };
}
