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
  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, radius, intensity, vx, vy]) {
    if (!isFiniteNumber(number)) return null;
  }
  if (name !== undefined && typeof name !== 'string') return null;
  return {
    id: id as number,
    x: x as number,
    y: y as number,
    radius: radius as number,
    intensity: intensity as number,
    vx: vx as number,
    vy: vy as number,
    ...(typeof name === 'string' ? { name } : {}),
  };
}

export function parseRotatingStormsPayload(payload: unknown): RotatingStormsPayload | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { storms } = payload as Record<string, unknown>;
  if (!Array.isArray(storms)) return null;
  const parsed: RotatingStormState[] = [];
  for (const value of storms) {
    const storm = parseOne(value);
    if (storm === null) return null;
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
