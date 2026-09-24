import { isFiniteNumber, scaleToRealSize } from '@terrace/shared';

export const APACHE_PLUGIN_NAME = 'apache';
export const APACHE_STATE_MESSAGE = 'state';
export const FLIGHT_SECONDS = 28;
export const FLIGHT_HALF_LENGTH = 20;
export const FLIGHT_BEND = 4;
export const APPROACH_HEIGHT = 4;
export const ROOFTOP_CLEARANCE = 3;

// Authored extents of apache.glb (nose to tail, rotor disc radius); the client checks the GLB against them.
export const APACHE_AUTHORED_LENGTH_WORLD_UNITS = 0.997;
export const APACHE_AUTHORED_ROTOR_RADIUS_WORLD_UNITS = 0.388;

export const APACHE_REAL_LENGTH_METRES = 17.7;

export const APACHE_DRAW_SCALE = scaleToRealSize(APACHE_AUTHORED_LENGTH_WORLD_UNITS, APACHE_REAL_LENGTH_METRES);

export interface ApacheFlight {
  readonly id: number;
  /** Settlement coordinates in cells; all vertical distances are world units. */
  readonly centreX: number;
  readonly centreY: number;
  readonly heading: number;
  readonly turn: number;
  readonly altitude: number;
  readonly elapsed: number;
}

export interface ApachePayload {
  readonly flight: ApacheFlight | null;
}

export function parseApachePayload(value: unknown): ApachePayload | null {
  if (typeof value !== 'object' || value === null) return null;
  const flight = (value as { flight?: unknown }).flight;
  if (flight === null) return { flight: null };
  if (typeof flight !== 'object') return null;
  const raw = flight as Partial<Record<keyof ApacheFlight, unknown>>;
  const { id, centreX, centreY, heading, turn, altitude, elapsed } = raw;
  if (!isFiniteNumber(id) || !Number.isSafeInteger(id) || id < 1 ||
      !isFiniteNumber(centreX) || centreX < 0 ||
      !isFiniteNumber(centreY) || centreY < 0 ||
      !isFiniteNumber(heading) || Math.abs(heading) > Math.PI * 2 ||
      (turn !== -1 && turn !== 1) ||
      !isFiniteNumber(altitude) || altitude < 0 || altitude > 128 ||
      !isFiniteNumber(elapsed) || elapsed < 0 || elapsed > FLIGHT_SECONDS) return null;
  return { flight: { id, centreX, centreY, heading, turn, altitude, elapsed } };
}
