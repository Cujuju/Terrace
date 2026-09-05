// Randomness, and this plugin's ONE seam for swapping it.
//
// TWO STREAMS, AND THE SPLIT IS THE POINT.
//
//   1. THE ARRIVAL CLOCK (`rollEncounter`) — "did an encounter start this
//      tick?". Nothing reproduces it, the answer travels to clients as
//      authoritative state, and the whole mechanic is that it is a surprise. It
//      runs off the swappable module source, exactly as monsters' summon roll
//      does, so a suite can pin it.
//
//   2. THE ENCOUNTER'S OWN SEEDED STREAM (`createEncounterRng`) — every choice
//      made INSIDE an encounter: which way the pair came in, where the arena is,
//      which hull each wears, and, above all, WHO WINS. It is a mulberry32
//      seeded once per encounter and carried on the encounter, which is what
//      makes "the same encounter plays out the same way twice" true, and
//      therefore what makes a bug report about a dogfight reproducible. The
//      brief's requirement — the outcome is deterministic from the encounter's
//      seeded RNG, never Math.random — is this stream and only this stream.
//
// The determinism contract in CLAUDE.md governs shared/'s terrain math, not
// plugin sim; what binds a SEEDED stream is that it gives the same sequence on
// every platform, which shared/src/rng.ts's integer-only mulberry32 does.

import { createRandomSource, createSeededRng, rollEvent } from '@terrace/shared';

/**
 * The source the ARRIVAL roll draws from. Swappable so a suite can be
 * deterministic in CI — the arrival roll is this plugin's whole entry point, and
 * a plugin whose central mechanic can only be tested statistically is a plugin
 * whose central mechanic is untested.
 */
const source = createRandomSource();

/** Returns a float in [0, 1). */
export const saucerRandom = source.random;

/** TEST SEAM. Installs a random source; `null` restores Math.random. */
export const setSaucerRandomSource = source.setSource;

/**
 * Did a Poisson event of rate `ratePerSecond` fire during `dt` seconds?
 *
 * THE EXACT FORM, not `random() < rate * dt` — see shared/src/rng.ts. The naive
 * product is a linear approximation whose outcome depends on how finely time is
 * sliced, so a server at TICK_HZ 20 would grow encounters at a measurably
 * different rate than one at 10, and the "mean wait in seconds" the difficulty
 * anchors are stated in would stop meaning that.
 */
export function rollEncounter(ratePerSecond: number, dt: number): boolean {
  return rollEvent(saucerRandom, ratePerSecond, dt);
}

/**
 * Seed for the FIRST encounter of a process.
 *
 * Fixed rather than drawn from the clock, for tornado's and relics' reason: a
 * self-hoster reporting "the same saucer always wins in my world" must be
 * reproducible. The value itself is arbitrary; only its fixedness is
 * load-bearing. It differs from every other plugin's default seed so two
 * independently-seeded populations do not roll off the same sequence.
 */
export const SAUCERS_RNG_DEFAULT_SEED = 0x5a_11_c3_04;

/**
 * The seed the NEXT encounter will use. Advanced once per encounter so two
 * encounters in one session do not play out identically, while the sequence of
 * encounters as a whole stays a function of the starting seed.
 *
 * NOT PERSISTED, and that is a decision rather than an omission: an encounter is
 * transient (this plugin has no persistence slice at all), so what a restart
 * resets is which dogfight the world sees next — a thing no player can observe
 * the difference in, since none of them survive a restart either.
 */
let nextSeed = SAUCERS_RNG_DEFAULT_SEED;

/**
 * A fresh seeded generator for one encounter, plus the seed it was built from —
 * returned so a log line or a bug report can name the number that reproduces
 * this exact dogfight.
 */
export function createEncounterRng(): { readonly seed: number; readonly next: () => number } {
  const seed = nextSeed;
  const rng = createSeededRng(seed);
  // The next encounter's seed is drawn FROM this one's generator rather than by
  // incrementing: consecutive mulberry32 seeds are related in their first few
  // outputs, and the first few outputs are exactly what an encounter uses to
  // pick its arena and its hulls.
  nextSeed = Math.floor(rng.next() * 0x1_00_00_00_00) >>> 0;
  return { seed, next: rng.next };
}

/** Test/reset seam: puts the encounter seed sequence back to its start. */
export function resetEncounterSeeds(): void {
  nextSeed = SAUCERS_RNG_DEFAULT_SEED;
}
