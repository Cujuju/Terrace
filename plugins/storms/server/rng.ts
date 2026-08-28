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
// apply is that the same seed must give the same world twice on the same build.

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
 * mulberry32 — the generator relics, volcanoes and weather each carry.
 *
 * RESTATED RATHER THAN IMPORTED, and that is the plugin boundary rather than an
 * oversight: a plugin is a distributable unit a self-hoster may install without
 * its neighbours, so plugins do not depend on each other's internals. The same
 * rule has wildlife and monsters each carrying their own
 * roundBroadcastPosition.
 */
export function createStormRng(seed: number): StormRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
    },
    state(): number {
      return a;
    },
  };
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
  if (!(ratePerSecond > 0) || !(dt > 0) || !Number.isFinite(dt)) return false;
  return rng.next() < 1 - Math.exp(-ratePerSecond * dt);
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
  if (!(meanSeconds > 0)) return 0;
  return -Math.log(1 - rng.next()) * meanSeconds;
}

/** A uniform draw in [min, max). */
export function randomInRange(rng: StormRng, min: number, max: number): number {
  return min + rng.next() * (max - min);
}
