// Shared randomness helpers.
//
// A separate file rather than a home in movement.ts or population.ts: those two
// already depend on each other (movement.ts reads WildlifeEntity and
// livingEntities from population.ts), so putting a helper either of them needs
// in the OTHER would invent a dependency cycle. flocks.ts needs it too. This
// file depends on nothing in the plugin, so everything can depend on it.

import {
  randomSigned as sharedRandomSigned,
  rollEvent as sharedRollEvent,
} from '@terrace/shared';

/**
 * A uniform random value in [-magnitude, +magnitude).
 *
 * The "double, then re-centre" shape (`Math.random() * 2 - 1`) used to appear
 * independently at eight call sites across this plugin — wander noise, group
 * scatter, flock aim spread, bird scatter, bird turn noise — each a candidate
 * for a transcription slip (dropping the `- 1` would silently bias every use
 * toward positive values, with no seeded test to catch it, since this plugin
 * deliberately runs on unseeded RNG). One named helper makes the shape
 * impossible to get wrong at more than one of them.
 *
 * The shape itself is @terrace/shared's now — weather carried the same helper —
 * and the source stays Math.random here, which is what "deliberately unseeded"
 * means for this plugin.
 */
export function randomSigned(magnitude: number): number {
  return sharedRandomSigned(Math.random, magnitude);
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS — the derivation lives on shared's own `rollEvent`. In
 * short: the naive `random() < rate * dt` is a linear approximation whose
 * outcome depends on how finely time is sliced, so a server at TICK_HZ 20 would
 * take idle bouts at a measurably different rate than one at 10. The exact form
 * is what lets the rates in ./species/*.ts be stated as "per second" and mean
 * it.
 *
 * ADDED 2026-09-02 for the idle bouts. The other two stochastic rates in this
 * plugin — the spawn hazard and the natural-turnover roll (population.ts) —
 * still use the linear form, deliberately and separately: their constants were
 * calibrated against it and swapping the arithmetic underneath them would
 * silently retune the ecosystem. This is the one function new rates go through.
 */
export function rollEvent(ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(Math.random, ratePerSecond, dt);
}
