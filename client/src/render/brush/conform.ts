import { BufferAttribute, BufferGeometry, DynamicDrawUsage } from 'three';
import { CHUNK_SIZE } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import type { BrushFootprint } from './brushGeometry.ts';
import { CELL_TOUCH_EPSILON } from './footprintMark.ts';
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
  /** Rewrites all three if anything it depends on moved; cheap no-op otherwise.
   *  capY pins every vertex at or below the selected band (null = off). */
  syncTo(
    footprint: BrushFootprint,
    footprintId: number,
    aimX: number,
    aimZ: number,
    fallbackY: number,
    ground: BrushGround,
    capY: number | null,
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

/** Mark cells touching x,z in cell space, written into out as dx,dz pairs. */
const touchInto = (footprint: BrushFootprint, x: number, z: number, out: Int32Array): number => {
  const x0 = Math.ceil(x - 0.5 - CELL_TOUCH_EPSILON);
  const x1 = Math.floor(x + 0.5 + CELL_TOUCH_EPSILON);
  const z0 = Math.ceil(z - 0.5 - CELL_TOUCH_EPSILON);
  const z1 = Math.floor(z + 0.5 + CELL_TOUCH_EPSILON);
  const width = 2 * footprint.markExtent + 1;
  let n = 0;
  for (let cz = z0; cz <= z1; cz++) {
    for (let cx = x0; cx <= x1; cx++) {
      const gx = cx + footprint.markExtent;
      const gz = cz + footprint.markExtent;
      if (gx < 0 || gz < 0 || gx >= width || gz >= width) continue;
      if (footprint.markGrid[gz * width + gx] === 0) continue;
      out[n * 2] = cx;
      out[n * 2 + 1] = cz;
      n++;
    }
  }
  if (n === 0) {
    out[0] = 0;
    out[1] = 0;
    n = 1;
  }
  return n;
};

const sampleHeight = (
  footprint: BrushFootprint,
  x: number,
  z: number,
  aimX: number,
  aimZ: number,
  fallbackY: number,
  capY: number | null,
  ground: BrushGround,
  scratch: Int32Array,
): number => {
  // capY pins the footprint to the selected band's cap: the ring never
  // rides higher than the surface being edited.
  const touched = touchInto(footprint, x, z, scratch);
  let y = -Infinity;
  for (let k = 0; k < touched; k++) {
    const sample = ground.yAt(aimX + scratch[k * 2]!, aimZ + scratch[k * 2 + 1]!);
    if (sample === null) continue;
    const capped = capY === null ? sample : Math.min(sample, capY);
    if (capped > y) y = capped;
  }
  const base = y === -Infinity ? fallbackY : y;
  return (capY === null ? base : Math.min(base, capY)) + OUTLINE_LIFT_WORLD_UNITS;
};

export function createConformedGeometry(
  maxRingVerts: number,
  maxGridSegments: number,
): ConformedGeometry {
  // Exact draped maxima, computed per footprint at construction: no resizes.
  const ring = makeLive(maxRingVerts);
  const hem = makeLive(6 * (maxRingVerts - 1));
  const grid = makeLive(2 * maxGridSegments);
  // At most four mark cells touch one point; reused, never reallocated.
  const touchScratch = new Int32Array(8);

  let lastFootprintId = -1;
  let lastAimX = Infinity;
  let lastAimZ = Infinity;
  let lastFallbackY = NaN;
  let lastCapY: number | null = null;
  let lastHash = 0;
  let hasWritten = false;

  return {
    ring: ring.geometry,
    hem: hem.geometry,
    grid: grid.geometry,
    syncTo(footprint, footprintId, aimX, aimZ, fallbackY, ground, capY): void {
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
        capY === lastCapY &&
        hash === lastHash
      ) {
        return;
      }

      // Y is absolute world Y, not local: the objects carry XZ only
      // (position.y is 0; see brushPreview.ts). The runs arrive pre-draped,
      // so every vertex melts onto the ground beneath it.
      for (let i = 0; i < footprint.ringCount; i++) {
        const x = footprint.ringPoints[i * 2]!;
        const z = footprint.ringPoints[i * 2 + 1]!;
        ring.array[i * 3] = x * CELL_WORLD_SIZE;
        ring.array[i * 3 + 1] = sampleHeight(
          footprint, x, z, aimX, aimZ, fallbackY, capY, ground, touchScratch,
        );
        ring.array[i * 3 + 2] = z * CELL_WORLD_SIZE;
      }
      commit(ring, footprint.ringCount);

      for (let s = 0; s < footprint.gridCount; s++) {
        // Each end rides the ground beneath it: one-cell runs hug one step.
        const ax = footprint.gridPoints[s * 4]!;
        const az = footprint.gridPoints[s * 4 + 1]!;
        const bx = footprint.gridPoints[s * 4 + 2]!;
        const bz = footprint.gridPoints[s * 4 + 3]!;
        const ya = sampleHeight(
          footprint, ax, az, aimX, aimZ, fallbackY, capY, ground, touchScratch,
        );
        const yb = sampleHeight(
          footprint, bx, bz, aimX, aimZ, fallbackY, capY, ground, touchScratch,
        );
        grid.array[s * 6] = ax * CELL_WORLD_SIZE;
        grid.array[s * 6 + 1] = ya;
        grid.array[s * 6 + 2] = az * CELL_WORLD_SIZE;
        grid.array[s * 6 + 3] = bx * CELL_WORLD_SIZE;
        grid.array[s * 6 + 4] = yb;
        grid.array[s * 6 + 5] = bz * CELL_WORLD_SIZE;
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
      lastCapY = capY;
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
