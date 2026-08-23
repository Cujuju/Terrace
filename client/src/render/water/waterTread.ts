// The tread builder for one band's worth of water (client/src/render/water/,
// unifying pools AND flowing rivers onto the terrain's own marched pipeline).
//
// This GENERALIZES render/riverRig.ts's `appendPoolSurface`: instead of a
// `Lake` whose surface is a spill HEIGHT, it takes a `WaterRegion` whose
// surface is a BAND index — the horizontal surface of any flooded region,
// including a river drawn as a narrow one-cell course. A companion module
// handles the vertical fall surfaces between bands; this one only ever draws
// flat treads.
//
// The geometry is the terrain's own pipeline, unchanged from the lake:
// loadSampleField → marchLevel → assembleLoops → smoothLoop → groupLoops /
// bridgeHole / earClip (docs/DESIGN.md 2026-08-21, issue #62 — "a lake is
// drawn with the terrain's own outline"). Only the FIELD RULE differs, and it
// is documented at length on `appendRegionSurface` below because that is
// where the whole shape decision lives.

import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  bandOf,
  cellIndex,
  chunksPerEdge,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { sampleHeight, type TerrainMirror } from '../../terrain/mirror.ts';
import {
  assembleLoops,
  loadSampleField,
  marchLevel,
  samples,
  type ContourLoop,
} from '../../terrain/contours.ts';
import { smoothLoop } from '../../terrain/contourSmoothing.ts';
import { bridgeHole, earClip, groupLoops } from '../../terrain/triangulation.ts';

/**
 * The four cells sharing an edge with a cell — the same neighbourhood the
 * trace flows through (shared/src/rivers.ts keeps its own copy as
 * FLOW_DIRECTIONS, private because ITS order is part of the determinism
 * contract; nothing here depends on the order).
 */
export const CARDINAL_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

/**
 * The cell offsets whose tiles must be marched for a given flooded cell.
 *
 * A tile's lattice covers cells [origin, origin + CHUNK_SIZE] INCLUSIVE, so a
 * cell on a tile's first row or column is also the last sample of the tile
 * before it — hence the reach back to −1. It reaches back to −2 because the
 * field is read one cell PAST the flooded set (`appendRegionSurface` samples
 * the four-neighbours of every wet cell), and a tile missed here would leave
 * a notch of unbuilt water at a tile border.
 *
 * (Copied verbatim from render/riverRig.ts, which will import this from here
 * once both sides of the water unification land.)
 */
export const TILE_LATTICE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const offsets: [number, number][] = [];
  for (let dy = -2; dy <= 1; dy++) {
    for (let dx = -2; dx <= 1; dx++) offsets.push([dx, dy]);
  }
  return offsets;
})();

/** One band's worth of water: the wet cells and the band its surface is drawn at. */
export interface WaterRegion {
  /** Cell indices (`cellIndex`) of every wet cell. */
  readonly cells: Set<number>;
  /** Band index; surface height = surfaceBand * BAND_HEIGHT. */
  readonly surfaceBand: number;
  /**
   * Origins of the marching tiles this region reaches, as `tileKey` values —
   * same rule as `Lake.tiles`: every tile whose lattice holds a wet cell,
   * collected via TILE_LATTICE_OFFSETS so the cost is proportional to the
   * water rather than to its bounding box.
   */
  readonly tiles: Set<number>;
}

/**
 * How far OUTSIDE the surface a dry neighbour sitting on the SAME tread is
 * forced, in height units: one unit under the threshold.
 *
 * DECISION (2026-08-22): "outside, by the least amount expressible" — the
 * same reasoning that gave the lake its `beyondLake = threshold - 1`. The
 * `>=` test inside `marchLevel` needs the value strictly under the threshold
 * for the contour to close around the region, and 1 is the smallest integer
 * step the height grid allows.
 *
 * WHY THE ARM EXISTS AT ALL: without it, a dry neighbour on the same tread
 * reads `bandOf(real) === surfaceBand`, i.e. its real height is >= the
 * threshold, and marching would flood it — spreading the water a full extra
 * cell onto ground the river never ran through wherever the course crosses
 * FLAT terrain. Forcing such cells one unit under the threshold puts the
 * waterline near the middle of the lattice edge, and Chaikin then rounds it:
 * the channel stays one cell wide across a flat tread.
 */
const DRY_SAME_TREAD_FIELD_OFFSET = 1;

/**
 * Appends one region's tread to the triangle soup at world height `surfaceY`,
 * and RETURNS the smoothed boundary loops it emitted (the riser builder
 * consumes them to draw the vertical fall surfaces).
 *
 * THE FIELD IT MARCHES, which is where the shape decision actually lives.
 * `threshold = region.surfaceBand * BAND_HEIGHT`. For lattice sample `(x,y)`:
 *
 *   * WET (`(x,y)` is in `region.cells`): `max(threshold, real)`. The surface,
 *     never below its own band floor — reading the real height would punch a
 *     hole wherever the ground under the water dips below the band.
 *
 *   * FOUR-NEIGHBOUR OF A WET CELL, REAL HEIGHT < THRESHOLD: the real height.
 *     The ground falls away there (spillway, cliff), so the water stops
 *     exactly on the terrain's own cap contour — the edge nothing has to line
 *     up cannot fail to line up (issue #62).
 *
 *   * FOUR-NEIGHBOUR OF A WET CELL, `bandOf(real) > surfaceBand`: the real
 *     height. The bank rises, so the water runs UNDER it and the terrain —
 *     opaque, drawn higher — covers it. DO NOT change this arm: forcing risen
 *     banks under the threshold was measured to stop the lake edge ~0.22 cell
 *     short of the riser foot, regressing an approved look.
 *
 *   * FOUR-NEIGHBOUR OF A WET CELL, DRY ON THE SAME TREAD
 *     (`bandOf(real) === surfaceBand`): `threshold - DRY_SAME_TREAD_FIELD_OFFSET`.
 *     NEW relative to the lake — see the constant's doc comment. A basin has
 *     no such ring by construction, which is why the lake never needed it; a
 *     channel crossing flat ground does.
 *
 *   * ANYTHING ELSE: outside, by the same offset. Only the wet cells and
 *     their four-neighbours are read from the terrain at all, so the region
 *     can never run away along a terrace at its own level.
 *
 * Everything downstream is exactly the lake's pipeline: chunk-sized tiling
 * over `region.tiles` (the tiles share their border samples exactly as
 * neighbouring chunks do, and `smoothLoop` pins border points, so two tiles'
 * halves meet along the border with no gap and no overlap), emission at the
 * caller's `surfaceY`, and the scratch discipline below.
 *
 * SCRATCH DISCIPLINE: `loadSampleField`/`marchLevel`/`assembleLoops` share
 * module-level scratch and must run to completion uninterrupted (see
 * loadSampleField's precondition). This runs inside the rig's synchronous
 * rebuild, so nothing can interleave with it.
 */
export function appendRegionSurface(
  mirror: TerrainMirror,
  region: WaterRegion,
  surfaceY: number,
  out: number[],
): ContourLoop[] {
  const threshold = region.surfaceBand * BAND_HEIGHT;
  /** One unit under the threshold: outside, by the least amount expressible. */
  const beyondRegion = threshold - DRY_SAME_TREAD_FIELD_OFFSET;

  const wet = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < mirror.map.size &&
    y < mirror.map.size &&
    region.cells.has(cellIndex(mirror.map, x, y));

  const fieldAt = (x: number, y: number): number => {
    if (wet(x, y)) return Math.max(threshold, sampleHeight(mirror, x, y));
    const besideWet = CARDINAL_NEIGHBOURS.some(([dx, dy]) => wet(x + dx, y + dy));
    if (besideWet) {
      const real = sampleHeight(mirror, x, y);
      // Ground falling away: stop on the terrain's own cap contour.
      if (real < threshold) return real;
      // Bank rising: run under it; the terrain is opaque and drawn higher.
      if (bandOf(real) > region.surfaceBand) return real;
      // Dry, same tread: force outside by one unit so the channel does not
      // spread onto flat land (see DRY_SAME_TREAD_FIELD_OFFSET).
      return beyondRegion;
    }
    return beyondRegion;
  };

  /** Every smoothed loop emitted, across all tiles, in emission order. */
  const emittedLoops: ContourLoop[] = [];

  const tilesPerEdge = chunksPerEdge(mirror.map.size);
  for (const tile of region.tiles) {
    const tileX = (tile % tilesPerEdge) * CHUNK_SIZE;
    const tileZ = Math.floor(tile / tilesPerEdge) * CHUNK_SIZE;
    loadSampleField((i, j) => fieldAt(tileX + i, tileZ + j));
    const segmentCount = marchLevel(threshold, tileX, tileZ, null);
    const loops = assembleLoops(segmentCount, tileX, tileZ, samples[0]! >= threshold)
      .map(smoothLoop)
      .filter((loop) => loop.length >= 3);
    emittedLoops.push(...loops);
    for (const polygon of groupLoops(loops)) {
      let merged = polygon.outer;
      for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
      earClip(merged, (a, b, c) => {
        out.push(a.x * CELL_WORLD_SIZE, surfaceY, a.z * CELL_WORLD_SIZE);
        out.push(b.x * CELL_WORLD_SIZE, surfaceY, b.z * CELL_WORLD_SIZE);
        out.push(c.x * CELL_WORLD_SIZE, surfaceY, c.z * CELL_WORLD_SIZE);
      });
    }
  }

  return emittedLoops;
}
