// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, the results
// travel to clients as authoritative system positions — so Math.random is fine
// (the determinism contract in CLAUDE.md governs shared/ terrain math, not
// plugin sim). What is NOT fine is each caller inventing its own "did it happen
// this tick?" arithmetic, so there is exactly one function for that.
//
// THE ARITHMETIC LIVES IN @terrace/shared NOW. It used to be monsters'
// server/rng.ts restated here, on the plugin boundary — a plugin is a
// distributable unit a self-hoster may install without its neighbours, so
// plugins do not depend on each other's internals. That is a rule about a
// NEIGHBOUR, and shared/ is core: it has no name, cannot be disabled for a
// world, and is not re-imported by a plugin reload. Three plugins carried the
// same six-line swappable source and six carried the same Poisson roll; the
// reasoning that kept those copies honest now lives on the one definition.
//
// WHAT STAYS HERE is this plugin's own SEAM — `weatherRandom` and
// `setWeatherRandomSource` are what this plugin's suite installs a generator
// through, and the names are part of how its tests read.

import {
  createRandomSource,
  pickWeightedIndex as sharedPickWeightedIndex,
  randomInRange as sharedRandomInRange,
  randomSigned as sharedRandomSigned,
  rollEvent as sharedRollEvent,
} from '@terrace/shared';

/**
 * The source of randomness. Swappable so tests can be deterministic in CI (see
 * setWeatherRandomSource) — spawn, decay and siting are this plugin's entire
 * behaviour, and a plugin whose central mechanic can only be tested
 * statistically is a plugin whose central mechanic is untested.
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

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS — see shared/src/rng.ts for the whole argument. In short:
 * `random() < rate * dt` is a linear approximation whose outcome depends on how
 * finely time is sliced, so a server at TICK_HZ 20 would grow weather at a
 * measurably different rate than one at 10. The exact form is what lets every
 * constant in ./systems.ts be stated as "mean seconds" and mean it.
 */
export function rollEvent(ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(weatherRandom, ratePerSecond, dt);
}

/**
 * Picks an index from a weight table. Weights need not sum to 1; a table whose
 * weights are all non-positive yields the last index rather than -1, so a
 * caller can never be handed an out-of-range kind.
 */
export function pickWeightedIndex(weights: readonly number[]): number {
  return sharedPickWeightedIndex(weatherRandom, weights);
}
