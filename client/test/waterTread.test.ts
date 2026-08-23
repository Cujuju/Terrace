// Water-tread geometry tests: the CONTRACT of the horizontal surface a water
// region is drawn with, ported from poolSurface.test.ts (which guards the old
// lake function until the swap) plus two contracts new to the band-region
// builder:
//
//   6. A one-cell-wide channel across FLAT ground stays one cell wide — the
//      dry same-tread field arm keeps the water from spreading onto land the
//      course never ran through.
//   7. The builder returns the smoothed boundary loops it emitted, non-empty
//      and each with at least three points — the riser builder's input.
//
// The six ported contracts are the lake's, and a lake has no same-tread dry
// ring cells by construction of a basin, so all six must still pass here.
//
// No WebGLRenderer and no DOM: appendRegionSurface writes a plain triangle
// soup and returns plain point loops.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, bandOf, cellIndex, cellX, cellY } from '@terrace/shared';
import { appendRegionSurface, type WaterRegion } from '../src/render/water/waterTread.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

/** Fixture world: four chunks a side, big enough to hold a region that spans a
 *  tile border with dry ground all round it. */
const WORLD_SIZE = CHUNK_SIZE * 4;
/** The flooded floor, in height units: the bottom of band 1, so the water has a
 *  band of dry ground below it as well as above and neither is a world edge. */
const FLOOR_HEIGHT = BAND_HEIGHT;
/** The bank: two bands over the floor, unambiguously out of the water. */
const BANK_HEIGHT = FLOOR_HEIGHT + 2 * BAND_HEIGHT;
/** World Y the surface is asked for — an arbitrary value the test can check
 *  against exactly, since the builder must not derive its own. */
const SURFACE_Y = 1.5;

/**
 * A heightmap used only for its cell-index LAYOUT, so the test addresses cells
 * through `cellIndex` exactly as the code under test does rather than
 * restating the row-major formula.
 */
const layout = createTerrainMirror(WORLD_SIZE).map;

/** A world of bank-height ground with `cells` dug down to the water floor. */
function mirrorWithFloor(cells: Iterable<number>): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(BANK_HEIGHT);
  for (const cell of cells) mirror.map.cells[cell] = FLOOR_HEIGHT;
  return mirror;
}

/** A world where EVERY cell sits at one height — flat-tread fixtures. */
function mirrorFlatAt(height: number): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(height);
  return mirror;
}

/** The wet set for a filled rectangle of cells, inclusive of its corners. */
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
    // The same four-tile rule TILE_LATTICE_OFFSETS encodes.
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) continue;
      tiles.add(Math.floor(ny / CHUNK_SIZE) * tilesPerEdge + Math.floor(nx / CHUNK_SIZE));
    }
  }
  return { cells, surfaceBand: bandOf(FLOOR_HEIGHT), tiles };
}

/**
 * How many of `triangles` contain the world XZ point.
 *
 * `strict` decides what a point ON a triangle's edge means. Counting edges in
 * answers "is this point covered at all" — the gap question. Counting only
 * strict interiors answers "is it covered twice" — the overlap question —
 * without the false positives every shared edge of a triangulation would
 * otherwise produce.
 */
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

    // Two cells clear of the water on every side: whatever the bank does, the
    // water's own field is not even read out here.
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
    // A region with a cliff on its east side: the neighbour is at sea level,
    // several bands under the water. The terrain's cap for the band ends a
    // quarter of a cell inside the region's own rim cell there, and the water
    // may not be drawn past it — it would be hanging in the air.
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
      coverCount(triangles, rim + 0.5 * CELL_WORLD_SIZE, worldOfCell(6)),
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
    // An unwetted cell inside the region stands ABOVE the water (it is bank
    // height), so the terrain draws it over the surface. The water carries on
    // underneath: that is what leaves no seam around it to get wrong.
    const cells = rectangleCells(4, 4, 12, 12);
    cells.delete(cellIndex(layout, 8, 8));
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    expect(coverCount(triangles, worldOfCell(8), worldOfCell(8))).toBeGreaterThan(0);
    expect(coverCount(triangles, worldOfCell(6), worldOfCell(8))).toBeGreaterThan(0);
  });

  it('meets exactly across a marching-tile border', () => {
    // Straddles the tile boundary at CHUNK_SIZE on both axes, so the region is
    // built out of four tiles and every seam between them is under test.
    const cells = rectangleCells(CHUNK_SIZE - 3, CHUNK_SIZE - 3, CHUNK_SIZE + 3, CHUNK_SIZE + 3);
    const triangles: number[] = [];
    appendRegionSurface(mirrorWithFloor(cells), regionOf(cells), SURFACE_Y, triangles);

    // Sampled ACROSS the seam, at quarter-cell steps, including points exactly
    // on the tile border line itself — where a gap or an overlap would be.
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
    // A straight one-cell-wide course across a FLAT tread: every dry neighbour
    // sits at the water's own height, so every one of them hits the new
    // dry-same-tread field arm. Without that arm each would read >= the
    // threshold and the water would spread a full extra cell to either side.
    const courseY = CHUNK_SIZE;
    const cells = new Set<number>();
    for (let x = 2; x <= CHUNK_SIZE + 4; x++) cells.add(cellIndex(layout, x, courseY));
    const triangles: number[] = [];
    appendRegionSurface(mirrorFlatAt(FLOOR_HEIGHT), regionOf(cells), SURFACE_Y, triangles);

    // On the course line: covered.
    for (let x = 3; x <= CHUNK_SIZE + 3; x++) {
      expect(
        coverCount(triangles, worldOfCell(x), worldOfCell(courseY)),
        `course cell (${x},${courseY}) has no water on it`,
      ).toBeGreaterThan(0);
    }
    // HALF a cell to either side of the course line: NOT covered. Sampled at
    // the CELL EDGE, not at the next cell's centre (2026-08-23): centres alone
    // pass at any width under two cells, so 0.94, 1.0 and 1.5 were all
    // indistinguishable and the test asserted nothing about width. The channel
    // is one cell wide, so its rim is half a cell out; anything drawn AT the
    // rim or beyond is water on land the river never ran through.
    for (const dy of [-0.5, 0.5]) {
      for (let x = 3; x <= CHUNK_SIZE + 3; x++) {
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(courseY + dy)),
          `water reached the rim at (${x},${courseY + dy}) — the channel is over a cell wide`,
        ).toBe(0);
      }
    }
    // And a full cell out, which is the coarse version of the same promise.
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
