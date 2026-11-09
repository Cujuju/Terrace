import { CELL_WORLD_SIZE, DRAWN_GROUND_CELL_CENTRE, SEA_LEVEL, WORLD_UNITS_PER_BAND, cellsAcross, drawnBandOfSample } from '@terrace/shared';
import { createFlightPose, MAX_FLIGHT_SPEED_WORLD_UNITS_PER_SECOND, sampleFlight } from './flight.ts';
import { APACHE_CLEARANCE_RADIUS_WORLD_UNITS, FLIGHT_SECONDS, type ApacheFlight } from './protocol.ts';

// Padding covers the shifted field's far corner, rounded pose centres, and travel between samples.
const MAX_SAMPLE_TRAVEL_CELLS = 0.5;
const TERRAIN_SAMPLE_SUPPORT_CELLS = 1 + DRAWN_GROUND_CELL_CENTRE;
const SAMPLE_ROUNDING_CELLS = 0.5;
const SAMPLE_SECONDS = MAX_SAMPLE_TRAVEL_CELLS * CELL_WORLD_SIZE / MAX_FLIGHT_SPEED_WORLD_UNITS_PER_SECOND;
const CORRIDOR_RADIUS_CELLS = Math.ceil(cellsAcross(APACHE_CLEARANCE_RADIUS_WORLD_UNITS) +
  TERRAIN_SAMPLE_SUPPORT_CELLS + SAMPLE_ROUNDING_CELLS + MAX_SAMPLE_TRAVEL_CELLS / 2);

export function terrainCapY(height: number): number {
  return Math.max(SEA_LEVEL, drawnBandOfSample(height) * WORLD_UNITS_PER_BAND);
}

export function visitCorridor(
  flight: ApacheFlight, from: number, to: number, worldSize: number,
  visit: (x: number, y: number, altitude: number) => boolean | void,
): boolean {
  const start = Math.max(0, Math.min(FLIGHT_SECONDS, from));
  const end = Math.max(start, Math.min(FLIGHT_SECONDS, to));
  const steps = Math.ceil((end - start) / SAMPLE_SECONDS);
  const pose = createFlightPose();
  for (let i = 0; i <= steps; i++) {
    sampleFlight(flight, steps === 0 ? start : start + (end - start) * i / steps, pose);
    const x = Math.round(pose.x / CELL_WORLD_SIZE), y = Math.round(pose.z / CELL_WORLD_SIZE);
    for (let dy = -CORRIDOR_RADIUS_CELLS; dy <= CORRIDOR_RADIUS_CELLS; dy++) {
      for (let dx = -CORRIDOR_RADIUS_CELLS; dx <= CORRIDOR_RADIUS_CELLS; dx++) {
        const sx = x + dx, sy = y + dy;
        if (sx < 0 || sy < 0 || sx >= worldSize || sy >= worldSize) continue;
        if (visit(sx, sy, pose.altitude) === false) return false;
      }
    }
  }
  return true;
}

export function corridorLift(
  flight: ApacheFlight, from: number, to: number, worldSize: number,
  groundAt: (x: number, y: number) => number | null, headroom: number,
): number {
  let lift = 0;
  visitCorridor(flight, from, to, worldSize, (x, y, altitude) => {
    const ground = groundAt(x, y);
    if (ground !== null) lift = Math.max(lift, ground + headroom + APACHE_CLEARANCE_RADIUS_WORLD_UNITS - altitude);
  });
  return lift;
}
