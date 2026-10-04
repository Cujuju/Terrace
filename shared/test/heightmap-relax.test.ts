import { describe, expect, it } from 'vitest';
import {
  applySculpt,
  bandFloorHeight,
  bandLevelHeight,
  BAND_HEIGHT,
  BEDROCK_BAND,
  cellIndex,
  createHeightmap,
  DEFAULT_SCULPT_AMOUNT,
  drawnBandOfSample,
  forEachFootprintOffset,
  heightAt,
  LIBRARY_SCULPT_TOOL,
  MAX_BRUSH_RADIUS,
  MAX_HEIGHT,
  MAX_STEP,
  readSpans,
  RELAX_SLACK,
  sculptReachCells,
  setColumn,
  smooth,
  SMOOTH_PASS_LIMIT,
  WIRE_DEFAULT_SCULPT_OPTIONS,
  type Heightmap,
  type SculptOptions,
} from '../src/index.ts';
import {
  expectGradientLimitHolds,
} from './support/heightmapFixtures.ts';

describe('relaxation conserves height exactly (issue #108)', () => {
  function cliffMap(size: number, height: number): Heightmap {
    const map = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size / 2; x++) {
        map.cells[cellIndex(map, x, y)] = height;
      }
    }
    return map;
  }

  function cliffSeed(map: Heightmap, height: number): Set<number> {
    const seed = new Set<number>();
    for (let i = 0; i < map.cells.length; i++) {
      if (map.cells[i] === height) seed.add(i);
    }
    return seed;
  }

  function spireMap(size: number): Heightmap {
    const map = createHeightmap(size);
    map.cells[cellIndex(map, size >> 1, size >> 1)] = MAX_HEIGHT;
    return map;
  }

  function mapTotal(map: Heightmap): number {
    let total = 0;
    for (let i = 0; i < map.cells.length; i++) total += map.cells[i]!;
    return total;
  }

  const CLIFF_HEIGHTS = [100, 401, 1000];

  const CONVERGING_CLIFF_HEIGHTS = [100, 401];

  const CLIFF_TIMEOUT_MS = 30_000;

  for (const height of CLIFF_HEIGHTS) {
    it(`invents nothing relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const before = mapTotal(map);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      expect(mapTotal(map)).toBe(before);
    });
  }

  for (const height of CONVERGING_CLIFF_HEIGHTS) {
    it(`converges relaxing a ${height}-unit cliff on 128x128`, { timeout: CLIFF_TIMEOUT_MS }, () => {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      const passes = smooth(map, new Set(seed), seed);
      expect(passes).toBeLessThan(SMOOTH_PASS_LIMIT);
    });
  }

  it('invents nothing relaxing a full-height spire', () => {
    const map = spireMap(128);
    const before = mapTotal(map);
    const seed = new Set([cellIndex(map, 64, 64)]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
  });

  it('converges relaxing a full-height spire', () => {
    const map = spireMap(128);
    const seed = new Set([cellIndex(map, 64, 64)]);
    expect(smooth(map, new Set(seed), seed)).toBeLessThan(SMOOTH_PASS_LIMIT);
  });

  it('leaves every pair inside the gradient limit plus the slack', { timeout: CLIFF_TIMEOUT_MS }, () => {
    for (const height of CONVERGING_CLIFF_HEIGHTS) {
      const map = cliffMap(128, height);
      const seed = cliffSeed(map, height);
      smooth(map, new Set(seed), seed);
      expectGradientLimitHolds(map);
    }
  });

  it('runs out of pass budget on a 1000-unit cliff — the known boundary', { timeout: CLIFF_TIMEOUT_MS }, () => {
    const map = cliffMap(128, 1000);
    const seed = cliffSeed(map, 1000);
    expect(smooth(map, new Set(seed), seed)).toBe(SMOOTH_PASS_LIMIT);
  });

  it('is deterministic: identical input, identical output', { timeout: CLIFF_TIMEOUT_MS }, () => {
    const a = cliffMap(128, 401);
    const b = cliffMap(128, 401);
    const seedA = cliffSeed(a, 401);
    const seedB = cliffSeed(b, 401);
    const passesA = smooth(a, new Set(seedA), seedA);
    const passesB = smooth(b, new Set(seedB), seedB);
    expect(passesA).toBe(passesB);
    expect(Array.from(a.cells)).toEqual(Array.from(b.cells));
  });

  function genesisTerraces(size: number): Heightmap {
    const map = createHeightmap(size);
    const LATTICE_CELLS = 16;
    const BAND_SPREAD = 7;
    const LOWEST_BAND = -2;
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) {
        const gx = Math.floor(x / LATTICE_CELLS);
        const gy = Math.floor(y / LATTICE_CELLS);
        let h = (gx * 73856093) ^ (gy * 19349663);
        h = (h ^ (h >>> 13)) >>> 0;
        map.cells[cellIndex(map, x, y)] = bandLevelHeight((h % BAND_SPREAD) + LOWEST_BAND);
      }
    }
    return map;
  }

  function brushFootprint(map: Heightmap, cx: number, cy: number, radius: number): Set<number> {
    const cells = new Set<number>();
    forEachFootprintOffset(radius, (dx, dy) => {
      const x = cx + dx;
      const y = cy + dy;
      if (x < 0 || y < 0 || x >= map.size || y >= map.size) return;
      cells.add(cellIndex(map, x, y));
    });
    return cells;
  }

  function mapVolume(map: Heightmap): number {
    let volume = 0;
    for (let y = 0; y < map.size; y++) {
      for (let x = 0; x < map.size; x++) {
        for (const span of readSpans(map, x, y)) {
          volume += span.ceiling - bandFloorHeight(span.floorBand);
        }
      }
    }
    return volume;
  }

  const TERRACE_SIZE = 96;
  const TERRACE_CENTRE = 48;
  /** Hang guard for repeated player smooths on genesis terraces. */
  const CASCADE_TAIL_LIMIT = 40;

  it('the PLAYER smooth on genesis terraces rounds the corners under it, then settles', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = Int16Array.from(map.cells);
    const PLAYER_SMOOTH: SculptOptions = { ...WIRE_DEFAULT_SCULPT_OPTIONS, tool: 'smooth' };
    const press = (): number =>
      applySculpt(map, TERRACE_CENTRE, TERRACE_CENTRE, 4, -DEFAULT_SCULPT_AMOUNT, PLAYER_SMOOTH).length;

    // The brush sits on a lattice corner: four terrace blocks meet in a kink.
    expect(press()).toBeGreaterThan(0);
    let tail = 0;
    while (tail < CASCADE_TAIL_LIMIT && press() > 0) tail++;
    expect(tail).toBeLessThan(CASCADE_TAIL_LIMIT);

    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 4);
    for (let i = 0; i < map.cells.length; i++) {
      if (!footprint.has(i)) expect(map.cells[i]).toBe(before[i]);
    }
  });

  it('the player smooth writes only its disc, inside sculptReachCells', () => {
    let moved = 0;
    for (const radius of [1, 4, MAX_BRUSH_RADIUS]) {
      for (const dir of [1, -1] as const) {
        const map = genesisTerraces(TERRACE_SIZE);
        const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, radius);
        const diff = applySculpt(map, TERRACE_CENTRE, TERRACE_CENTRE, radius, dir * DEFAULT_SCULPT_AMOUNT, {
          ...WIRE_DEFAULT_SCULPT_OPTIONS,
          tool: 'smooth',
        });
        moved += diff.length;
        const escaped = diff.filter((cell) => !footprint.has(cellIndex(map, cell.x, cell.y)));
        expect([radius, dir, escaped]).toEqual([radius, dir, []]);
        // The server resyncs a faulted stroke over exactly this rectangle.
        const bound = sculptReachCells(radius, 'hard', 'smooth', 'clicked');
        for (const cell of diff) {
          expect(Math.abs(cell.x - TERRACE_CENTRE)).toBeLessThanOrEqual(bound);
          expect(Math.abs(cell.y - TERRACE_CENTRE)).toBeLessThanOrEqual(bound);
        }
      }
    }
    expect(moved).toBeGreaterThan(0);
  });

  it('settle grades only what its stroke added: terraces it did not raise keep their steps', () => {
    const rest = MAX_STEP + RELAX_SLACK;
    for (const amount of [DEFAULT_SCULPT_AMOUNT, -DEFAULT_SCULPT_AMOUNT, 4 * DEFAULT_SCULPT_AMOUNT]) {
      const map = genesisTerraces(TERRACE_SIZE);
      const before = Int16Array.from(map.cells);
      const radius = 4;
      const diff = applySculpt(map, TERRACE_CENTRE, TERRACE_CENTRE, radius, amount, {
        tool: LIBRARY_SCULPT_TOOL,
        profile: 'soft',
      });
      expect(diff.length).toBeGreaterThan(0);

      // Every pair is at rest, or no steeper than it stood before the stroke.
      let steepPairsKept = 0;
      for (let y = 0; y < TERRACE_SIZE; y++) {
        for (let x = 0; x < TERRACE_SIZE; x++) {
          const i = cellIndex(map, x, y);
          for (const j of [x + 1 < TERRACE_SIZE ? i + 1 : -1, y + 1 < TERRACE_SIZE ? i + TERRACE_SIZE : -1]) {
            if (j < 0) continue;
            const now = Math.abs(map.cells[i]! - map.cells[j]!);
            const was = Math.abs(before[i]! - before[j]!);
            expect(now).toBeLessThanOrEqual(Math.max(rest, was + RELAX_SLACK));
            if (was > rest && now === was) steepPairsKept++;
          }
        }
      }
      expect(steepPairsKept).toBeGreaterThan(0);

      // Material slumps at most its own height over MAX_STEP past the footprint.
      const reach = radius + Math.ceil(Math.abs(amount) / MAX_STEP);
      for (const cell of diff) {
        expect(Math.max(Math.abs(cell.x - TERRACE_CENTRE), Math.abs(cell.y - TERRACE_CENTRE))).toBeLessThanOrEqual(reach);
      }
    }
  });

  it('the relaxation pass conserves height exactly on the FREE path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const seed = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), seed);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the BANDED path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the relaxation pass conserves height exactly on the ANCHORED path', () => {
    const map = genesisTerraces(TERRACE_SIZE);
    const before = mapTotal(map);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const anchorBounds = new Map<number, { lo: number; hi: number }>();
    for (const i of footprint) {
      const h = map.cells[i]!;
      anchorBounds.set(i, { lo: h - BAND_HEIGHT, hi: h + BAND_HEIGHT });
    }
    const passes = smooth(map, new Set(), footprint, footprint, anchorBounds);
    expect(passes).toBeGreaterThan(0);
    expect(mapTotal(map)).toBe(before);
  });

  it('the LAYERED path conserves SOLID VOLUME and loses no roof span', () => {
    const ROOF_GAP_BANDS = 8;
    const map = genesisTerraces(TERRACE_SIZE);
    for (let y = 40; y < 56; y++) {
      for (let x = 40; x < 56; x++) {
        const floorHeight = map.cells[cellIndex(map, x, y)]!;
        setColumn(map, x, y, [
          { floorBand: BEDROCK_BAND, ceiling: floorHeight },
          {
            floorBand: drawnBandOfSample(floorHeight) + ROOF_GAP_BANDS,
            ceiling: floorHeight + (ROOF_GAP_BANDS + 1) * BAND_HEIGHT,
          },
        ]);
      }
    }
    const volumeBefore = mapVolume(map);
    const cellsBefore = mapTotal(map);
    const before = Int16Array.from(map.cells);
    const footprint = brushFootprint(map, TERRACE_CENTRE, TERRACE_CENTRE, 8);
    const passes = smooth(map, new Set(), footprint, footprint);
    expect(passes).toBeGreaterThan(0);
    expect(Array.from(map.cells)).not.toEqual(Array.from(before));
    expect(mapVolume(map)).toBe(volumeBefore);
    // A roof is floored in a band, and the layer view bounds it there, so a
    // smooth can no longer cut one away: the cells-sum moves with the volume.
    for (let y = 40; y < 56; y++) {
      for (let x = 40; x < 56; x++) {
        expect([x, y, readSpans(map, x, y).length]).toEqual([x, y, 2]);
      }
    }
    expect(mapTotal(map) - cellsBefore).toBe(0);
  });

  it('smooth clicks build nothing: melt deposits no material', () => {
    const STACKED_CLICKS = (MAX_HEIGHT * 6) / DEFAULT_SCULPT_AMOUNT;
    const map = createHeightmap(64);
    for (let k = 0; k < STACKED_CLICKS; k++) {
      applySculpt(map, 32, 32, 2, DEFAULT_SCULPT_AMOUNT, { tool: 'smooth' });
    }
    expect(heightAt(map, 32, 32)).toBe(0);
    expect(mapTotal(map)).toBe(0);
  });

  it('a span ceiling never drops below its floor band, and a held side stops the pair (the movePair guard)', () => {
    // The layer view floors a span ceiling at its band floor, where an edge-encoded ceiling may sit.
    const ROOF_BAND = 2;
    const roofed = (ceiling: number): Heightmap => {
      const map = createHeightmap(16);
      setColumn(map, 8, 8, [
        { floorBand: BEDROCK_BAND, ceiling: -100 },
        { floorBand: ROOF_BAND, ceiling },
      ]);
      return map;
    };
    const floor = bandFloorHeight(ROOF_BAND);

    // At the cap: the held side stops the exchange outright.
    const held = roofed(floor);
    const layered = cellIndex(held, 8, 8);
    const neighbour = cellIndex(held, 9, 8);
    const before = Int16Array.from(held.cells);
    smooth(held, new Set(), new Set([layered, neighbour]));
    expect(Array.from(held.cells)).toEqual(Array.from(before));

    // One unit above it: the ceiling gives exactly that unit, conserved.
    const above = roofed(floor + 1);
    const total = mapTotal(above);
    smooth(above, new Set(), new Set([layered, neighbour]));
    expect(above.cells[layered]).toBe(floor);
    expect(mapTotal(above)).toBe(total);
  });

  it('invents nothing scouring a head out of steep ground (issue #239)', () => {
    const map = createHeightmap(128);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = 512;
    const centre = cellIndex(map, 64, 64);
    map.cells[centre] = 512 - 64;
    const before = mapTotal(map);
    const seed = new Set([centre]);
    smooth(map, new Set(seed), seed);
    expect(mapTotal(map)).toBe(before);
    expect(map.cells[centre]!).toBeLessThan(512);
  });
});
