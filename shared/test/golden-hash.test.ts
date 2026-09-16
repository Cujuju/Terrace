import { describe, expect, test } from 'vitest';
import { createHeightmap } from '../src/index.ts';
import { fnv1aOfInt32s, hashHeightmap } from './support/goldenCorpus.ts';

describe('fnv1aOfInt32s', () => {
  test('pins the empty and single-value digests', () => {
    expect(fnv1aOfInt32s([])).toBe('811c9dc5');
    expect(fnv1aOfInt32s([0])).toBe('4b95f515');
    expect(fnv1aOfInt32s([1])).toBe('fb69b604');
    expect(fnv1aOfInt32s([-1])).toBe('e3160fb1');
  });

  test('is order sensitive', () => {
    expect(fnv1aOfInt32s([1, 2])).not.toBe(fnv1aOfInt32s([2, 1]));
  });

  test('separates a shifted value from its neighbour', () => {
    expect(fnv1aOfInt32s([256])).not.toBe(fnv1aOfInt32s([1]));
  });

  test('always returns eight hex digits', () => {
    for (let n = 0; n < 64; n++) expect(fnv1aOfInt32s([n])).toMatch(/^[0-9a-f]{8}$/);
  });
});

describe('hashHeightmap', () => {
  test('separates two worlds that differ in one cell', () => {
    const a = createHeightmap(4);
    const b = createHeightmap(4);
    b.cells[5] = 16;
    expect(hashHeightmap(a)).not.toBe(hashHeightmap(b));
  });

  test('separates the same heights at two grid sizes', () => {
    expect(hashHeightmap(createHeightmap(4))).not.toBe(hashHeightmap(createHeightmap(5)));
  });

  test('covers the span table, not only the cells', () => {
    const flat = createHeightmap(4);
    const layered = createHeightmap(4);
    layered.cells[5] = 160;
    flat.cells[5] = 160;
    layered.columnSpans.set(5, Int16Array.from([-1536, 16, 96, 160]));
    expect(hashHeightmap(flat)).not.toBe(hashHeightmap(layered));
  });
});
