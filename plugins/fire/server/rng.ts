// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, and spread
// results travel to clients as authoritative ignitions — so Math.random is fine
// (CLAUDE.md's determinism contract governs shared/'s terrain math, not plugin
// sim). What is NOT fine is each caller inventing its own "did it happen this
// tick?" arithmetic, so there is exactly one function for that.
//
// This is the weather plugin's server/rng.ts, restated. It is NOT imported from
// there: a plugin is a distributable unit a self-hoster may install without its
// neighbours, so plugins do not depend on each other's internals. The reasoning
// is copied deliberately, because the reasoning is the thing worth keeping in
// step.

/**
 * The source of randomness. Swappable so tests can be deterministic — spread is
 * this plugin's central mechanic, and a mechanic that can only be tested
 * statistically is a mechanic that is untested.
 */
let randomSource: () => number = Math.random;

/** Returns a float in [0, 1). */
export function fireRandom(): number {
  return randomSource();
}

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetFireState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export function setFireRandomSource(source: (() => number) | null): void {
  randomSource = source ?? Math.random;
}

/**
 * Did an event of rate `perSecond` happen during `dt` seconds?
 *
 * The exact exponential form, not `random() < rate * dt`: the linear
 * approximation is wrong by 5% at rate·dt = 0.1 and silently saturates at 1
 * above rate·dt = 1, which would make a hot spread rate stop scaling exactly
 * where it matters most. It also makes the answer independent of how the caller
 * chops up time — two half-second steps and one one-second step give the same
 * distribution, so changing the spread cadence cannot quietly change the game's
 * balance.
 */
export function happensWithin(perSecond: number, dt: number): boolean {
  if (perSecond <= 0 || dt <= 0) return false;
  return fireRandom() < 1 - Math.exp(-perSecond * dt);
}
