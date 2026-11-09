import { CHUNK_SIZE, SEA_LEVEL } from '@terrace/shared';
import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { PluginActionSite, WorldApi } from '../../../server/src/plugins/types.ts';
import { terrainCapY, visitCorridor } from '../clearance.ts';
import {
  APACHE_CLEARANCE_RADIUS_WORLD_UNITS,
  FLIGHT_SECONDS,
  ROOFTOP_CLEARANCE,
  type ApacheFlight,
} from '../protocol.ts';

interface StructuresApi {
  standingStructures(): readonly { readonly x: number; readonly y: number }[];
}

// Documented copy of structures' public standingStructures contract; no sibling imports.
export const settlements = createSiblingBridge<StructuresApi>({
  pluginName: 'structures',
  duckType: (module) => module !== null && typeof module.standingStructures === 'function'
    ? module as unknown as StructuresApi : null,
  unavailableWarning: '[apache] structures unavailable; waiting for settlements before flying',
});

const MAX_TARGET_ATTEMPTS = 6;
const MAX_ADDITIONAL_ALTITUDE_WORLD_UNITS = 1;

export interface FlybyPlan {
  readonly flight: ApacheFlight;
  readonly visibilityCells: readonly { readonly x: number; readonly y: number }[];
}

function corridorAltitude(
  world: WorldApi, flight: ApacheFlight, groundAt: (x: number, y: number) => number | null,
): number | null {
  let required = flight.altitude;
  const clear = visitCorridor(flight, 0, FLIGHT_SECONDS, world.worldSize, (x, y, altitude) => {
    const ground = groundAt(x, y);
    if (ground === null) return;
    required = Math.max(required, ground + ROOFTOP_CLEARANCE + APACHE_CLEARANCE_RADIUS_WORLD_UNITS -
      (altitude - flight.altitude));
    return required <= flight.altitude + MAX_ADDITIONAL_ALTITUDE_WORLD_UNITS;
  });
  return clear ? required : null;
}

export function planFlyby(
  world: WorldApi, id: number, random: () => number, near?: PluginActionSite,
): FlybyPlan | null {
  const visibility = new Map<number, { x: number; y: number }>();
  const groundCache = new Map<number, number>();
  const requireCell = (x: number, y: number): void => {
    const cx = Math.floor(x / CHUNK_SIZE), cy = Math.floor(y / CHUNK_SIZE);
    visibility.set(cy * world.chunksPerEdge + cx, { x: cx * CHUNK_SIZE, y: cy * CHUNK_SIZE });
  };
  const groundAt = (x: number, y: number): number | null => {
    if (!world.isCellUnlocked(x, y)) return null;
    const key = y * world.worldSize + x;
    let ground = groundCache.get(key);
    if (ground === undefined) {
      requireCell(x, y);
      ground = terrainCapY(world.heightAt(x, y));
      groundCache.set(key, ground);
    }
    return ground;
  };
  const available = settlements.api()?.standingStructures().filter(({ x, y }) => {
    return (near === undefined || Math.hypot(x - near.x, y - near.y) <= 160) &&
      world.isCellUnlocked(x, y);
  }) ?? [];
  if (available.length === 0) return null;
  if (near !== undefined) {
    available.sort((a, b) => (a.x - near.x) ** 2 + (a.y - near.y) ** 2 -
      ((b.x - near.x) ** 2 + (b.y - near.y) ** 2));
  }
  const offset = near === undefined ? Math.floor(random() * available.length) : 0;
  const heading = random() * Math.PI * 2;
  for (let attempt = 0; attempt < Math.min(MAX_TARGET_ATTEMPTS, available.length); attempt++) {
    const target = available[(offset + attempt) % available.length]!;
    requireCell(target.x, target.y);
    if (world.heightAt(target.x, target.y) <= SEA_LEVEL) continue;
    const ground = groundAt(target.x, target.y);
    if (ground === null) continue;
    const altitude = ground + ROOFTOP_CLEARANCE + APACHE_CLEARANCE_RADIUS_WORLD_UNITS;
    for (let bearing = 0; bearing < 8; bearing++) {
      const flight: ApacheFlight = {
        id, centreX: target.x, centreY: target.y,
        heading: (heading + bearing * Math.PI / 4) % (Math.PI * 2),
        turn: random() < 0.5 ? -1 : 1, altitude, elapsed: 0,
      };
      const safeAltitude = corridorAltitude(world, flight, groundAt);
      // A distant ridge must not turn a rooftop pass into a high-altitude crossing.
      if (safeAltitude !== null) {
        return { flight: { ...flight, altitude: safeAltitude }, visibilityCells: [...visibility.values()] };
      }
    }
  }
  return null;
}
