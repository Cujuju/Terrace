import { isFiniteNumber, parseRecordArray } from '@terrace/shared';
import type { RotatingStorm, RotatingStormsSnapshot } from './rotatingStormTypes.ts';

function clampFraction(value: number): number {
  return Math.min(1, Math.max(0, value));
}

function parseStorm(value: unknown): RotatingStorm | null {
  if (typeof value !== 'object' || value === null) return null;
  const {
    id,
    x,
    y,
    radius,
    heading,
    peakIntensity,
    envelope,
    retiring,
    lifeSeconds,
    name,
    landfallReported,
    damageDebtSeconds,
    ownerDebtSeconds,
  } = value as Record<string, unknown>;

  if (!Number.isInteger(id)) return null;
  for (const number of [x, y, radius, heading, peakIntensity, envelope, lifeSeconds]) {
    if (!isFiniteNumber(number)) return null;
  }
  if ((radius as number) <= 0) return null;
  if (!isFiniteNumber(damageDebtSeconds) || damageDebtSeconds < 0) return null;
  const ownerDebt = ownerDebtSeconds === undefined ? 0 : ownerDebtSeconds;
  if (!isFiniteNumber(ownerDebt) || ownerDebt < 0) return null;
  if (typeof retiring !== 'boolean' || typeof landfallReported !== 'boolean') return null;
  if (name !== undefined && typeof name !== 'string') return null;

  return {
    id: id as number,
    x: x as number,
    y: y as number,
    radius: radius as number,
    heading: heading as number,
    peakIntensity: clampFraction(peakIntensity as number),
    envelope: clampFraction(envelope as number),
    retiring: retiring as boolean,
    lifeSeconds: lifeSeconds as number,
    ...(typeof name === 'string' ? { name } : {}),
    landfallReported: landfallReported as boolean,
    damageDebtSeconds: damageDebtSeconds as number,
    ownerDebtSeconds: ownerDebt,
  };
}

export function parseRotatingStormsSnapshot(data: unknown): RotatingStormsSnapshot | null {
  if (typeof data !== 'object' || data === null) return null;
  const { nextStormId, namedCount, rngState, storms } = data as Record<string, unknown>;
  if (!Number.isInteger(nextStormId) || !Number.isInteger(namedCount)) return null;
  if (!Number.isInteger(rngState)) return null;
  const parsed = parseRecordArray(storms, parseStorm);
  if (parsed === null) return null;
  return {
    nextStormId: nextStormId as number,
    namedCount: namedCount as number,
    rngState: rngState as number,
    storms: parsed,
  };
}
