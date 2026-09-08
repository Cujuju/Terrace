export {
  parseDiscSystemsPayload,
  type DiscSystemState,
  type DiscSystemsPayload,
} from '@terrace/shared';

import { isFiniteNumber } from '@terrace/shared';

export const THUNDERSTORM_PLUGIN_NAME = 'thunderstorm';

export const THUNDERSTORM_SYSTEMS_MESSAGE = 'systems';

export const THUNDERSTORM_COVERAGE_FRACTION = 0.036;

export const MAX_ACTIVE_SYSTEMS = 3;

export const THUNDERSTORM_STRIKES_MESSAGE = 'strikes';

export const MAX_STRIKES_PER_MESSAGE = 8;

export const STRIKE_NO_SYSTEM = 0;

export interface ThunderstormStrike {
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

export interface ThunderstormStrikesPayload {
  readonly strikes: readonly number[];
}

export const STRIKE_WIRE_STRIDE = 3;

export function packStrikes(strikes: Iterable<ThunderstormStrike>): number[] {
  const packed: number[] = [];
  for (const strike of strikes) packed.push(strike.systemId, strike.x, strike.y);
  return packed;
}

export function parseStrikesPayload(payload: unknown): ThunderstormStrike[] | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const strikes = (payload as { strikes?: unknown }).strikes;
  if (!Array.isArray(strikes)) return null;

  const parsed: ThunderstormStrike[] = [];
  for (let i = 0; i + STRIKE_WIRE_STRIDE - 1 < strikes.length; i += STRIKE_WIRE_STRIDE) {
    if (parsed.length >= MAX_STRIKES_PER_MESSAGE) break;
    const systemId = strikes[i];
    const x = strikes[i + 1];
    const y = strikes[i + 2];
    if (!isFiniteNumber(systemId) || !isFiniteNumber(x) || !isFiniteNumber(y)) continue;
    if (!Number.isInteger(x) || !Number.isInteger(y) || x < 0 || y < 0) continue;
    parsed.push({ systemId, x, y });
  }
  return parsed;
}
