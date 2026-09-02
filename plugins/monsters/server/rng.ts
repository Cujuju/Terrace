// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, the results
// travel to clients as authoritative positions — so Math.random is fine (the
// determinism contract in CLAUDE.md governs shared/ terrain math, not plugin
// sim). What is NOT fine is each caller inventing its own "did it happen this
// tick?" arithmetic, so there is exactly one function for that.
//
// THE ARITHMETIC LIVES IN @terrace/shared NOW — the Poisson roll six plugins
// carried, and the murmur3 finalizer whose whole argument (integer-only,
// citable constants, the named modulo bias) travelled with it. What stays here
// is this plugin's own SEAM: `monsterRandom` and `setMonsterRandomSource` are
// what this plugin's suite installs a generator through.

import { createRandomSource, hashToIndex, rollEvent as sharedRollEvent } from '@terrace/shared';

/**
 * The source of randomness. Swappable so tests can be deterministic in CI
 * (see setMonsterRandomSource) — the summon roll is the whole point of this
 * plugin's arrival behaviour, and a plugin whose central mechanic can only be
 * tested statistically is a plugin whose central mechanic is untested.
 */
const source = createRandomSource();

/** Returns a float in [0, 1). */
export const monsterRandom = source.random;

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetMonstersState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export const setMonsterRandomSource = source.setSource;

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE FORM MATTERS — see shared/src/rng.ts. In short: the naive
 * `random() < rate * dt` is a linear approximation whose outcome depends on how
 * finely time is sliced, so a server at TICK_HZ 20 would summon monsters at a
 * measurably different rate than one at 10. The exact form is what lets the
 * constants in ./kinds.ts be stated as "mean wait in seconds" and mean it.
 */
export function rollEvent(ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(monsterRandom, ratePerSecond, dt);
}

/**
 * THE OTHER KIND OF CHOICE: a repeatable one.
 *
 * `rollEvent` above answers "did it happen?", and it is allowed to be random
 * because nothing reproduces it. `hashToIndex` answers "which of these N?", and
 * it is deliberately NOT random: the summon cell is picked through it
 * (summoning.ts), and a summon cell that differed between two runs over the same
 * world state would make the arrival tests un-writable and a bug report
 * un-reproducible. Same seed, same count, same answer, on any machine, forever.
 * Its integer-only mix and its named modulo bias are documented on the shared
 * definition, which is where this plugin's copy of it went.
 */
export { hashToIndex } from '@terrace/shared';

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
