import { createSeededRng, rollEvent as sharedRollEvent } from '@terrace/shared';

export interface MudslideRng {
  next(): number;
  state(): number;
}

export const MUDSLIDE_RNG_DEFAULT_SEED = 0x4d_55_44_21;

export function createMudslideRng(seed: number): MudslideRng {
  return createSeededRng(seed);
}

export function rollEvent(rng: MudslideRng, ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(rng.next, ratePerSecond, dt);
}

export function randomIndex(rng: MudslideRng, count: number): number {
  if (count <= 0) return 0;
  return Math.min(count - 1, Math.floor(rng.next() * count));
}
