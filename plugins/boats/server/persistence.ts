import { fleetSnapshot, restoreFleet, type Boat, type Village } from './fleet.ts';
import { parseRecordArray } from '@terrace/shared';

interface SavedFleet {
  villages: Village[];
  boats: Boat[];
  nextBoatId: number;
}

export function saveBoats(): unknown {
  return fleetSnapshot();
}

function parseVillage(value: unknown): Village | null {
  if (typeof value !== 'object' || value === null) return null;
  const { x, y, rebuildSeconds } = value as Record<string, unknown>;
  if (!Number.isInteger(x) || !Number.isInteger(y)) return null;
  if (typeof rebuildSeconds !== 'number' || !Number.isFinite(rebuildSeconds)) return null;
  return { x: x as number, y: y as number, rebuildSeconds: rebuildSeconds as number };
}

function parseBoat(value: unknown): Boat | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, homeX, homeY, x, y, heading, fighting } = value as Record<string, unknown>;
  if (!Number.isInteger(id) || !Number.isInteger(homeX) || !Number.isInteger(homeY)) return null;
  for (const n of [x, y, heading]) {
    if (typeof n !== 'number' || !Number.isFinite(n)) return null;
  }
  if (typeof fighting !== 'boolean') return null;
  return {
    id: id as number,
    homeX: homeX as number,
    homeY: homeY as number,
    x: x as number,
    y: y as number,
    heading: heading as number,
    fighting: false,
  };
}

export function loadBoats(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const { villages, boats, nextBoatId } = data as Record<string, unknown>;
  if (!Number.isInteger(nextBoatId)) return;

  const parsedVillages = parseRecordArray(villages, parseVillage);
  if (parsedVillages === null) return;
  const parsedBoats = parseRecordArray(boats, parseBoat);
  if (parsedBoats === null) return;

  const restored: SavedFleet = {
    villages: parsedVillages,
    boats: parsedBoats,
    nextBoatId: nextBoatId as number,
  };
  restoreFleet(restored);
}
