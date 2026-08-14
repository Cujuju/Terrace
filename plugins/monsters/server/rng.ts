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
