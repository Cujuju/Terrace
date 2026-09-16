import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandLevelHeight,
  BAND_HEIGHT,
  bandFloorHeight,
  BEDROCK_BAND,
  carveBands,
  createHeightmap,
  createSeededRng,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  highestCeilingUnderSpan,
  MAX_BRUSH_RADIUS,
  readSpans,
  sculptOptionsOf,
  setColumn,
  smooth,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  type Heightmap,
  type SculptOptions,
  type SeededRng,
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
      carveBands(map, CARVED_X, CARVED_Y, CARVE_FLOOR_BAND, CARVE_ROOF_BAND - 1);
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
  const UPPER = { floorBand: 8, ceiling: 200 };
  const LOW_CEILING = 60;
  const HIGH_CEILING = 100;
  const PRESSES = 25;

  it('25 spanBand raise-smooths leave every column two spans', () => {
    const map = createHeightmap(SIZE);
    map.cells.fill(300);
    for (let y = 12; y < 20; y++) {
      for (let x = 12; x < 20; x++) {
        const ceiling = (x + y) % 2 === 0 ? HIGH_CEILING : LOW_CEILING;
        setColumn(map, x, y, [{ floorBand: BEDROCK_BAND, ceiling }, UPPER]);
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

describe('an anchored smooth conserves height (2026-09-15)', () => {
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
  // Measured against the conserving relaxation; the limit below is a hang guard.
  const CONVERGED_PRESSES = 1;
  const CONVERGENCE_LIMIT = 40;
  const SMOOTH_RAISE = sculptOptionsOf({
    type: 'sculpt', x: CLICK_X, y: ROW, radius: MAX_BRUSH_RADIUS, dir: 1, tool: 'smooth',
  });
  const RANDOM_SEED = 0x5eed;
  const RANDOM_SIZE = 64;
  const RANDOM_MAPS = 10;
  const RANDOM_PRESSES_PER_MAP = 20;
  const RANDOM_MARGIN = 6;
  const NOISE_LOW_BAND = 8;
  const NOISE_HIGH_BAND = 52;
  // Straddles the waterline: band -1 is 25 tall and band 0 starts at the shore.
  const SHORE_LOW_BAND = -3;
  const SHORE_HIGH_BAND = 4;
  const BUILT_GROUND_BAND = 30;
  const BUILT_SITES = 6;
  const BUILT_PRESSES_PER_SITE = 6;
  const BUILT_SITE_MARGIN = 8;
  const BUILT_RADIUS = 4;

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
  const noiseMapOver = (rng: SeededRng, lowBand: number, highBand: number): Heightmap => {
    const map = createHeightmap(RANDOM_SIZE);
    const bands = highBand - lowBand;
    for (let i = 0; i < map.cells.length; i++) {
      map.cells[i] = bandLevelHeight(lowBand + Math.floor(rng.next() * bands));
    }
    return map;
  };
  const noiseMap = (rng: SeededRng): Heightmap => noiseMapOver(rng, NOISE_LOW_BAND, NOISE_HIGH_BAND);
  const shoreMap = (rng: SeededRng): Heightmap => noiseMapOver(rng, SHORE_LOW_BAND, SHORE_HIGH_BAND);

  const builtMap = (rng: SeededRng): Heightmap => {
    const map = createHeightmap(RANDOM_SIZE);
    map.cells.fill(bandLevelHeight(BUILT_GROUND_BAND));
    const span = RANDOM_SIZE - 2 * BUILT_SITE_MARGIN;
    for (let site = 0; site < BUILT_SITES; site++) {
      const x = BUILT_SITE_MARGIN + Math.floor(rng.next() * span);
      const y = BUILT_SITE_MARGIN + Math.floor(rng.next() * span);
      const dir = rng.next() < 0.5 ? 1 : -1;
      for (let k = 0; k < BUILT_PRESSES_PER_SITE; k++) {
        applySculpt(map, x, y, BUILT_RADIUS, dir * DEFAULT_SCULPT_AMOUNT, WIRE_DEFAULT_SCULPT_OPTIONS);
      }
    }
    return map;
  };

  it('moves height whatever the pit under it holds, and changes no total', () => {
    for (const digs of TRENCH_DEPTHS) {
      const map = trenchAndTower(digs);
      const before = totalOf(map);
      expect(press(map)).toBeGreaterThan(0);
      expect([digs, totalOf(map) - before]).toEqual([digs, 0]);
    }
  });

  it('every brush size and direction conserves the total, empty-handed or not', () => {
    for (const radius of [1, MAX_BRUSH_RADIUS]) {
      for (const dir of [1, -1] as const) {
        for (const profile of ['soft', 'hard'] as const) {
          const map = trenchAndTower(TRENCH_DEPTHS[1]!);
          const before = totalOf(map);
          const options = sculptOptionsOf({
            type: 'sculpt', x: CLICK_X, y: ROW, radius, dir, tool: 'smooth', profile,
          });
          applySculpt(map, CLICK_X, ROW, radius, dir * DEFAULT_SCULPT_AMOUNT, options);
          expect([radius, dir, profile, totalOf(map) - before]).toEqual([radius, dir, profile, 0]);
        }
      }
    }
  });

  it('a spanBand press on a layered column conserves SOLID VOLUME', () => {
    const ROOF_GAP_BANDS = 6;
    const map = createHeightmap(RANDOM_SIZE);
    map.cells.fill(bandLevelHeight(BUILT_GROUND_BAND));
    for (let y = 20; y < 44; y++) {
      for (let x = 20; x < 44; x++) {
        const floorHeight = bandLevelHeight(BUILT_GROUND_BAND) + ((x + y) % 5) * BAND_HEIGHT;
        setColumn(map, x, y, [
          { floorBand: BEDROCK_BAND, ceiling: floorHeight },
          {
            floorBand: drawnBandOfSample(floorHeight) + ROOF_GAP_BANDS,
            ceiling: floorHeight + (ROOF_GAP_BANDS + 2) * BAND_HEIGHT,
          },
        ]);
      }
    }
    const volumeOf = (m: Heightmap): number => {
      let volume = 0;
      for (let y = 0; y < m.size; y++) {
        for (let x = 0; x < m.size; x++) {
          for (const span of readSpans(m, x, y)) {
            volume += span.ceiling - bandFloorHeight(span.floorBand);
          }
        }
      }
      return volume;
    };
    const before = volumeOf(map);
    const spanBand = drawnBandOfSample(bandLevelHeight(BUILT_GROUND_BAND));
    for (const dir of [1, -1] as const) {
      const options = sculptOptionsOf({
        type: 'sculpt', x: 32, y: 32, radius: BUILT_RADIUS, dir, tool: 'smooth', spanBand,
      });
      applySculpt(map, 32, 32, BUILT_RADIUS, dir * DEFAULT_SCULPT_AMOUNT, options);
    }
    expect(volumeOf(map)).toBe(before);
  });

  it.each([
    ['random', noiseMap],
    ['player-built', builtMap],
    ['waterline', shoreMap],
  ])('no press on %s ground invents or destroys a unit of height', (_kind, make) => {
    const rng = createSeededRng(RANDOM_SEED);
    const span = RANDOM_SIZE - 2 * RANDOM_MARGIN;
    let pressed = 0;
    let moved = 0;
    const breaches: unknown[] = [];
    for (let m = 0; m < RANDOM_MAPS; m++) {
      const map = make(rng);
      for (let k = 0; k < RANDOM_PRESSES_PER_MAP; k++) {
        const cx = RANDOM_MARGIN + Math.floor(rng.next() * span);
        const cy = RANDOM_MARGIN + Math.floor(rng.next() * span);
        const radius = 1 + Math.floor(rng.next() * MAX_BRUSH_RADIUS);
        const dir = rng.next() < 0.5 ? 1 : -1;
        const before = totalOf(map);
        const smoothPress = sculptOptionsOf({
          type: 'sculpt', x: cx, y: cy, radius, dir, tool: 'smooth',
        });
        const diff = applySculpt(map, cx, cy, radius, dir * DEFAULT_SCULPT_AMOUNT, smoothPress);
        const flux = Math.abs(totalOf(map) - before);
        pressed++;
        if (diff.length > 0) moved++;
        if (flux !== 0) breaches.push({ m, cx, cy, radius, dir, flux });
      }
    }
    expect(pressed).toBe(RANDOM_MAPS * RANDOM_PRESSES_PER_MAP);
    expect(moved).toBeGreaterThan(0);
    expect(breaches).toEqual([]);
  });

  it('converges: repeats stop changing the ground and report an empty diff', () => {
    const map = trenchAndTower(TRENCH_DEPTHS[1]!);
    let presses = 0;
    while (presses < CONVERGENCE_LIMIT && press(map) > 0) presses++;
    expect(presses).toBe(CONVERGED_PRESSES);
    expect(press(map)).toBe(0);
  });
});
