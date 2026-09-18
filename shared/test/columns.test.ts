import { describe, expect, it } from 'vitest';
import {
  applyPackedSpans,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_BAND,
  BEDROCK_FLOOR,
  canonicaliseColumn,
  columnCoversBand,
  columnHoldsRun,
  createHeightmap,
  fillBandRun,
  heightAt,
  highestCeilingUnderSpan,
  isGapDrawn,
  isSpanDrawn,
  MAX_HEIGHT,
  moveSpanCeiling,
  packColumnSpans,
  parsePackedSpans,
  readSpans,
  runFloorBandAt,
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

describe('runFloorBandAt — the run down from a dragged band', () => {
  // The spec specimen, band for band: ground to 3, hollow at 4-5, ledge at
  // 6-7, cutout at 8, cap at 9, open sky above.
  const SPECIMEN: readonly Span[] = [
    { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(3) },
    { floorBand: 6, ceiling: bandLevelHeight(7) },
    { floorBand: 9, ceiling: bandLevelHeight(9) },
  ];

  function specimen(): Heightmap {
    const map = world();
    setColumn(map, 0, 0, SPECIMEN);
    return map;
  }

  it('runs solid down to its own span’s floor', () => {
    const map = specimen();
    // Ground carries everything beneath it; the ledge carries only itself.
    expect([1, 2, 3].map((b) => runFloorBandAt(map, 0, 0, b))).toEqual([
      BEDROCK_BAND,
      BEDROCK_BAND,
      BEDROCK_BAND,
    ]);
    expect([runFloorBandAt(map, 0, 0, 6), runFloorBandAt(map, 0, 0, 7)]).toEqual([6, 6]);
    expect(runFloorBandAt(map, 0, 0, 9)).toBe(9);
  });

  it('runs air down to the floor of its own void', () => {
    const map = specimen();
    // The 4-5 hollow floors at 4; the one-band cutout and open sky floor in themselves.
    expect([runFloorBandAt(map, 0, 0, 4), runFloorBandAt(map, 0, 0, 5)]).toEqual([4, 4]);
    expect(runFloorBandAt(map, 0, 0, 8)).toBe(8);
    expect(runFloorBandAt(map, 0, 0, 10)).toBe(10);
  });

  it('never reaches below the material it was grasped in', () => {
    const map = specimen();
    // Shielding, stated: no run started at or above band 6 can touch the hollow.
    for (const band of [6, 7, 8, 9, 10]) {
      expect([band, runFloorBandAt(map, 0, 0, band) > 5]).toEqual([band, true]);
    }
  });
});

describe('fillBandRun — what a swept cell writes', () => {
  // Same ground as the specimen, nothing above it: the cell a stroke sweeps into.
  function swept(): Heightmap {
    const map = world();
    setColumn(map, 0, 0, [{ floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(3) }]);
    return map;
  }

  function fill(map: Heightmap, floorBand: number, band: number): boolean {
    return fillBandRun(map, 0, 0, floorBand, band, bandLevelHeight(band));
  }

  it('welds a slab that lands on material, closing the gap under it', () => {
    const map = swept();
    expect(fill(map, 4, 5)).toBe(true);
    expect(readSpans(map, 0, 0)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(5) },
    ]);
  });

  it('lays a slab with air under it, and leaves that air alone', () => {
    const map = swept();
    // The ledge pulled out sideways: the hollow under it is continued, not filled.
    expect(fill(map, 6, 7)).toBe(true);
    expect(readSpans(map, 0, 0)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(3) },
      { floorBand: 6, ceiling: bandLevelHeight(7) },
    ]);
  });

  it('has no refusal but “already solid”', () => {
    const map = swept();
    // Every band of the run is held, so there is nothing to write.
    expect(columnHoldsRun(map, 0, 0, BEDROCK_BAND, 3)).toBe(true);
    expect(fill(map, BEDROCK_BAND, 3)).toBe(false);
    // Held deeper than the run asks still counts as held.
    expect(fill(map, 2, 3)).toBe(false);
    // Held above but not through: the run is written.
    expect(fill(map, 5, 6)).toBe(true);
  });

  it('merges a slab that spans two standing spans into one', () => {
    const map = world();
    setColumn(map, 0, 0, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(3) },
      { floorBand: 6, ceiling: bandLevelHeight(7) },
    ]);
    // Nothing inspects what is overhead: the slab lands and canonicalisation joins it.
    expect(fill(map, 4, 5)).toBe(true);
    expect(readSpans(map, 0, 0)).toEqual([
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(7) },
    ]);
  });

  it('leaves a column it cannot draw into untouched', () => {
    const map = swept();
    const before = readSpans(map, 0, 0);
    // A ceiling below the slab's own floor draws nothing, so nothing is written.
    expect(fillBandRun(map, 0, 0, 6, 7, bandLevelHeight(4))).toBe(false);
    expect(readSpans(map, 0, 0)).toEqual(before);
  });
});
