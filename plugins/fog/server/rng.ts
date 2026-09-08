import { createRandomSource } from '@terrace/shared';

const source = createRandomSource();

export const fogRandom = source.random;

export const setFogRandomSource = source.setSource;
