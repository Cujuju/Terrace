import {
  randomSigned as sharedRandomSigned,
  rollEvent as sharedRollEvent,
} from '@terrace/shared';

export function randomSigned(magnitude: number): number {
  return sharedRandomSigned(Math.random, magnitude);
}

export function rollEvent(ratePerSecond: number, dt: number): boolean {
  return sharedRollEvent(Math.random, ratePerSecond, dt);
}
