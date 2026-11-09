import { eyewallWindFalloff, isFiniteNumber } from '@terrace/shared';
import { ROTATING_STORM_DAMAGE_SAMPLE_CELLS } from './rotatingStormTypes.ts';

// One event carries one storm's samples; the ceiling leaves generous slack
// before a hostile payload is truncated.
const MAX_STORMS_PER_DAMAGE_EVENT = 100;

export const MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT =
  ROTATING_STORM_DAMAGE_SAMPLE_CELLS * MAX_STORMS_PER_DAMAGE_EVENT;

export const STORM_WIND_FALLOFF_EYEWALL = 'eyewall';
export const STORM_WIND_FALLOFF_QUADRATIC = 'quadratic';

export type StormWindFalloff =
  | typeof STORM_WIND_FALLOFF_EYEWALL
  | typeof STORM_WIND_FALLOFF_QUADRATIC;

export interface StruckCell {
  readonly x: number;
  readonly y: number;
  readonly severity: number;
}

export interface ParsedStormDamage {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly eyeRadius: number;
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly cells: readonly StruckCell[];
  readonly windFalloff?: StormWindFalloff;
}

function isExtent(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0;
}

function isFraction(value: unknown): value is number {
  return isFiniteNumber(value) && value >= 0 && value <= 1;
}

function parseStruckCells(value: unknown): StruckCell[] | null {
  if (!Array.isArray(value)) return null;
  const cells: StruckCell[] = [];
  for (const item of value) {
    if (cells.length >= MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT) break;
    if (typeof item !== 'object' || item === null) continue;
    const { x, y, severity } = item as { x?: unknown; y?: unknown; severity?: unknown };
    if (!isFiniteNumber(x) || !isFiniteNumber(y) || !isFraction(severity)) continue;
    cells.push({ x, y, severity });
  }
  return cells;
}

export function parseStormDamage(
  payload: unknown,
  windFalloff: StormWindFalloff = STORM_WIND_FALLOFF_EYEWALL,
): ParsedStormDamage | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const { stormId, x, y, radius, eyeRadius, intensity, durationSeconds, cells } = payload as {
    stormId?: unknown;
    x?: unknown;
    y?: unknown;
    radius?: unknown;
    eyeRadius?: unknown;
    intensity?: unknown;
    durationSeconds?: unknown;
    cells?: unknown;
  };

  if (!isFiniteNumber(stormId) || !Number.isInteger(stormId) || stormId <= 0) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isExtent(radius) || radius <= 0) return null;
  if (!isExtent(eyeRadius) || eyeRadius >= radius) return null;
  if (!isFraction(intensity)) return null;
  if (!isExtent(durationSeconds)) return null;

  const struck = parseStruckCells(cells);
  if (struck === null) return null;

  return { stormId, x, y, radius, eyeRadius, intensity, durationSeconds, cells: struck, windFalloff };
}

export function severityAt(damage: ParsedStormDamage, cellX: number, cellY: number): number {
  const dx = cellX - damage.x;
  const dy = cellY - damage.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  const radiusFraction = distance / damage.radius;
  if (damage.windFalloff === STORM_WIND_FALLOFF_QUADRATIC) {
    return damage.intensity * Math.max(0, 1 - radiusFraction * radiusFraction);
  }
  return (
    damage.intensity * eyewallWindFalloff(radiusFraction, damage.eyeRadius / damage.radius)
  );
}

export function tangentialWindAt(
  damage: ParsedStormDamage,
  cellX: number,
  cellY: number,
): { readonly x: number; readonly y: number } | null {
  const dx = cellX - damage.x;
  const dy = cellY - damage.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  if (distance === 0) return null;
  return { x: -dy / distance, y: dx / distance };
}
