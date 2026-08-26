import { describe, expect, it } from 'vitest';
import {
  BEDROCK_FLOOR,
  createHeightmap,
  heightAt,
  seabedHeight,
  SEA_LEVEL,
  setColumn,
  type Heightmap,
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
    // Air at the waterline: the gap between the two spans is flooded, so the
    // seabed is the solid cap under the gap, not the roof above it.
    const map = world();
    setColumn(map, 7, 8, [
      { floor: BEDROCK_FLOOR, ceiling: -32 },
      { floor: 64, ceiling: 128 },
    ]);
    expect(seabedHeight(map, 7, 8)).toBe(-32);
    expect(heightAt(map, 7, 8)).toBe(128);
  });

  it('returns the ROOF ceiling when the column is solid at the waterline', () => {
    // The upper span spans the waterline itself, so there is no water here at
    // all — the answer is "dry", exactly what a one-span land column returns.
    const map = world();
    setColumn(map, 9, 10, [
      { floor: BEDROCK_FLOOR, ceiling: -100 },
      { floor: -50, ceiling: 200 },
    ]);
    expect(seabedHeight(map, 9, 10)).toBe(200);
    expect(seabedHeight(map, 9, 10)).toBeGreaterThan(SEA_LEVEL);
  });

  it('returns the ROOF ceiling when the whole column is below the sea', () => {
    // Every span is submerged: the topmost cap is the seabed, the same answer
    // plain sea gives, and heightAt agrees.
    const map = world();
    setColumn(map, 11, 12, [
      { floor: BEDROCK_FLOOR, ceiling: -200 },
      { floor: -100, ceiling: -50 },
    ]);
    expect(seabedHeight(map, 11, 12)).toBe(-50);
    expect(seabedHeight(map, 11, 12)).toBe(heightAt(map, 11, 12));
  });
});
