import { createRandomSource, hashToIndex, rollEvent as sharedRollEvent } from '@terrace/shared';

const source = createRandomSource();

export const monsterRandom = source.random;

export const setMonsterRandomSource = source.setSource;

export function rollEvent(ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(monsterRandom, ratePerSecond, dt);
}

export { hashToIndex } from '@terrace/shared';

const RANDOM_SEED_RANGE = 2 ** 32;

export function randomIndex(count: number): number {
  return hashToIndex(Math.floor(monsterRandom() * RANDOM_SEED_RANGE), count);
}
