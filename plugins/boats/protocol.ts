import {
  WORLD_UNIT_CELLS,
  cellsAcross,
  cellsOverArea,
} from '@terrace/shared';
import { isFiniteNumber } from '@terrace/shared';

export const BOATS_PLUGIN_NAME = 'boats';

export const BOATS_STATE_MESSAGE = 'state';

export interface BoatState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly heading: number;
  readonly fighting: boolean;
}

export const VILLAGE_MIN_TIER = 1;

export const BOATS_PER_VILLAGE = 3;

export const BOAT_REBUILD_SECONDS = 20;

export const BOAT_SPEED_CELLS_PER_SECOND = cellsAcross(0.9);

export const BOAT_ENGAGEMENT_RANGE_CELLS = cellsAcross(5);

export const BOAT_WOUNDS_PER_SECOND = 1;

export const KRAKEN_SINKS_BOAT_EVERY_SECONDS = 12;

export const KRAKEN_ROUT_WOUNDS = 54;

export const KRAKEN_WOUND_HEAL_PER_SECOND = 2;

export const COASTAL_SEARCH_RADIUS_CELLS = cellsAcross(4);
export const COASTAL_MIN_WATER_CELLS = cellsOverArea(2);

export const HARBOUR_INSHORE_BAND_WORLD_UNITS = 1.75;

export const VILLAGE_PATROL_RANGE_CELLS = cellsAcross(64);

export {
  BROADCAST_POSITION_DECIMALS,
  roundBroadcastCell,
  roundBroadcastPosition,
} from '@terrace/shared';

export const BOATS_PAYLOAD_CAP = 2048;

export interface BoatsStatePayload {
  readonly boats: readonly BoatState[];
}

export function parseBoatsPayload(payload: unknown): BoatState[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { boats } = payload as { boats?: unknown };
  if (!Array.isArray(boats) || boats.length > BOATS_PAYLOAD_CAP) return null;

  const parsed: BoatState[] = [];
  for (const item of boats) {
    if (typeof item !== 'object' || item === null) return null;
    const { id, x, y, heading, fighting } = item as Record<string, unknown>;
    if (!Number.isInteger(id) || (id as number) < 0) return null;
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFiniteNumber(heading)) return null;
    if (typeof fighting !== 'boolean') return null;
    parsed.push({ id: id as number, x, y, heading, fighting });
  }
  return parsed;
}
