import { randomInRange, rollEvent } from '@terrace/shared';
import { STRIKE_NO_SYSTEM } from '../protocol.ts';
import { thunderstormRandom } from './rng.ts';

export interface StrikeWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

export interface StrikeSource {
  readonly id: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly peakIntensity: number;
  readonly envelope: number;
}

export const STRIKE_BUDGET_PER_SECOND = 0.06;

export const STRIKE_TARGET_SAMPLES = 6;

export const DRY_STRIKE_RATE_PER_SECOND = 1 / 240;

export const DRY_STRIKE_TARGET_SAMPLES = 24;

export const EXPOSURE_SAMPLE_RADIUS_CELLS = 4;

const EXPOSURE_OFFSETS: readonly (readonly [number, number])[] = [
  [-EXPOSURE_SAMPLE_RADIUS_CELLS, 0],
  [EXPOSURE_SAMPLE_RADIUS_CELLS, 0],
  [0, -EXPOSURE_SAMPLE_RADIUS_CELLS],
  [0, EXPOSURE_SAMPLE_RADIUS_CELLS],
];

export const EXPOSURE_PROMINENCE_WEIGHT = 2;

export function exposureAt(world: StrikeWorld, x: number, y: number): number {
  const height = world.heightAt(x, y);
  if (height <= 0) return Number.NEGATIVE_INFINITY;

  let surrounding = 0;
  for (const [dx, dy] of EXPOSURE_OFFSETS) {
    const sx = Math.min(world.worldSize - 1, Math.max(0, x + dx));
    const sy = Math.min(world.worldSize - 1, Math.max(0, y + dy));
    surrounding += world.heightAt(sx, sy);
  }
  const prominence = height - surrounding / EXPOSURE_OFFSETS.length;
  return height + prominence * EXPOSURE_PROMINENCE_WEIGHT;
}

export function chooseDryStrikeCell(world: StrikeWorld): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestExposure = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < DRY_STRIKE_TARGET_SAMPLES; sample++) {
    const x = Math.floor(randomInRange(thunderstormRandom, 0, world.worldSize));
    const y = Math.floor(randomInRange(thunderstormRandom, 0, world.worldSize));
    const exposure = exposureAt(world, x, y);
    if (exposure <= bestExposure) continue;
    bestExposure = exposure;
    best = { x, y };
  }

  return best;
}

export interface Strike {
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

function sampleCell(system: StrikeSource, worldSize: number): { x: number; y: number } | null {
  const angle = thunderstormRandom() * Math.PI * 2;
  const radius = Math.sqrt(thunderstormRandom()) * system.radius;
  const x = Math.round(system.x + Math.cos(angle) * radius);
  const y = Math.round(system.y + Math.sin(angle) * radius);
  if (x < 0 || y < 0 || x >= worldSize || y >= worldSize) return null;
  return { x, y };
}

export function chooseStrikeCell(
  system: StrikeSource,
  world: StrikeWorld,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestHeight = Number.NEGATIVE_INFINITY;

  for (let sample = 0; sample < STRIKE_TARGET_SAMPLES; sample++) {
    const cell = sampleCell(system, world.worldSize);
    if (cell === null) continue;
    const height = world.heightAt(cell.x, cell.y);
    if (height <= bestHeight) continue;
    bestHeight = height;
    best = cell;
  }

  return best;
}

function stormIntensity(system: StrikeSource): number {
  return system.peakIntensity * system.envelope;
}

export function rollStrikes(
  world: StrikeWorld,
  systems: readonly StrikeSource[],
  dt: number,
): Strike[] {
  const strikes: Strike[] = [];

  if (rollEvent(thunderstormRandom, DRY_STRIKE_RATE_PER_SECOND, dt)) {
    const cell = chooseDryStrikeCell(world);
    if (cell !== null) strikes.push({ systemId: STRIKE_NO_SYSTEM, x: cell.x, y: cell.y });
  }

  let totalIntensity = 0;
  for (const system of systems) totalIntensity += stormIntensity(system);
  const budgetShareDenominator = Math.max(1, totalIntensity);

  for (const system of systems) {
    const intensity = stormIntensity(system);
    if (intensity <= 0) continue;
    const rate = (STRIKE_BUDGET_PER_SECOND * intensity) / budgetShareDenominator;
    if (!rollEvent(thunderstormRandom, rate, dt)) continue;

    const cell = chooseStrikeCell(system, world);
    if (cell === null) continue;
    strikes.push({ systemId: system.id, x: cell.x, y: cell.y });
  }

  return strikes;
}
