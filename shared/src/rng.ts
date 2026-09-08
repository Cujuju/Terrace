export interface SeededRng {
  next(): number;
  state(): number;
}

const UINT32_RANGE = 0x100000000;

export function createSeededRng(seed: number): SeededRng {
  let a = seed >>> 0;
  return {
    next(): number {
      a = (a + 0x6d2b79f5) >>> 0;
      let t = a;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / UINT32_RANGE;
    },
    state(): number {
      return a;
    },
  };
}

export interface RandomSource {
  random(): number;
  setSource(source: (() => number) | null): void;
}

export function createRandomSource(): RandomSource {
  let source: () => number = Math.random;
  return {
    random(): number {
      return source();
    },
    setSource(next: (() => number) | null): void {
      source = next ?? Math.random;
    },
  };
}

export function rollEvent(random: () => number, ratePerSecond: number, dt: number): boolean {
  if (!(ratePerSecond > 0) || !(dt > 0) || !Number.isFinite(dt)) return false;
  return random() < 1 - Math.exp(-ratePerSecond * dt);
}

export function exponentialWaitSeconds(random: () => number, meanSeconds: number): number {
  if (!(meanSeconds > 0)) return 0;
  return unitExponential(random) * meanSeconds;
}

function unitExponential(random: () => number): number {
  return -Math.log(1 - random());
}

export function erlangSample(random: () => number, shape: number, mean: number): number {
  if (!(mean > 0)) return 0;
  const stages = Number.isFinite(shape) && shape >= 1 ? Math.floor(shape) : 1;
  const stageMean = mean / stages;

  let total = 0;
  for (let stage = 0; stage < stages; stage++) total += unitExponential(random) * stageMean;
  return total;
}

export function randomInRange(random: () => number, min: number, max: number): number {
  return min + random() * (max - min);
}

export function randomSigned(random: () => number, magnitude: number): number {
  return (random() * 2 - 1) * magnitude;
}

export function pickWeightedIndex(random: () => number, weights: readonly number[]): number {
  let total = 0;
  for (const weight of weights) total += Math.max(0, weight);
  if (!(total > 0)) return weights.length - 1;

  let roll = random() * total;
  for (let index = 0; index < weights.length; index++) {
    roll -= Math.max(0, weights[index]!);
    if (roll < 0) return index;
  }
  return weights.length - 1;
}

const HASH_MIX_MULTIPLIER_A = 0x85ebca6b;
const HASH_MIX_MULTIPLIER_B = 0xc2b2ae35;
const HASH_MIX_SHIFT_A = 16;
const HASH_MIX_SHIFT_B = 13;

export function hashToIndex(seed: number, count: number): number {
  if (!Number.isFinite(count) || count <= 0) return 0;
  let h = seed | 0;
  h ^= h >>> HASH_MIX_SHIFT_A;
  h = Math.imul(h, HASH_MIX_MULTIPLIER_A);
  h ^= h >>> HASH_MIX_SHIFT_B;
  h = Math.imul(h, HASH_MIX_MULTIPLIER_B);
  h ^= h >>> HASH_MIX_SHIFT_A;
  return (h >>> 0) % count;
}
