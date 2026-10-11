import { createRandomSource, rollEvent } from '@terrace/shared';

const source = createRandomSource();

export const fireRandom = source.random;

export const setFireRandomSource = source.setSource;

export function happensWithin(perSecond: number, dt: number): boolean {
  return rollEvent(fireRandom, perSecond, dt);
}
