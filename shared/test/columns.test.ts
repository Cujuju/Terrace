import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  canCarveBandAt,
  createHeightmap,
  heightAt,
  seabedHeight,
  SEA_LEVEL,
  MAX_SPANS_PER_COLUMN,
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

function stackedSpans(count: number): Span[] {
  const spans: Span[] = [{ floor: BEDROCK_FLOOR, ceiling: BEDROCK_FLOOR + BAND_HEIGHT }];
  for (let k = 1; k < count; k++) {
    const floor = BEDROCK_FLOOR + k * 2 * BAND_HEIGHT;
    spans.push({ floor, ceiling: floor + BAND_HEIGHT });
  }
  return spans;
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

  it('makes canCarveBandAt refuse a column already at the limit', () => {
    const band = 5;
    const below = world();
    setColumn(below, 4, 4, stackedSpans(MAX_SPANS_PER_COLUMN - 1));
    expect(canCarveBandAt(below, 4, 4, band)).toBe(true);

    const atLimit = world();
    setColumn(atLimit, 4, 4, stackedSpans(MAX_SPANS_PER_COLUMN));
    expect(canCarveBandAt(atLimit, 4, 4, band)).toBe(false);
  });
});
