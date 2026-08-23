// Does a river down a CONE get water on its risers at all? The unit tests
// drive the apron with hand-built loops; this drives the REAL pair — the
// region tread builder and the apron — over a terraced cone.
//
// HONEST LIMIT, stated rather than implied: this does NOT reproduce the
// defect it was written for. The `fork` preview fixture was measured in the
// browser emitting 1328 flat triangles and ZERO falling ones, and this test
// passes both with the lip test that produced that and with the one that
// replaced it. Whatever geometry defeats the classifier there, a cone built
// this way does not have it. What this does guard is the coarse regression —
// a change that stops falls being emitted on ordinary sloping ground.
import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, bandOf, cellIndex } from '@terrace/shared';
import { appendRegionSurface, type WaterRegion } from '../src/render/water/waterTread.ts';
import { appendApronSurfaces } from '../src/render/water/waterApron.ts';
import { createTerrainMirror } from '../src/terrain/mirror.ts';
import { CELL_WORLD_SIZE } from '../src/config.ts';

const WORLD = 64;
const SUMMIT = BAND_HEIGHT * 20;
/** Height units the cone loses per cell of radius: five bands a cell. */
const DROP_PER_CELL = BAND_HEIGHT * 5;

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

    // A course running straight down one flank, cell by cell.
    const bandOfCell = new Map<number, number>();
    for (let step = 0; step <= 6; step++) {
      const x = cx + step;
      const cell = cellIndex(mirror.map, x, cx);
      bandOfCell.set(cell, bandOf(mirror.map.cells[cell]!));
    }

    const regions = new Map<number, WaterRegion>();
    for (const [cell, band] of bandOfCell) {
      let region = regions.get(band);
      if (region === undefined) {
        region = { cells: new Set(), surfaceBand: band, tiles: new Set() };
        regions.set(band, region);
      }
      region.cells.add(cell);
      for (const tile of [0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15]) region.tiles.add(tile);
    }
    expect(regions.size).toBeGreaterThan(1); // the course really does step down

    const bandWorldY = (band: number): number => band * 0.25;
    const triangles: number[] = [];
    for (const region of regions.values()) {
      const loops = appendRegionSurface(mirror, region, bandWorldY(region.surfaceBand), triangles);
      appendApronSurfaces(
        loops,
        bandWorldY(region.surfaceBand),
        bandWorldY,
        (px, pz) => {
          const ax = Math.round(px);
          const az = Math.round(pz);
          let best: number | null = null;
          for (let dz = -1; dz <= 1; dz++) {
            for (let dx = -1; dx <= 1; dx++) {
              if (ax + dx < 0 || az + dz < 0 || ax + dx >= WORLD || az + dz >= WORLD) continue;
              const band = bandOfCell.get(cellIndex(mirror.map, ax + dx, az + dz));
              if (band === undefined || band >= region.surfaceBand) continue;
              if (best === null || band > best) best = band;
            }
          }
          return best;
        },
        (gx, gz) => {
          const x = Math.min(WORLD - 1, Math.max(0, Math.round(gx)));
          const z = Math.min(WORLD - 1, Math.max(0, Math.round(gz)));
          return bandOf(mirror.map.cells[cellIndex(mirror.map, x, z)]!) * 0.25;
        },
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
    void CELL_WORLD_SIZE;
    expect(flat).toBeGreaterThan(0);
    expect(falling, 'no water on any riser — the river is a row of puddles').toBeGreaterThan(0);
  });
});
