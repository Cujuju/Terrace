import { describe, expect, it } from 'vitest';
import {
  applyBandFill,
  bandFillAt,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  createHeightmap,
  heightAt,
  readSpans,
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

describe('bandFillAt — drag-fill material reach (lane/drag-fill)', () => {
  // Fill admission is material reach toward the write level, not drawn
  // coverage: spanIndexCoveringBand rounds caps UP to the drawn level, so a
  // ceiling that merely touches a drawn band floor must still fill toward
  // the target. bandFillAt keeps its own raw-ceiling check for this reason.
  const BAND = 2;
  const LEVEL = BAND * BAND_HEIGHT;

  it('writes band levels at raw multiples of the band height', () => {
    expect(LEVEL).toBe(32);
    expect(bandLevelHeight(BAND)).toBe(LEVEL);
  });

  it('fills toward the write level when the ceiling only touches the drawn floor', () => {
    // Drawn floor of band 2 is 24; ceilings 24..31 touch but do not reach 32.
    for (const h of [24, 25, 31]) {
      const map = world();
      setHeight(map, 0, 0, h);
      const fill = bandFillAt(map, 0, 0, BAND);
      expect(fill).toEqual({ kind: 'extend', spanIndex: 0 });
      applyBandFill(map, 0, 0, fill!, LEVEL);
      expect(heightAt(map, 0, 0)).toBe(LEVEL);
    }
  });

  it('skips when solid material already meets or exceeds the write level', () => {
    for (const h of [LEVEL, LEVEL + BAND_HEIGHT]) {
      const map = world();
      setHeight(map, 0, 0, h);
      expect(bandFillAt(map, 0, 0, BAND)).toBeNull();
    }
    // A straddling upper span also reaches the level.
    const map = world();
    setColumn(map, 0, 0, [
      { floor: BEDROCK_FLOOR, ceiling: 16 },
      { floor: 24, ceiling: 48 },
    ]);
    expect(bandFillAt(map, 0, 0, BAND)).toBeNull();
  });

  it('inserts an overhang across a true gap', () => {
    const map = world();
    setColumn(map, 0, 0, [
      { floor: BEDROCK_FLOOR, ceiling: 16 },
      { floor: 40, ceiling: 48 },
    ]);
    const fill = bandFillAt(map, 0, 0, BAND);
    expect(fill).toEqual({ kind: 'overhang' });
    applyBandFill(map, 0, 0, fill!, LEVEL);
    // Inserted material reaches the write level.
    const spans = readSpans(map, 0, 0);
    expect(spans.some((s) => s.floor <= LEVEL && LEVEL <= s.ceiling)).toBe(true);
  });

  it('keeps a drawn gap layered after the overhang insert', () => {
    const map = world();
    setColumn(map, 0, 0, [
      { floor: BEDROCK_FLOOR, ceiling: 16 },
      { floor: 64, ceiling: 80 },
    ]);
    const fill = bandFillAt(map, 0, 0, BAND);
    expect(fill).toEqual({ kind: 'overhang' });
    applyBandFill(map, 0, 0, fill!, LEVEL);
    expect(readSpans(map, 0, 0)).toEqual([
      { floor: BEDROCK_FLOOR, ceiling: LEVEL },
      { floor: 64, ceiling: 80 },
    ]);
  });
});
