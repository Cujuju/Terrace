import { describe, expect, it } from 'vitest';
import {
  applyBandFill,
  applyPackedSpans,
  bandFillAt,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  canonicaliseColumn,
  columnCoversBand,
  createHeightmap,
  heightAt,
  highestCeilingUnderSpan,
  isGapDrawn,
  isSpanDrawn,
  MAX_HEIGHT,
  moveSpanCeiling,
  packColumnSpans,
  parsePackedSpans,
  readSpans,
  seabedHeight,
  SEA_LEVEL,
  setColumn,
  spanCapBand,
  spanCoversBand,
  spansAdjacent,
  type Heightmap,
  type Span,
} from '../src/index.ts';

const WORLD_SIZE = 16;

function world(): Heightmap {
  return createHeightmap(WORLD_SIZE);
}

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  setColumn(map, x, y, [{ floorBand: BEDROCK_BAND, ceiling: h }]);
}

describe('seabedHeight', () => {
  it('is identical to heightAt for a one-span LAND column', () => {
    const map = world();
    for (const h of [SEA_LEVEL + 1, 16, 64, 512]) {
      setHeight(map, 3, 4, h);
      expect(seabedHeight(map, 3, 4)).toBe(heightAt(map, 3, 4));
      expect(seabedHeight(map, 3, 4)).toBe(h);
    }
  });

  it('is identical to heightAt for a one-span SEA column', () => {
    const map = world();
    for (const h of [SEA_LEVEL, -16, -256, BEDROCK_FLOOR + 1]) {
      setHeight(map, 5, 6, h);
      expect(seabedHeight(map, 5, 6)).toBe(heightAt(map, 5, 6));
      expect(seabedHeight(map, 5, 6)).toBe(h);
    }
  });

  it('returns the LOWER span cap when a roof straddles the waterline', () => {
    const map = world();
    setColumn(map, 7, 8, [
      { floorBand: BEDROCK_BAND, ceiling: -32 },
      { floorBand: 4, ceiling: 128 },
    ]);
    expect(seabedHeight(map, 7, 8)).toBe(-32);
    expect(heightAt(map, 7, 8)).toBe(128);
  });

  it('returns the ROOF ceiling when the column is solid at the waterline', () => {
    const map = world();
    setColumn(map, 9, 10, [
      { floorBand: BEDROCK_BAND, ceiling: -100 },
      { floorBand: -3, ceiling: 200 },
    ]);
    expect(seabedHeight(map, 9, 10)).toBe(200);
    expect(seabedHeight(map, 9, 10)).toBeGreaterThan(SEA_LEVEL);
  });

  it('returns the ROOF ceiling when the whole column is below the sea', () => {
    const map = world();
    setColumn(map, 11, 12, [
      { floorBand: BEDROCK_BAND, ceiling: -200 },
      { floorBand: -6, ceiling: -50 },
    ]);
    expect(seabedHeight(map, 11, 12)).toBe(-50);
    expect(seabedHeight(map, 11, 12)).toBe(heightAt(map, 11, 12));
  });
});

describe('the span contract — floors in bands, ceilings raw', () => {
  it('covers exactly the bands from its floor to its cap', () => {
    const span: Span = { floorBand: 2, ceiling: 100 };
    expect(spanCapBand(span)).toBe(6);
    for (const band of [-1, 0, 1]) expect(spanCoversBand(span, band)).toBe(false);
    for (const band of [2, 3, 4, 5, 6]) expect(spanCoversBand(span, band)).toBe(true);
    for (const band of [7, 8]) expect(spanCoversBand(span, band)).toBe(false);
  });

  it('a span whose ceiling falls below its own floor band draws nothing', () => {
    expect(isSpanDrawn({ floorBand: 2, ceiling: 100 })).toBe(true);
    expect(isSpanDrawn({ floorBand: 7, ceiling: 100 })).toBe(false);
    expect(spanCoversBand({ floorBand: 7, ceiling: 100 }, 7)).toBe(false);
  });

  it('adjacent means no band of air, and only a gap of air draws', () => {
    const lower: Span = { floorBand: BEDROCK_BAND, ceiling: 32 };
    expect(spanCapBand(lower)).toBe(2);
    expect(spansAdjacent(lower, { floorBand: 3, ceiling: 64 })).toBe(true);
    expect(isGapDrawn(lower, { floorBand: 3, ceiling: 64 })).toBe(false);
    expect(spansAdjacent(lower, { floorBand: 4, ceiling: 64 })).toBe(false);
    expect(isGapDrawn(lower, { floorBand: 4, ceiling: 64 })).toBe(true);
  });
});

describe('canonicaliseColumn', () => {
  it('drops spans that draw nothing', () => {
    expect(
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: 32 },
        { floorBand: 9, ceiling: 100 },
        { floorBand: 12, ceiling: 200 },
      ]),
    ).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: 32 },
      { floorBand: 12, ceiling: 200 },
    ]);
  });

  it('merges spans with no band of air between them', () => {
    expect(
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: 32 },
        { floorBand: 3, ceiling: 64 },
      ]),
    ).toEqual([{ floorBand: BEDROCK_BAND, ceiling: 64 }]);
  });

  it('keeps spans that a whole band of air separates', () => {
    const spans = canonicaliseColumn([
      { floorBand: BEDROCK_BAND, ceiling: 32 },
      { floorBand: 4, ceiling: 64 },
    ]);
    expect(spans).toHaveLength(2);
    expect(isGapDrawn(spans[0]!, spans[1]!)).toBe(true);
  });

  it('floors the bottom span at bedrock, dropping it onto the floor when adjacent', () => {
    expect(canonicaliseColumn([{ floorBand: BEDROCK_BAND + 1, ceiling: 32 }])).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: 32 },
    ]);
  });

  it('leaves a bedrock floor under a span that still clears it', () => {
    expect(canonicaliseColumn([{ floorBand: 4, ceiling: 64 }])).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
      { floorBand: 4, ceiling: 64 },
    ]);
  });

  it('a column cut to nothing keeps its bedrock band and no more', () => {
    expect(canonicaliseColumn([])).toEqual([{ floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR }]);
    expect(canonicaliseColumn([{ floorBand: 9, ceiling: 100 }])).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
    ]);
  });

  it('merges a cascade of adjacent spans in one pass', () => {
    expect(
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
        { floorBand: 2, ceiling: bandLevelHeight(2) },
        { floorBand: 3, ceiling: bandLevelHeight(3) },
        { floorBand: 4, ceiling: bandLevelHeight(4) },
      ]),
    ).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
      { floorBand: 2, ceiling: bandLevelHeight(4) },
    ]);
  });

  it('keeps the higher ceiling when a pair overlaps', () => {
    expect(
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
        { floorBand: 2, ceiling: bandLevelHeight(20) },
        { floorBand: 5, ceiling: bandLevelHeight(8) },
      ]),
    ).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
      { floorBand: 2, ceiling: bandLevelHeight(20) },
    ]);
  });

  it('refuses a ceiling outside the world, so its output always suits setColumn', () => {
    expect(() =>
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
        { floorBand: 64, ceiling: MAX_HEIGHT + 1 },
      ]),
    ).toThrow(RangeError);
    expect(() => canonicaliseColumn([{ floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR - 1 }])).toThrow(
      RangeError,
    );
  });

  it('refuses spans that do not ascend instead of sorting them', () => {
    expect(() =>
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
        { floorBand: 10, ceiling: bandLevelHeight(10) },
        { floorBand: 2, ceiling: bandLevelHeight(2) },
      ]),
    ).toThrow(RangeError);
    expect(() =>
      canonicaliseColumn([
        { floorBand: BEDROCK_BAND, ceiling: BEDROCK_FLOOR },
        { floorBand: 4, ceiling: bandLevelHeight(4) },
        { floorBand: 4, ceiling: bandLevelHeight(6) },
      ]),
    ).toThrow(RangeError);
  });
});

describe('packed spans round-trip', () => {
  const LAYERED: readonly Span[] = [
    { floorBand: BEDROCK_BAND, ceiling: 32 },
    { floorBand: 4, ceiling: 70 },
    { floorBand: 8, ceiling: 131 },
  ];

  it('packs as [floorBand, ceiling] pairs and reads back identically', () => {
    const map = world();
    setColumn(map, 2, 3, LAYERED);
    const packed = packColumnSpans(map, 2, 3)!;
    expect(packed).toEqual([BEDROCK_BAND, 32, 4, 70, 8, 131]);
    expect(parsePackedSpans(packed)).toEqual(LAYERED);

    const other = world();
    expect(applyPackedSpans(other, 2, 3, packed)).toBe(true);
    expect(readSpans(other, 2, 3)).toEqual(LAYERED);
    expect(heightAt(other, 2, 3)).toBe(131);
  });

  it('refuses a packed column that breaks the contract', () => {
    expect(parsePackedSpans([BEDROCK_BAND, 32, 4])).toBeNull();
    expect(parsePackedSpans([BEDROCK_BAND, 32])).toBeNull();
    // Bottom span must floor at bedrock.
    expect(parsePackedSpans([BEDROCK_BAND + 1, 32, 4, 70])).toBeNull();
    // Second span draws nothing.
    expect(parsePackedSpans([BEDROCK_BAND, 32, 9, 100])).toBeNull();
    // No band of air between the two.
    expect(parsePackedSpans([BEDROCK_BAND, 32, 3, 64])).toBeNull();
    // Floor below the bedrock band.
    expect(parsePackedSpans([BEDROCK_BAND - 1, 32, 4, 70])).toBeNull();
  });
});

describe('highestCeilingUnderSpan', () => {
  const UPPER_FLOOR_BANDS = [8, 6, 10, 0, -20];

  const legalUnder = (upper: Span, ceiling: number): boolean =>
    isGapDrawn({ floorBand: BEDROCK_BAND, ceiling }, upper);

  it('is the highest ceiling that leaves the gap under the span drawn', () => {
    for (const floorBand of UPPER_FLOOR_BANDS) {
      const upper: Span = { floorBand, ceiling: bandLevelHeight(floorBand) };
      const cap = highestCeilingUnderSpan(upper);
      expect([floorBand, legalUnder(upper, cap)]).toEqual([floorBand, true]);
      expect([floorBand, legalUnder(upper, cap + 1)]).toEqual([floorBand, false]);
    }
  });

  it('a ceiling written at the cap keeps the column two spans', () => {
    for (const floorBand of UPPER_FLOOR_BANDS) {
      const map = world();
      const upper: Span = { floorBand, ceiling: bandLevelHeight(floorBand) };
      setColumn(map, 8, 8, [
        { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(floorBand - 4) },
        upper,
      ]);
      moveSpanCeiling(map, 8, 8, 0, highestCeilingUnderSpan(upper));
      expect([floorBand, readSpans(map, 8, 8).length]).toEqual([floorBand, 2]);
    }
  });
});

describe('bandFillAt — drag-fill admission', () => {
  const BAND = 2;
  const LEVEL = BAND * BAND_HEIGHT;

  it('writes band levels at raw multiples of the band height', () => {
    expect(LEVEL).toBe(32);
    expect(bandLevelHeight(BAND)).toBe(LEVEL);
  });

  it('fills toward the write level while the column does not draw the band', () => {
    for (const h of [8, 16, 23]) {
      const map = world();
      setHeight(map, 0, 0, h);
      expect([h, columnCoversBand(map, 0, 0, BAND)]).toEqual([h, false]);
      const fill = bandFillAt(map, 0, 0, BAND);
      expect([h, fill]).toEqual([h, { kind: 'extend', spanIndex: 0 }]);
      applyBandFill(map, 0, 0, fill!, LEVEL);
      expect([h, heightAt(map, 0, 0)]).toEqual([h, LEVEL]);
    }
  });

  it('skips as soon as the column already draws the band', () => {
    // Coverage is the ONE predicate: a ceiling of 24 draws band 2, so a drag to
    // band 2 has nothing left to fill.
    for (const h of [24, LEVEL, LEVEL + BAND_HEIGHT]) {
      const map = world();
      setHeight(map, 0, 0, h);
      expect([h, bandFillAt(map, 0, 0, BAND)]).toEqual([h, null]);
    }
    // An upper span covering the band also counts.
    const map = world();
    setColumn(map, 0, 0, [
      { floorBand: BEDROCK_BAND, ceiling: SEA_LEVEL },
      { floorBand: BAND, ceiling: 48 },
    ]);
    expect(bandFillAt(map, 0, 0, BAND)).toBeNull();
  });

  it('inserts an overhang across a gap with room under the slab', () => {
    const map = world();
    setColumn(map, 0, 0, [
      { floorBand: BEDROCK_BAND, ceiling: 4 },
      { floorBand: 4, ceiling: 80 },
    ]);
    const fill = bandFillAt(map, 0, 0, BAND);
    expect(fill).toEqual({ kind: 'overhang' });
    applyBandFill(map, 0, 0, fill!, LEVEL);
    // The slab is its own band, and the ground under it is untouched.
    expect(readSpans(map, 0, 0)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: 4 },
      { floorBand: BAND, ceiling: LEVEL },
      { floorBand: 4, ceiling: 80 },
    ]);
  });

  it('refuses a slab that would weld to the ground under it (overhangs.md 2026-08-27)', () => {
    // An overhang needs its own band plus one of air to be seen under.
    for (const groundCeiling of [8, 16, 23]) {
      const map = world();
      setColumn(map, 0, 0, [
        { floorBand: BEDROCK_BAND, ceiling: groundCeiling },
        { floorBand: 3, ceiling: 48 },
      ]);
      expect([groundCeiling, bandFillAt(map, 0, 0, BAND)]).toEqual([groundCeiling, null]);
    }
  });
});
