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
import { BAND_HEIGHT, CHUNK_SIZE, type ChunkPayload } from '@terrace/shared';
import { applySnapshot, createTerrainMirror } from '../src/terrain/mirror.ts';
import { createTerrainMeshes } from '../src/render/terrainMeshes.ts';
import { pickTerrainCellByRay } from '../src/terrain/picking.ts';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../src/config.ts';

const WORLD = 64;
const CELLS_PER_CHUNK = CHUNK_SIZE * CHUNK_SIZE;

/**
 * How far the two picks may ever land apart, in cells.
 *
 * ONE, and one only where the ray strikes a cliff FACE. The mesh draws that
 * face on the smoothed contour, which wanders within the boundary cell
 * (vertexGrid.ts step 2); the march draws it on the cell boundary itself. A
 * hit on either lands within half a cell of the other, so rounding to a cell
 * centre can differ by one — and on that face the raycast's own answer is
 * already arbitrary, since the contour it hit IS the border between the two
 * cells. Anywhere the ray lands on a flat cap — which is every pick that is
 * not a grazing shot at a riser — the two agree exactly.
 */
const MAX_CELL_DISAGREEMENT = 1;

/**
 * Share of picks that must match EXACTLY, not merely within a cell.
 *
 * Measured at 97.2% over the sweep below; the floor is set a little under that
 * so ordinary contour-smoothing tweaks do not fail the build, while a change
 * that genuinely decouples the pick from the mesh — which would send this
 * toward chance — still does.
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
 * Rolling hills with a second, out-of-phase ripple: enough cliffs, caps and
 * saddles in 64² that the sweep meets every case, and no axis-aligned
 * regularity that could let a grid walk and a triangle test agree by accident.
 */
function terrainHeight(x: number, y: number): number {
  return Math.round(
    (Math.sin(x / 9) * Math.cos(y / 7) * 6 + Math.sin((x + y) / 13) * 4) * BAND_HEIGHT,
  );
}

function buildWorld(): { mirror: ReturnType<typeof createTerrainMirror>; pickables: Mesh[] } {
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
  const mirror = createTerrainMirror(WORLD);
  const group = new Group();
  const meshes = createTerrainMeshes(group, mirror);
  meshes.update(applySnapshot(mirror, { type: 'snapshot', worldSize: WORLD, chunks }));
  return { mirror, pickables: meshes.pickables() as Mesh[] };
}

describe('pickTerrainCellByRay vs the mesh raycast it replaced', () => {
  it('agrees on the cell, and never disagrees about whether there is terrain at all', () => {
    const { mirror, pickables } = buildWorld();
    expect(pickables).toHaveLength((WORLD / CHUNK_SIZE) ** 2);

    const raycaster = new Raycaster();
    let compared = 0;
    let exact = 0;
    let worstDisagreement = 0;
    /** Rays where exactly one of the two found terrain — must stay zero. */
    let disagreedOnHit = 0;

    // A camera orbiting the world and looking at assorted points on it: the
    // real geometry of a pan, which is the case that made this matter.
    const CAMERA_ORBIT_CELLS = 60;
    const CAMERA_HEIGHT_WORLD_UNITS = 30;
    for (let degrees = 0; degrees < 360; degrees += 7) {
      const angle = (degrees * Math.PI) / 180;
      const camera = new Vector3(
        32 + CAMERA_ORBIT_CELLS * Math.cos(angle),
        CAMERA_HEIGHT_WORLD_UNITS,
        32 + CAMERA_ORBIT_CELLS * Math.sin(angle),
      );
      for (let tx = 4; tx < 60; tx += 5) {
        for (let tz = 4; tz < 60; tz += 11) {
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
  });
});
