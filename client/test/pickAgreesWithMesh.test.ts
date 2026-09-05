// Differential test: the height-field march must answer what the mesh raycast
// it replaced answered.
//
// WHY THIS EXISTS. terrain/picking.ts stopped raycasting the terrain meshes on
// 2026-08-21 and started marching the height mirror instead, because the
// raycast cost 29.5 ms per pick and ran every frame of every pan. That is only
// a safe trade if the two agree about what the player is pointing at, and the
// argument that they do is a chain of reasoning about vertexGrid.ts's honesty
// invariant — exactly the kind of argument that rots silently. So this pins it
// against the REAL geometry: build actual chunk meshes, fire thousands of rays
// from an orbiting camera, and compare cell against cell.
//
// Like terrainMeshes.test.ts this constructs real Three objects but never a
// WebGLRenderer — BufferGeometry, Mesh and Raycaster are plain maths.

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
import { SUPER_MESH_SPAN_CHUNKS } from '../src/render/terrainMeshes.ts';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';

/**
 * 64 WORLD UNITS of land, in cells.
 *
 * STATED AS LAND, NOT AS A CELL COUNT (2026-08-21). Everything this test is
 * made of — the hills below, the camera's orbit, where it aims — is a fact
 * about the ground, so a bare `64` would have quietly shrunk the fixture to a
 * quarter of the world it was written against when the cell did.
 */
const WORLD = cellsAcross(64);
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/**
 * How far the two picks may ever land apart.
 *
 * ONLY where the ray strikes a cliff FACE. The mesh draws that face on the
 * smoothed contour, which wanders within the boundary cell (vertexGrid.ts
 * step 2); the march draws it on the cell boundary itself. A hit on either
 * lands within half a cell of the other — and on that face the raycast's own
 * answer is already arbitrary, since the contour it hit IS the border between
 * the two cells. Anywhere the ray lands on a flat cap — which is every pick
 * that is not a grazing shot at a riser — the two agree exactly.
 *
 * HALF A WORLD UNIT, CONVERTED, AND THAT IS TIGHTER THAN THE BOUND IT REPLACES
 * (2026-08-21). This was a literal `1` cell when a cell WAS a world unit, so it
 * permitted a world unit of disagreement; half of one permits less ground, and
 * the sweep measures it: 3 744 comparisons, 3 603 exact, 139 apart by one cell,
 * and exactly 2 apart by two — both of them verified to be the face case above,
 * the mesh reporting a point ON the riser at a band floor while the march named
 * the cell whose cap the ray crossed a band higher.
 *
 * Left at one CELL the bound would have quietly tightened fourfold with the
 * re-sample and failed on those two — not because picking got worse, but
 * because the same half-cell of contour wander is now measured with four times
 * the resolution.
 */
const MAX_CELL_DISAGREEMENT = cellsAcross(0.5);

/**
 * Share of picks that must match EXACTLY, not merely within a cell.
 *
 * Measured at 97.2% over the sweep below, and re-measured at 96.2% after the
 * 2026-08-21 re-sample restated the fixture as land (see terrainHeight); the
 * floor is set under both so ordinary contour-smoothing tweaks do not fail the
 * build, while a change that genuinely decouples the pick from the mesh —
 * which would send this toward chance — still does.
 *
 * Do not read 97% as the figure for any world: it is the figure for THESE
 * rolling hills, where cliff faces are a small share of what a ray can land
 * on. A live tower-heavy world measured 73.8% exact for the same reason, with
 * every one of the one-cell differences being a hit on a cliff face — the
 * case the two rules are entitled to answer differently. See
 * pickTerrainCellByRay's header for that measurement.
 */
const MIN_EXACT_AGREEMENT = 0.95;

/**
 * This file's own timeout rail, because the shared 30 s one is under its cost.
 *
 * The reference side of this differential test is the brute-force
 * `Raycaster.intersectObjects` that pickTerrainCellByRay REPLACED, so its cost
 * is the O(triangles) cost the march exists to avoid, paid 3 744 times. The
 * arena the sculpted sweep crosses is deliberately fragmented (see
 * buildSculptedWorld), and holes sit inside the draw range rather than being
 * skipped: measured on this fixture at 1 136 934 drawn vertices of which
 * 809 880 are dead, 378 978 triangles per ray against the flat world's
 * 131 072. Measured single-file: 15 s for the flat sweep, 42 s for the
 * fragmented one; 45 s observed for the fragmented one under full-suite
 * parallel load.
 *
 * vitest.base.config.ts dropped the workspace rail from 300 s to 30 s on
 * 2026-09-02 (de874ec) and says there that a test needing longer states its
 * own timeout inline — this is that statement. Set at ~3x the fragmented
 * sweep's measured cost, which is a rail against a hang and not a budget the
 * sweep is expected to approach; if this test ever nears it, the arena is
 * drawing far more dead space than it was measured with.
 */
const SWEEP_TIMEOUT_MS = 120_000;

/**
 * Rolling hills with a second, out-of-phase ripple: enough cliffs, caps and
 * saddles in 64² that the sweep meets every case, and no axis-aligned
 * regularity that could let a grid walk and a triangle test agree by accident.
 */
function terrainHeight(cellX: number, cellY: number): number {
  // THE WAVELENGTHS ARE IN WORLD UNITS, so the hills keep the ground footprint
  // — and therefore the SLOPES — they were tuned for. Left per cell they would
  // have steepened fourfold at the 2026-08-21 re-sample, putting roughly two
  // cells between whole bands where the terrain invariant allows no more than
  // one band per four (MAX_STEP): a world the game cannot contain, all cliff
  // face and no cap, which is precisely the case the two picking rules are
  // entitled to answer differently. Measured: fifteen of the sweep's rays then
  // disagreed about whether they hit terrain at all; restated as land, none do.
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

/**
 * The same world, sculpted, on the FRAME-HOOKED path — so the geometry the rays
 * meet has been through the vertex arena's placement and compaction rather than
 * laid out once in chunk order.
 *
 * WHY THE SWEEP ABOVE IS NOT ENOUGH. A from-scratch build appends every run in
 * the order the chunks arrive, so it never exercises a first fit, a moved run
 * or a zeroed hole: it would pass whatever the arena did with any of them. A
 * sculpted world does exercise all three, and the compactor then reorders the
 * runs — which is what `reordered` below asserts, so this fixture cannot
 * quietly stop being the case it was written for.
 *
 * AND THE CLOCK IS A CONSTANT, which is what makes the holes deterministic. On
 * the real `performance.now` the splice budget decides how many of the dirtied
 * chunks land per frame, and therefore how far behind the frame's single
 * compaction budget falls — a machine-load-dependent amount of dead space,
 * which is no basis for an assertion. Frozen, every dirty chunk splices on one
 * frame (the budget can never be exceeded) and exactly one compaction budget is
 * spent against all of them.
 *
 * THE SCULPT IS A STRIP, not the whole world, for the same reason it is a
 * sculpt at all: dead space is inside the DRAW RANGE, so it is inside the
 * Raycaster's traversal too, and fragmenting all 256 chunks at once would make
 * this sweep several times slower to no extra purpose. Two chunk rows leave
 * more dead space than one frame's ARENA_COMPACT_STROKE_BUDGET_MS can close and
 * a few per cent more triangles to walk.
 */
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
    // Bounded rather than `while (true)`: a queue that stopped draining would
    // otherwise hang the suite instead of failing it.
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

  // A RAISE AND THEN THE ORIGINAL HEIGHTS BACK, so a grow and a shrink both
  // land: the grow moves runs to fresh ground and the shrink opens holes behind
  // them. RESTORED EXACTLY, not merely levelled — the world the rays sweep must
  // be the same world the sweep's agreement thresholds were measured on, so
  // that what this test varies is the LAYOUT of the geometry and nothing else.
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
  // A run whose neighbour in the buffers is not its neighbour by chunk index:
  // proof that placement and compaction, not the arrival order, decided where
  // this geometry sits.
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
    // ONE MESH PER SUPER-MESH, not per chunk (2026-08-21). This world's 256
    // chunks are submitted as 4 draw calls — the merge this differential test
    // has to keep honest, since it raycasts the very geometry the renderer
    // draws. If the merge ever silently reverted, this number would go back to
    // 256 and the pick agreement below would be measuring something else.
    const chunksPerSuperMesh = SUPER_MESH_SPAN_CHUNKS ** 2;
    expect(pickables).toHaveLength((WORLD / CHUNK_SIZE) ** 2 / chunksPerSuperMesh);

    const raycaster = new Raycaster();
    let compared = 0;
    let exact = 0;
    let worstDisagreement = 0;
    /** Rays where exactly one of the two found terrain — must stay zero. */
    let disagreedOnHit = 0;

    // A camera orbiting the world and looking at assorted points on it: the
    // real geometry of a pan, which is the case that made this matter.
    // THE CAMERA IS IN WORLD SPACE and every distance here is a world distance:
    // the orbit is sixty units out from the middle of a sixty-four-unit world
    // and thirty units up, which is the pan this test is about. The X/Z of the
    // orbit is built in CELLS and converted once, because the world's middle is
    // a cell index; the height needs no conversion because the world's relief
    // never moved (config.ts's MAX_RELIEF_WORLD_UNITS, unchanged through both
    // the re-terrace and the re-sample).
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
          // The raycast's own cell is the hit point rounded to the nearest
          // cell centre — worldPointToCell's rule, the one picking used before.
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
      // THE ARENA IS INSIDE THE RAYCAST. Its dead space sits within the draw
      // range — a hole is not skipped by the GPU or by the Raycaster, only
      // zeroed — and its live runs are wherever placement and compaction put
      // them. A `copyWithin` that moved a run by the wrong length, or a zeroing
      // that ate one vertex too many, would show up here as rays hitting
      // terrain that is not there, which is the same failure a player's clicks
      // would show.
      const { mirror, pickables, deadVertices, reordered } = buildSculptedWorld();
      expect(reordered).toBe(true);
      // The rays really do cross dead space: a hole is not skipped by anything,
      // it is simply three zero positions per triangle, which is zero area and
      // which `Ray.intersectTriangle` rejects for `DdN === 0`.
      expect(deadVertices).toBeGreaterThan(0);
      sweep(mirror, pickables);
    },
  );
});
