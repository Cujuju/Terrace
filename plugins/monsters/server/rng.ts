// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, the results
// travel to clients as authoritative positions — so Math.random is fine (the
// determinism contract in CLAUDE.md governs shared/ terrain math, not plugin
// sim). What is NOT fine is each caller inventing its own "did it happen this
// tick?" arithmetic, so there is exactly one function for that.

/**
 * The source of randomness. Swappable so tests can be deterministic in CI
 * (see setMonsterRandomSource) — the summon roll is the whole point of this
 * plugin's arrival behaviour, and a plugin whose central mechanic can only be
 * tested statistically is a plugin whose central mechanic is untested.
 */
let randomSource: () => number = Math.random;

/** Returns a float in [0, 1). */
export function monsterRandom(): number {
  return randomSource();
}

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetMonstersState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export function setMonsterRandomSource(source: (() => number) | null): void {
  randomSource = source ?? Math.random;
}

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS. The naive version — `random() < rate * dt` — is a linear
 * approximation of the same thing, and it is WRONG in a way that bites exactly
 * this codebase: its outcome depends on how finely time is sliced, so a server
 * running at TICK_HZ 20 would summon monsters at a measurably different rate
 * than one at 10, and a rate × dt above 1 would silently become certainty.
 *
 * 1 - e^(-λΔt) is the exact probability of at least one arrival of a Poisson
 * process in the interval. Chaining intervals composes exactly (e^-λa · e^-λb =
 * e^-λ(a+b)), so the expected wait is 1/λ seconds however the ticks fall — which
 * is what lets the constants in ./kinds.ts be stated as "mean wait in seconds"
 * and mean it.
 *
 * A non-positive rate never fires; a non-finite dt is treated as no time at all
 * rather than as certainty.
 */
export function rollEvent(ratePerSecond: number, dt: number): boolean {
  if (!(ratePerSecond > 0) || !(dt > 0) || !Number.isFinite(dt)) return false;
  return monsterRandom() < 1 - Math.exp(-ratePerSecond * dt);
}

/**
 * THE OTHER KIND OF CHOICE: a repeatable one.
 *
 * `rollEvent` above answers "did it happen?", and it is allowed to be random
 * because nothing reproduces it. This answers "which of these N?", and it is
 * deliberately NOT random: the summon cell is picked through it (summoning.ts),
 * and a summon cell that differed between two runs over the same world state
 * would make the arrival tests un-writable and a bug report un-reproducible.
 * Same `seed`, same `count`, same answer, on any machine, forever.
 *
 * INTEGER-ONLY, and that is a house rule rather than a preference here: this is
 * the one place in this plugin whose output is a CELL, and cells are the units
 * shared/ says must never be arrived at by float arithmetic. Math.imul keeps
 * every product in 32 bits exactly, so there is no double rounding anywhere in
 * the path from a monster id to a coordinate.
 *
 * THE MIX is murmur3's `fmix32` finalizer, constants and shift distances
 * verbatim — a published, widely-implemented avalanche function, chosen so the
 * numbers below are citable rather than invented. What it buys is the property
 * the caller actually needs: consecutive seeds (and the seed IS a counter — see
 * summoning.ts) must land far apart, or the first few monsters of a world would
 * walk along the candidate list one step at a time instead of scattering.
 *
 * MODULO BIAS, stated rather than ignored: `% count` over a 32-bit hash favours
 * the first `2³² mod count` indices by a relative excess of about
 * `count / 2³²`. For a candidate list of even a million cells that is under one
 * part in four thousand — orders of magnitude below the variation in the
 * candidate set itself from one sculpt to the next. Rejection sampling would
 * buy nothing an observer could ever detect and would cost this function its
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

/**
 * A uniformly-distributed index in [0, count), drawn from the random source.
 *
 * THE THIRD KIND OF CHOICE, and it needed a name of its own because it is
 * neither of the two above: `rollEvent` answers "did it happen?", `hashToIndex`
 * answers "which of these N?" REPRODUCIBLY from a seed the caller already has,
 * and this answers "which of these N?" when there is no such seed — the pick is
 * a fresh coin, not a function of the world (the yeti's variant, summoning.ts).
 *
 * IT GOES THROUGH hashToIndex RATHER THAN THROUGH `floor(random() * count)`,
 * for the test seam's sake. `setMonsterRandomSource` is what makes this
 * plugin's behaviour reproducible in CI, and the sources a suite installs are
 * deliberately trivial — a constant, a short cycle, a linear ramp. Scaling such
 * a source directly onto a small range makes it degenerate (a constant 0.5
 * source picks the same index for every count, forever); putting the murmur3
 * finalizer between the two means neighbouring draws land far apart, so a
 * seeded suite still exercises more than one branch. It costs four integer ops
 * per summon.
 *
 * The multiplier is 2³² because that is hashToIndex's input width: anything
 * smaller would feed the mixer a fraction of its domain.
 */
const RANDOM_SEED_RANGE = 2 ** 32;

export function randomIndex(count: number): number {
  return hashToIndex(Math.floor(monsterRandom() * RANDOM_SEED_RANGE), count);
}
