import { createRandomSource } from '@terrace/shared';

const source = createRandomSource();

export const thunderstormRandom = source.random;

export const setThunderstormRandomSource = source.setSource;
