import { describe, expect, it } from 'vitest';
import {
  BAND_HEIGHT,
  bandOf,
  cellIndex,
  computeRiverNetwork,
  createHeightmap,
  riverPoints,
  SEA_LEVEL,
  SPRING_MIN_HEIGHT_ABOVE_SEA,
  type Heightmap,
} from '../src/index.ts';

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  map.cells[cellIndex(map, x, y)] = h;
}

const PYRAMID_RINGS = 8;

function pyramid(size: number): Heightmap {
  const map = createHeightmap(size);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.max(Math.abs(x - centre), Math.abs(y - centre));
      setHeight(map, x, y, (PYRAMID_RINGS - distance) * BAND_HEIGHT);
    }
  }
  return map;
}

describe('computeRiverNetwork — determinism', () => {
  it('is byte-identical across two calls on the same heightmap', () => {
    const map = pyramid(17);
    const a = computeRiverNetwork(map);
    const b = computeRiverNetwork(map);
    expect(a).toEqual(b);
  });
});

describe('computeRiverNetwork — a spring on a slope reaches the sea', () => {
  it('traces the pyramid summit straight down to SEA_LEVEL', () => {
    const map = pyramid(17);
    const network = computeRiverNetwork(map);
    expect(network.rivers).toHaveLength(1);

    const river = network.rivers[0]!;
    expect(river.reachedSea).toBe(true);
    expect(river.truncated).toBe(false);
    expect(river.courses).toHaveLength(4);
    expect(riverPoints(river).every((p) => !p.pooled)).toBe(true);

    const trunk = river.courses[0]!;
    expect(trunk.points).toHaveLength(9);
    expect(trunk.points[0]).toMatchObject({ x: 8, y: 8 });
    expect(trunk.points[trunk.points.length - 1]).toMatchObject({ x: 8, y: 0 });
    const lastHeight = map.cells[cellIndex(map, 8, 0)]!;
    expect(lastHeight).toBeLessThanOrEqual(SEA_LEVEL);

    for (const course of river.courses.slice(1)) {
      expect(course.points[0]).toMatchObject({ x: 8, y: 8 });
      expect(course.points).toHaveLength(9);
    }
    expect(river.courses.map((c) => c.points[c.points.length - 1])).toMatchObject([
      { x: 8, y: 0 },
      { x: 16, y: 8 },
      { x: 8, y: 16 },
      { x: 0, y: 8 },
    ]);
  });
});

function forkedRidge(): Heightmap {
  const size = 7;
  const map = createHeightmap(size);
  const WALL = 40 * BAND_HEIGHT;
  for (let i = 0; i < map.cells.length; i++) map.cells[i] = WALL;
  const CREST = 12 * BAND_HEIGHT;
  const RUNG_DROP = 3 * BAND_HEIGHT;
  setHeight(map, 3, 0, CREST);
  setHeight(map, 3, 1, CREST - 1);
  for (let y = 0; y < 6; y++) {
    setHeight(map, 2, y, CREST - (y + 1) * RUNG_DROP);
    setHeight(map, 4, y, CREST - (y + 1) * RUNG_DROP);
  }
  return map;
}

describe('computeRiverNetwork — a course splits where two ways down tie', () => {
  it('forks into two courses, and each fork keeps its own descent', () => {
    const map = forkedRidge();
    const network = computeRiverNetwork(map);
    expect(network.rivers).toHaveLength(1);
    const river = network.rivers[0]!;

    expect(river.courses).toHaveLength(2);
    const [trunk, fork] = river.courses;
    expect(trunk!.points[0]).toMatchObject({ x: 3, y: 0 });
    expect(trunk!.points[1]).toMatchObject({ x: 4, y: 0 });
    expect(fork!.points[0]).toMatchObject({ x: 3, y: 0 });
    expect(fork!.points[1]).toMatchObject({ x: 2, y: 0 });

    expect(river.reachedSea).toBe(true);
    const visited = new Set(riverPoints(river).map((p) => `${p.x},${p.y}`));
    for (let y = 0; y <= 3; y++) {
      expect(visited.has(`2,${y}`)).toBe(true);
      expect(visited.has(`4,${y}`)).toBe(true);
    }
    expect(map.cells[cellIndex(map, 2, 3)]!).toBeLessThanOrEqual(SEA_LEVEL);
  });

  it('is byte-identical across two calls on a splitting map', () => {
    const map = forkedRidge();
    expect(computeRiverNetwork(map)).toEqual(computeRiverNetwork(map));
  });
});

describe('computeRiverNetwork — waterfalls at band edges', () => {
  it('fires only where a step crosses a terrace band, with the right drop', () => {
    const size = 5;
    const map = createHeightmap(size);
    const WALL = 20 * BAND_HEIGHT;
    const SPRING_BAND = bandOf(SEA_LEVEL + SPRING_MIN_HEIGHT_ABOVE_SEA) + 1;
    const SEA_BAND = -1;
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = WALL;
    setHeight(map, 0, 0, SPRING_BAND * BAND_HEIGHT + 3);
    setHeight(map, 0, 1, SPRING_BAND * BAND_HEIGHT + 2);
    setHeight(map, 1, 0, SPRING_BAND * BAND_HEIGHT + 1);
    setHeight(map, 2, 0, (SPRING_BAND - 1) * BAND_HEIGHT + 1);
    setHeight(map, 3, 0, (SPRING_BAND - 2) * BAND_HEIGHT + 1);
    setHeight(map, 4, 0, SEA_BAND * BAND_HEIGHT + 1);

    const network = computeRiverNetwork(map);
    expect(network.rivers).toHaveLength(1);
    const river = network.rivers[0]!;
    expect(river.reachedSea).toBe(true);

    expect(bandOf(SPRING_BAND * BAND_HEIGHT + 1)).toBe(
      bandOf(SPRING_BAND * BAND_HEIGHT + 3),
    );
    expect(river.waterfalls).toEqual([
      { x: 2, y: 0, dropBands: 1 },
      { x: 3, y: 0, dropBands: 1 },
      { x: 4, y: 0, dropBands: SPRING_BAND - 2 - SEA_BAND },
    ]);
  });
});

describe('computeRiverNetwork — closed basins pool instead of looping forever', () => {
  it('terminates, unrouted to the sea, with pooled points, for a bowl with no escape', () => {
    const map = createHeightmap(9);
    const heights: Record<string, number> = {
      '0,0': 512,
      '1,0': 256,
      '2,0': 224,
      '0,1': 256,
      '1,1': 192,
      '2,1': 160,
      '0,2': 224,
      '1,2': 160,
      '2,2': 64,
    };
    for (const [key, h] of Object.entries(heights)) {
      const [x, y] = key.split(',').map(Number);
      setHeight(map, x!, y!, h);
    }
    const isActive = (x: number, y: number): boolean => x < 3 && y < 3;

    const network = computeRiverNetwork(map, { isActive });
    expect(network.rivers).toHaveLength(1);
    const river = network.rivers[0]!;

    expect(river.reachedSea).toBe(false);
    expect(river.truncated).toBe(false);
    expect(riverPoints(river).some((p) => p.pooled)).toBe(true);
    for (const p of riverPoints(river).filter((p) => p.pooled)) expect(p.poolHeight).toBe(512);
  });
});

describe('computeRiverNetwork — sculpting reroutes a river', () => {
  it('changes the very next step once the original one is raised out of reach', () => {
    const size = 9;
    const before = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) setHeight(before, x, y, 1000 - x * 100 - y * 10);
    }
    const baseline = computeRiverNetwork(before);
    expect(baseline.rivers).toHaveLength(1);
    expect(baseline.rivers[0]!.courses[0]!.points[1]).toMatchObject({ x: 1, y: 0 });

    const after = createHeightmap(size);
    for (let i = 0; i < before.cells.length; i++) after.cells[i] = before.cells[i]!;
    setHeight(after, 1, 0, 995);

    const rerouted = computeRiverNetwork(after);
    expect(rerouted.rivers).toHaveLength(1);
    expect(rerouted.rivers[0]!.courses[0]!.points[1]).toMatchObject({ x: 0, y: 1 });
    expect(rerouted.rivers[0]!.courses[0]!.points[1]).not.toEqual(
      baseline.rivers[0]!.courses[0]!.points[1],
    );
  });
});

describe('computeRiverNetwork — isActive scoping', () => {
  it('never seeds a spring, or crosses, an inactive cell', () => {
    const map = pyramid(17);
    const network = computeRiverNetwork(map, { isActive: (x, y) => x < 1 && y < 1 });
    expect(network.rivers).toHaveLength(0);
  });
});
