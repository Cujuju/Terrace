// parseShoalSightings — the `wildlife:shoals` payload contract.
//
// The parser has no consumer yet (S1 of the skiffs arc ships the producer and
// the validator alone), so this file IS the contract: whatever a future skiff
// reads, it reads through here, and these are the rules it may rely on.

import { describe, expect, it } from 'vitest';
import { EVENT_LIST_CAP, parseShoalSightings } from '../server/events.ts';

/** A well-formed shoal row, for tests that damage exactly one field of one. */
function shoal(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { species: 'fish', x: 12.5, y: 40.25, count: 5, ...overrides };
}

describe('parseShoalSightings', () => {
  it('reads a well-formed payload', () => {
    const parsed = parseShoalSightings({ shoals: [shoal(), shoal({ species: 'ray', count: 1 })] });
    expect(parsed).toEqual([
      { species: 'fish', x: 12.5, y: 40.25, count: 5 },
      { species: 'ray', x: 12.5, y: 40.25, count: 1 },
    ]);
  });

  it('accepts an empty list — a sea with no fish in it is not an error', () => {
    expect(parseShoalSightings({ shoals: [] })).toEqual([]);
  });

  // THE RULE parseMonsterSightings ALREADY HOLDS for `kind`: the emitter's
  // species union is the emitter's, and a consumer must survive meeting a
  // species it has never heard of rather than dropping the whole event.
  it('accepts an unknown species rather than failing on it', () => {
    const parsed = parseShoalSightings({
      shoals: [shoal({ species: 'a-species-that-does-not-exist-yet' })],
    });
    expect(parsed).toHaveLength(1);
    expect(parsed?.[0].species).toBe('a-species-that-does-not-exist-yet');
  });

  it('rejects a payload that is not an object', () => {
    for (const payload of [null, undefined, 7, 'shoals', [], true]) {
      expect(parseShoalSightings(payload)).toBeNull();
    }
  });

  it('rejects a payload whose shoals key is missing or not an array', () => {
    for (const shoals of [undefined, null, {}, 'none', 3]) {
      expect(parseShoalSightings({ shoals })).toBeNull();
    }
  });

  // WHOLE, NOT PARTIAL. Every case below carries one good row and one bad one,
  // so a parser that salvaged what it could would return a length-1 array and
  // fail here. Half a shoal list is a picture of the sea with fish silently
  // missing from it.
  it('rejects a malformed row by rejecting the whole payload', () => {
    const bad: unknown[] = [
      null,
      7,
      'fish',
      shoal({ species: 42 }),
      shoal({ species: undefined }),
      shoal({ x: 'near' }),
      shoal({ x: Number.NaN }),
      shoal({ y: Number.POSITIVE_INFINITY }),
      shoal({ y: undefined }),
      shoal({ count: 0 }),
      shoal({ count: -1 }),
      shoal({ count: 2.5 }),
      shoal({ count: undefined }),
    ];
    for (const row of bad) {
      expect(parseShoalSightings({ shoals: [shoal(), row] })).toBeNull();
      expect(parseShoalSightings({ shoals: [row, shoal()] })).toBeNull();
    }
  });

  it('rejects a list longer than the defensive cap', () => {
    const overCap = Array.from({ length: EVENT_LIST_CAP + 1 }, () => shoal());
    expect(parseShoalSightings({ shoals: overCap })).toBeNull();
  });
});
