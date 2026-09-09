import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, bandOf, cellIndex, cellX, cellY } from '@terrace/shared';
import {
  appendRegionSurface,
  waterRegionOfCells,
  type WaterRegion,
} from '../src/render/water/waterTread.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;
const FLOOR_HEIGHT = BAND_HEIGHT;
const BANK_HEIGHT = FLOOR_HEIGHT + 2 * BAND_HEIGHT;
const SURFACE_Y = 1.5;

const layout = createTerrainMirror(WORLD_SIZE).map;

function mirrorWithFloor(cells: Iterable<number>): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(BANK_HEIGHT);
  for (const cell of cells) mirror.map.cells[cell] = FLOOR_HEIGHT;
  return mirror;
}

function mirrorFlatAt(height: number): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(height);
  return mirror;
}

function rectangleCells(x0: number, y0: number, x1: number, y1: number): Set<number> {
  const cells = new Set<number>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.add(cellIndex(layout, x, y));
  }
  return cells;
}

function regionOf(cells: Set<number>): WaterRegion {
  const tiles = new Set<number>();
  const tilesPerEdge = WORLD_SIZE / CHUNK_SIZE;
  for (const cell of cells) {
    const x = cellX(WORLD_SIZE, cell);
    const y = cellY(WORLD_SIZE, cell);
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) continue;
      tiles.add(Math.floor(ny / CHUNK_SIZE) * tilesPerEdge + Math.floor(nx / CHUNK_SIZE));
    }
  }
  return waterRegionOfCells(cells, bandOf(FLOOR_HEIGHT), tiles);
}

function coverCount(
  triangles: readonly number[],
  px: number,
  pz: number,
  strict = false,
): number {
  let count = 0;
  for (let i = 0; i < triangles.length; i += 9) {
    const ax = triangles[i]!;
    const az = triangles[i + 2]!;
    const bx = triangles[i + 3]!;
    const bz = triangles[i + 5]!;
    const cx = triangles[i + 6]!;
    const cz = triangles[i + 8]!;
    const d1 = (px - bx) * (az - bz) - (ax - bx) * (pz - bz);
    const d2 = (px - cx) * (bz - cz) - (bx - cx) * (pz - cz);
    const d3 = (px - ax) * (cz - az) - (cx - ax) * (pz - az);
    const negative = d1 < 0 || d2 < 0 || d3 < 0;
    const positive = d1 > 0 || d2 > 0 || d3 > 0;
    const onEdge = d1 === 0 || d2 === 0 || d3 === 0;
    if (negative && positive) continue;
    if (strict && onEdge) continue;
    count++;
  }
  return count;
}

const worldOfCell = (cell: number): number => cell * CELL_WORLD_SIZE;

describe('water region tread', () => {
  it('covers every flooded cell', () => {
    const cells = rectangleCells(4, 4, 10, 9);
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    for (let y = 4; y <= 9; y++) {
      for (let x = 4; x <= 10; x++) {
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(y)),
          `flooded cell (${x},${y}) has no water on it`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('never runs away past the ring of cells beside the water', () => {
    const cells = rectangleCells(4, 4, 10, 9);
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    for (let y = 2; y <= 11; y++) {
      for (let x = 2; x <= 12; x++) {
        const nearWater = x >= 3 && x <= 11 && y >= 3 && y <= 10;
        if (nearWater) continue;
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(y)),
          `water reached (${x},${y}), two cells clear of the region`,
        ).toBe(0);
      }
    }
  });

  it('does not overhang the lip where the ground falls away', () => {
    const cells = rectangleCells(4, 4, 8, 8);
    const mirror = mirrorWithFloor(cells);
    for (let y = 3; y <= 9; y++) mirror.map.cells[cellIndex(layout, 9, y)] = 0;
    const triangles: number[] = [];
    appendRegionSurface(mirror, regionOf(cells), SURFACE_Y, triangles);

    const rim = worldOfCell(8);
    expect(
      coverCount(triangles, rim, worldOfCell(6)),
      'the rim cell itself must be under water',
    ).toBeGreaterThan(0);
    expect(
      coverCount(triangles, rim + 0.5 * CELL_WORLD_SIZE, worldOfCell(6), true),
      'water is drawn out over the cliff edge',
    ).toBe(0);
  });

  it('is one flat plane at the height it was given', () => {
    const cells = rectangleCells(4, 4, 10, 9);
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    expect(triangles.length).toBeGreaterThan(0);
    for (let i = 1; i < triangles.length; i += 3) expect(triangles[i]).toBe(SURFACE_Y);
  });

  it('runs under an island rather than stopping short of it', () => {
    const cells = rectangleCells(4, 4, 12, 12);
    cells.delete(cellIndex(layout, 8, 8));
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    expect(coverCount(triangles, worldOfCell(8), worldOfCell(8))).toBeGreaterThan(0);
    expect(coverCount(triangles, worldOfCell(6), worldOfCell(8))).toBeGreaterThan(0);
  });

  it('meets exactly across a marching-tile border', () => {
    const cells = rectangleCells(CHUNK_SIZE - 3, CHUNK_SIZE - 3, CHUNK_SIZE + 3, CHUNK_SIZE + 3);
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    for (let x = CHUNK_SIZE - 2; x <= CHUNK_SIZE + 2; x += 0.25) {
      for (let y = CHUNK_SIZE - 2; y <= CHUNK_SIZE + 2; y += 0.25) {
        const px = worldOfCell(x);
        const pz = worldOfCell(y);
        expect(
          coverCount(triangles, px, pz),
          `interior point (${x},${y}) is not covered — a seam`,
        ).toBeGreaterThan(0);
        expect(
          coverCount(triangles, px, pz, true),
          `interior point (${x},${y}) is covered twice — tiles overlap`,
        ).toBeLessThanOrEqual(1);
      }
    }
  });

  it('keeps a one-cell channel one cell wide across flat ground', () => {
    const courseY = CHUNK_SIZE;
    const cells = new Set<number>();
    for (let x = 2; x <= CHUNK_SIZE + 4; x++) cells.add(cellIndex(layout, x, courseY));
    const triangles: number[] = [];
    appendRegionSurface(mirrorFlatAt(FLOOR_HEIGHT), regionOf(cells), SURFACE_Y, triangles);

    for (let x = 3; x <= CHUNK_SIZE + 3; x++) {
      expect(
        coverCount(triangles, worldOfCell(x), worldOfCell(courseY)),
        `course cell (${x},${courseY}) has no water on it`,
      ).toBeGreaterThan(0);
    }
    for (const dy of [-1, 1]) {
      for (let x = 3; x <= CHUNK_SIZE + 3; x++) {
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(courseY + dy)),
          `water spread to (${x},${courseY + dy}), one cell off the course`,
        ).toBe(0);
      }
    }
  });

  it('returns the smoothed boundary loops it emitted', () => {
    const cells = rectangleCells(4, 4, 10, 9);
    const triangles: number[] = [];
    const loops = appendRegionSurface(
      mirrorWithFloor(cells),
      regionOf(cells),
      SURFACE_Y,
      triangles,
    );

    expect(loops.length).toBeGreaterThan(0);
    for (const loop of loops) expect(loop.length).toBeGreaterThanOrEqual(3);
  });
});
