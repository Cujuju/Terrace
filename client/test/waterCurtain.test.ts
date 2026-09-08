import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, CHUNK_SIZE, bandOf, cellIndex, cellX, cellY } from '@terrace/shared';
import {
  appendRegionSurface,
  waterRegionOfCells,
  type WaterRegion,
} from '../src/render/water/waterTread.ts';
import { appendCurtains } from '../src/render/water/waterCurtain.ts';
import { CELL_WORLD_SIZE, BAND_WORLD_HEIGHT } from '../src/config.ts';
import { createDrawnGround, type DrawnGround } from '../src/terrain/drawnGround.ts';
import {
  createDrawnGroundStore,
  publishPlannedWorld,
} from '../src/terrain/drawnGroundStore.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';

function groundOf(mirror: TerrainMirror): DrawnGround {
  const store = createDrawnGroundStore(mirror.map.size);
  publishPlannedWorld(store, mirror);
  return createDrawnGround(mirror, store);
}

const WORLD_SIZE = CHUNK_SIZE * 4;

const PLATEAU_HEIGHT = 3 * BAND_HEIGHT;
const PIT_HEIGHT = 0;
const bandCapY = (band: number): number => band * BAND_WORLD_HEIGHT;

const RIVER_LIFT_WORLD_UNITS = 1 / 64;

const SURFACE_Y = bandCapY(3) + RIVER_LIFT_WORLD_UNITS;
const BELOW_EVERYTHING = -1;
const SEA_WORLD_Y = bandCapY(1);

const bandSurfaceY = (band: number): number => bandCapY(band) + RIVER_LIFT_WORLD_UNITS;

const NO_WATER_BELOW = (): number | null => null;

function mirrorWithPlateau(dig: Iterable<number>): TerrainMirror {
  const mirror = createTerrainMirror(WORLD_SIZE);
  mirror.map.cells.fill(PLATEAU_HEIGHT);
  for (const cell of dig) mirror.map.cells[cell] = PIT_HEIGHT;
  return mirror;
}

const layout = createTerrainMirror(WORLD_SIZE).map;

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
  return waterRegionOfCells(cells, bandOf(PLATEAU_HEIGHT), tiles);
}

function cliffFixture(): { loops: ReturnType<typeof appendRegionSurface>; ground: ReturnType<typeof createDrawnGround>; mirror: TerrainMirror } {
  const wet = rectangleCells(20, 28, 26, 34);
  const dig = rectangleCells(27, 26, 31, 36);
  const mirror = mirrorWithPlateau(dig);
  const triangles: number[] = [];
  const loops = appendRegionSurface(mirror, regionOf(wet), SURFACE_Y, triangles);
  return { loops, ground: groundOf(mirror), mirror };
}

function curtainsFor(
  fixture: ReturnType<typeof cliffFixture>,
  seaWorldY: number,
): number[] {
  const out: number[] = [];
  appendCurtains(
    fixture.ground,
    fixture.loops,
    bandOf(PLATEAU_HEIGHT),
    SURFACE_Y,
    bandSurfaceY,
    NO_WATER_BELOW,
    seaWorldY,
    out,
  );
  return out;
}

function levelsOf(triangles: readonly number[]): Set<number> {
  const ys = new Set<number>();
  for (let i = 1; i < triangles.length; i += 3) ys.add(triangles[i]!);
  return ys;
}

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
    const allowed = new Set<number>([0, 1, 2, 3].map(bandSurfaceY));
    for (let i = 1; i < triangles.length; i += 3) {
      expect(
        allowed.has(triangles[i]!),
        `vertex Y ${triangles[i]} is no band's drawn cap`,
      ).toBe(true);
    }
  });

  it('emits one sheet per segment, always starting at the water own band', () => {
    const surfaceBand = bandOf(PLATEAU_HEIGHT);
    const triangles = curtainsFor(cliffFixture(), BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);
    const topY = SURFACE_Y;

    for (let i = 0; i < triangles.length; i += 9) {
      const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
      expect(Math.max(...ys), `a quad at ${i} hangs from below the water band`).toBe(topY);
      expect(Math.min(...ys)).toBeLessThan(topY);
    }

    expect(
      quadsBetween(triangles, topY, bandSurfaceY(0)),
      'no sheet reached the pit floor — the falls stop short',
    ).toBeGreaterThan(0);

    const fullDrop = topY - bandSurfaceY(0);
    expect(fullDrop).toBe(surfaceBand * BAND_WORLD_HEIGHT);
  });

  it('loses no vertex between the rows: every quad is exactly vertical', () => {
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

  it('welds to the pool above: every top vertex IS a tread boundary vertex', () => {
    const fixture = cliffFixture();
    const triangles = curtainsFor(fixture, BELOW_EVERYTHING);
    expect(triangles.length).toBeGreaterThan(0);

    const treadVertices = new Set<string>();
    for (const loop of fixture.loops) {
      for (const p of loop) {
        treadVertices.add(`${p.x * CELL_WORLD_SIZE},${p.z * CELL_WORLD_SIZE}`);
      }
    }

    const topY = SURFACE_Y;
    let topVertices = 0;
    for (let i = 0; i < triangles.length; i += 3) {
      const key = `${triangles[i]!},${triangles[i + 2]!}`;
      expect(
        treadVertices.has(key),
        `vertex (${key}) is not a vertex of the tread's own boundary`,
      ).toBe(true);
      if (triangles[i + 1]! === topY) topVertices++;
    }
    expect(topVertices, 'no vertex sits at the pool surface').toBeGreaterThan(0);
  });

  it('emits nothing for chunk-border closing segments', () => {
    const wet = rectangleCells(CHUNK_SIZE - 2, CHUNK_SIZE + 4, CHUNK_SIZE + 4, CHUNK_SIZE + 10);
    const dig = rectangleCells(CHUNK_SIZE + 5, CHUNK_SIZE + 2, CHUNK_SIZE + 9, CHUNK_SIZE + 12);
    const mirror = mirrorWithPlateau(dig);
    const triangles: number[] = [];
    const loops = appendRegionSurface(mirror, regionOf(wet), SURFACE_Y, triangles);
    const out: number[] = [];
    appendCurtains(
      groundOf(mirror),
      loops,
      bandOf(PLATEAU_HEIGHT),
      SURFACE_Y,
      bandSurfaceY,
      NO_WATER_BELOW,
      BELOW_EVERYTHING,
      out,
    );

    expect(out.length).toBeGreaterThan(0);
    const borderLine = CHUNK_SIZE * CELL_WORLD_SIZE;
    for (let i = 0; i < out.length; i += 3) {
      const x = out[i]!;
      const z = out[i + 2]!;
      expect(x === borderLine || z === borderLine, `vertex (${x},${z}) stands on a tile border`).toBe(false);
    }
  });

  it('stops at the sea instead of pouring below it', () => {
    const triangles = curtainsFor(cliffFixture(), SEA_WORLD_Y);
    expect(triangles.length).toBeGreaterThan(0);
    expect(bandSurfaceY(0)).toBeLessThan(SEA_WORLD_Y);
    for (const y of levelsOf(triangles)) {
      expect(y, 'a curtain vertex reached below the sea').toBeGreaterThanOrEqual(SEA_WORLD_Y);
    }
    expect(levelsOf(triangles).has(bandSurfaceY(0))).toBe(false);
  });
});
