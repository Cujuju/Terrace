// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, the results
// travel to clients as authoritative system positions — so Math.random is fine
// (the determinism contract in CLAUDE.md governs shared/ terrain math, not
// plugin sim). What is NOT fine is each caller inventing its own "did it happen
// this tick?" arithmetic, so there is exactly one function for that.
//
// This is the monsters plugin's server/rng.ts, restated. It is NOT imported from
// there: a plugin is a distributable unit that a self-hoster may install without
// its neighbours, so plugins do not depend on each other's internals — the same
// boundary that has wildlife and monsters each carry their own
// roundBroadcastPosition. The reasoning below is copied deliberately, because
// the reasoning is the thing worth keeping in step.

/**
 * The source of randomness. Swappable so tests can be deterministic in CI (see
 * setWeatherRandomSource) — spawn, decay and siting are this plugin's entire
 * behaviour, and a plugin whose central mechanic can only be tested
 * statistically is a plugin whose central mechanic is untested.
 */
let randomSource: () => number = Math.random;

/** Returns a float in [0, 1). */
export function weatherRandom(): number {
  return randomSource();
}

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetWeatherState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export function setWeatherRandomSource(source: (() => number) | null): void {
  randomSource = source ?? Math.random;
}

/** Uniform float in [min, max). */
export function randomInRange(min: number, max: number): number {
  return min + weatherRandom() * (max - min);
}

/** Uniform float in [-magnitude, +magnitude). */
export function randomSigned(magnitude: number): number {
  return (weatherRandom() * 2 - 1) * magnitude;
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS. The naive version — `random() < rate * dt` — is a linear
 * approximation of the same thing, and it is WRONG in a way that bites exactly
 * this codebase: its outcome depends on how finely time is sliced, so a server
 * running at TICK_HZ 20 would grow weather at a measurably different rate than
 * one at 10, and a rate × dt above 1 would silently become certainty.
 *
 * 1 - e^(-λΔt) is the exact probability of at least one arrival of a Poisson
 * process in the interval. Chaining intervals composes exactly (e^-λa · e^-λb =
 * e^-λ(a+b)), so the expected wait is 1/λ seconds however the ticks fall —
 * which is what lets every constant in ./systems.ts be stated as "mean seconds"
 * and mean it.
 *
 * A non-positive rate never fires; a non-finite dt is treated as no time at all
 * rather than as certainty.
 */
export function rollEvent(ratePerSecond: number, dt: number): boolean {
  if (!(ratePerSecond > 0) || !(dt > 0) || !Number.isFinite(dt)) return false;
  return weatherRandom() < 1 - Math.exp(-ratePerSecond * dt);
}

/**
 * Picks an index from a weight table. Weights need not sum to 1; a table whose
 * weights are all non-positive yields the last index rather than -1, so a
 * caller can never be handed an out-of-range kind.
 */
export function pickWeightedIndex(weights: readonly number[]): number {
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (!(total > 0)) return weights.length - 1;

  let roll = weatherRandom() * total;
  for (let index = 0; index < weights.length; index++) {
    roll -= Math.max(0, weights[index]!);
    if (roll < 0) return index;
  }
  // Only reachable through floating-point round-off at the very top of the
  // range; the last bucket is the honest answer there.
  return weights.length - 1;
}
