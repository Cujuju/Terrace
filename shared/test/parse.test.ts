// Contract tests for shared/src/parse.ts — the guards every plugin's wire
// parser and persistence slice validates untrusted JSON with.

import { describe, expect, it } from 'vitest';
import { isFiniteNumber, parseRecordArray } from '../src/index.ts';

describe('isFiniteNumber', () => {
  it('accepts only finite numbers', () => {
    expect(isFiniteNumber(0)).toBe(true);
    expect(isFiniteNumber(-1.5)).toBe(true);
    expect(isFiniteNumber(Number.NaN)).toBe(false);
    expect(isFiniteNumber(Number.POSITIVE_INFINITY)).toBe(false);
    expect(isFiniteNumber('1')).toBe(false);
    expect(isFiniteNumber(null)).toBe(false);
    expect(isFiniteNumber(undefined)).toBe(false);
  });
});

describe('parseRecordArray', () => {
  const parseItem = (value: unknown): number | null =>
    isFiniteNumber(value) ? value : null;

  it('maps every element through the item parser', () => {
    expect(parseRecordArray([1, 2, 3], parseItem)).toEqual([1, 2, 3]);
  });

  it('accepts an empty array as an empty result, not as a failure', () => {
    expect(parseRecordArray([], parseItem)).toEqual([]);
  });

  it('abandons the WHOLE array on the first element that does not parse', () => {
    expect(parseRecordArray([1, 'no', 3], parseItem)).toBe(null);
  });

  it('rejects anything that is not an array', () => {
    expect(parseRecordArray(undefined, parseItem)).toBe(null);
    expect(parseRecordArray({ length: 1 }, parseItem)).toBe(null);
  });
});
