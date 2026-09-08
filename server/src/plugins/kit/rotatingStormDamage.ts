import { eyewallWindFalloff, isFiniteNumber } from '@terrace/shared';
import { ROTATING_STORM_DAMAGE_SAMPLE_CELLS } from './rotatingStorms.ts';

export const MAX_DAMAGE_SAMPLE_CELLS_PER_EVENT = ROTATING_STORM_DAMAGE_SAMPLE_CELLS * 100;

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

export function parseStormDamage(payload: unknown): ParsedStormDamage | null {
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

  if (!isFiniteNumber(stormId)) return null;
  if (!isFiniteNumber(x) || !isFiniteNumber(y)) return null;
  if (!isExtent(radius) || radius <= 0) return null;
  if (!isExtent(eyeRadius) || eyeRadius >= radius) return null;
  if (!isFraction(intensity)) return null;
  if (!isExtent(durationSeconds)) return null;

  const struck = parseStruckCells(cells);
  if (struck === null) return null;

  return { stormId, x, y, radius, eyeRadius, intensity, durationSeconds, cells: struck };
}

export function severityAt(damage: ParsedStormDamage, cellX: number, cellY: number): number {
  const dx = cellX - damage.x;
  const dy = cellY - damage.y;
  const distance = Math.sqrt(dx * dx + dy * dy);
  return (
    damage.intensity * eyewallWindFalloff(distance / damage.radius, damage.eyeRadius / damage.radius)
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
