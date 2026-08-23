// Does a river down a CONE get water on its risers at all? The unit tests
// drive the riser with hand-built loops; this drives the REAL pair — the
// region tread builder and the riser builder — over a terraced cone.
//
// HONEST LIMIT, stated rather than implied: this does NOT reproduce the
// defect it was written for. The `fork` preview fixture was measured in the
// browser emitting 1328 flat triangles and ZERO falling ones, and this test
// passed with the apron classifier that produced that measurement as well as
// with the one that replaced it. Whatever geometry defeated the apron there,
// a cone built this way does not have it — which is why the riser's real
// guarantee is contract-tested in waterRiser.test.ts and measured in the
// browser, and why this file guards only the coarse regression: a change that
// stops falls being emitted on ordinary sloping ground.
//
// RETARGETED 2026-08-23 from water/waterApron.ts to water/waterRiser.ts.
import { describe, expect, it } from 'vitest';
import { BAND_HEIGHT, bandOf, cellIndex } from '@terrace/shared';
import { appendRegionSurface, type WaterRegion } from '../src/render/water/waterTread.ts';
import { appendRiserSurfaces, waterPlateOf } from '../src/render/water/waterRiser.ts';
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
    // Treads for every band first, then the falls — a fall is classified
    // against a lower PLATE, so all the plates have to exist. Highest first.
    const bands = [...regions.keys()].sort((a, b) => b - a);
    const plates = bands.map((band) =>
      waterPlateOf(
        band,
        appendRegionSurface(mirror, regions.get(band)!, bandWorldY(band), triangles),
      ),
    );
    for (let i = 0; i < bands.length; i++) {
      appendRiserSurfaces(
        plates[i]!.loops,
        bandWorldY(bands[i]!),
        bandWorldY,
        plates.slice(i + 1),
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
