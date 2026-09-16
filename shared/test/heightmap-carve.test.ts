import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandFloorHeight,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CARVE_BANDS_PER_STROKE,
  cellIndex,
  columnCoversBand,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  DRAWN_SHORE_HEIGHT,
  heightAt,
  isGapDrawn,
  isValidHeight,
  MAX_BAND,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MIN_BAND,
  MIN_BRUSH_RADIUS,
  MIN_HEIGHT,
  readSpans,
  sculptDisplacementUnits,
  sculptOptionsOf,
  SEA_LEVEL,
  setColumn,
  type Heightmap,
} from '../src/index.ts';

describe('applySculpt — a carve walks inward from a cliff face (2026-09-02)', () => {
  const SIZE = 32;
  const GROUND_BAND = 2;
  const CLIFF_BAND = 10;
  const FACE_X = 10;
  const ROW = 16;
  const LIP_BAND = GROUND_BAND + 1;
  const CELLS_INWARD = 5;

  it('opens the grasped band, so the next pick inside names the same band and the cut continues', () => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = (x >= FACE_X ? CLIFF_BAND : GROUND_BAND) * BAND_HEIGHT;
      }
    }
    for (let x = FACE_X; x < FACE_X + CELLS_INWARD; x++) {
      const diff = applySculpt(map, x, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: LIP_BAND,
      });
      expect(diff.length, `cut at x=${x}`).toBe(1);
      const [floor, roof] = readSpans(map, x, ROW);
      // The carve window is drawn: it opens the grasped band plus the drawn
      // floor below it.
      expect(floor!.ceiling).toBe(bandFloorHeight(LIP_BAND - 1));
      expect(roof!.floor).toBe(bandFloorHeight(LIP_BAND + 1));
      expect(Math.ceil((roof!.floor - BAND_HEIGHT) / BAND_HEIGHT)).toBe(LIP_BAND);
    }
  });
});

describe('applySculpt — carve grasped at the bottom of the world', () => {
  const SIZE = 32;
  const PIT_X = 10;
  const PIT_Y = 10;
  const RADIUS = 2;

  it('refuses the whole stroke rather than cutting a column off its bedrock', () => {
    const map = createHeightmap(SIZE);
    const strokes = Math.ceil((0 - MIN_HEIGHT) / DEFAULT_SCULPT_AMOUNT);
    for (let n = 0; n < strokes; n++) {
      applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'stamp',
        profile: 'hard',
      });
    }
    expect(heightAt(map, PIT_X, PIT_Y)).toBe(MIN_HEIGHT + 1);

    const before = Int16Array.from(map.cells);
    const diff = applySculpt(map, PIT_X, PIT_Y, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: MIN_BAND,
    });

    expect(diff).toEqual([]);
    expect(map.cells).toEqual(before);
    expect(map.columnSpans.size).toBe(0);
  });

  it('refuses the band above it too, and keeps bedrock at the lowest band it admits', () => {
    const DEEP_ROOF_BAND = 8;
    const LOWEST_CARVEABLE_BAND = MIN_BAND + 2;
    const map = createHeightmap(SIZE);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = bandLevelHeight(DEEP_ROOF_BAND);
    // The only neighbour open that deep: air spreads from air, so without one
    // the anti-cheat refuses every band down here.
    setColumn(map, PIT_X - 1, PIT_Y, [
      { floor: BEDROCK_FLOOR, ceiling: bandFloorHeight(LOWEST_CARVEABLE_BAND - 1) },
      { floor: bandFloorHeight(LOWEST_CARVEABLE_BAND + 1), ceiling: bandLevelHeight(DEEP_ROOF_BAND) },
    ]);

    for (const spanBand of [MIN_BAND, MIN_BAND + 1]) {
      expect(
        applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand }),
        `spanBand ${spanBand}`,
      ).toEqual([]);
    }

    const diff = applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: LOWEST_CARVEABLE_BAND,
    });
    expect(diff).toHaveLength(1);
    expect(readSpans(map, PIT_X, PIT_Y)[0]!.floor).toBe(BEDROCK_FLOOR);
  });
});

describe('applySculpt — the carve cuts CARVE_BANDS_PER_STROKE bands and is priced at them', () => {
  const SIZE = 32;
  const GROUND_BAND = 2;
  const CLIFF_BAND = 10;
  const FACE_X = 10;
  const ROW = 16;
  const LIP_BAND = GROUND_BAND + 1;

  function cliff(): Heightmap {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = bandLevelHeight(x >= FACE_X ? CLIFF_BAND : GROUND_BAND);
      }
    }
    return map;
  }

  const solidHeightAt = (map: Heightmap, x: number, y: number): number =>
    readSpans(map, x, y).reduce((total, span) => total + (span.ceiling - span.floor), 0);

  function openBandsAt(map: Heightmap, x: number, y: number, upTo: number): number[] {
    const open: number[] = [];
    for (let band = MIN_BAND; band <= upTo; band++) {
      if (!columnCoversBand(map, x, y, band)) open.push(band);
    }
    return open;
  }

  // The constant is the cut's DEPTH in bands; the drawn opening it leaves is
  // one band shallower, because the remnant's cap rounds up to its own band.
  it('cuts CARVE_BANDS_PER_STROKE bands of material and opens one drawn band fewer', () => {
    const map = cliff();
    const before = solidHeightAt(map, FACE_X, ROW);

    const diff = applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: LIP_BAND,
    });

    expect(diff).toHaveLength(1);
    expect(before - solidHeightAt(map, FACE_X, ROW)).toBe(CARVE_BANDS_PER_STROKE * BAND_HEIGHT);
    expect(openBandsAt(map, FACE_X, ROW, CLIFF_BAND)).toEqual([LIP_BAND]);
    expect(openBandsAt(map, FACE_X, ROW, CLIFF_BAND)).toHaveLength(CARVE_BANDS_PER_STROKE - 1);
  });

  it('leaves an opening the renderer keeps — the smallest gap isGapDrawn admits', () => {
    const map = cliff();
    applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });

    const [floor, roof] = readSpans(map, FACE_X, ROW);
    expect(roof).toBeDefined();
    expect(isGapDrawn(floor!, roof!)).toBe(true);
  });

  it('prices a one-cell stroke at exactly the material it removes', () => {
    const map = cliff();
    const before = solidHeightAt(map, FACE_X, ROW);
    applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });

    expect(sculptDisplacementUnits(1, 'carve')).toBe(CARVE_BANDS_PER_STROKE * BAND_HEIGHT);
    expect(sculptDisplacementUnits(1, 'carve')).toBe(before - solidHeightAt(map, FACE_X, ROW));
  });

  it('changes no material outside the raw range it cuts', () => {
    const map = cliff();
    setColumn(map, FACE_X, ROW, [
      { floor: BEDROCK_FLOOR, ceiling: bandLevelHeight(GROUND_BAND) },
      { floor: bandFloorHeight(LIP_BAND + 1), ceiling: bandLevelHeight(CLIFF_BAND) },
    ]);
    const lo = bandFloorHeight(LIP_BAND - 1);
    const hi = bandFloorHeight(LIP_BAND + 1);

    const solidBefore = new Set<number>();
    for (const span of readSpans(map, FACE_X, ROW)) {
      for (let h = span.floor; h < span.ceiling; h++) solidBefore.add(h);
    }
    applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });
    const solidAfter = new Set<number>();
    for (const span of readSpans(map, FACE_X, ROW)) {
      for (let h = span.floor; h < span.ceiling; h++) solidAfter.add(h);
    }

    for (let h = BEDROCK_FLOOR; h < MAX_HEIGHT; h++) {
      if (h >= lo && h < hi) continue;
      expect(solidAfter.has(h), `height ${h}`).toBe(solidBefore.has(h));
    }
  });

  it('reports an empty diff when the aimed column does not cover the band it names', () => {
    const map = cliff();
    const before = Int16Array.from(map.cells);

    const diff = applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: CLIFF_BAND + 2,
    });

    expect(diff).toEqual([]);
    expect(map.cells).toEqual(before);
    expect(map.columnSpans.size).toBe(0);
  });
});

describe('a dragged band never fills the carve under it (issue #224)', () => {
  const SIZE = 32;
  const GROUND_BAND = 2;
  const CLIFF_BAND = 10;
  const FACE_X = 10;
  const ROW = 16;
  const LIP_BAND = GROUND_BAND + 1;
  const CELLS_INWARD = 5;
  const INSIDE_X = FACE_X + 2;
  const DRAG_RAISE = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const tunnelledCliff = (): Heightmap => {
    const map = createHeightmap(SIZE);
    for (let y = 0; y < SIZE; y++) {
      for (let x = 0; x < SIZE; x++) {
        map.cells[cellIndex(map, x, y)] = bandLevelHeight(x >= FACE_X ? CLIFF_BAND : GROUND_BAND);
      }
    }
    for (let x = FACE_X; x < FACE_X + CELLS_INWARD; x++) {
      applySculpt(map, x, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });
    }
    return map;
  };

  it('leaves the tunnel byte-untouched whichever band in it is dragged', () => {
    for (const targetBand of [LIP_BAND - 1, LIP_BAND, LIP_BAND + 1]) {
      const map = tunnelledCliff();
      const before = readSpans(map, INSIDE_X, ROW);
      expect(before).toHaveLength(2);
      const diff = applySculpt(map, INSIDE_X, ROW, 1, DEFAULT_SCULPT_AMOUNT, {
        ...DRAG_RAISE,
        targetBand,
      });
      expect([targetBand, diff]).toEqual([targetBand, []]);
      expect([targetBand, readSpans(map, INSIDE_X, ROW)]).toEqual([targetBand, before]);
    }
  });
});

describe('a wire-validated carve never throws, wherever the ground sits', () => {
  const SIZE = 24;
  const CX = 12;
  const CY = 12;
  const ROOF_GAP_BANDS = 3;
  const ROOF_BANDS = 2;
  // Every legal extreme a heightmap can hold: both limits and a band edge.
  const GROUNDS = [
    MAX_HEIGHT,
    MAX_HEIGHT - 1,
    MAX_HEIGHT - BAND_HEIGHT,
    bandFloorHeight(MAX_BAND),
    MIN_HEIGHT + 1,
    MIN_HEIGHT + BAND_HEIGHT,
    bandFloorHeight(MIN_BAND + 1),
    SEA_LEVEL,
    DRAWN_SHORE_HEIGHT,
  ];

  const plainWorld = (ground: number): Heightmap => {
    const map = createHeightmap(SIZE);
    map.cells.fill(ground);
    return map;
  };

  const roofedWorld = (top: number): Heightmap => {
    const floorHeight = top - (ROOF_GAP_BANDS + ROOF_BANDS) * BAND_HEIGHT;
    if (floorHeight <= BEDROCK_FLOOR) return plainWorld(top);
    const map = plainWorld(floorHeight);
    for (let y = CY - 4; y <= CY + 4; y++) {
      for (let x = CX - 4; x <= CX + 4; x++) {
        setColumn(map, x, y, [
          { floor: BEDROCK_FLOOR, ceiling: floorHeight },
          { floor: top - ROOF_BANDS * BAND_HEIGHT, ceiling: top },
        ]);
      }
    }
    return map;
  };

  const heightsAreLegal = (map: Heightmap): boolean => {
    for (let i = 0; i < map.cells.length; i++) {
      if (!isValidHeight(map.cells[i]!)) return false;
    }
    for (const packed of map.columnSpans.values()) {
      for (let k = 0; k < packed.length; k += 2) {
        if (packed[k]! < MIN_HEIGHT || packed[k + 1]! > MAX_HEIGHT) return false;
      }
    }
    return true;
  };

  it.each([
    ['plain', plainWorld],
    ['roofed', roofedWorld],
  ])('carves every band of a %s world without a RangeError', (_kind, build) => {
    const faults: unknown[] = [];
    for (const ground of GROUNDS) {
      for (let band = MIN_BAND - 1; band <= MAX_BAND + 1; band++) {
        for (const radius of [MIN_BRUSH_RADIUS, 4, MAX_BRUSH_RADIUS]) {
          const map = build(ground);
          const options = sculptOptionsOf({
            type: 'sculpt', x: CX, y: CY, radius, dir: -1, tool: 'carve', spanBand: band,
          });
          try {
            applySculpt(map, CX, CY, radius, -DEFAULT_SCULPT_AMOUNT, options);
          } catch (error) {
            faults.push({ ground, band, radius, error: String(error) });
          }
          if (!heightsAreLegal(map)) faults.push({ ground, band, radius, illegal: true });
        }
      }
    }
    expect(faults).toEqual([]);
  });
});
