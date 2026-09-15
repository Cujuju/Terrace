import { cellsAcross, randomInRange, rollEvent } from '@terrace/shared';
import { STRIKE_NO_SYSTEM } from '../protocol.ts';
import { thunderstormRandom } from './rng.ts';

export interface StrikeWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
  isCellUnlocked(x: number, y: number): boolean;
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

// Below one storm-equivalent the budget scales with intensity instead of being shared.
export const BUDGET_SHARE_FLOOR_INTENSITY = 1;

export const STRIKE_TARGET_SAMPLES = 6;

export const DRY_STRIKE_RATE_PER_SECOND = 1 / 240;

export const DRY_STRIKE_TARGET_SAMPLES = 24;

export const SAMPLE_ATTEMPT_MULTIPLIER = 4;

export const STRIKE_MAX_SAMPLE_ATTEMPTS = SAMPLE_ATTEMPT_MULTIPLIER * STRIKE_TARGET_SAMPLES;

export const DRY_STRIKE_MAX_SAMPLE_ATTEMPTS =
  SAMPLE_ATTEMPT_MULTIPLIER * DRY_STRIKE_TARGET_SAMPLES;

export const EXPOSURE_SAMPLE_RADIUS_CELLS = cellsAcross(1);

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

export interface Strike {
  readonly systemId: number;
  readonly x: number;
  readonly y: number;
}

// Fire ignites on every strike: only an in-world, unlocked cell may be struck.
// A burn scar on unrevealed ground is the write-is-the-harm case
// (docs/decisions/storms-and-mudslides.md).
function bestUnlockedCandidate(
  world: StrikeWorld,
  targetSamples: number,
  maxAttempts: number,
  draw: () => { x: number; y: number } | null,
  score: (x: number, y: number) => number,
): { x: number; y: number } | null {
  let best: { x: number; y: number } | null = null;
  let bestScore = Number.NEGATIVE_INFINITY;
  let candidates = 0;

  for (let attempt = 0; attempt < maxAttempts && candidates < targetSamples; attempt++) {
    const cell = draw();
    if (cell === null || !world.isCellUnlocked(cell.x, cell.y)) continue;
    candidates++;
    const value = score(cell.x, cell.y);
    if (value <= bestScore) continue;
    bestScore = value;
    best = cell;
  }

  return best;
}

export function chooseDryStrikeCell(world: StrikeWorld): { x: number; y: number } | null {
  return bestUnlockedCandidate(
    world,
    DRY_STRIKE_TARGET_SAMPLES,
    DRY_STRIKE_MAX_SAMPLE_ATTEMPTS,
    () => ({
      x: Math.floor(randomInRange(thunderstormRandom, 0, world.worldSize)),
      y: Math.floor(randomInRange(thunderstormRandom, 0, world.worldSize)),
    }),
    (x, y) => exposureAt(world, x, y),
  );
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
  return bestUnlockedCandidate(
    world,
    STRIKE_TARGET_SAMPLES,
    STRIKE_MAX_SAMPLE_ATTEMPTS,
    () => sampleCell(system, world.worldSize),
    (x, y) => world.heightAt(x, y),
  );
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
  const budgetShareDenominator = Math.max(BUDGET_SHARE_FLOOR_INTENSITY, totalIntensity);

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
