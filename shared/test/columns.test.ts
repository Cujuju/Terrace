import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  canCarveBandAt,
  carveKeepsSpanCap,
  carveRange,
  createHeightmap,
  fitColumnToSpanCap,
  heightAt,
  seabedHeight,
  SEA_LEVEL,
  MAX_SPANS_PER_COLUMN,
  parsePackedSpans,
  setColumn,
  spanCount,
  type Heightmap,
  type Span,
} from '../src/index.ts';

const WORLD_SIZE = 16;

function world(): Heightmap {
  return createHeightmap(WORLD_SIZE);
}

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  setColumn(map, x, y, [{ floor: BEDROCK_FLOOR, ceiling: h }]);
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
      { floor: BEDROCK_FLOOR, ceiling: -32 },
      { floor: 64, ceiling: 128 },
    ]);
    expect(seabedHeight(map, 7, 8)).toBe(-32);
    expect(heightAt(map, 7, 8)).toBe(128);
  });

  it('returns the ROOF ceiling when the column is solid at the waterline', () => {
    const map = world();
    setColumn(map, 9, 10, [
      { floor: BEDROCK_FLOOR, ceiling: -100 },
      { floor: -50, ceiling: 200 },
    ]);
    expect(seabedHeight(map, 9, 10)).toBe(200);
    expect(seabedHeight(map, 9, 10)).toBeGreaterThan(SEA_LEVEL);
  });

  it('returns the ROOF ceiling when the whole column is below the sea', () => {
    const map = world();
    setColumn(map, 11, 12, [
      { floor: BEDROCK_FLOOR, ceiling: -200 },
      { floor: -100, ceiling: -50 },
    ]);
    expect(seabedHeight(map, 11, 12)).toBe(-50);
    expect(seabedHeight(map, 11, 12)).toBe(heightAt(map, 11, 12));
  });
});

const DRAWN_GAP_HEIGHT = 2 * BAND_HEIGHT;

const SPLITTABLE_SPAN_HEIGHT = 5 * BAND_HEIGHT;

function stackedSpans(count: number): Span[] {
  const spans: Span[] = [{ floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT }];
  for (let k = 1; k < count; k++) {
    const floor = BEDROCK_FLOOR + k * 2 * BAND_HEIGHT;
    spans.push({ floor, ceiling: floor + BAND_HEIGHT });
  }
  return spans;
}

function drawnGapSpans(count: number, bottomHeight: number = BAND_HEIGHT): Span[] {
  const spans: Span[] = [{ floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + bottomHeight }];
  for (let k = 1; k < count; k++) {
    const floor = spans[k - 1]!.ceiling + DRAWN_GAP_HEIGHT;
    spans.push({ floor, ceiling: floor + BAND_HEIGHT });
  }
  return spans;
}

function packOf(spans: readonly Span[]): number[] {
  const flat: number[] = [];
  for (const span of spans) flat.push(span.floor, span.ceiling);
  return flat;
}

describe('MAX_SPANS_PER_COLUMN', () => {
  it('lets setColumn write a column at the limit', () => {
    const map = world();
    setColumn(map, 4, 4, stackedSpans(MAX_SPANS_PER_COLUMN));
    expect(spanCount(map, 4, 4)).toBe(MAX_SPANS_PER_COLUMN);
  });

  it('makes setColumn throw past the limit', () => {
    const map = world();
    expect(() => setColumn(map, 4, 4, stackedSpans(MAX_SPANS_PER_COLUMN + 1))).toThrow(RangeError);
  });

  it('lets a carve through at the limit when the carve shrinks the column', () => {
    const map = world();
    const spans = stackedSpans(MAX_SPANS_PER_COLUMN);
    setColumn(map, 4, 4, spans);
    const top = spans[spans.length - 1]!;

    expect(carveKeepsSpanCap(map, 4, 4, top.floor, top.ceiling)).toBe(true);
    carveRange(map, 4, 4, top.floor, top.ceiling);
    expect(spanCount(map, 4, 4)).toBeLessThan(MAX_SPANS_PER_COLUMN);
  });

  it('refuses a carve at the limit that splits a span into two', () => {
    const map = world();
    setColumn(map, 4, 4, drawnGapSpans(MAX_SPANS_PER_COLUMN, SPLITTABLE_SPAN_HEIGHT));
    const lo = BEDROCK_FLOOR + BAND_HEIGHT;
    const hi = BEDROCK_FLOOR + SPLITTABLE_SPAN_HEIGHT - BAND_HEIGHT;

    expect(carveKeepsSpanCap(map, 4, 4, lo, hi)).toBe(false);
    expect(() => carveRange(map, 4, 4, lo, hi)).toThrow(RangeError);
  });

  it('leaves canCarveBandAt judging only whether a side is open', () => {
    const map = world();
    setColumn(map, 4, 4, stackedSpans(MAX_SPANS_PER_COLUMN));
    setColumn(map, 5, 4, [{ floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT }]);
    const topBand = stackedSpans(MAX_SPANS_PER_COLUMN)[MAX_SPANS_PER_COLUMN - 1]!.ceiling / BAND_HEIGHT;

    expect(canCarveBandAt(map, 4, 4, topBand)).toBe(true);
  });
});

describe('fitColumnToSpanCap', () => {
  it('parses a saved over-cap column instead of rejecting it', () => {
    const saved = stackedSpans(MAX_SPANS_PER_COLUMN + 1);
    const parsed = parsePackedSpans(packOf(saved));

    expect(parsed).not.toBeNull();
    expect(parsed!.length).toBe(MAX_SPANS_PER_COLUMN);
    expect(parsed![0]!.floor).toBe(BEDROCK_FLOOR);
    expect(parsed![parsed!.length - 1]!.ceiling).toBe(saved[saved.length - 1]!.ceiling);
  });

  it('fills an undrawn gap before any drawn one', () => {
    const spans = drawnGapSpans(MAX_SPANS_PER_COLUMN + 1);
    const below = spans[4]!;
    spans[5] = { floor: below.ceiling + BAND_HEIGHT, ceiling: below.ceiling + 2 * BAND_HEIGHT };

    expect(fitColumnToSpanCap(spans)).toEqual([
      ...spans.slice(0, 4),
      { floor: below.floor, ceiling: spans[5]!.ceiling },
      ...spans.slice(6),
    ]);
  });

  it('fills the smallest drawn gap once no undrawn gap is left', () => {
    const smallGapAt = 3;
    const spans: Span[] = [{ floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT }];
    for (let k = 1; k <= MAX_SPANS_PER_COLUMN; k++) {
      const gap = k - 1 === smallGapAt ? DRAWN_GAP_HEIGHT : DRAWN_GAP_HEIGHT + BAND_HEIGHT;
      const floor = spans[k - 1]!.ceiling + gap;
      spans.push({ floor, ceiling: floor + BAND_HEIGHT });
    }

    expect(fitColumnToSpanCap(spans)).toEqual([
      ...spans.slice(0, smallGapAt),
      { floor: spans[smallGapAt]!.floor, ceiling: spans[smallGapAt + 1]!.ceiling },
      ...spans.slice(smallGapAt + 2),
    ]);
  });
});
