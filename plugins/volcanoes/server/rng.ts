import {
  createSeededRng,
  exponentialWaitSeconds as sharedExponentialWait,
  rollEvent as sharedRollEvent,
} from '@terrace/shared';

export interface VolcanoRng {
  next(): number;
  state(): number;
}

export const VOLCANO_RNG_DEFAULT_SEED = 0x5ea1_f14e;

export function createVolcanoRng(seed: number): VolcanoRng {
  return createSeededRng(seed);
}

export function rollEvent(rng: VolcanoRng, ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(rng.next, ratePerSecond, dt);
}

export function exponentialWaitSeconds(rng: VolcanoRng, meanSeconds: number): number {
  return sharedExponentialWait(rng.next, meanSeconds);
}
