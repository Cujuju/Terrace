import {
  BAND_HEIGHT,
  BEDROCK_FLOOR,
  CHUNK_SIZE,
  cellIndex,
  chunkIndex,
  heightAt,
  quantizeToBand,
  setColumn,
  type Span,
} from '@terrace/shared';

import { chunksDirtiedByCell, hasChunk, type TerrainMirror } from './mirror.ts';

const ARCH_FIXTURE_QUERY_KEY = 'arch';

const MOUND_RADIUS_X_CELLS = 30;
const MOUND_RADIUS_Z_CELLS = 14;

const MOUND_CREST_BANDS = 9;
const MOUND_SHOULDER_BANDS = 8;
const MOUND_RIM_BANDS = 7;

const MOUND_CREST_EDGE_SQUARED = 0.5 * 0.5;
const MOUND_SHOULDER_EDGE_SQUARED = 0.8 * 0.8;

const TUNNEL_OPENING_BANDS = 5;

const TUNNEL_HALF_WIDTH_CELLS = 6;

const ARCH_TUNNEL_OFFSET_CELLS = -14;
const CAVE_TUNNEL_OFFSET_CELLS = 14;

const CAVE_DEPTH_FRACTION = 2 / 3;

export function archFixtureAim(worldSize: number): {
  readonly archBore: { x: number; z: number };
  readonly caveMouth: { x: number; z: number };
  readonly crest: { x: number; z: number };
} {
  const centreX = Math.floor(worldSize / 2);
  const centreZ = Math.floor(worldSize / 2);
  return {
    archBore: { x: centreX + ARCH_TUNNEL_OFFSET_CELLS, z: centreZ },
    caveMouth: {
      x: centreX + CAVE_TUNNEL_OFFSET_CELLS,
      z: centreZ - moundEdgeZCells(CAVE_TUNNEL_OFFSET_CELLS),
    },
    crest: { x: centreX, z: centreZ },
  };
}

function moundEdgeZCells(dx: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const remaining = 1 - nx * nx;
  if (remaining <= 0) return 0;
  return Math.floor(MOUND_RADIUS_Z_CELLS * Math.sqrt(remaining));
}

export function archFixtureRequested(): boolean {
  if (typeof window === 'undefined') return false;
  return new URLSearchParams(window.location.search).get(ARCH_FIXTURE_QUERY_KEY) === '1';
}

function cellAvailable(mirror: TerrainMirror, x: number, y: number): boolean {
  const size = mirror.map.size;
  if (x < 0 || y < 0 || x >= size || y >= size) return false;
  return hasChunk(
    mirror,
    chunkIndex(size, Math.floor(x / CHUNK_SIZE), Math.floor(y / CHUNK_SIZE)),
  );
}

function moundBandsAt(dx: number, dz: number): number {
  const nx = dx / MOUND_RADIUS_X_CELLS;
  const nz = dz / MOUND_RADIUS_Z_CELLS;
  const rSquared = nx * nx + nz * nz;
  if (rSquared > 1) return 0;
  if (rSquared <= MOUND_CREST_EDGE_SQUARED) return MOUND_CREST_BANDS;
  if (rSquared <= MOUND_SHOULDER_EDGE_SQUARED) return MOUND_SHOULDER_BANDS;
  return MOUND_RIM_BANDS;
}

function insideTunnel(dx: number, dz: number): boolean {
  if (Math.abs(dx - ARCH_TUNNEL_OFFSET_CELLS) <= TUNNEL_HALF_WIDTH_CELLS) return true;
  if (Math.abs(dx - CAVE_TUNNEL_OFFSET_CELLS) > TUNNEL_HALF_WIDTH_CELLS) return false;
  const caveEnd = -MOUND_RADIUS_Z_CELLS + 2 * MOUND_RADIUS_Z_CELLS * CAVE_DEPTH_FRACTION;
  return dz <= caveEnd;
}

export function carveArchFixture(mirror: TerrainMirror): Set<number> {
  const dirty = new Set<number>();
  const size = mirror.map.size;
  const centreX = Math.floor(size / 2);
  const centreZ = Math.floor(size / 2);
  if (!cellAvailable(mirror, centreX, centreZ)) {
    console.warn('[terrace] arch fixture: the world centre has not been received — skipped');
    return dirty;
  }

  const base = quantizeToBand(heightAt(mirror.map, centreX, centreZ));

  for (let dz = -MOUND_RADIUS_Z_CELLS; dz <= MOUND_RADIUS_Z_CELLS; dz++) {
    for (let dx = -MOUND_RADIUS_X_CELLS; dx <= MOUND_RADIUS_X_CELLS; dx++) {
      const bands = moundBandsAt(dx, dz);
      if (bands === 0) continue;

      const x = centreX + dx;
      const z = centreZ + dz;
      if (!cellAvailable(mirror, x, z)) continue;

      const moundTop = base + bands * BAND_HEIGHT;
      const ground = mirror.map.cells[cellIndex(mirror.map, x, z)]!;
      const roofFloor = base + TUNNEL_OPENING_BANDS * BAND_HEIGHT;

      let spans: readonly Span[];
      if (
        insideTunnel(dx, dz) &&
        ground > BEDROCK_FLOOR &&
        ground < roofFloor &&
        roofFloor < moundTop
      ) {
        spans = [
          { floor: BEDROCK_FLOOR, ceiling: ground },
          { floor: roofFloor, ceiling: moundTop },
        ];
      } else {
        spans = [{ floor: BEDROCK_FLOOR, ceiling: moundTop }];
      }

      setColumn(mirror.map, x, z, spans);
      for (const idx of chunksDirtiedByCell(mirror, x, z)) dirty.add(idx);
    }
  }

  return dirty;
}
