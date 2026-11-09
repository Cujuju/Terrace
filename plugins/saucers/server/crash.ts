import { BAND_HEIGHT } from '@terrace/shared';
import {
  CRASH_CRATER_DEPTH_BANDS,
  CRASH_CRATER_RADIUS_CELLS,
  CRASH_FIRE_RING_OFFSETS,
  CRASH_SEABED_CRATER_MAX_DEPTH_BANDS,
} from '../protocol.ts';
import { igniteCrashCell } from './fire-bridge.ts';
import { crashCellAt, type CrashCell, type SiteWorld } from './site.ts';
import { crashWriteAllowed, isClearOfSettlements } from './structures-bridge.ts';

export interface CrashWorld extends SiteWorld {
  sculpt(x: number, y: number, radius: number, amount: number, canWrite?: (x: number, y: number) => boolean): unknown;
}

const CRASH_CRATER_AMOUNT = -(CRASH_CRATER_DEPTH_BANDS * BAND_HEIGHT);

export function applyCrash(world: CrashWorld, target: CrashCell): CrashCell | null {
  const cell = crashCellAt(world, target.x, target.y);
  if (cell === null || !isClearOfSettlements(cell.x, cell.y)) return null;
  const canWrite = crashWriteAllowed();
  if (!cell.water || cell.depthBands <= CRASH_SEABED_CRATER_MAX_DEPTH_BANDS) {
    world.sculpt(cell.x, cell.y, CRASH_CRATER_RADIUS_CELLS, CRASH_CRATER_AMOUNT, canWrite);
  }
  if (!cell.water) {
    for (const [dx, dy] of CRASH_FIRE_RING_OFFSETS) {
      const x = cell.x + dx;
      const y = cell.y + dy;
      if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
      if (world.isCellUnlocked(x, y) && canWrite(x, y)) igniteCrashCell(x, y);
    }
  }
  return cell;
}
