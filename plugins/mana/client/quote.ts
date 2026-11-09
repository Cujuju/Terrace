import {
  DEFAULT_SCULPT_AMOUNT,
  applySculpt,
  applyPackedSpans,
  createHeightmap,
  displacementOf,
  sculptOptionsOf,
  snapshotSolidUnits,
  strokeSolidMeasure,
  strokeReachBox,
  type SculptIntent,
  type CellDiff,
  type Heightmap,
} from '@terrace/shared';

/** The ground the client knows, cell by cell. Null where no chunk has arrived. */
export interface LocalHeights {
  worldSize(): number;
  terrainSampleAt(x: number, y: number): number | null;
  terrainSpansAt(x: number, y: number): readonly number[] | null | undefined;
}

/** An applier reads one cell past everything it writes. */
const SCRATCH_HALO_CELLS = 1;

export interface SculptSample {
  readonly scratch: Heightmap;
  readonly intent: SculptIntent;
  readonly originX: number;
  readonly originY: number;
}

export interface SculptMeasurement {
  readonly units: number;
  readonly diff: readonly CellDiff[];
}

export interface QuoteRequest {
  readonly id: number;
  readonly sample: SculptSample;
}

export interface QuoteReply {
  readonly id: number;
  readonly measurement: SculptMeasurement | null;
}

/** Copies every terrain column the stroke can read; null when any ground is unknown. */
export function sampleSculpt(
  terrain: LocalHeights,
  intent: SculptIntent,
): SculptSample | null {
  const worldSize = terrain.worldSize();
  if (worldSize <= 0) return null;

  const box = strokeReachBox(worldSize, intent);
  const wantedX = box.maxX - box.minX + 1 + 2 * SCRATCH_HALO_CELLS;
  const wantedY = box.maxY - box.minY + 1 + 2 * SCRATCH_HALO_CELLS;
  const side = wantedX > wantedY ? wantedX : wantedY;
  if (side > worldSize) return null;

  // Scratch edge must not fall inside the world: slide it back, don't clip the stroke.
  const originX = Math.min(Math.max(0, box.minX - SCRATCH_HALO_CELLS), worldSize - side);
  const originY = Math.min(Math.max(0, box.minY - SCRATCH_HALO_CELLS), worldSize - side);

  const scratch = createHeightmap(side);
  for (let sy = 0; sy < side; sy++) {
    for (let sx = 0; sx < side; sx++) {
      const height = terrain.terrainSampleAt(originX + sx, originY + sy);
      if (height === null) return null;
      scratch.cells[sy * side + sx] = height;
      const spans = terrain.terrainSpansAt(originX + sx, originY + sy);
      if (spans === null || !applyPackedSpans(scratch, sx, sy, spans)) return null;
    }
  }

  return { scratch, originX, originY, intent: {
    ...intent,
    x: intent.x - originX,
    y: intent.y - originY,
    ...(intent.fromX !== undefined && intent.fromY !== undefined
      ? { fromX: intent.fromX - originX, fromY: intent.fromY - originY }
      : {}),
  } };
}

export function measureSculpt(sample: SculptSample): SculptMeasurement {
  const { scratch, intent: local, originX, originY } = sample;
  const side = scratch.size;
  const reach = strokeReachBox(side, local);
  const measure = strokeSolidMeasure(sculptOptionsOf(local).tool);
  const before = snapshotSolidUnits(
    scratch,
    reach.minX,
    reach.minY,
    reach.maxX,
    reach.maxY,
    measure,
  );
  const diff = applySculpt(
    scratch,
    local.x,
    local.y,
    local.radius,
    DEFAULT_SCULPT_AMOUNT * local.dir,
    sculptOptionsOf(local),
  );
  return {
    units: displacementOf(before, scratch, diff, measure),
    diff: diff.map((cell) => ({ ...cell, x: cell.x + originX, y: cell.y + originY })),
  };
}

export function dryRunSculpt(terrain: LocalHeights, intent: SculptIntent): SculptMeasurement | null {
  const sample = sampleSculpt(terrain, intent);
  return sample === null ? null : measureSculpt(sample);
}

export function dryRunDisplacement(terrain: LocalHeights, intent: SculptIntent): number | null {
  return dryRunSculpt(terrain, intent)?.units ?? null;
}
