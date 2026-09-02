// Randomness, for the one stochastic thing this plugin still owns: the wind.
//
// Nothing here is terrain math — no client reproduces any of it, and the wind
// travels to clients as an authoritative per-system velocity — so Math.random is
// fine (the determinism contract in CLAUDE.md governs shared/ terrain math, not
// plugin sim).
//
// THE ARITHMETIC LIVES IN @terrace/shared. What stays here is this plugin's own
// SEAM — `weatherRandom` and `setWeatherRandomSource` are what this plugin's
// suite installs a generator through, and the names are part of how its tests
// read.

import {
  createRandomSource,
  randomInRange as sharedRandomInRange,
  randomSigned as sharedRandomSigned,
} from '@terrace/shared';

/**
 * The source of randomness. Swappable so tests can be deterministic in CI (see
 * setWeatherRandomSource).
 */
const source = createRandomSource();

/** Returns a float in [0, 1). */
export const weatherRandom = source.random;

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetWeatherState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export const setWeatherRandomSource = source.setSource;

/** Uniform float in [min, max). */
export function randomInRange(min: number, max: number): number {
  return sharedRandomInRange(weatherRandom, min, max);
}

/** Uniform float in [-magnitude, +magnitude). */
export function randomSigned(magnitude: number): number {
  return sharedRandomSigned(weatherRandom, magnitude);
}
