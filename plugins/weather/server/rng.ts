import {
  createRandomSource,
  randomInRange as sharedRandomInRange,
  randomSigned as sharedRandomSigned,
} from '@terrace/shared';

const source = createRandomSource();

export const weatherRandom = source.random;

export const setWeatherRandomSource = source.setSource;

export function randomInRange(min: number, max: number): number {
  return sharedRandomInRange(weatherRandom, min, max);
}

export function randomSigned(magnitude: number): number {
  return sharedRandomSigned(weatherRandom, magnitude);
}
