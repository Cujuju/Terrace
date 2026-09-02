// Randomness — the one place a plugin turns a seed into a stream, and a rate
// into an event.
//
// WHY IT IS HERE AND NOT IN EACH PLUGIN. Seven plugins carried a byte-identical
// mulberry32 body (storms, volcanoes, structures, mudslides, flora, relics, and
// core's own genesis), three carried the same six-line swappable-source seam,
// and six carried the same Poisson roll. Each copy restated the same reasoning
// in its own header, which is how the copies stayed honest — and also what made
// them copies: an algorithm that is IDENTICAL in seven places is one algorithm.
// The precedent is shared/src/wire.ts (#180), where the same argument moved a
// rounding out of five plugins.
//
// THIS IS NOT A PLUGIN, so importing it is not a cross-plugin dependency. It has
// no name, no lifecycle, cannot be disabled for a world, and is not re-imported
// with a plugin reload (the reload's resolve hook only re-stamps URLs inside the
// reloading plugin's own directory) — it behaves exactly like core. What stays a
// documented copy is the CONTRACT between two plugins; an algorithm is not one.
//
// DETERMINISM. Nothing here is terrain math — no client reproduces a plugin's
// sim, and results travel to clients as authoritative state — so the contract in
// CLAUDE.md that governs shared/'s heightmap ops does not bind these. What DOES
// bind them is that a SEEDED stream must give the same world twice on the same
// build: a persisted cyclone, a relic field, a forest and a genesis world are
// all reproducible from a seed and a bug report. Every operation below is
// integer-only up to the final divide, so that holds on every platform.

/** A seeded PRNG whose whole state is one uint32, so it persists trivially. */
export interface SeededRng {
  /** Next value in [0, 1). */
  next(): number;
  /** Current internal state, for a persistence slice. */
  state(): number;
}

/**
 * The number of distinct values a uint32 state can take — the divisor that
 * turns the generator's 32-bit output into a fraction in [0, 1).
 */
const UINT32_RANGE = 0x100000000;

/**
 * mulberry32.
 *
 * A 32-bit-state PRNG with an avalanche finaliser. The obvious alternative, a
 * plain LCG, was tried in the monsters suite first and REJECTED on measurement:
 * a spawn gate compares against a probability of 4.2e-4 per tick, so the only
 * thing under test is the very top of the generator's output range, and an LCG's
 * lattice structure there skewed the measured mean wait to 1.5× the configured
 * one. Mulberry32's finaliser mixes the high bits, and the same measurement
 * lands within a few percent.
 *
 * Eight lines and no dependency, which is what a repo that asks before adding
 * one wants from a generator that only has to be plausible.
 *
 * `next` and `state` close over `a` rather than reading `this`, so a caller can
 * hand `rng.next` straight to `rollEvent` without binding or allocating.
 */
export function createSeededRng(seed: number): SeededRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    },
    state(): number {
      return a;
    },
  };
}

/** A source of randomness that a test can swap out from under its plugin. */
export interface RandomSource {
  /** Returns a float in [0, 1). Safe to detach from the object. */
  random(): number;
  /** TEST SEAM. Installs a source; `null` restores Math.random. */
  setSource(source: (() => number) | null): void;
}

/**
 * An UNSEEDED source whose provider is swappable.
 *
 * Swappable so tests can be deterministic in CI: spawn, spread and siting are
 * whole plugins' central mechanics, and a mechanic that can only be tested
 * statistically is a mechanic that is untested.
 *
 * DELIBERATELY NOT CLEARED BY A PLUGIN'S OWN STATE RESET, wherever a plugin
 * exposes one: a suite installs a seeded generator once and then resets sim
 * state repeatedly, and having the reset silently re-arm Math.random would make
 * those tests flaky in a way that looks like a sim bug. The plugin owns that
 * decision — this only holds the variable.
 */
export function createRandomSource(): RandomSource {
  let source: () => number = Math.random;
  return {
    random(): number {
      return source();
    },
    setSource(next: (() => number) | null): void {
      source = next ?? Math.random;
    },
  };
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS. The naive version — `random() < rate * dt` — is a linear
 * approximation of the same thing, and it is WRONG in a way that bites exactly
 * this codebase: its outcome depends on how finely time is sliced, so a server
 * running at TICK_HZ 20 would spawn at a measurably different rate than one at
 * 10, and a rate × dt above 1 would silently become certainty. (Measured: the
 * linear form is off by 5% at rate·dt = 0.1.)
 *
 * 1 - e^(-λΔt) is the exact probability of at least one arrival of a Poisson
 * process in the interval. Chaining intervals composes exactly (e^-λa · e^-λb =
 * e^-λ(a+b)), so the expected wait is 1/λ seconds however the ticks fall — which
 * is what lets every constant in a plugin's sim be stated as "mean seconds" and
 * mean it.
 *
 * A non-positive rate never fires; a non-finite dt is treated as no time at all
 * rather than as certainty.
 */
export function rollEvent(random: () => number, ratePerSecond: number, dt: number): boolean {
  if (!(ratePerSecond > 0) || !(dt > 0) || !Number.isFinite(dt)) return false;
  return random() < 1 - Math.exp(-ratePerSecond * dt);
}

/**
 * An exponentially-distributed wait, in seconds, with the given mean — the
 * OTHER half of the same Poisson process, and the one a LIFETIME uses.
 *
 * WHY BOTH FORMS EXIST. A storm's life is a wait its plugin has to be able to
 * SHOW: it is counted down in a field, persisted across a restart, and resumed.
 * Sampling it once and counting it down is identical in distribution to rolling
 * the rate every tick (that is the memorylessness of the exponential), and it
 * survives a snapshot, which a per-tick roll does not — a restored cyclone would
 * otherwise have its whole remaining life silently re-drawn on every boot.
 *
 * SPAWNING keeps the per-tick roll instead, because there is no individual thing
 * to hang a countdown on: it is a property of the world, and a world-level
 * countdown persisted across a change of the frequency setting would be a second
 * piece of state saying the same thing.
 *
 * The `1 - random()` is not superstition: the draw can return exactly 0, and
 * `log(0)` is -Infinity, which would give a storm eternal life.
 */
export function exponentialWaitSeconds(random: () => number, meanSeconds: number): number {
  if (!(meanSeconds > 0)) return 0;
  return unitExponential(random) * meanSeconds;
}

/**
 * One exponential draw with mean 1 — the arithmetic both exponential forms are
 * built from, in one place so the `1 - random()` guard cannot be present in one
 * and missing from the other.
 *
 * The `1 - random()` is not superstition: the draw can return exactly 0, and
 * `log(0)` is -Infinity.
 */
function unitExponential(random: () => number): number {
  return -Math.log(1 - random());
}

/**
 * An ERLANG draw — a Gamma with an INTEGER shape `k` — with the given mean.
 *
 * WHAT IT IS FOR. An exponential wait (above) is MEMORYLESS: however long a
 * thing has already been exposed, its remaining wait has the same distribution,
 * so two identically-exposed things resolve at times that are independent of
 * one another (coefficient of variation 1). That is right for a world-level
 * arrival and WRONG for a threshold something accumulates towards — a target
 * heated by a flame has a history, and the spread of its ignition time should
 * be narrower than its mean, not equal to it. Summing k exponentials of mean
 * `mean / k` gives exactly that: the same mean, a coefficient of variation of
 * 1/√k, and k = 1 reproduces the exponential exactly.
 *
 * THE ALGORITHM IS THE SUM OF k EXPONENTIALS, not Marsaglia–Tsang. Both are
 * standard; the sum is chosen because it is exact for integer k (no rejection
 * loop, so a seeded stream consumes a FIXED number of draws per sample, which
 * is what keeps a replay reproducible), needs no normal sampler, and is six
 * lines. Marsaglia–Tsang's advantage is a non-integer shape and an O(1) draw
 * count for large k, and no caller here has either need — this repo's only
 * shape is a small named integer constant.
 *
 * `shape` is taken as an integer count of stages: a non-finite or below-one
 * shape is treated as 1 (the exponential), and a fractional one is FLOORED
 * rather than silently rounded up, so the sample can never consume more stages
 * than the caller asked for. A non-positive mean yields 0.
 */
export function erlangSample(random: () => number, shape: number, mean: number): number {
  if (!(mean > 0)) return 0;
  const stages = Number.isFinite(shape) && shape >= 1 ? Math.floor(shape) : 1;
  const stageMean = mean / stages;

  let total = 0;
  for (let stage = 0; stage < stages; stage++) total += unitExponential(random) * stageMean;
  return total;
}

/** A uniform draw in [min, max). */
export function randomInRange(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

/**
 * A uniform draw in [-magnitude, +magnitude).
 *
 * The "double, then re-centre" shape (`random() * 2 - 1`) appeared independently
 * at eight call sites in wildlife alone — wander noise, group scatter, flock aim
 * spread, bird scatter, bird turn noise — each a candidate for a transcription
 * slip (dropping the `- 1` would silently bias every use toward positive values,
 * with no seeded test to catch it). One named helper makes the shape impossible
 * to get wrong at more than one of them.
 */
export function randomSigned(random: () => number, magnitude: number): number {
  return (random() * 2 - 1) * magnitude;
}

/**
 * Picks an index from a weight table. Weights need not sum to 1; a table whose
 * weights are all non-positive yields the last index rather than -1, so a caller
 * can never be handed an out-of-range kind.
 */
export function pickWeightedIndex(random: () => number, weights: readonly number[]): number {
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (!(total > 0)) return weights.length - 1;

  let roll = random() * total;
  for (let index = 0; index < weights.length; index++) {
    roll -= Math.max(0, weights[index]!);
    if (roll < 0) return index;
  }
  // Only reachable through floating-point round-off at the very top of the
  // range; the last bucket is the honest answer there.
  return weights.length - 1;
}

/**
 * A REPRODUCIBLE choice of one out of N, from a seed the caller already has.
 *
 * `rollEvent` answers "did it happen?", and it is allowed to be random because
 * nothing reproduces it. This answers "which of these N?", and it is
 * deliberately NOT random: a monster's summon cell is picked through it, and a
 * summon cell that differed between two runs over the same world state would
 * make the arrival tests un-writable and a bug report un-reproducible. Same
 * `seed`, same `count`, same answer, on any machine, forever.
 *
 * INTEGER-ONLY, and that is a house rule rather than a preference: the output is
 * used as a CELL index, and cells are the units shared/ says must never be
 * arrived at by float arithmetic. Math.imul keeps every product in 32 bits
 * exactly, so there is no double rounding anywhere in the path from an id to a
 * coordinate.
 *
 * THE MIX is murmur3's `fmix32` finalizer, constants and shift distances
 * verbatim — a published, widely-implemented avalanche function, chosen so the
 * numbers below are citable rather than invented. What it buys is the property
 * the caller actually needs: consecutive seeds (and the seed IS often a counter)
 * must land far apart, or the first few draws of a world would walk along the
 * candidate list one step at a time instead of scattering.
 *
 * MODULO BIAS, stated rather than ignored: `% count` over a 32-bit hash favours
 * the first `2³² mod count` indices by a relative excess of about
 * `count / 2³²`. For a candidate list of even a million cells that is under one
 * part in four thousand — orders of magnitude below the variation in the
 * candidate set itself from one sculpt to the next. Rejection sampling would buy
 * nothing an observer could ever detect and would cost this function its
 * single-expression determinism.
 *
 * Returns 0 for a non-positive or non-finite `count`, so a caller that somehow
 * has no candidates gets a defined index rather than a NaN coordinate.
 */
const HASH_MIX_MULTIPLIER_A = 0x85ebca6b;
const HASH_MIX_MULTIPLIER_B = 0xc2b2ae35;
const HASH_MIX_SHIFT_A = 16;
const HASH_MIX_SHIFT_B = 13;

export function hashToIndex(seed: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  let h = seed | 0;
  h ^= h >>> HASH_MIX_SHIFT_A;
  h = Math.imul(h, HASH_MIX_MULTIPLIER_A);
  h ^= h >>> HASH_MIX_SHIFT_B;
  h = Math.imul(h, HASH_MIX_MULTIPLIER_B);
  h ^= h >>> HASH_MIX_SHIFT_A;
  return (h >>> 0) % count;
}
