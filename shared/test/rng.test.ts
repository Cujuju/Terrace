// Contract tests for shared/src/rng.ts — the one randomness library the plugins
// share. Abbreviated on purpose: what is asserted here is the CONTRACT (the
// exact mulberry32 stream, the Poisson form, the guards), not a statistical
// survey of the generator.

import { describe, expect, it } from 'vitest';
import {
  createRandomSource,
  createSeededRng,
  exponentialWaitSeconds,
  hashToIndex,
  pickWeightedIndex,
  randomInRange,
  randomSigned,
  rollEvent,
} from '../src/index.ts';

/**
 * The stream the seven copies produced, restated INLINE here rather than
 * imported: a golden vector derived from the thing it guards is not a guard.
 * This is mulberry32 exactly as every copy wrote it.
 */
function referenceMulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 0x100000000;
  };
}

describe('createSeededRng', () => {
  it('reproduces the mulberry32 stream bit for bit', () => {
    const reference = referenceMulberry32(0x57_07_3d_51);
    const rng = createSeededRng(0x57_07_3d_51);
    for (let i = 0; i < 64; i++) expect(rng.next()).toBe(reference());
  });

  it('exposes a uint32 state that resumes the same stream', () => {
    const rng = createSeededRng(1234);
    rng.next();
    const state = rng.state();
    expect(state).toBe(state >>> 0);
    // The state IS the seed: resuming from it continues the sequence.
    const resumed = createSeededRng(state);
    expect(resumed.next()).toBe(rng.next());
  });

  it('detaches next() from the object, so it can be passed as a function', () => {
    const rng = createSeededRng(7);
    const next = rng.next;
    expect(next()).toBe(createSeededRng(7).next());
  });
});

describe('createRandomSource', () => {
  it('defaults to Math.random and swaps to an installed source', () => {
    const source = createRandomSource();
    expect(source.random()).toBeGreaterThanOrEqual(0);
    source.setSource(() => 0.25);
    expect(source.random()).toBe(0.25);
    source.setSource(null);
    expect(source.random()).not.toBe(0.25);
  });

  it('hands out a random() that survives being detached from the object', () => {
    const source = createRandomSource();
    const random = source.random;
    source.setSource(() => 0.5);
    expect(random()).toBe(0.5);
  });
});

describe('rollEvent', () => {
  it('uses the exact Poisson form, not the linear approximation', () => {
    const rate = 2;
    const dt = 0.5;
    const threshold = 1 - Math.exp(-rate * dt);
    expect(rollEvent(() => threshold - 1e-12, rate, dt)).toBe(true);
    expect(rollEvent(() => threshold, rate, dt)).toBe(false);
  });

  it('never fires on a non-positive rate, a non-positive dt, or a non-finite dt', () => {
    const always = (): number => 0;
    expect(rollEvent(always, 0, 1)).toBe(false);
    expect(rollEvent(always, 1, 0)).toBe(false);
    expect(rollEvent(always, 1, Number.POSITIVE_INFINITY)).toBe(false);
    expect(rollEvent(always, Number.NaN, 1)).toBe(false);
  });
});

describe('exponentialWaitSeconds', () => {
  it('is -ln(1 - u) scaled by the mean, and cannot return Infinity on u = 0', () => {
    expect(exponentialWaitSeconds(() => 0.5, 10)).toBeCloseTo(-Math.log(0.5) * 10, 12);
    expect(Number.isFinite(exponentialWaitSeconds(() => 0, 10))).toBe(true);
    expect(exponentialWaitSeconds(() => 0.5, 0)).toBe(0);
  });
});

describe('uniform draws', () => {
  it('randomInRange maps [0, 1) onto [min, max)', () => {
    expect(randomInRange(() => 0, 4, 8)).toBe(4);
    expect(randomInRange(() => 0.5, 4, 8)).toBe(6);
  });

  it('randomSigned doubles and re-centres', () => {
    expect(randomSigned(() => 0, 3)).toBe(-3);
    expect(randomSigned(() => 0.5, 3)).toBe(0);
  });
});

describe('pickWeightedIndex', () => {
  it('picks the bucket the roll lands in', () => {
    const weights = [1, 1, 2];
    expect(pickWeightedIndex(() => 0, weights)).toBe(0);
    expect(pickWeightedIndex(() => 0.3, weights)).toBe(1);
    expect(pickWeightedIndex(() => 0.9, weights)).toBe(2);
  });

  it('yields the last index rather than -1 when no weight is positive', () => {
    expect(pickWeightedIndex(() => 0.5, [0, 0, 0])).toBe(2);
  });
});

describe('hashToIndex', () => {
  it('is reproducible, scatters consecutive seeds, and stays in range', () => {
    expect(hashToIndex(1, 1000)).toBe(hashToIndex(1, 1000));
    expect(hashToIndex(1, 1000)).not.toBe(hashToIndex(2, 1000));
    expect(hashToIndex(12345, 0)).toBe(0);
    for (let seed = 0; seed < 32; seed++) {
      const index = hashToIndex(seed, 7);
      expect(index).toBeGreaterThanOrEqual(0);
      expect(index).toBeLessThan(7);
    }
  });
});
