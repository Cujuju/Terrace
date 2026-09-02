// Randomness, and the ONE way this plugin turns a rate into an event.
//
// Nothing here is terrain math — no client reproduces any of it, and spread
// results travel to clients as authoritative ignitions — so Math.random is fine
// (CLAUDE.md's determinism contract governs shared/'s terrain math, not plugin
// sim). What is NOT fine is each caller inventing its own "did it happen this
// tick?" arithmetic, so there is exactly one function for that.
//
// THE ARITHMETIC LIVES IN @terrace/shared NOW. It used to be weather's
// server/rng.ts restated here, on the plugin boundary — plugins do not depend on
// each other's internals. That is a rule about a NEIGHBOUR, and shared/ is core.
// What stays here is this plugin's own SEAM: `fireRandom` and
// `setFireRandomSource` are what this plugin's suite installs a generator
// through.

import { createRandomSource, rollEvent } from '@terrace/shared';

/**
 * The source of randomness. Swappable so tests can be deterministic — spread is
 * this plugin's central mechanic, and a mechanic that can only be tested
 * statistically is a mechanic that is untested.
 */
const source = createRandomSource();

/** Returns a float in [0, 1). */
export const fireRandom = source.random;

/**
 * TEST SEAM. Installs a random source; `null` restores Math.random.
 *
 * Deliberately NOT cleared by resetFireState(): a suite installs a seeded
 * generator once and then resets sim state repeatedly, and having the reset
 * silently re-arm Math.random would make those tests flaky in a way that looks
 * like a sim bug.
 */
export const setFireRandomSource = source.setSource;

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
 *
 * ONE GUARD IS STRICTER THAN THIS PLUGIN'S OWN COPY WAS. The copy rejected only
 * `perSecond <= 0 || dt <= 0`; shared's `rollEvent` also rejects a NON-FINITE
 * dt, where the copy would have fired with certainty. Every caller here passes
 * either the tick's dt or an accumulated dwell time, both finite by
 * construction, so the difference is unreachable — and the shared guard is the
 * one that is right if it ever stops being.
 */
export function happensWithin(perSecond: number, dt: number): boolean {
  return rollEvent(fireRandom, perSecond, dt);
}
