import { createRandomSource } from '@terrace/shared';

const source = createRandomSource();

export const snowRandom = source.random;

export const setSnowRandomSource = source.setSource;
