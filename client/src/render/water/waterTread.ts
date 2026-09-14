import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  DRAWN_GROUND_BAND_BIAS,
  cellIndex,
  chunksPerEdge,
  drawnBandOfSample,
  drawnLevelThreshold,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { sampleHeight, sampleRenderHeight, type TerrainMirror } from '../../terrain/mirror.ts';
import {
  assembleLoops,
  domainInside,
  loadSampleField,
  marchLevel,
  type ContourLoop,
} from '../../terrain/contours.ts';
import { simplifyLoop } from '../../terrain/contourSmoothing.ts';
import { bridgeHole, earClip, groupLoops } from '../../terrain/triangulation.ts';

export const CARDINAL_NEIGHBOURS: readonly (readonly [number, number])[] = [
  [0, -1],
  [1, 0],
  [0, 1],
  [-1, 0],
];

export const TILE_LATTICE_MIN_OFFSET = -2;
export const TILE_LATTICE_MAX_OFFSET = 1;

export const TILE_LATTICE_OFFSETS: readonly (readonly [number, number])[] = (() => {
  const offsets: [number, number][] = [];
  for (let dy = TILE_LATTICE_MIN_OFFSET; dy <= TILE_LATTICE_MAX_OFFSET; dy++) {
    for (let dx = TILE_LATTICE_MIN_OFFSET; dx <= TILE_LATTICE_MAX_OFFSET; dx++) {
      offsets.push([dx, dy]);
    }
  }
  return offsets;
})();

export interface WaterRegion {
  isWet(cell: number): boolean;
  readonly anchorCell: number;
  readonly surfaceBand: number;
  readonly tiles: Set<number>;
}

export function waterRegionOfCells(
  cells: ReadonlySet<number>,
  surfaceBand: number,
  tiles: Set<number>,
): WaterRegion {
  return {
    isWet: (cell) => cells.has(cell),
    anchorCell: cells.values().next().value as number,
    surfaceBand,
    tiles,
  };
}

const DRY_SAME_TREAD_FIELD_OFFSET = BAND_HEIGHT;

export function appendRegionSurface(
  mirror: TerrainMirror,
  region: WaterRegion,
  surfaceY: number,
  out: number[],
): ContourLoop[] {
  const emittedLoops: ContourLoop[] = [];
  for (const tile of region.tiles) {
    emittedLoops.push(...appendRegionTile(mirror, region, tile, surfaceY, out));
  }
  return emittedLoops;
}

export function appendRegionTile(
  mirror: TerrainMirror,
  region: WaterRegion,
  tile: number,
  surfaceY: number,
  out: number[],
): ContourLoop[] {
  // Surface band 0 is the shoreline band: its raw plane (0) sits below the
  // drawn shore threshold (drawnLevelThreshold(0)), so the constructed
  // field below would draw a different edge than the land shoreline. March
  // the mirrored land isoline instead; every other band's raw and drawn
  // thresholds already coincide, so those keep the region field.
  if (region.surfaceBand === 0) return appendShoreTile(mirror, tile, surfaceY, out);
  const threshold = region.surfaceBand * BAND_HEIGHT;
  const fieldAt = regionFieldAt(mirror, region, threshold);

  const tilesPerEdge = chunksPerEdge(mirror.map.size);
  const tileX = (tile % tilesPerEdge) * CHUNK_SIZE;
  const tileZ = Math.floor(tile / tilesPerEdge) * CHUNK_SIZE;
  loadSampleField((i, j) => fieldAt(tileX + i, tileZ + j));
  const segmentCount = marchLevel(threshold, tileX, tileZ, null);
  const loops = assembleLoops(segmentCount, tileX, tileZ, domainInside(threshold, null))
    .map(simplifyLoop)
    .filter((loop) => loop.length >= 3);
  emitSheet(loops, surfaceY, out);
  return loops;
}

/**
 * Marching threshold for the shoreline water side. The water field is the
 * negated mirror field, so the threshold mirrors across the band bias:
 * -h + BIAS >= 2*BIAS - T  ⟺  h + BIAS <= T, the complement of the land
 * inside (h + BIAS >= T) at T = drawnLevelThreshold(0). The tie-break keeps
 * exact-shore heights (integers) strictly dry: without it a saddle cell
 * averaging exactly to the shore would join on both sides with mismatched
 * pairings, and exact-shore flats would film over with water-only edges.
 * Crossing positions shift by at most the tie-break, far under simplify
 * epsilon, so the edge still coincides with the land shoreline.
 */
const SHORE_TIE_BREAK = 1e-7;
const SHORE_WATER_THRESHOLD = 2 * DRAWN_GROUND_BAND_BIAS - drawnLevelThreshold(0) + SHORE_TIE_BREAK;

/**
 * Shoreline tread: march the mirror samples the land caps march (cf.
 * loadSamples), negated so the marched inside is the wet side, at the
 * mirrored shore threshold. The edge coincides with the land shoreline:
 * the crossing interpolation mirrors exactly (drawnCrossingFraction is
 * symmetric about its midpoint) and the isoline refinement converges to
 * the adjacent grid point, so both sit within simplify epsilon. The region
 * only scopes coverage to its tiles; wet/dry membership no longer shapes
 * the edge, so the old wet-max flattening (which degenerates marching)
 * and the dry-same-band -16 clamp (which hugged cell edges, blocky) are
 * gone here.
 *
 * Marching the water side (rather than reversing the land loops) matters:
 * border-touching loops close along the tile border on the inside, so only
 * the water-side march closes them around the water. The returned loops
 * bound the emitted sheet wound for the water side, keeping the curtain
 * contract unchanged: outward normals point away from the water.
 */
function appendShoreTile(
  mirror: TerrainMirror,
  tile: number,
  surfaceY: number,
  out: number[],
): ContourLoop[] {
  const tilesPerEdge = chunksPerEdge(mirror.map.size);
  const tileX = (tile % tilesPerEdge) * CHUNK_SIZE;
  const tileZ = Math.floor(tile / tilesPerEdge) * CHUNK_SIZE;
  loadSampleField((i, j) => -sampleRenderHeight(mirror, tileX + i, tileZ + j), CHUNK_SIZE);
  const segmentCount = marchLevel(SHORE_WATER_THRESHOLD, tileX, tileZ, null);
  const loops = assembleLoops(
    segmentCount,
    tileX,
    tileZ,
    domainInside(SHORE_WATER_THRESHOLD, null),
  )
    .map(simplifyLoop)
    .filter((loop) => loop.length >= 3);
  if (loops.length === 0) {
    // No edge in the tile: it is uniformly wet or dry. Emit water only
    // where the land draws no cap (raw corner below the drawn shore); a
    // tile constant at exactly the shore belongs to the land cap.
    if (
      sampleRenderHeight(mirror, tileX, tileZ) + DRAWN_GROUND_BAND_BIAS >=
      drawnLevelThreshold(0)
    ) {
      return [];
    }
    // Marching nothing with the whole domain inside yields exactly the
    // tile border loop (with seam flags), which is the sheet's boundary.
    const tileRect = assembleLoops(0, tileX, tileZ, true)[0]!;
    emitSheet([tileRect], surfaceY, out);
    return [tileRect];
  }
  emitSheet(loops, surfaceY, out);
  return loops;
}

function emitSheet(loops: ContourLoop[], surfaceY: number, out: number[]): void {
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

function regionFieldAt(
  mirror: TerrainMirror,
  region: WaterRegion,
  threshold: number,
): (x: number, y: number) => number {
  const beyondRegion = threshold - DRY_SAME_TREAD_FIELD_OFFSET;

  const wet = (x: number, y: number): boolean =>
    x >= 0 &&
    y >= 0 &&
    x < mirror.map.size &&
    y < mirror.map.size &&
    region.isWet(cellIndex(mirror.map, x, y));

  return (x: number, y: number): number => {
    if (wet(x, y)) return Math.max(threshold, sampleHeight(mirror, x, y));
    const besideWet = CARDINAL_NEIGHBOURS.some(([dx, dy]) => wet(x + dx, y + dy));
    if (besideWet) {
      const real = sampleHeight(mirror, x, y);
      if (drawnBandOfSample(real) !== region.surfaceBand) return real;
      return beyondRegion;
    }
    return beyondRegion;
  };
}
