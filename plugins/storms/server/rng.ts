// Randomness, and the ONE way this plugin turns a rate into an event.
//
// SEEDED AND PERSISTED. Weather can use Math.random because a front nobody was
// watching is not worth reproducing. A storm is a different bargain: it is
// persisted (a cyclone lives eight minutes and must survive a restart mid-
// landfall), it emits events other plugins will act on destructively, and with
// surge on it can `sculpt` the shoreline. "A typhoon ate my harbour" has to be
// a thing a self-hoster can reproduce from a snapshot and a bug report. The
// generator's whole state is one uint32, so persisting it costs one number in
// the slice.
//
// Nothing here is terrain math — the results travel to clients as authoritative
// state and no client reproduces any of it — so the determinism contract in
// CLAUDE.md (which governs shared/'s heightmap ops) does not apply. What DOES
// apply is that the same seed must give the same world twice on the same
// build — for a cyclone and for surge, which draw only from this generator.
// A tornado is the one exception: ./storms.ts's trySpawnTornado also draws on
// weather's live storm-cell list (./weather-bridge.ts), and that list is
// positioned by weather's OWN unseeded rng (plugins/weather/server/rng.ts —
// Math.random by design, since no client reproduces a front either). So a
// tornado replays only given the same seed AND the same weather-cell history;
// seeding this generator alone reproduces where and when tornadoes are SITED
// relative to a cell, not which cells exist to be sited against.

import {
  createSeededRng,
  exponentialWaitSeconds as sharedExponentialWait,
  randomInRange as sharedRandomInRange,
  rollEvent as sharedRollEvent,
} from '@terrace/shared';

/** A seeded PRNG whose whole state is one uint32, so it persists trivially. */
export interface StormRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/**
 * Seed for a world that has never had a storm.
 *
 * Fixed rather than drawn from the clock, for relics' and volcanoes' reason: a
 * self-hoster reporting "every cyclone in my world came ashore on the same
 * beach" must be reproducible. The value itself is arbitrary; only its
 * fixedness is load-bearing.
 */
export const STORM_RNG_DEFAULT_SEED = 0x57_07_3d_51;

/**
 * mulberry32, from @terrace/shared.
 *
 * IMPORTED, NOT RESTATED. This was a byte-identical copy of the body seven
 * other files carried, kept as a copy on the plugin-boundary argument — a
 * plugin is a distributable unit and must not depend on a NEIGHBOUR's
 * internals. That argument is about plugins, and shared/ is not one: it has no
 * name, no lifecycle, cannot be disabled for a world and is not re-imported by
 * a plugin reload. The seed and the stream are unchanged, which is what the
 * persistence slice needs (see shared/src/rng.ts's header).
 */
export function createStormRng(seed: number): StormRng {
  return createSeededRng(seed);
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS, and the argument is weather/server/rng.ts's, which is
 * monsters' before it. The naive `random() < rate * dt` is a linear
 * approximation whose outcome depends on how finely time is sliced, so a server
 * at TICK_HZ 20 would spawn storms at a measurably different rate than one at
 * 10, and a rate × dt above 1 would silently become certainty.
 *
 * 1 - e^(-λΔt) is the exact probability of at least one arrival of a Poisson
 * process in the interval, and chaining intervals composes exactly
 * (e^-λa · e^-λb = e^-λ(a+b)) — which is what lets every constant in
 * ./storms.ts be stated as "mean seconds" and mean it however the ticks fall.
 *
 * A non-positive rate never fires; a non-finite dt is treated as no time at all
 * rather than as certainty.
 */
export function rollEvent(rng: StormRng, ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(rng.next, ratePerSecond, dt);
}

/**
 * An exponentially-distributed wait, in seconds, with the given mean — the
 * OTHER half of the same Poisson process, and the one a LIFETIME uses.
 *
 * WHY BOTH FORMS EXIST. A storm's life is a wait this plugin has to be able to
 * SHOW: it is counted down in a field, persisted across a restart, and resumed.
 * Sampling it once and counting it down is identical in distribution to rolling
 * the rate every tick (that is the memorylessness of the exponential), and it
 * survives a snapshot, which a per-tick roll does not — a restored cyclone
 * would otherwise have its whole remaining life silently re-drawn on every
 * boot.
 *
 * SPAWNING keeps the per-tick roll instead, because there is no individual
 * thing to hang a countdown on: it is a property of the world, and a
 * world-level countdown persisted across a change of the frequency setting
 * would be a second piece of state saying the same thing.
 *
 * The `1 - next()` is not superstition: `next()` can return exactly 0, and
 * `log(0)` is -Infinity, which would give a storm eternal life.
 */
export function exponentialWaitSeconds(rng: StormRng, meanSeconds: number): number {
  return sharedExponentialWait(rng.next, meanSeconds);
}

/** A uniform draw in [min, max). */
export function randomInRange(rng: StormRng, min: number, max: number): number {
  return sharedRandomInRange(rng.next, min, max);
}
