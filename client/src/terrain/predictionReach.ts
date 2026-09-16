import {
  CHUNK_SIZE,
  cellX,
  cellY,
  chunkIndex,
  chunksPerEdge,
  forEachFootprintOffset,
  forEachLineCell,
  sculptOptionsOf,
  sculptReachCells,
  sculptSweepRadius,
  type SculptIntent,
} from '@terrace/shared';
import { hasChunk, type TerrainMirror } from './mirror.ts';
import { PREDICTION_HALO_CELLS } from './predictionLimits.ts';

export interface ReachChecks {
  chunkOfCell(x: number, y: number): number;
  chunkOfCellIndex(i: number): number;
  cellAndHaloAreKnown(x: number, y: number): boolean;
  canPredictFaithfully(intent: SculptIntent): boolean;
}

export function createReachChecks(mirror: TerrainMirror): ReachChecks {
  const size = mirror.map.size;
  const edge = chunksPerEdge(size);

  const chunkOfCell = (x: number, y: number): number =>
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE));

  const cellIsKnown = (x: number, y: number): boolean =>
    x < 0 || y < 0 || x >= size || y >= size || hasChunk(mirror, chunkOfCell(x, y));

  const cellAndHaloAreKnown = (x: number, y: number): boolean =>
    cellIsKnown(x, y) &&
    cellIsKnown(x - PREDICTION_HALO_CELLS, y) &&
    cellIsKnown(x + PREDICTION_HALO_CELLS, y) &&
    cellIsKnown(x, y - PREDICTION_HALO_CELLS) &&
    cellIsKnown(x, y + PREDICTION_HALO_CELLS);

  const discIsKnown = (cx: number, cy: number, radius: number): boolean => {
    let known = true;
    forEachFootprintOffset(radius, (dx, dy) => {
      if (!known) return;
      if (!cellAndHaloAreKnown(cx + dx, cy + dy)) known = false;
    });
    return known;
  };

  const clampChunk = (c: number): number => (c < 0 ? 0 : c > edge - 1 ? edge - 1 : c);

  /** Ground outside the world is never unknown, so the span clamps to the edge. */
  const boxIsKnown = (cx: number, cy: number, reach: number): boolean => {
    const firstX = clampChunk(Math.floor((cx - reach) / CHUNK_SIZE));
    const lastX = clampChunk(Math.floor((cx + reach) / CHUNK_SIZE));
    const firstY = clampChunk(Math.floor((cy - reach) / CHUNK_SIZE));
    const lastY = clampChunk(Math.floor((cy + reach) / CHUNK_SIZE));
    for (let chunkY = firstY; chunkY <= lastY; chunkY++) {
      for (let chunkX = firstX; chunkX <= lastX; chunkX++) {
        if (!hasChunk(mirror, chunkIndex(size, chunkX, chunkY))) return false;
      }
    }
    return true;
  };

  return {
    chunkOfCell,

    chunkOfCellIndex: (i: number): number => chunkOfCell(cellX(size, i), cellY(size, i)),

    cellAndHaloAreKnown,

    canPredictFaithfully(intent: SculptIntent): boolean {
      const options = sculptOptionsOf(intent);
      const sweep = sculptSweepRadius(
        intent.radius,
        options.profile,
        options.tool,
        options.anchor,
      );
      // A relaxing tool reads and writes a square bbox past its brush, so its
      // whole reach must be known; for the rest the reach IS the sweep.
      const reach = sculptReachCells(
        intent.radius,
        options.profile,
        options.tool,
        options.anchor,
      );
      const stepIsKnown = (sx: number, sy: number): boolean =>
        discIsKnown(sx, sy, sweep) && (reach <= sweep || boxIsKnown(sx, sy, reach));

      const { x, y } = intent;
      if (intent.fromX === undefined || intent.fromY === undefined) return stepIsKnown(x, y);
      let known = true;
      forEachLineCell(intent.fromX, intent.fromY, x, y, (sx, sy) => {
        if (known && !stepIsKnown(sx, sy)) known = false;
      });
      return known;
    },
  };
}
