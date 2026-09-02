// Randomness, and the ONE way this plugin turns a rate into an event.
//
// SEEDED AND PERSISTED, for storms' reason and a stronger one: a mudslide is the
// only thing in this repo that MOVES THE GROUND without a player asking it to.
// "A hillside ate my village" has to be a thing a self-hoster can reproduce from
// a snapshot and a bug report, and a slide half-run when the process died has to
// resume with the same draws it would have made. The generator's whole state is
// one uint32, so persisting it costs one number in the slice.
//
// Nothing here is terrain math — the results travel to clients as authoritative
// state and no client reproduces any of it — so the determinism contract in
// CLAUDE.md (which governs shared/'s heightmap ops) does not apply. What DOES
// apply is that the same seed must give the same world twice on the same build.

import { createSeededRng, rollEvent as sharedRollEvent } from '@terrace/shared';

/** A seeded PRNG whose whole state is one uint32, so it persists trivially. */
export interface MudslideRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for the persistence slice. */
  state(): number;
}

/**
 * Seed for a world that has never had a slide.
 *
 * Fixed rather than drawn from the clock, for relics', volcanoes' and storms'
 * reason: a self-hoster reporting "the same hillside collapses every time I
 * restart" must be reproducible. The value itself is arbitrary; only its
 * fixedness is load-bearing.
 */
export const MUDSLIDE_RNG_DEFAULT_SEED = 0x4d_55_44_21;

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
export function createMudslideRng(seed: number): MudslideRng {
  return createSeededRng(seed);
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS, and the argument is weather/server/rng.ts's, which is
 * monsters' before it. The naive `random() < rate * dt` is a linear
 * approximation whose outcome depends on how finely time is sliced, so a server
 * at TICK_HZ 20 would trigger slides at a measurably different rate than one at
 * 10, and a rate × dt above 1 would silently become certainty.
 *
 * 1 - e^(-λΔt) is the exact probability of at least one arrival of a Poisson
 * process in the interval, and chaining intervals composes exactly — which is
 * what lets every constant in ./slides.ts be stated as "mean seconds" and mean
 * it however the ticks fall.
 *
 * A non-positive rate never fires; a non-finite dt is treated as no time at all
 * rather than as certainty.
 */
export function rollEvent(rng: MudslideRng, ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(rng.next, ratePerSecond, dt);
}

/** A uniform integer draw in [0, count). */
export function randomIndex(rng: MudslideRng, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.floor(rng.next() * count));
}
