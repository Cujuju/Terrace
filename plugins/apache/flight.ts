import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  APPROACH_HEIGHT, FLIGHT_BEND, FLIGHT_HALF_LENGTH, FLIGHT_SECONDS,
  type ApacheFlight,
} from './protocol.ts';

export interface FlightPose {
  x: number;
  z: number;
  altitude: number;
  heading: number;
  bank: number;
  pitch: number;
}

export function createFlightPose(): FlightPose {
  return { x: 0, z: 0, altitude: 0, heading: 0, bank: 0, pitch: 0 };
}

const TWO_PI = Math.PI * 2;
const SPEED_VARIATION = 0.12;
const EFFECTIVE_GRAVITY = 0.7;

function clamp(value: number, limit: number): number {
  return Math.max(-limit, Math.min(limit, value));
}

/** A single C2 flight curve: no waypoint corners or tick-sized position steps. */
export function sampleFlight(flight: ApacheFlight, elapsed: number, out: FlightPose): FlightPose {
  const u = Math.max(0, Math.min(1, elapsed / FLIGHT_SECONDS));
  const wave = TWO_PI * u;
  const s = 2 * u - 1 + SPEED_VARIATION * Math.sin(wave);
  const ds = (2 + SPEED_VARIATION * TWO_PI * Math.cos(wave)) / FLIGHT_SECONDS;
  const dds = -SPEED_VARIATION * TWO_PI ** 2 * Math.sin(wave) / FLIGHT_SECONDS ** 2;
  const lateral = flight.turn * FLIGHT_BEND;
  const along = FLIGHT_HALF_LENGTH * s;
  const across = lateral * Math.sin(Math.PI * s);
  const forwardSpeed = FLIGHT_HALF_LENGTH * ds;
  const sideSpeed = lateral * Math.PI * Math.cos(Math.PI * s) * ds;
  const forwardAccel = FLIGHT_HALF_LENGTH * dds;
  const sideAccel = lateral * Math.PI *
    (Math.cos(Math.PI * s) * dds - Math.PI * Math.sin(Math.PI * s) * ds * ds);
  const cos = Math.cos(flight.heading), sin = Math.sin(flight.heading);
  const speed = Math.hypot(forwardSpeed, sideSpeed);
  const turnRate = (forwardSpeed * sideAccel - sideSpeed * forwardAccel) / (speed * speed);
  const acceleration = (forwardSpeed * forwardAccel + sideSpeed * sideAccel) / speed;
  const climbRate = 2 * APPROACH_HEIGHT * s * ds;

  out.x = flight.centreX * CELL_WORLD_SIZE + along * cos - across * sin;
  out.z = flight.centreY * CELL_WORLD_SIZE + along * sin + across * cos;
  out.altitude = flight.altitude + APPROACH_HEIGHT * s * s;
  out.heading = flight.heading + Math.atan2(sideSpeed, forwardSpeed);
  out.bank = clamp(Math.atan2(speed * turnRate, EFFECTIVE_GRAVITY), 0.42);
  out.pitch = clamp(0.45 * Math.atan2(climbRate, speed) - 0.065 - acceleration * 0.16, 0.22);
  return out;
}

export function fadeAt(elapsed: number): number {
  const t = Math.max(0, Math.min(1, elapsed / 1.5, (FLIGHT_SECONDS - elapsed) / 1.5));
  return t * t * (3 - 2 * t);
}
