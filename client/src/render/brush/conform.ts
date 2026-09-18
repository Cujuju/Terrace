import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three';
import { CHUNK_SIZE } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import type { BrushFootprint } from './brushGeometry.ts';
import { OUTLINE_LIFT_WORLD_UNITS, RING_HEM_WORLD_UNITS } from './style.ts';

export interface BrushGround {
  /** Drawn band cap Y at a cell, or null where the terrain is not drawn yet. */
  yAt(cellX: number, cellZ: number): number | null;
  revisionAt(cellX: number, cellZ: number): number;
}

export interface ConformedGeometry {
  readonly ring: BufferGeometry;
  readonly hem: BufferGeometry;
  readonly grid: BufferGeometry;
  /** Rewrites all three if anything it depends on moved; cheap no-op otherwise. */
  syncTo(
    footprint: BrushFootprint,
    footprintId: number,
    aimX: number,
    aimZ: number,
    fallbackY: number,
    ground: BrushGround,
  ): void;
  dispose(): void;
}

interface LiveGeometry {
  readonly geometry: BufferGeometry;
  readonly array: Float32Array;
  readonly attribute: BufferAttribute;
}

function makeLive(vertexCapacity: number): LiveGeometry {
  const geometry = new BufferGeometry();
  const array = new Float32Array(vertexCapacity * 3);
  const attribute = new BufferAttribute(array, 3);
  attribute.setUsage(DynamicDrawUsage);
  geometry.setAttribute('position', attribute);
  geometry.setDrawRange(0, 0);
  return { geometry, array, attribute };
}

function commit(live: LiveGeometry, vertexCount: number): void {
  live.geometry.setDrawRange(0, vertexCount);
  live.attribute.needsUpdate = true;
}

const highestOf = (
  cells: Int32Array,
  from: number,
  to: number,
  aimX: number,
  aimZ: number,
  fallbackY: number,
  ground: BrushGround,
): number => {
  let y = -Infinity;
  for (let i = from; i < to; i += 2) {
    const sample = ground.yAt(aimX + cells[i]!, aimZ + cells[i + 1]!);
    if (sample !== null && sample > y) y = sample;
  }
  return (y === -Infinity ? fallbackY : y) + OUTLINE_LIFT_WORLD_UNITS;
};

export function createConformedGeometry(
  maxRingPoints: number,
  maxGridSegments: number,
): ConformedGeometry {
  // The x2 is headroom for the Commit 2 step joins, so that commit never resizes.
  const ring = makeLive(2 * maxRingPoints);
  const hem = makeLive(6 * 2 * (maxRingPoints - 1));
  const grid = makeLive(2 * maxGridSegments);

  let lastFootprintId = -1;
  let lastAimX = Infinity;
  let lastAimZ = Infinity;
  let lastFallbackY = NaN;
  let lastHash = 0;
  let hasWritten = false;

  return {
    ring: ring.geometry,
    hem: hem.geometry,
    grid: grid.geometry,
    syncTo(footprint, footprintId, aimX, aimZ, fallbackY, ground): void {
      const reach = footprint.reachCells;
      const firstChunkX = Math.floor((aimX - reach) / CHUNK_SIZE);
      const lastChunkX = Math.floor((aimX + reach) / CHUNK_SIZE);
      const firstChunkZ = Math.floor((aimZ - reach) / CHUNK_SIZE);
      const lastChunkZ = Math.floor((aimZ + reach) / CHUNK_SIZE);
      let hash = 0;
      for (let cz = firstChunkZ; cz <= lastChunkZ; cz++) {
        for (let cx = firstChunkX; cx <= lastChunkX; cx++) {
          hash =
            (Math.imul(hash, 31) + ground.revisionAt(cx * CHUNK_SIZE, cz * CHUNK_SIZE)) | 0;
        }
      }
      // No camera state enters here: a pan or rotate with a steady aim
      // supplies identical inputs, so orbiting rewrites nothing.
      if (
        hasWritten &&
        footprintId === lastFootprintId &&
        aimX === lastAimX &&
        aimZ === lastAimZ &&
        fallbackY === lastFallbackY &&
        hash === lastHash
      ) {
        return;
      }

      // Y is absolute world Y, not local: the objects carry XZ only
      // (position.y is 0; see brushPreview.ts).
      for (let i = 0; i < footprint.ringCount; i++) {
        const y = highestOf(
          footprint.ringCells,
          footprint.ringCellIndex[i]!,
          footprint.ringCellIndex[i + 1]!,
          aimX,
          aimZ,
          fallbackY,
          ground,
        );
        ring.array[i * 3] = footprint.ringPoints[i * 2]! * CELL_WORLD_SIZE;
        ring.array[i * 3 + 1] = y;
        ring.array[i * 3 + 2] = footprint.ringPoints[i * 2 + 1]! * CELL_WORLD_SIZE;
      }
      commit(ring, footprint.ringCount);

      for (let s = 0; s < footprint.gridCount; s++) {
        // One Y for both endpoints: the line lies flat on the higher of the
        // two cells it separates.
        const y = highestOf(
          footprint.gridCells,
          s * 4,
          s * 4 + 4,
          aimX,
          aimZ,
          fallbackY,
          ground,
        );
        grid.array[s * 6] = footprint.gridPoints[s * 4]! * CELL_WORLD_SIZE;
        grid.array[s * 6 + 1] = y;
        grid.array[s * 6 + 2] = footprint.gridPoints[s * 4 + 1]! * CELL_WORLD_SIZE;
        grid.array[s * 6 + 3] = footprint.gridPoints[s * 4 + 2]! * CELL_WORLD_SIZE;
        grid.array[s * 6 + 4] = y;
        grid.array[s * 6 + 5] = footprint.gridPoints[s * 4 + 3]! * CELL_WORLD_SIZE;
      }
      commit(grid, footprint.gridCount * 2);

      for (let i = 0; i < footprint.ringCount - 1; i++) {
        const ax = ring.array[i * 3]!;
        const ya = ring.array[i * 3 + 1]!;
        const az = ring.array[i * 3 + 2]!;
        const bx = ring.array[i * 3 + 3]!;
        const yb = ring.array[i * 3 + 4]!;
        const bz = ring.array[i * 3 + 5]!;
        const base = i * 18;
        hem.array[base] = ax;
        hem.array[base + 1] = ya;
        hem.array[base + 2] = az;
        hem.array[base + 3] = bx;
        hem.array[base + 4] = yb;
        hem.array[base + 5] = bz;
        hem.array[base + 6] = bx;
        hem.array[base + 7] = yb - RING_HEM_WORLD_UNITS;
        hem.array[base + 8] = bz;
        hem.array[base + 9] = ax;
        hem.array[base + 10] = ya;
        hem.array[base + 11] = az;
        hem.array[base + 12] = bx;
        hem.array[base + 13] = yb - RING_HEM_WORLD_UNITS;
        hem.array[base + 14] = bz;
        hem.array[base + 15] = ax;
        hem.array[base + 16] = ya - RING_HEM_WORLD_UNITS;
        hem.array[base + 17] = az;
      }
      commit(hem, 6 * (footprint.ringCount - 1));

      lastFootprintId = footprintId;
      lastAimX = aimX;
      lastAimZ = aimZ;
      lastFallbackY = fallbackY;
      lastHash = hash;
      hasWritten = true;
    },
    dispose(): void {
      ring.geometry.dispose();
      hem.geometry.dispose();
      grid.geometry.dispose();
    },
  };
}
