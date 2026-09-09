import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  cellIndex,
  chunksPerEdge,
  drawnBandOfSample,
} from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import { sampleHeight, type TerrainMirror } from '../../terrain/mirror.ts';
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
  for (const polygon of groupLoops(loops)) {
    let merged = polygon.outer;
    for (const hole of polygon.holes) merged = bridgeHole(merged, hole);
    earClip(merged, (a, b, c) => {
      out.push(a.x * CELL_WORLD_SIZE, surfaceY, a.z * CELL_WORLD_SIZE);
      out.push(b.x * CELL_WORLD_SIZE, surfaceY, b.z * CELL_WORLD_SIZE);
      out.push(c.x * CELL_WORLD_SIZE, surfaceY, c.z * CELL_WORLD_SIZE);
    });
  }
  return loops;
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
