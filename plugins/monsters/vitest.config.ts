import { defineConfig } from 'vitest/config';

/**
 * A longer per-test budget than Vitest's 5 s default, because this suite's
 * FIXTURES are slow rather than its assertions.
 *
 * Every monster gate is a fact about a habitat — a basin big enough to be a
 * lair, a snowfield big enough to hold a yeti — so its worlds have to be
 * ground-sized, and the 2026-08-21 re-sample put sixteen times the cells inside
 * the same ground. The habitat census walks every unlocked cell on its
 * interval, so a test that runs ten simulated minutes over a 128-world-unit
 * world now does sixteen times the scanning it used to.
 *
 * Raised rather than shrunk: the ground these tests cover IS the contract (a
 * smaller world stops being a lair at all), and the alternative — sampling the
 * census — would test something other than what ships.
 */
export default defineConfig({
  test: {
    testTimeout: 120_000,
  },
});
