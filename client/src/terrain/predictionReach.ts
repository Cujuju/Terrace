import {
  CHUNK_SIZE,
  cellX,
  cellY,
  chunkIndex,
  forEachFootprintOffset,
  forEachLineCell,
  sculptOptionsOf,
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

  return {
    chunkOfCell,

    chunkOfCellIndex: (i: number): number => chunkOfCell(cellX(size, i), cellY(size, i)),

    cellAndHaloAreKnown,

    canPredictFaithfully(intent: SculptIntent): boolean {
      const { x, y } = intent;
      const options = sculptOptionsOf(intent);
      const radius = sculptSweepRadius(
        intent.radius,
        options.profile,
        options.tool,
        options.anchor,
      );
      if (intent.fromX === undefined || intent.fromY === undefined) return discIsKnown(x, y, radius);
      let known = true;
      forEachLineCell(intent.fromX, intent.fromY, x, y, (sx, sy) => {
        if (known && !discIsKnown(sx, sy, radius)) known = false;
      });
      return known;
    },
  };
}
