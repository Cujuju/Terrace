import { createRandomSource } from '@terrace/shared';

const source = createRandomSource();

export const rainRandom = source.random;

export const setRainRandomSource = source.setSource;
