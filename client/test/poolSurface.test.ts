// Lake-surface geometry tests (issue #62): the CONTRACT of the outline a lake
// is drawn with, not the wiring that reaches it.
//
// A lake used to be a field of full-cell quads, so there was nothing to test —
// the geometry was the cell set. Now it is marched, smoothed and triangulated
// by the terrain's own pipeline (render/riverRig.ts's appendPoolSurface), and
// what has to hold is what the player sees:
//
//   1. The water covers every cell the basin flooded.
//   2. It never runs away from the lake: past the one-cell ring the field is
//      read over, no cell is covered, however much ground sits at the lake's
//      own level.
//   3. It does not OVERHANG where the ground falls away — the defect that made
//      a lake hang half a cell past its rim in mid-air over the spillway. The
//      edge there is the terrain's own cap contour, and this pins it.
//   4. It is one flat plane at the height it was asked for.
//   5. It PARTITIONS its own area: every point is covered once, never twice —
//      which is what proves the chunk-sized marching tiles meet exactly, with
//      neither a seam of missing water nor a double-drawn overlap.
//
// What is deliberately NOT asserted: that the water stops at the bank. It does
// not — where the ground rises it continues underneath, and the terrain, which
// is opaque and drawn higher, covers it. That is the point of the design: an
// edge that nothing has to line up cannot fail to line up.
//
// No WebGLRenderer and no DOM: appendPoolSurface writes a plain triangle soup.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, cellIndex, cellX, cellY } from '@terrace/shared';
import { appendPoolSurface, type Lake } from '../src/render/riverRig.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

/** Fixture world: four chunks a side, big enough to hold a lake that spans a
 *  tile border with dry ground all round it. */
const WORLD_SIZE = CHUNK_SIZE * 4;
/** The flooded floor, in height units: the bottom of band 1, so the lake has a
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

/** A world of bank-height ground with `cells` dug down to the lake floor. */
function mirrorWithFloor(cells: Iterable<number>): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(BANK_HEIGHT);
  for (const cell of cells) mirror.map.cells[cell] = FLOOR_HEIGHT;
  return mirror;
}

/** The flooded set for a filled rectangle of cells, inclusive of its corners. */
function rectangleLake(x0: number, y0: number, x1: number, y1: number): Set<number> {
  const cells = new Set<number>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.add(cellIndex(layout, x, y));
  }
  return cells;
}

function lakeOf(cells: Set<number>): Lake {
  const tiles = new Set<number>();
  const tilesPerEdge = WORLD_SIZE / CHUNK_SIZE;
  for (const cell of cells) {
    const x = cellX(WORLD_SIZE, cell);
    const y = cellY(WORLD_SIZE, cell);
    // The same four-tile rule appendPoolSurface's caller applies.
    for (const [dx, dy] of [[0, 0], [-1, 0], [0, -1], [-1, -1]] as const) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0) continue;
      tiles.add(Math.floor(ny / CHUNK_SIZE) * tilesPerEdge + Math.floor(nx / CHUNK_SIZE));
    }
  }
  return { cells, surfaceHeight: FLOOR_HEIGHT, tiles };
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

describe('lake surface', () => {
  it('covers every flooded cell', () => {
    const cells = rectangleLake(4, 4, 10, 9);
    const triangles: number[] = [];
    appendPoolSurface(mirrorWithFloor(cells), lakeOf(cells), SURFACE_Y, triangles);

    for (let y = 4; y <= 9; y++) {
      for (let x = 4; x <= 10; x++) {
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(y)),
          `flooded cell (${x},${y}) has no water on it`,
        ).toBeGreaterThan(0);
      }
    }
  });

  it('never runs away past the ring of cells beside the lake', () => {
    const cells = rectangleLake(4, 4, 10, 9);
    const triangles: number[] = [];
    appendPoolSurface(mirrorWithFloor(cells), lakeOf(cells), SURFACE_Y, triangles);

    // Two cells clear of the lake on every side: whatever the bank does, the
    // water's own field is not even read out here.
    for (let y = 2; y <= 11; y++) {
      for (let x = 2; x <= 12; x++) {
        const nearLake = x >= 3 && x <= 11 && y >= 3 && y <= 10;
        if (nearLake) continue;
        expect(
          coverCount(triangles, worldOfCell(x), worldOfCell(y)),
          `water reached (${x},${y}), two cells clear of the lake`,
        ).toBe(0);
      }
    }
  });

  it('does not overhang the lip where the ground falls away', () => {
    // A lake with a cliff on its east side: the neighbour is at sea level,
    // several bands under the water. The terrain's cap for the lake's band
    // ends a quarter of a cell inside the lake's own rim cell there
    // (crossingFraction with CONTOUR_SAMPLE_CLEARANCE), and the water may not
    // be drawn past it — it would be hanging in the air.
    const cells = rectangleLake(4, 4, 8, 8);
    const mirror = mirrorWithFloor(cells);
    for (let y = 3; y <= 9; y++) mirror.map.cells[cellIndex(layout, 9, y)] = 0;
    const triangles: number[] = [];
    appendPoolSurface(mirror, lakeOf(cells), SURFACE_Y, triangles);

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
    const cells = rectangleLake(4, 4, 10, 9);
    const triangles: number[] = [];
    appendPoolSurface(mirrorWithFloor(cells), lakeOf(cells), SURFACE_Y, triangles);

    expect(triangles.length).toBeGreaterThan(0);
    for (let i = 1; i < triangles.length; i += 3) expect(triangles[i]).toBe(SURFACE_Y);
  });

  it('runs under an island rather than stopping short of it', () => {
    // An unflooded cell inside the lake stands ABOVE the water (it is bank
    // height), so the terrain draws it over the surface. The water carries on
    // underneath: that is what leaves no seam around it to get wrong.
    const cells = rectangleLake(4, 4, 12, 12);
    cells.delete(cellIndex(layout, 8, 8));
    const triangles: number[] = [];
    appendPoolSurface(mirrorWithFloor(cells), lakeOf(cells), SURFACE_Y, triangles);

    expect(coverCount(triangles, worldOfCell(8), worldOfCell(8))).toBeGreaterThan(0);
    expect(coverCount(triangles, worldOfCell(6), worldOfCell(8))).toBeGreaterThan(0);
  });

  it('meets exactly across a marching-tile border', () => {
    // Straddles the tile boundary at CHUNK_SIZE on both axes, so the lake is
    // built out of four tiles and every seam between them is under test.
    const cells = rectangleLake(CHUNK_SIZE - 3, CHUNK_SIZE - 3, CHUNK_SIZE + 3, CHUNK_SIZE + 3);
    const triangles: number[] = [];
    appendPoolSurface(mirrorWithFloor(cells), lakeOf(cells), SURFACE_Y, triangles);

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
});
