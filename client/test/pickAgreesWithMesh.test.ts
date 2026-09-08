import { describe, expect, it } from 'vitest';
import { Group, Raycaster, Vector3, type Mesh } from 'three';
import {
  BAND_HEIGHT,
  CHUNK_SIZE,
  WORLD_UNIT_CELLS,
  cellsAcross,
  type ChunkPayload,
} from '@terrace/shared';
import {
  applySnapshot,
  applyTerrainDiff,
  createTerrainMirror,
} from '../src/terrain/mirror.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import { pickTerrainCellByRay } from '../src/terrain/picking.ts';
import { SUPER_MESH_SPAN_CHUNKS } from '../src/render/chunkTiling.ts';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = cellsAcross(64);
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

const MAX_CELL_DISAGREEMENT = cellsAcross(0.5);

const MIN_EXACT_AGREEMENT = 0.95;

const SWEEP_TIMEOUT_MS = 120_000;

function terrainHeight(cellX: number, cellY: number): number {
  const x = cellX / WORLD_UNIT_CELLS;
  const y = cellY / WORLD_UNIT_CELLS;
  return Math.round(
    (Math.sin(x / 9) * Math.cos(y / 7) * 6 + Math.sin((x + y) / 13) * 4) * BAND_HEIGHT,
  );
}

function worldChunks(): ChunkPayload[] {
  const chunks: ChunkPayload[] = [];
  for (let cy = 0; cy < WORLD / CHUNK_SIZE; cy++) {
    for (let cx = 0; cx < WORLD / CHUNK_SIZE; cx++) {
      const heights = new Array<number>(CELLS_PER_CHUNK);
      for (let ly = 0; ly < CHUNK_SIZE; ly++) {
        for (let lx = 0; lx < CHUNK_SIZE; lx++) {
          heights[ly * CHUNK_SIZE + lx] = terrainHeight(
            cx * CHUNK_SIZE + lx,
            cy * CHUNK_SIZE + ly,
          );
        }
      }
      chunks.push({ cx, cy, heights });
    }
  }
  return chunks;
}

function buildWorld(): { mirror: ReturnType<typeof createTerrainMirror>; pickables: Mesh[] } {
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror);
  meshes.update(
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks: worldChunks() }),
  );
  return { mirror, pickables: meshes.pickables() as Mesh[] };
}

function buildSculptedWorld(): {
  mirror: ReturnType<typeof createTerrainMirror>;
  pickables: Mesh[];
  deadVertices: number;
  reordered: boolean;
} {
  const handlers = new Set<(dt: number) => void>();
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror, {
    onFrame(handler: (dt: number) => void): () => void {
      handlers.add(handler);
      return () => handlers.delete(handler);
    },
    now: () => 0,
  });
  const frame = (): void => {
    for (const handler of handlers) handler(1 / 60);
  };
  const runToIdle = (): void => {
    for (let guard = 0; guard <= (WORLD / CHUNK_SIZE) ** 2 * 4; guard++) {
      if (meshes.pendingCount() === 0) return;
      frame();
    }
    throw new Error('the chunk queue never drained');
  };
  meshes.update(
    applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks: worldChunks() }),
  );
  runToIdle();

  const STRIP_CHUNK_ROWS = 2;
  for (const lift of [6 * BAND_HEIGHT, 0]) {
    const cells: { x: number; y: number; h: number }[] = [];
    for (let y = CHUNK_SIZE; y < CHUNK_SIZE * (1 + STRIP_CHUNK_ROWS); y += 3) {
      for (let x = CHUNK_SIZE; x < WORLD - CHUNK_SIZE; x += 3) {
        cells.push({ x, y, h: terrainHeight(x, y) + lift });
      }
    }
    meshes.update(applyTerrainDiff(mirror, { type: 'terrainDiff', cells }));
    runToIdle();
  }

  const deadVertices = meshes
    .arenaStats()
    .reduce((total, stats) => total + stats.deadVertices, 0);
  const reordered = meshes.arenaLayout().some(({ slots }) => {
    const byOffset = [...slots].sort((a, b) => a.offset - b.offset);
    return byOffset.some((slot, i) => i > 0 && slot.chunkIdx < byOffset[i - 1]!.chunkIdx);
  });
  return { mirror, pickables: meshes.pickables() as Mesh[], deadVertices, reordered };
}

function sweep(
  mirror: ReturnType<typeof createTerrainMirror>,
  pickables: Mesh[],
): void {
    const chunksPerSuperMesh = SUPER_MESH_SPAN_CHUNKS ** 2;
    expect(pickables).toHaveLength((WORLD / CHUNK_SIZE) ** 2 / chunksPerSuperMesh);

    const raycaster = new Raycaster();
    let compared = 0;
    let exact = 0;
    let worstDisagreement = 0;
    let disagreedOnHit = 0;

    const CAMERA_ORBIT_CELLS = cellsAcross(60);
    const CAMERA_HEIGHT_WORLD_UNITS = 30;
    const WORLD_MIDDLE_CELLS = WORLD / 2;
    const TARGET_STEP_X_CELLS = cellsAcross(5);
    const TARGET_STEP_Z_CELLS = cellsAcross(11);
    const TARGET_MARGIN_CELLS = cellsAcross(4);
    const TARGET_LIMIT_CELLS = cellsAcross(60);
    for (let degrees = 0; degrees < 360; degrees += 7) {
      const angle = (degrees * Math.PI) / 180;
      const camera = new Vector3(
        (WORLD_MIDDLE_CELLS + CAMERA_ORBIT_CELLS * Math.cos(angle)) * CELL_WORLD_SIZE,
        CAMERA_HEIGHT_WORLD_UNITS,
        (WORLD_MIDDLE_CELLS + CAMERA_ORBIT_CELLS * Math.sin(angle)) * CELL_WORLD_SIZE,
      );
      for (let tx = TARGET_MARGIN_CELLS; tx < TARGET_LIMIT_CELLS; tx += TARGET_STEP_X_CELLS) {
        for (let tz = TARGET_MARGIN_CELLS; tz < TARGET_LIMIT_CELLS; tz += TARGET_STEP_Z_CELLS) {
          const direction = new Vector3(
            tx * CELL_WORLD_SIZE,
            terrainHeight(tx, tz) * HEIGHT_WORLD_SCALE,
            tz * CELL_WORLD_SIZE,
          )
            .sub(camera)
            .normalize();

          raycaster.set(camera, direction);
          const hits = raycaster.intersectObjects(pickables, false);
          const marched = pickTerrainCellByRay(mirror, camera, direction);

          if (hits.length === 0 || marched === null) {
            if (hits.length !== 0 || marched !== null) disagreedOnHit++;
            continue;
          }
          const rayCellX = Math.round(hits[0].point.x / CELL_WORLD_SIZE);
          const rayCellY = Math.round(hits[0].point.z / CELL_WORLD_SIZE);
          const apart = Math.max(
            Math.abs(rayCellX - marched.x),
            Math.abs(rayCellY - marched.y),
          );
          compared++;
          if (apart === 0) exact++;
          if (apart > worstDisagreement) worstDisagreement = apart;
        }
      }
    }

    expect(compared).toBeGreaterThan(1000);
    expect(disagreedOnHit).toBe(0);
    expect(worstDisagreement).toBeLessThanOrEqual(MAX_CELL_DISAGREEMENT);
    expect(exact / compared).toBeGreaterThanOrEqual(MIN_EXACT_AGREEMENT);
}

describe('pickTerrainCellByRay vs the mesh raycast it replaced', () => {
  it(
    'agrees on the cell, and never disagrees about whether there is terrain at all',
    { timeout: SWEEP_TIMEOUT_MS },
    () => {
      const { mirror, pickables } = buildWorld();
      sweep(mirror, pickables);
    },
  );

  it(
    'still agrees when the arena the rays cross is fragmented',
    { timeout: SWEEP_TIMEOUT_MS },
    () => {
      const { mirror, pickables, deadVertices, reordered } = buildSculptedWorld();
      expect(reordered).toBe(true);
      expect(deadVertices).toBeGreaterThan(0);
      sweep(mirror, pickables);
    },
  );
});
