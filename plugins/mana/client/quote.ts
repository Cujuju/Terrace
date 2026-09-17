import {
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  createHeightmap,
  displacementOf,
  sculptOptionsOf,
  snapshotSolidUnits,
  strokeReachBox,
  type SculptIntent,
} from '@terrace/shared';

/** The ground the client knows, cell by cell. Null where no chunk has arrived. */
export interface LocalHeights {
  worldSize(): number;
  terrainSampleAt(x: number, y: number): number | null;
}

/** An applier reads one cell past everything it writes. */
const SCRATCH_HALO_CELLS = 1;

/**
 * The units a stroke would move, run on a copy of the ground it touches. Null
 * when any of that ground is unknown.
 */
export function dryRunDisplacement(
  terrain: LocalHeights,
  intent: SculptIntent,
): number | null {
  const worldSize = terrain.worldSize();
  if (worldSize <= 0) return null;

  const box = strokeReachBox(worldSize, intent);
  const wantedX = box.maxX - box.minX + 1 + 2 * SCRATCH_HALO_CELLS;
  const wantedY = box.maxY - box.minY + 1 + 2 * SCRATCH_HALO_CELLS;
  const side = wantedX > wantedY ? wantedX : wantedY;
  if (side > worldSize) return null;

  // The scratch's own edge stands in for the world's, so it may never fall
  // inside the world: slide it back rather than clipping the stroke's reach.
  const originX = Math.min(Math.max(0, box.minX - SCRATCH_HALO_CELLS), worldSize - side);
  const originY = Math.min(Math.max(0, box.minY - SCRATCH_HALO_CELLS), worldSize - side);

  const scratch = createHeightmap(side);
  for (let sy = 0; sy < side; sy++) {
    for (let sx = 0; sx < side; sx++) {
      const height = terrain.terrainSampleAt(originX + sx, originY + sy);
      if (height === null) return null;
      scratch.cells[sy * side + sx] = height;
    }
  }

  const local: SculptIntent = {
    ...intent,
    x: intent.x - originX,
    y: intent.y - originY,
    ...(intent.fromX !== undefined && intent.fromY !== undefined
      ? { fromX: intent.fromX - originX, fromY: intent.fromY - originY }
      : {}),
  };
  const reach = strokeReachBox(side, local);
  const before = snapshotSolidUnits(scratch, reach.minX, reach.minY, reach.maxX, reach.maxY);
  const diff = applySculpt(
    scratch,
    local.x,
    local.y,
    local.radius,
    DEFAULT_SCULPT_AMOUNT * local.dir,
    sculptOptionsOf(local),
  );
  return displacementOf(before, scratch, diff);
}
