import { isFiniteNumber } from './parse.ts';

export interface RotatingStormState {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
  readonly vx: number;
  readonly vy: number;
  readonly name?: string;
}

export interface RotatingStormsPayload {
  readonly storms: readonly RotatingStormState[];
}

function parseOne(value: unknown): RotatingStormState | null {
  if (typeof value !== 'object' || value === null) return null;
  const { id, x, y, radius, intensity, vx, vy, name } = value as Record<string, unknown>;
  if (!isFiniteNumber(id) || !Number.isInteger(id) || id <= 0) return null;
  for (const number of [x, y, radius, intensity, vx, vy]) {
    if (!isFiniteNumber(number)) return null;
  }
  if ((radius as number) <= 0) return null;
  if (name !== undefined && typeof name !== 'string') return null;
  return {
    id,
    x: x as number,
    y: y as number,
    radius: radius as number,
    intensity: Math.min(1, Math.max(0, intensity as number)),
    vx: vx as number,
    vy: vy as number,
    ...(typeof name === 'string' ? { name } : {}),
  };
}

// Drops what it cannot use rather than the whole sky, and stops at the
// caller's draw ceiling: a malformed storm costs one storm, not the frame.
export function parseRotatingStormsPayload(
  payload: unknown,
  maxStorms: number = Number.POSITIVE_INFINITY,
): RotatingStormsPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { storms } = payload as Record<string, unknown>;
  if (!Array.isArray(storms)) return null;
  const parsed: RotatingStormState[] = [];
  const seen = new Set<number>();
  for (const value of storms) {
    if (parsed.length >= maxStorms) break;
    const storm = parseOne(value);
    if (storm === null) continue;
    if (seen.has(storm.id)) continue;
    seen.add(storm.id);
    parsed.push(storm);
  }
  return { storms: parsed };
}

export function eyewallWindFalloff(radiusFraction: number, eyeRadiusFraction: number): number {
  if (eyeRadiusFraction >= 1) return 0;
  if (radiusFraction <= eyeRadiusFraction) return 0;
  if (radiusFraction >= 1) return 0;
  return (1 - radiusFraction) / (1 - eyeRadiusFraction);
}
