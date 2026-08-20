// The plugin's persistence slice: villages and the boats afloat.
//
// STRUCTURAL VALIDATION ON LOAD, exactly as every other plugin's slice does:
// the saved blob comes from a database file that may predate this code, so a
// shape that does not parse is DISCARDED WHOLE rather than half-applied. A
// world that comes back with no boats rebuilds them within a minute
// (BOAT_REBUILD_SECONDS); a world that comes back with half a fleet and a
// corrupt village list would be wrong forever.

import { fleetSnapshot, restoreFleet, type Boat, type Village } from './fleet.ts';

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
    // NOT SAVED AS TRUE, whatever the blob says: `fighting` describes a fight
    // that a restart has ended. It is recomputed on the first tick from the
    // boat's distance to a kraken that may no longer be there.
    fighting: false,
  };
}

export function loadBoats(data: unknown): void {
  if (typeof data !== 'object' || data === null) return;
  const { villages, boats, nextBoatId } = data as Record<string, unknown>;
  if (!Array.isArray(villages) || !Array.isArray(boats)) return;
  if (!Number.isInteger(nextBoatId)) return;

  const parsedVillages: Village[] = [];
  for (const value of villages) {
    const village = parseVillage(value);
    if (village === null) return;
    parsedVillages.push(village);
  }
  const parsedBoats: Boat[] = [];
  for (const value of boats) {
    const boat = parseBoat(value);
    if (boat === null) return;
    parsedBoats.push(boat);
  }

  const restored: SavedFleet = {
    villages: parsedVillages,
    boats: parsedBoats,
    nextBoatId: nextBoatId as number,
  };
  restoreFleet(restored);
}
