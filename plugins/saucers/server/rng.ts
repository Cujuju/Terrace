import { createRandomSource, createSeededRng, rollEvent } from '@terrace/shared';

const source = createRandomSource();

export const saucerRandom = source.random;

export const setSaucerRandomSource = source.setSource;

export function rollEncounter(ratePerSecond: number, dt: number): boolean {
  return rollEvent(saucerRandom, ratePerSecond, dt);
}

export const SAUCERS_RNG_DEFAULT_SEED = 0x5a_11_c3_04;

let nextSeed = SAUCERS_RNG_DEFAULT_SEED;

export function createEncounterRng(): { readonly seed: number; readonly next: () => number } {
  const seed = nextSeed;
  const rng = createSeededRng(seed);
  nextSeed = Math.floor(rng.next() * 0x1_00_00_00_00) >>> 0;
  return { seed, next: rng.next };
}

export function resetEncounterSeeds(): void {
  nextSeed = SAUCERS_RNG_DEFAULT_SEED;
}
