import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, bandOf, cellIndex } from '@terrace/shared';
import {
  appendRegionSurface,
  waterRegionOfCells,
  type WaterRegion,
} from '../src/render/water/waterTread.ts';
import { appendCurtains } from '../src/render/water/waterCurtain.ts';
import { createDrawnGround, type DrawnGround } from '../src/terrain/drawnGround.ts';
import {
  createDrawnGroundStore,
  publishPlannedWorld,
} from '../src/terrain/drawnGroundStore.ts';
import { createTerrainMirror, type TerrainMirror } from '../src/terrain/mirror.ts';
import { BAND_WORLD_HEIGHT } from '../src/config.ts';

function groundOf(mirror: TerrainMirror): DrawnGround {
  const store = createDrawnGroundStore(mirror.map.size);
  publishPlannedWorld(store, mirror);
  return createDrawnGround(mirror, store);
}

const WORLD = 64;
const SUMMIT = BAND_HEIGHT * 20;
const DROP_PER_CELL = BAND_HEIGHT * 5;

const SEA_WORLD_Y = 0;

describe('a river down a cone', () => {
  it('draws water on the risers, not only on the treads', () => {
    const mirror = createTerrainMirror(WORLD);
    const cx = WORLD / 2;
    for (let y = 0; y < WORLD; y++) {
      for (let x = 0; x < WORLD; x++) {
        const r = Math.max(Math.abs(x - cx), Math.abs(y - cx));
        mirror.map.cells[cellIndex(mirror.map, x, y)] = Math.max(0, SUMMIT - r * DROP_PER_CELL);
      }
    }

    const bandOfCell = new Map<number, number>();
    for (let step = 0; step <= 6; step++) {
      const x = cx + step;
      const cell = cellIndex(mirror.map, x, cx);
      bandOfCell.set(cell, bandOf(mirror.map.cells[cell]!));
    }

    const cellsByBand = new Map<number, Set<number>>();
    for (const [cell, band] of bandOfCell) {
      let cells = cellsByBand.get(band);
      if (cells === undefined) {
        cells = new Set<number>();
        cellsByBand.set(band, cells);
      }
      cells.add(cell);
    }
    const regions = new Map<number, WaterRegion>();
    for (const [band, cells] of cellsByBand) {
      const tiles = new Set<number>();
      for (const tile of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) tiles.add(tile);
      regions.set(band, waterRegionOfCells(cells, band, tiles));
    }
    expect(regions.size).toBeGreaterThan(1);

    const ground = groundOf(mirror);
    const triangles: number[] = [];
    for (const region of regions.values()) {
      const surfaceY = region.surfaceBand * BAND_WORLD_HEIGHT;
      const loops = appendRegionSurface(mirror, region, surfaceY, triangles);
      appendCurtains(
        ground,
        loops,
        region.surfaceBand,
        surfaceY,
        (band: number) => band * BAND_WORLD_HEIGHT,
        (x, y) => bandOfCell.get(cellIndex(mirror.map, x, y)) ?? null,
        SEA_WORLD_Y,
        triangles,
      );
    }

    let flat = 0;
    let falling = 0;
    for (let i = 0; i < triangles.length; i += 9) {
      const ys = [triangles[i + 1]!, triangles[i + 4]!, triangles[i + 7]!];
      if (Math.max(...ys) - Math.min(...ys) < 1e-9) flat++;
      else falling++;
    }
    expect(flat).toBeGreaterThan(0);
    expect(falling, 'no water on any riser — the river is a row of puddles').toBeGreaterThan(0);
  });
});
