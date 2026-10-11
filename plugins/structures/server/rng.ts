import { createSeededRng } from '@terrace/shared';

export interface StructuresRng {
  next(): number;
  state(): number;
}

export const STRUCTURES_RNG_DEFAULT_SEED = 0x57a7e5;

export function createStructuresRng(seed: number): StructuresRng {
  return createSeededRng(seed);
}
