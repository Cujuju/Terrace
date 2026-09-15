import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  carveRange,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  DRAWN_GROUND_BAND_BIAS,
  forEachFootprintOffset,
  highestCeilingUnderSpan,
  MAX_BRUSH_RADIUS,
  readSpans,
  sculptOptionsOf,
  setColumn,
  smooth,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';

describe('smooth builds the layer view only where the sweep meets a layered column', () => {
  const SIZE = 64;
  const GROUND_BAND = 10;
  const CARVED_X = 1;
  const CARVED_Y = 1;
  const CARVE_FLOOR_BAND = 2;
  const CARVE_ROOF_BAND = 6;
  const FAR_X = 48;
  const FAR_Y = 48;
  const STROKE_RADIUS = 8;
  const SMOOTH_STROKE: SculptOptions = {
    tool: 'smooth',
    profile: 'soft',
    spill: 'banded',
    anchor: 'clicked',
  };

  function flatWorld(carved: boolean): Heightmap {
    const map = createHeightmap(SIZE);
    map.cells.fill(GROUND_BAND * BAND_HEIGHT);
    if (carved) {
      carveRange(
        map,
        CARVED_X,
        CARVED_Y,
        CARVE_FLOOR_BAND * BAND_HEIGHT,
        CARVE_ROOF_BAND * BAND_HEIGHT,
      );
    }
    return map;
  }

  function countGridCopies(map: Heightmap): () => number {
    let copies = 0;
    const real = map.cells.slice.bind(map.cells);
    Object.defineProperty(map.cells, 'slice', {
      configurable: true,
      value: (...args: readonly number[]): Int16Array => {
        copies++;
        return real(...args);
      },
    });
    return () => copies;
  }

  it('a carve in the far corner costs a distant stroke nothing, and changes nothing', () => {
    const carved = flatWorld(true);
    expect(carved.columnSpans.size).toBe(1);
    const copies = countGridCopies(carved);
    const carvedDiff = applySculpt(carved, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(0);

    const plain = flatWorld(false);
    const plainDiff = applySculpt(plain, FAR_X, FAR_Y, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(carvedDiff).toEqual(plainDiff);
    expect(carvedDiff.length).toBe(0);
  });

  it('a stroke whose sweep does reach the carved column still relaxes a view', () => {
    const carved = flatWorld(true);
    const copies = countGridCopies(carved);
    applySculpt(carved, CARVED_X + STROKE_RADIUS, CARVED_Y + STROKE_RADIUS, STROKE_RADIUS, -DEFAULT_SCULPT_AMOUNT, SMOOTH_STROKE);
    expect(copies()).toBe(1);
  });
});

describe('a smooth grasping a lower layer never swallows the cave above it', () => {
  const SIZE = 32;
  const UPPER = { floor: 128, ceiling: 200 };
  const LOW_CEILING = 60;
  const HIGH_CEILING = 100;
  const PRESSES = 25;

  it('25 spanBand raise-smooths leave every column two spans', () => {
    const map = createHeightmap(SIZE);
    map.cells.fill(300);
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const ceiling = (x + y) % 2 === 0 ? HIGH_CEILING : LOW_CEILING;
        setColumn(map, x, y, [{ floor: BEDROCK_FLOOR, ceiling }, UPPER]);
      }
    }
    const spanBand = drawnBandOfSample(HIGH_CEILING);
    const options = sculptOptionsOf({
      type: 'sculpt', x: 16, y: 16, radius: 5, dir: 1, tool: 'smooth', spanBand,
    });

    for (let k = 0; k < PRESSES; k++) {
      applySculpt(map, 16, 16, 5, DEFAULT_SCULPT_AMOUNT, options);
    }

    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const spans = readSpans(map, x, y);
        expect(spans).toHaveLength(2);
        expect(spans[1]).toEqual(UPPER);
        expect(spans[0].ceiling).toBeLessThanOrEqual(highestCeilingUnderSpan(UPPER));
      }
    }
  });
});

describe('an anchored smooth manufactures at most one band per cell (2026-09-15)', () => {
  const SIZE = 96;
  const GROUND_BAND = 40;
  const TRENCH_X = 40;
  const TOWER_X = 52;
  const CLICK_X = 46;
  const ROW = 48;
  const TRENCH_RADIUS = 4;
  const TOWER_RADIUS = 3;
  const TOWER_PRESSES = 6;
  const TRENCH_DEPTHS = [6, 20, 40];
  const CONVERGENCE_LIMIT = 40;
  // The furthest one melt can lift a cell: a band's floor to the next band's level.
  const MELT_ROOM_PER_CELL = BAND_HEIGHT + DRAWN_GROUND_BAND_BIAS;
  const SMOOTH_RAISE = sculptOptionsOf({
    type: 'sculpt', x: CLICK_X, y: ROW, radius: MAX_BRUSH_RADIUS, dir: 1, tool: 'smooth',
  });

  const trenchAndTower = (digs: number): Heightmap => {
    const map = createHeightmap(SIZE);
    map.cells.fill(bandLevelHeight(GROUND_BAND));
    for (let k = 0; k < digs; k++) {
      applySculpt(map, TRENCH_X, ROW, TRENCH_RADIUS, -DEFAULT_SCULPT_AMOUNT, WIRE_DEFAULT_SCULPT_OPTIONS);
    }
    for (let k = 0; k < TOWER_PRESSES; k++) {
      applySculpt(map, TOWER_X, ROW, TOWER_RADIUS, DEFAULT_SCULPT_AMOUNT, WIRE_DEFAULT_SCULPT_OPTIONS);
    }
    return map;
  };
  const totalOf = (map: Heightmap): number => map.cells.reduce((sum, h) => sum + h, 0);
  const press = (map: Heightmap): number =>
    applySculpt(map, CLICK_X, ROW, MAX_BRUSH_RADIUS, DEFAULT_SCULPT_AMOUNT, SMOOTH_RAISE).length;
  const footprintCells = (): number => {
    let cells = 0;
    forEachFootprintOffset(MAX_BRUSH_RADIUS, () => cells++);
    return cells;
  };

  it('is bounded by the brush, not by how deep the pit under it is', () => {
    const cap = footprintCells() * MELT_ROOM_PER_CELL;
    for (const digs of TRENCH_DEPTHS) {
      const map = trenchAndTower(digs);
      const before = totalOf(map);
      expect(press(map)).toBeGreaterThan(0);
      expect([digs, totalOf(map) - before <= cap]).toEqual([digs, true]);
    }
  });

  it('converges: repeats stop changing the ground and report an empty diff', () => {
    const map = trenchAndTower(TRENCH_DEPTHS[1]!);
    let presses = 0;
    while (presses < CONVERGENCE_LIMIT && press(map) > 0) presses++;
    expect(presses).toBeGreaterThan(0);
    expect(presses).toBeLessThan(CONVERGENCE_LIMIT);
  });
});
