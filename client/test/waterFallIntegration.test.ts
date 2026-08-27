// Does a river down a CONE get water on its risers at all? The unit tests
// drive the curtain builder with hand-built loops; this drives the REAL pair
// the rig wires together (riverRig.ts's rebuild) — the region tread builder
// and the curtain builder — over a terraced cone.
//
// RETARGETED 2026-08-24 from the retired apron onto water/waterCurtain.ts
// (work item W4, docs/plans/water-painted-on-bands.md). The apron took two
// caller-supplied probes and re-derived ground height from the cell lattice;
// the curtain takes the DrawnGround oracle and derives nothing, so this test
// now builds one from the same mirror the tread reads and hands it over — the
// wiring the rig performs, which is the thing an integration test here exists
// to guard.
//
// HONEST LIMIT, inherited from the apron-era version and still true: this does
// NOT reproduce the floating defect that motivated the rewrite. That is only
// measurable against the DRAWN mesh in a browser, which is what
// client/scripts/measureWaterFloat.mjs is for. What this guards is the coarse
// regression — a change that stops falls being emitted on ordinary sloping
// ground at all, the state the `fork` fixture was actually found in (1328 flat
// triangles, ZERO falling ones).
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

/**
 * The drawn-ground oracle for a fixture the harness never draws. The app's
 * store is filled by the mesh emitter as it draws each chunk; a test with no
 * meshes publishes the same plans itself.
 */
function groundOf(mirror: TerrainMirror): DrawnGround {
  const store = createDrawnGroundStore(mirror.map.size);
  publishPlannedWorld(store, mirror);
  return createDrawnGround(mirror, store);
}


const WORLD = 64;
const SUMMIT = BAND_HEIGHT * 20;
/** Height units the cone loses per cell of radius: five bands a cell. */
const DROP_PER_CELL = BAND_HEIGHT * 5;

/**
 * The sea surface for this fixture: sea level itself. The cone never reaches
 * it — its lowest wet cell is many bands up — so it only has to be a number
 * the curtain can compare against, not the rig's exact lifted plane.
 */
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

    // A course running straight down one flank, cell by cell.
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
    expect(regions.size).toBeGreaterThan(1); // the course really does step down

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
