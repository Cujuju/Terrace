import { describe, expect, it } from 'vitest';
import { validateSculptIntent } from '../src/index.ts';

const WORLD = 128;

describe('validateSculptIntent', () => {
  it('accepts a well-formed intent and returns it typed', () => {
    const intent = validateSculptIntent(
      { type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 },
      WORLD,
    );
    expect(intent).toEqual({ type: 'sculpt', x: 10, y: 20, radius: 2, dir: -1 });
  });

  it('accepts the boundary values', () => {
    expect(
      validateSculptIntent({ type: 'sculpt', x: 0, y: WORLD - 1, radius: 1, dir: 1 }, WORLD),
    ).not.toBeNull();
    expect(
      validateSculptIntent({ type: 'sculpt', x: 5, y: 5, radius: 4, dir: 1 }, WORLD),
    ).not.toBeNull();
  });

  it('rejects non-objects and wrong types', () => {
    expect(validateSculptIntent(null, WORLD)).toBeNull();
    expect(validateSculptIntent('sculpt', WORLD)).toBeNull();
    expect(validateSculptIntent(42, WORLD)).toBeNull();
    expect(validateSculptIntent({ type: 'nuke', x: 1, y: 1, radius: 1, dir: 1 }, WORLD)).toBeNull();
  });

  it('rejects out-of-bounds and non-integer coordinates', () => {
    const base = { type: 'sculpt', radius: 1, dir: 1 };
    expect(validateSculptIntent({ ...base, x: -1, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: WORLD, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 1.5, y: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 0, y: Number.NaN }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, x: 0 }, WORLD)).toBeNull(); // missing y
  });

  it('rejects invalid radius and direction', () => {
    const base = { type: 'sculpt', x: 1, y: 1 };
    expect(validateSculptIntent({ ...base, radius: 0, dir: 1 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 5, dir: 1 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 2.5, dir: 1 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: 0 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: 2 }, WORLD)).toBeNull();
    expect(validateSculptIntent({ ...base, radius: 1, dir: '-1' }, WORLD)).toBeNull();
  });
});
