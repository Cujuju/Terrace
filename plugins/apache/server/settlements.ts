import { CELL_WORLD_SIZE, MAX_HEIGHT, MAX_RELIEF_WORLD_UNITS, SEA_LEVEL } from '@terrace/shared';
import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { PluginActionSite, WorldApi } from '../../../server/src/plugins/types.ts';
import { createFlightPose, sampleFlight } from '../flight.ts';
import { FLIGHT_SECONDS, ROOFTOP_CLEARANCE, type ApacheFlight } from '../protocol.ts';

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

const HEIGHT_SCALE = MAX_RELIEF_WORLD_UNITS / MAX_HEIGHT;
const CORRIDOR_RADIUS_CELLS = 3;
const MAX_TARGET_ATTEMPTS = 6;

function corridorAltitude(world: WorldApi, flight: ApacheFlight, groundCache: Map<number, number>): number | null {
  const pose = createFlightPose();
  let required = flight.altitude;
  // Below half a cell of travel per sample, including the rotor footprint and cell rounding.
  for (let i = 0; i <= 512; i++) {
    sampleFlight(flight, FLIGHT_SECONDS * i / 512, pose);
    const x = Math.round(pose.x / CELL_WORLD_SIZE), y = Math.round(pose.z / CELL_WORLD_SIZE);
    if (x < 0 || y < 0 || x >= world.worldSize || y >= world.worldSize) continue;
    const heightAbovePass = pose.altitude - flight.altitude;
    for (let dy = -CORRIDOR_RADIUS_CELLS; dy <= CORRIDOR_RADIUS_CELLS; dy++) {
      for (let dx = -CORRIDOR_RADIUS_CELLS; dx <= CORRIDOR_RADIUS_CELLS; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= world.worldSize || sy >= world.worldSize) continue;
        const key = sy * world.worldSize + sx;
        let ground = groundCache.get(key);
        if (ground === undefined) {
          ground = Math.max(SEA_LEVEL, world.heightAt(sx, sy)) * HEIGHT_SCALE;
          groundCache.set(key, ground);
        }
        required = Math.max(required, ground + ROOFTOP_CLEARANCE - heightAbovePass);
        if (required > flight.altitude + 1) return null;
      }
    }
  }
  return required;
}

export function planFlyby(
  world: WorldApi, id: number, random: () => number, near?: PluginActionSite,
): ApacheFlight | null {
  const available = settlements.api()?.standingStructures().filter(({ x, y }) =>
    world.isCellUnlocked(x, y) && world.heightAt(x, y) > SEA_LEVEL &&
    (near === undefined || Math.hypot(x - near.x, y - near.y) <= 160)) ?? [];
  if (available.length === 0) return null;
  if (near !== undefined) {
    available.sort((a, b) => (a.x - near.x) ** 2 + (a.y - near.y) ** 2 -
      ((b.x - near.x) ** 2 + (b.y - near.y) ** 2));
  }
  const offset = near === undefined ? Math.floor(random() * available.length) : 0;
  const heading = random() * Math.PI * 2;
  const groundCache = new Map<number, number>();
  for (let attempt = 0; attempt < Math.min(MAX_TARGET_ATTEMPTS, available.length); attempt++) {
    const target = available[(offset + attempt) % available.length]!;
    const altitude = world.heightAt(target.x, target.y) * HEIGHT_SCALE + ROOFTOP_CLEARANCE;
    for (let bearing = 0; bearing < 8; bearing++) {
      const flight: ApacheFlight = {
        id, centreX: target.x, centreY: target.y,
        heading: (heading + bearing * Math.PI / 4) % (Math.PI * 2),
        turn: random() < 0.5 ? -1 : 1, altitude, elapsed: 0,
      };
      const safeAltitude = corridorAltitude(world, flight, groundCache);
      // A distant ridge must not turn a rooftop pass into a high-altitude crossing.
      if (safeAltitude !== null && safeAltitude <= altitude + 1) {
        return { ...flight, altitude: safeAltitude };
      }
    }
  }
  return null;
}
