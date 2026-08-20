import { describe, expect, it } from 'vitest';
import {
  bandOf,
  cellIndex,
  computeRiverNetwork,
  createHeightmap,
  SEA_LEVEL,
  type Heightmap,
} from '../src/index.ts';

function setHeight(map: Heightmap, x: number, y: number, h: number): void {
  map.cells[cellIndex(map, x, y)] = h;
}

/**
 * A clean square pyramid: height decreases by exactly BAND_HEIGHT (64) per
 * cell of Chebyshev distance from the centre, reaching SEA_LEVEL exactly at
 * distance 8. Every same-ring cell ties (a genuine feature of a radial
 * pyramid), so the fixed N,E,S,W scan order always sends the descent due
 * north from the centre — a single, easily-verified straight path that also
 * crosses a full terrace band on every step, which is what makes this map
 * double as the waterfall fixture below.
 */
function pyramid(size: number): Heightmap {
  const map = createHeightmap(size);
  const centre = (size - 1) / 2;
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const distance = Math.max(Math.abs(x - centre), Math.abs(y - centre));
      setHeight(map, x, y, 512 - distance * 64);
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
    // Centre (8,8) straight north to (8,0): 9 points, none pooled.
    expect(river.points).toHaveLength(9);
    expect(river.points.every((p) => !p.pooled)).toBe(true);
    expect(river.points[0]).toMatchObject({ x: 8, y: 8 });
    expect(river.points[river.points.length - 1]).toMatchObject({ x: 8, y: 0 });
    const lastHeight = map.cells[cellIndex(map, 8, 0)]!;
    expect(lastHeight).toBeLessThanOrEqual(SEA_LEVEL);
  });
});

describe('computeRiverNetwork — waterfalls at band edges', () => {
  it('fires only where a step crosses a terrace band, with the right drop', () => {
    // Everything defaults to a 900 "wall" so only the intended row can ever be
    // chosen by steepest descent, whatever the scan order does elsewhere.
    const size = 5;
    const map = createHeightmap(size);
    for (let i = 0; i < map.cells.length; i++) map.cells[i] = 900;
    setHeight(map, 0, 0, 250); // band 3 — the spring
    setHeight(map, 0, 1, 220); // qualifies (0,0) as a local max without ever
    // being the steepest neighbor (220 > the 200 to its east)
    setHeight(map, 1, 0, 200); // band 3 — same band as (0,0): no waterfall
    setHeight(map, 2, 0, 150); // band 2 — one band down from (1,0)
    setHeight(map, 3, 0, 100); // band 1 — one band down from (2,0)
    setHeight(map, 4, 0, -10); // band -1 — two bands down from (3,0), and the sea

    const network = computeRiverNetwork(map);
    expect(network.rivers).toHaveLength(1);
    const river = network.rivers[0]!;
    expect(river.reachedSea).toBe(true);

    expect(bandOf(200) === bandOf(250)).toBe(true); // sanity on the fixture
    expect(river.waterfalls).toEqual([
      { x: 2, y: 0, dropBands: 1 },
      { x: 3, y: 0, dropBands: 1 },
      { x: 4, y: 0, dropBands: 2 },
    ]);
  });
});

describe('computeRiverNetwork — closed basins pool instead of looping forever', () => {
  it('terminates, unrouted to the sea, with pooled points, for a bowl with no escape', () => {
    // A 3×3 active window (the rest of a bigger map is inactive and so never
    // examined) shaped as a single bowl draining to its own corner: every
    // active cell is reachable only by climbing away from (2,2), so the fill
    // must eventually absorb the whole window and find no lower escape.
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

    // The defining behaviour under test: this MUST resolve (no hang/infinite
    // loop — the surrounding `it` completing at all is part of the assertion)
    // and MUST NOT reach the sea or be cut off by the work budget — a
    // genuinely closed basin, not a truncated one.
    expect(river.reachedSea).toBe(false);
    expect(river.truncated).toBe(false);
    expect(river.points.some((p) => p.pooled)).toBe(true);
    // Every pooled point carries the SAME flat surface height (a renderer's
    // lake is one flat plane, not the lumpy floor underneath it) — 512, this
    // fixture's own maximum, since the fill absorbed the whole active window.
    for (const p of river.points.filter((p) => p.pooled)) expect(p.poolHeight).toBe(512);
  });
});

describe('computeRiverNetwork — sculpting reroutes a river', () => {
  it('changes the very next step once the original one is raised out of reach', () => {
    // A strictly monotonic (no ties) diagonal ramp, so the descent direction
    // at every cell is unambiguous.
    const size = 9;
    const before = createHeightmap(size);
    for (let y = 0; y < size; y++) {
      for (let x = 0; x < size; x++) setHeight(before, x, y, 1000 - x * 100 - y * 10);
    }
    const baseline = computeRiverNetwork(before);
    expect(baseline.rivers).toHaveLength(1);
    // East (1,0)=900 beats south (0,1)=990 under steepest descent.
    expect(baseline.rivers[0]!.points[1]).toMatchObject({ x: 1, y: 0 });

    // Raise the cell the river used to step into — literally "sculpting
    // across its course" — just enough (995, still below the spring's own
    // 1000, so (0,0) stays the one spring) that it is no longer the steepest
    // neighbor.
    const after = createHeightmap(size);
    for (let i = 0; i < before.cells.length; i++) after.cells[i] = before.cells[i]!;
    setHeight(after, 1, 0, 995);

    const rerouted = computeRiverNetwork(after);
    expect(rerouted.rivers).toHaveLength(1);
    // Only the south neighbour (0,1)=990 is left strictly below the spring.
    expect(rerouted.rivers[0]!.points[1]).toMatchObject({ x: 0, y: 1 });
    expect(rerouted.rivers[0]!.points[1]).not.toEqual(baseline.rivers[0]!.points[1]);
  });
});

describe('computeRiverNetwork — isActive scoping', () => {
  it('never seeds a spring, or crosses, an inactive cell', () => {
    const map = pyramid(17);
    // The only active cell is a map corner, sitting exactly at SEA_LEVEL (the
    // pyramid's base) — below SPRING_MIN_HEIGHT_ABOVE_SEA and with every
    // neighbor excluded, so it correctly finds no spring. The summit (and the
    // whole descent path a wider active window would reveal) is inactive
    // throughout, mirroring how the server bounds this to the unlocked mask.
    const network = computeRiverNetwork(map, { isActive: (x, y) => x < 1 && y < 1 });
    expect(network.rivers).toHaveLength(0);
  });
});
