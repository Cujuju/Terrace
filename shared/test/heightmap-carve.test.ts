import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandFloorHeight,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_BAND,
  CARVE_DEFAULT_DEPTH_BANDS,
  CARVE_MAX_DEPTH_BANDS,
  CARVE_MIN_DEPTH_BANDS,
  cellIndex,
  columnCoversBand,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  DRAWN_SHORE_HEIGHT,
  heightAt,
  isGapDrawn,
  spanCapBand,
  isValidCarveDepth,
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

const SIZE = 32;
const GROUND_BAND = 2;
const CLIFF_BAND = 10;
const FACE_X = 10;
const ROW = 16;
const LIP_BAND = GROUND_BAND + 1;

function cliff(topBand: number): Heightmap {
  const map = createHeightmap(SIZE);
  for (let y = 0; y < SIZE; y++) {
    for (let x = 0; x < SIZE; x++) {
      map.cells[cellIndex(map, x, y)] = bandLevelHeight(x >= FACE_X ? topBand : GROUND_BAND);
    }
  }
  return map;
}

function coveredBands(map: Heightmap, x: number, y: number, upTo: number): number[] {
  const covered: number[] = [];
  for (let band = MIN_BAND; band <= upTo; band++) {
    if (columnCoversBand(map, x, y, band)) covered.push(band);
  }
  return covered;
}

describe('applySculpt — a carve walks inward from a cliff face (2026-09-02)', () => {
  const CELLS_INWARD = 5;

  it('opens the grasped band, so the next pick inside names the same band and the cut continues', () => {
    const map = cliff(CLIFF_BAND);
    for (let x = FACE_X; x < FACE_X + CELLS_INWARD; x++) {
      const diff = applySculpt(map, x, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: LIP_BAND,
      });
      expect(diff.length, `cut at x=${x}`).toBe(1);
      const [floor, roof] = readSpans(map, x, ROW);
      // The slab the stroke named is the slab it cleared: the remnant caps in
      // the band below it, the roof floors in the band above.
      expect(floor!.ceiling).toBe(bandLevelHeight(LIP_BAND - 1));
      expect(roof!.floorBand).toBe(LIP_BAND + 1);
      expect(coveredBands(map, x, ROW, CLIFF_BAND)).not.toContain(LIP_BAND);
    }
  });
});

describe('applySculpt — carve grasped at the bottom of the world', () => {
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
    expect(heightAt(map, PIT_X, PIT_Y)).toBe(MIN_HEIGHT);

    const before = Int16Array.from(map.cells);
    const diff = applySculpt(map, PIT_X, PIT_Y, RADIUS, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: MIN_BAND,
    });

    expect(diff).toEqual([]);
    expect(map.cells).toEqual(before);
    expect(map.columnSpans.size).toBe(0);
  });

  it('admits the band above bedrock, and keeps the column floored there', () => {
    const DEEP_ROOF_BAND = 8;
    const LOWEST_CARVEABLE_BAND = MIN_BAND + 1;
    const map = createHeightmap(SIZE);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = bandLevelHeight(DEEP_ROOF_BAND);
    // The only neighbour open that deep: air spreads from air, so without one
    // the anti-cheat refuses every band down here.
    setColumn(map, PIT_X - 1, PIT_Y, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(LOWEST_CARVEABLE_BAND - 1) },
      { floorBand: LOWEST_CARVEABLE_BAND + 1, ceiling: bandLevelHeight(DEEP_ROOF_BAND) },
    ]);

    expect(
      applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: MIN_BAND,
      }),
    ).toEqual([]);

    const diff = applySculpt(map, PIT_X, PIT_Y, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: LOWEST_CARVEABLE_BAND,
    });
    expect(diff).toHaveLength(1);
    expect(readSpans(map, PIT_X, PIT_Y)[0]!.floorBand).toBe(BEDROCK_BAND);
  });
});

describe('applySculpt — the carve clears the slabs it names and is priced at them', () => {
  it('clears exactly one slab by default', () => {
    const map = cliff(CLIFF_BAND);
    const before = coveredBands(map, FACE_X, ROW, CLIFF_BAND);

    const diff = applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
      tool: 'carve',
      spanBand: LIP_BAND,
    });

    expect(diff).toHaveLength(1);
    const after = coveredBands(map, FACE_X, ROW, CLIFF_BAND);
    expect(before.filter((band) => !after.includes(band))).toEqual([LIP_BAND]);
    expect(CARVE_DEFAULT_DEPTH_BANDS).toBe(CARVE_MIN_DEPTH_BANDS);
  });

  it('clears depthBands slabs upward from the grasped band', () => {
    const TALL_BAND = LIP_BAND + CARVE_MAX_DEPTH_BANDS + 1;
    for (const depthBands of [CARVE_MIN_DEPTH_BANDS, 2, CARVE_MAX_DEPTH_BANDS]) {
      const map = cliff(TALL_BAND);
      const before = coveredBands(map, FACE_X, ROW, TALL_BAND);
      const diff = applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: LIP_BAND,
        depthBands,
      });
      expect([depthBands, diff.length]).toEqual([depthBands, 1]);
      const after = coveredBands(map, FACE_X, ROW, TALL_BAND);
      const cleared = before.filter((band) => !after.includes(band));
      const wanted: number[] = [];
      for (let n = 0; n < depthBands; n++) wanted.push(LIP_BAND + n);
      expect([depthBands, cleared]).toEqual([depthBands, wanted]);

      const [floor, roof] = readSpans(map, FACE_X, ROW);
      expect([depthBands, floor!.ceiling]).toEqual([depthBands, bandLevelHeight(LIP_BAND - 1)]);
      expect([depthBands, roof!.floorBand]).toEqual([depthBands, LIP_BAND + depthBands]);
    }
  });

  it('refuses a depth outside the validated range instead of cutting something else', () => {
    expect(isValidCarveDepth(CARVE_MIN_DEPTH_BANDS)).toBe(true);
    expect(isValidCarveDepth(CARVE_MAX_DEPTH_BANDS)).toBe(true);
    expect(isValidCarveDepth(CARVE_MIN_DEPTH_BANDS - 1)).toBe(false);
    expect(isValidCarveDepth(CARVE_MAX_DEPTH_BANDS + 1)).toBe(false);
    expect(isValidCarveDepth(1.5)).toBe(false);

    for (const depthBands of [0, -1, CARVE_MAX_DEPTH_BANDS + 1, 1.5]) {
      const map = cliff(CLIFF_BAND);
      const before = Int16Array.from(map.cells);
      const diff = applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, {
        tool: 'carve',
        spanBand: LIP_BAND,
        depthBands,
      });
      expect([depthBands, diff]).toEqual([depthBands, []]);
      expect([depthBands, map.cells]).toEqual([depthBands, before]);
    }
  });

  it('leaves an opening the renderer keeps — the smallest gap isGapDrawn admits', () => {
    const map = cliff(CLIFF_BAND);
    applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });

    const [floor, roof] = readSpans(map, FACE_X, ROW);
    expect(roof).toBeDefined();
    expect(isGapDrawn(floor!, roof!)).toBe(true);
  });

  it('prices a stroke at its footprint times its depth', () => {
    const oneCell = sculptDisplacementUnits(1, 'carve', 'hard', CARVE_DEFAULT_DEPTH_BANDS);
    expect(oneCell).toBe(CARVE_DEFAULT_DEPTH_BANDS * BAND_HEIGHT);
    for (const depthBands of [CARVE_MIN_DEPTH_BANDS, 2, CARVE_MAX_DEPTH_BANDS]) {
      expect([depthBands, sculptDisplacementUnits(1, 'carve', 'hard', depthBands)]).toEqual([
        depthBands,
        depthBands * BAND_HEIGHT,
      ]);
      // Linear in depth at every radius, not just one cell.
      expect([depthBands, sculptDisplacementUnits(4, 'carve', 'hard', depthBands)]).toEqual([
        depthBands,
        sculptDisplacementUnits(4, 'carve', 'hard', CARVE_MIN_DEPTH_BANDS) * depthBands,
      ]);
    }
  });

  it('changes no band outside the slabs it clears', () => {
    const map = cliff(CLIFF_BAND);
    setColumn(map, FACE_X, ROW, [
      { floorBand: BEDROCK_BAND, ceiling: bandLevelHeight(GROUND_BAND) },
      { floorBand: LIP_BAND + 1, ceiling: bandLevelHeight(CLIFF_BAND) },
    ]);
    const before = coveredBands(map, FACE_X, ROW, MAX_BAND);
    applySculpt(map, FACE_X, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });
    const after = coveredBands(map, FACE_X, ROW, MAX_BAND);

    for (let band = MIN_BAND; band <= MAX_BAND; band++) {
      if (band === LIP_BAND) continue;
      expect([band, after.includes(band)]).toEqual([band, before.includes(band)]);
    }
  });

  it('reports an empty diff when the aimed column does not cover the band it names', () => {
    const map = cliff(CLIFF_BAND);
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

describe('a drag never reaches below its run’s floor (supersedes issue #224)', () => {
  const CELLS_INWARD = 5;
  const INSIDE_X = FACE_X + 2;
  const DRAG_RAISE = { tool: 'drag', profile: 'hard', anchor: 'band' } as const;

  const tunnelledCliff = (): Heightmap => {
    const map = cliff(CLIFF_BAND);
    for (let x = FACE_X; x < FACE_X + CELLS_INWARD; x++) {
      applySculpt(map, x, ROW, 1, -DEFAULT_SCULPT_AMOUNT, { tool: 'carve', spanBand: LIP_BAND });
    }
    return map;
  };

  it('leaves the tunnel byte-untouched when the run floors in the roof above it', () => {
    const map = tunnelledCliff();
    const before = readSpans(map, INSIDE_X, ROW);
    expect(before).toHaveLength(2);
    const roof = before[1]!;
    const diff = applySculpt(map, INSIDE_X, ROW, 1, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_RAISE,
      targetBand: spanCapBand(roof),
      runFloorBand: roof.floorBand,
    });
    expect(diff).toEqual([]);
    expect(readSpans(map, INSIDE_X, ROW)).toEqual(before);
  });

  it('fills the tunnel when the run IS the tunnel’s own air', () => {
    // #224 forbade this. The run contract allows it: grabbing the void's band
    // runs down to that void's floor, and the slab welds where it lands.
    const map = tunnelledCliff();
    const before = readSpans(map, INSIDE_X, ROW);
    const void_ = spanCapBand(before[0]!) + 1;
    applySculpt(map, INSIDE_X, ROW, 1, DEFAULT_SCULPT_AMOUNT, {
      ...DRAG_RAISE,
      targetBand: void_,
      runFloorBand: void_,
    });
    expect(readSpans(map, INSIDE_X, ROW)).not.toEqual(before);
  });
});

describe('a wire-validated carve never throws, wherever the ground sits', () => {
  const CX = 12;
  const CY = 12;
  const ROOF_GAP_BANDS = 3;
  const ROOF_BANDS = 2;
  const DEPTHS = [CARVE_MIN_DEPTH_BANDS, CARVE_MAX_DEPTH_BANDS];
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
    const map = createHeightmap(24);
    map.cells.fill(ground);
    return map;
  };

  const roofedWorld = (top: number): Heightmap => {
    const floorHeight = top - (ROOF_GAP_BANDS + ROOF_BANDS) * BAND_HEIGHT;
    if (floorHeight <= MIN_HEIGHT) return plainWorld(top);
    const map = plainWorld(floorHeight);
    const roofFloorBand = drawnBandOfSample(top) - (ROOF_BANDS - 1);
    for (let y = CY - 4; y <= CY + 4; y++) {
      for (let x = CX - 4; x <= CX + 4; x++) {
        setColumn(map, x, y, [
          { floorBand: BEDROCK_BAND, ceiling: floorHeight },
          { floorBand: roofFloorBand, ceiling: top },
        ]);
      }
    }
    return map;
  };

  const spansAreLegal = (map: Heightmap): boolean => {
    for (let i = 0; i < map.cells.length; i++) {
      if (!isValidHeight(map.cells[i]!)) return false;
    }
    for (const packed of map.columnSpans.values()) {
      for (let k = 0; k < packed.length; k += 2) {
        if (packed[k]! < MIN_BAND || packed[k]! > MAX_BAND) return false;
        if (packed[k + 1]! < MIN_HEIGHT || packed[k + 1]! > MAX_HEIGHT) return false;
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
        const depthBands = DEPTHS[(band - MIN_BAND + 1) % DEPTHS.length]!;
        for (const radius of [MIN_BRUSH_RADIUS, 4, MAX_BRUSH_RADIUS]) {
          const map = build(ground);
          const options = sculptOptionsOf({
            type: 'sculpt',
            x: CX,
            y: CY,
            radius,
            dir: -1,
            tool: 'carve',
            spanBand: band,
            depthBands,
          });
          try {
            applySculpt(map, CX, CY, radius, -DEFAULT_SCULPT_AMOUNT, options);
          } catch (error) {
            faults.push({ ground, band, radius, depthBands, error: String(error) });
          }
          if (!spansAreLegal(map)) faults.push({ ground, band, radius, depthBands, illegal: true });
        }
      }
    }
    expect(faults).toEqual([]);
  });
});
