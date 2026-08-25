// Waterfall-curtain contract tests (plan water-painted-on-bands, W3).
//
// The module's whole claim is that its numbers are the TERRAIN'S OWN NUMBERS:
// every curtain vertex hangs off a contour the drawn-ground pipeline already
// produced, at a level height capEmission's skirt stack already uses. So the
// tests are exact-equality contracts, not tolerances:
//
//   1. every emitted vertex's Y equals `drawnBandWorldY` of some band EXACTLY;
//   2. every emitted vertex lies on the terrain's own contour for its own
//      level (to within the mandated depth-buffer inset — see the test);
//   3. every quad is VERTICAL — its bottom row shares the top row's plan-view
//      position, so no vertex can be lost between the rows;
//   4. a cliff emits ONE sheet per segment, running from the water's own band
//      straight to the band it pours onto;
//   5. a chunk-border segment emits nothing;
//   6. nothing is emitted below `seaWorldY`.
//
// RETARGETED 2026-08-24 from the staircase contract (items 3 and 4 used to
// assert N stacked one-band quads per segment, each re-seated onto its own
// level's contour). The owner paused that design in favour of a flat vertical
// sheet; see waterCurtain.ts's header for why, including the three ways the
// re-seating could drop geometry that these tests did not catch.
//
// Fixtures are built with `createTerrainMirror` and hand-written heights, the
// way waterTread.test.ts does. No WebGLRenderer, no DOM: appendCurtains writes
// a plain triangle soup.

import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, bandOf, cellIndex, cellX, cellY } from '@terrace/shared';
import { appendRegionSurface, type WaterRegion } from '../src/render/water/waterTread.ts';
import {
  CURTAIN_OUTWARD_WORLD_UNITS,
  appendCurtains,
} from '../src/render/water/waterCurtain.ts';
import { CELL_WORLD_SIZE, BAND_WORLD_HEIGHT } from '../src/config.ts';
import { SEABED_CAP_SINK } from '../src/terrain/capEmission.ts';
import { createDrawnGround, drawnBandWorldY } from '../src/terrain/drawnGround.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

const WORLD_SIZE = CHUNK_SIZE * 4;

/** The plateau every fixture stands on: band 3, with two dry bands below it. */
const PLATEAU_HEIGHT = 3 * BAND_HEIGHT;
/** The cliff floor: everything dug away pours toward here. */
const PIT_HEIGHT = 0;
/**
 * The tread is asked at an arbitrary world Y; the curtains must not care.
 * Drawn at the band's own cap plus a lift, as the rig does.
 */
const SURFACE_Y = drawnBandWorldY(3, false) + 1 / 64;
/** Below any level the descent can reach: lets a fall run to band 0's seabed. */
const BELOW_EVERYTHING = -1;
/** The sea plane as the caller would pass it: dry-land band 0 sits exactly here. */
const SEA_WORLD_Y = 0;

/** A world of plateau-height ground with `dig` cells dropped to the pit. */
function mirrorWithPlateau(dig: Iterable<number>): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(PLATEAU_HEIGHT);
  for (const cell of dig) mirror.map.cells[cell] = PIT_HEIGHT;
  return mirror;
}

const layout = createTerrainMirror(WORLD_SIZE).map;

/** Inclusive rectangle of cell indices. */
function rectangleCells(x0: number, y0: number, x1: number, y1: number): Set<number> {
  const cells = new Set<number>();
  for (let y = y0; y <= y1; y++) {
    for (let x = x0; x <= x1; x++) cells.add(cellIndex(layout, x, y));
  }
  return cells;
}

/** Same four-tile rule waterTread.test.ts encodes for its regions. */
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
  return { cells, surfaceBand: bandOf(PLATEAU_HEIGHT), tiles };
}

/**
 * The east-cliff fixture: a wet plateau region whose east side falls away.
 * The dig runs past the region on every row it touches, so every probe just
 * outside the east rim reads the pit's band and the east segments pour.
 */
function cliffFixture(): { loops: ReturnType<typeof appendRegionSurface>; ground: ReturnType<typeof createDrawnGround>; mirror: TerrainMirror } {
  const wet = rectangleCells(20, 28, 26, 34);
  const dig = rectangleCells(27, 26, 31, 36);
  const mirror = mirrorWithPlateau(dig);
  const triangles: number[] = [];
  const loops = appendRegionSurface(mirror, regionOf(wet), SURFACE_Y, triangles);
  return { loops, ground: createDrawnGround(mirror), mirror };
}

/** Run the curtain builder over a fixture, returning the raw triangle soup. */
function curtainsFor(
  fixture: ReturnType<typeof cliffFixture>,
  seaWorldY: number,
): number[] {
  const out: number[] = [];
  appendCurtains(
    fixture.ground,
    fixture.loops,
    bandOf(PLATEAU_HEIGHT),
    seaWorldY,
    out,
  );
  return out;
}

/** Every distinct Y in a triangle soup. */
function levelsOf(triangles: readonly number[]): Set<number> {
  const ys = new Set<number>();
  for (let i = 1; i < triangles.length; i += 3) ys.add(triangles[i]!);
  return ys;
}

/** Triangles whose three vertices sit at exactly these two heights. */
function quadsBetween(
  triangles: readonly number[],
  topY: number,
  bottomY: number,
): number {
  let count = 0;
  for (let i = 0; i < triangles.length; i += 9) {
    const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
    if (ys.every((y) => y === topY || y === bottomY)) count++;
  }
  return count;
}

describe('waterfall curtains', () => {
  it('emits something on the east-cliff fixture (the tests are not vacuous)', () => {
    const triangles = curtainsFor(cliffFixture(), BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);
  });

  it('places every vertex Y exactly on some band drawn cap', () => {
    const triangles = curtainsFor(cliffFixture(), BELOW_EVERYTHING);
    // Band 0 has two levels; the curtain descends onto the SUNK one (the
    // seabed face the terrain actually drew), so both are legitimate answers.
    const allowed = new Set<number>([
      drawnBandWorldY(0, true),
      drawnBandWorldY(0, false),
      drawnBandWorldY(1, true),
      drawnBandWorldY(2, true),
      drawnBandWorldY(3, true),
    ]);
    for (let i = 1; i < triangles.length; i += 3) {
      expect(
        allowed.has(triangles[i]!),
        `vertex Y ${triangles[i]} is no band's drawn cap`,
      ).toBe(true);
    }
  });

  it('emits one sheet per segment, always starting at the water own band', () => {
    const surfaceBand = bandOf(PLATEAU_HEIGHT); // 3
    const triangles = curtainsFor(cliffFixture(), BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);
    const topY = drawnBandWorldY(surfaceBand, true);

    // EVERY quad hangs from the water's own band — never from an intermediate
    // level. That is what "one sheet, top to bottom" means and what separates
    // this from the paused staircase, which emitted a slab per band and so had
    // quads whose tops sat at bands 2 and 1 as well.
    for (let i = 0; i < triangles.length; i += 9) {
      const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
      expect(Math.max(...ys), `a quad at ${i} hangs from below the water band`).toBe(topY);
      expect(Math.min(...ys)).toBeLessThan(topY);
    }

    // A SHEER 3-BAND CLIFF IS DRAWN TO THE BOTTOM, not stopped one band down.
    // This is the assertion that catches the defect the foot search was added
    // for: a single probe read the terrain's own band-2 skirt level inside the
    // half cell of contour interpolation and every sheet stopped there, which
    // on a 20-band cliff would leave water on the first band only.
    expect(
      quadsBetween(triangles, topY, drawnBandWorldY(0, true)),
      'no sheet reached the pit floor — the falls stop short',
    ).toBeGreaterThan(0);

    // Corners are allowed to land higher: a segment whose outward normal runs
    // diagonally really does have nearer, higher ground under it. What is not
    // allowed is a landing height that is no band's drawn cap, which the Y
    // test above covers.
    const fullDrop = topY - drawnBandWorldY(0, true);
    expect(fullDrop).toBe(surfaceBand * BAND_WORLD_HEIGHT + SEABED_CAP_SINK);
  });

  it('loses no vertex between the rows: every quad is exactly vertical', () => {
    // THE CONTRACT THIS FILE EXISTS FOR SINCE 2026-08-24. The paused staircase
    // paired two independently-marched arcs and dropped whatever the shorter
    // one could not match; a vertical sheet cannot, because the bottom row IS
    // the top row at a lower Y. Asserted on the coordinates, exactly: every
    // triangle must stand on exactly two plan-view columns and span exactly
    // two heights — three corners of a rectangle standing on end.
    const triangles = curtainsFor(cliffFixture(), BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);

    for (let i = 0; i < triangles.length; i += 9) {
      const columns = new Set<string>();
      const heights = new Set<number>();
      for (let v = 0; v < 3; v++) {
        columns.add(`${triangles[i + v * 3]!},${triangles[i + v * 3 + 2]!}`);
        heights.add(triangles[i + v * 3 + 1]!);
      }
      expect(columns.size, `triangle at ${i} spans ${columns.size} plan-view columns`).toBe(2);
      expect(heights.size, `triangle at ${i} is flat, not vertical`).toBe(2);
    }
  });

  it('seats every vertex on the tread own contour, top row and bottom row alike', () => {
    // The sheet is vertical, so BOTH rows stand over the same plan-view curve:
    // the loop `appendRegionSurface` marched and smoothed. There is no
    // per-level re-seating any more, and therefore no second curve a vertex
    // could be mistraced onto — the claim is simply that every vertex, at
    // either height, lies within the mandated depth-buffer inset of a point
    // the tread's own march produced.
    const fixture = cliffFixture();
    const triangles = curtainsFor(fixture, BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);

    const treadPoints: { x: number; z: number }[] = [];
    for (const loop of fixture.loops) {
      for (const p of loop) {
        treadPoints.push({ x: p.x * CELL_WORLD_SIZE, z: p.z * CELL_WORLD_SIZE });
      }
    }

    // Exact coordinate equality holds for the LEVEL, never for the offset, so
    // what is asserted without a tolerance is the BOUND: one inset, no more.
    const reach = CURTAIN_OUTWARD_WORLD_UNITS * 1.000001;
    for (let i = 0; i < triangles.length; i += 3) {
      const vx = triangles[i]!;
      const vz = triangles[i + 2]!;
      let ok = false;
      for (const p of treadPoints) {
        const dx = vx - p.x;
        const dz = vz - p.z;
        if (dx * dx + dz * dz <= reach * reach) {
          ok = true;
          break;
        }
      }
      expect(ok, `vertex (${vx},${vz}) is off every point of the tread's own contour`).toBe(true);
    }
  });

  it('emits nothing for chunk-border closing segments', () => {
    // A region whose WEST edge lies ON the x = CHUNK_SIZE tile border: its
    // boundary arrives as half-loops closed by straight segments running ALONG
    // that border — interior water, not outline — and every such closing
    // segment's endpoints are border-flagged. The east cliff still pours, so
    // whatever IS emitted came from non-border segments only, provable by the
    // absence of any vertex ON a border line (border points are pinned to
    // exact integer cell coordinates; smoothed interior points are not).
    const wet = rectangleCells(CHUNK_SIZE - 2, CHUNK_SIZE + 4, CHUNK_SIZE + 4, CHUNK_SIZE + 10);
    const dig = rectangleCells(CHUNK_SIZE + 5, CHUNK_SIZE + 2, CHUNK_SIZE + 9, CHUNK_SIZE + 12);
    const mirror = mirrorWithPlateau(dig);
    const triangles: number[] = [];
    const loops = appendRegionSurface(mirror, regionOf(wet), SURFACE_Y, triangles);
    const out: number[] = [];
    appendCurtains(createDrawnGround(mirror), loops, bandOf(PLATEAU_HEIGHT), BELOW_EVERYTHING, out);

    expect(out.length).toBeGreaterThan(0);
    const borderLine = CHUNK_SIZE * CELL_WORLD_SIZE;
    for (let i = 0; i < out.length; i += 3) {
      const x = out[i]!;
      const z = out[i + 2]!;
      expect(x === borderLine || z === borderLine, `vertex (${x},${z}) stands on a tile border`).toBe(false);
    }
  });

  it('stops at the sea instead of pouring below it', () => {
    // Same cliff, but the caller says the sea plane is at band 0's dry-shore
    // level. The next level down would be the sunk seabed cap — below the sea
    // — so that final drop must be absent entirely: no clamping, no vertex.
    const triangles = curtainsFor(cliffFixture(), SEA_WORLD_Y);
    expect(triangles.length).toBeGreaterThan(0);
    const sunkCapY = drawnBandWorldY(0, true);
    expect(sunkCapY).toBeLessThan(SEA_WORLD_Y);
    for (const y of levelsOf(triangles)) {
      expect(y, 'a curtain vertex reached below the sea').toBeGreaterThanOrEqual(SEA_WORLD_Y);
    }
    expect(levelsOf(triangles).has(sunkCapY)).toBe(false);
  });
});
