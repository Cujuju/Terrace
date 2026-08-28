// THE TWO THINGS THIS PLUGIN DRAWS — the moving front, and what it leaves behind.
//
// ─────────────────────────────────────────────────────────────────────────────
// ONE INSTANCED MESH EACH, AND THAT IS THE POINT.
//
// A slide crosses up to ninety-six cells and this world's draw-call budget is
// the recurring defect in this codebase (the streaming or authoring unit keeps
// becoming the DRAWING unit). So the front is ONE InstancedMesh of clumps and the
// settled debris is ONE more: two draw calls for the whole plugin, whatever is
// happening, with the per-instance work done on the CPU once per frame over at
// most a few hundred matrices.
//
// ─────────────────────────────────────────────────────────────────────────────
// WHICH GROUND ORACLE, AND WHY IT IS THIS ONE.
//
// Both renderers place CLUMPS — lumps of earth STANDING ON the ground — so both
// use `terrainHeightAt` (the lattice height), which ClientPluginCtx says is the
// right oracle for anything standing up and costs nothing. Neither lays a flat
// sheet on the surface, which is the case that would have to ask
// `drawnGroundYAt` instead. That distinction is the water bug this codebase paid
// four rewrites for, so it is named here as well as at each call site.

import {
  Color,
  DodecahedronGeometry,
  InstancedMesh,
  MeshLambertMaterial,
  Object3D,
  type BufferGeometry,
  type Material,
} from 'three';
import { BAND_HEIGHT, CELL_WORLD_SIZE } from '@terrace/shared';

/**
 * Clump radius, in world units.
 *
 * 0.35 — a bit over one cell across at the 2026-08-21 sampling (a cell is 0.25
 * world units). Small enough that a line of them reads as churned earth rather
 * than as boulders, big enough to be visible from an orbit camera's usual height.
 */
const CLUMP_RADIUS_WORLD_UNITS = 0.35;

/**
 * Geometry detail. ZERO — a bare dodecahedron, 36 triangles.
 *
 * These are lumps of mud. Detail on them is invisible at any camera distance the
 * game is played at and multiplies straight through the instance count, which is
 * the one number that matters here.
 */
const CLUMP_DETAIL = 0;

/** Wet earth. Dark and desaturated, so it reads against every terrace band. */
const MUD_COLOR = 0x4a3a2a;

/** The settled debris, drier and lighter than the moving front. */
const DEBRIS_COLOR = 0x6b5740;

/**
 * Clumps drawn per cell of the moving front.
 *
 * SIX. One clump per cell reads as a trail of pebbles; six, jittered around the
 * cell, reads as a mass of moving earth. The front is only ever a few cells long
 * (see FRONT_TAIL_CELLS) so this multiplies a small number.
 */
const CLUMPS_PER_FRONT_CELL = 6;

/**
 * How far back behind the front the moving mass is drawn, in cells.
 *
 * TWELVE — three world units. The front is the head of a flow, not a point: a
 * single cell's worth of clumps at the leading edge looks like a rolling ball,
 * and a tail this long looks like the thing the debris trail was left by.
 */
const FRONT_TAIL_CELLS = 12;

/**
 * The instance ceiling for each mesh.
 *
 * The front's is derived (MAX_ACTIVE_SLIDES × tail × clumps per cell, rounded up
 * for the jitter) rather than stated, so raising either constant above cannot
 * silently truncate the flow. The debris ceiling is a straight budget: 1024
 * clumps is about 37 000 triangles in one call, which is nothing next to one
 * chunk of terrain, and cells past it evict the oldest.
 */
const MAX_FRONT_INSTANCES = 3 * FRONT_TAIL_CELLS * CLUMPS_PER_FRONT_CELL;
const MAX_DEBRIS_INSTANCES = 1024;

/**
 * How far a clump is jittered off its cell centre, in world units.
 *
 * 0.5 — two cells. Enough that six clumps in one cell do not stack into a column,
 * and not so much that the trail stops following the path the mud actually took.
 */
const CLUMP_JITTER_WORLD_UNITS = 0.5;

/**
 * How far a clump sinks into the ground, as a fraction of its radius.
 *
 * 0.4. A sphere sitting exactly ON the surface reads as a ball resting on the
 * ground; sunk by this much it reads as earth that is part of the ground. It also
 * hides the gap where the terrain's drawn contour and its lattice height disagree
 * (ClientPluginCtx.drawnGroundYAt's note) without this plugin having to pay for
 * the more expensive oracle.
 */
const CLUMP_SINK_FRACTION = 0.4;

/**
 * DETERMINISTIC JITTER — a hash of the cell, not `Math.random()`.
 *
 * Two reasons, and the second is the load-bearing one. The obvious one is that a
 * clump must not jump every frame. The other is that the debris mesh is rebuilt
 * whenever a cell is added, so a random offset would re-scatter EVERY existing
 * clump on every new deposit — the whole trail would shimmer as the slide ran.
 */
function jitter(x: number, y: number, index: number): { dx: number; dz: number } {
  // A cheap integer hash (the multiply-xor-shift shape mulberry32 uses), taken to
  // two independent fractions.
  let h = (x * 0x1f1f1f1f) ^ (y * 0x27d4eb2d) ^ (index * 0x165667b1);
  h = Math.imul(h ^ (h >>> 15), h | 1);
  h ^= h + Math.imul(h ^ (h >>> 7), h | 61);
  const a = ((h ^ (h >>> 14)) >>> 0) / 0x100000000;
  const b = ((Math.imul(h, 0x9e3779b1) ^ (h >>> 9)) >>> 0) / 0x100000000;
  return {
    dx: (a - 0.5) * 2 * CLUMP_JITTER_WORLD_UNITS,
    dz: (b - 0.5) * 2 * CLUMP_JITTER_WORLD_UNITS,
  };
}

/** One clump to draw, in cell space, with the scale it is drawn at. */
export interface Clump {
  readonly cellX: number;
  readonly cellY: number;
  /** Which of the several clumps on this cell — feeds the jitter hash. */
  readonly index: number;
  /** Multiplier on CLUMP_RADIUS_WORLD_UNITS. */
  readonly scale: number;
}

/** How the renderer asks the host where the ground is. */
export type GroundAt = (cellX: number, cellY: number) => number | null;

export interface ClumpField {
  readonly mesh: InstancedMesh;
  /** Re-lays every instance. Cheap enough to call per frame at these counts. */
  apply(clumps: readonly Clump[], groundAt: GroundAt): void;
  dispose(): void;
}

function createClumpField(color: number, capacity: number): ClumpField {
  const geometry: BufferGeometry = new DodecahedronGeometry(
    CLUMP_RADIUS_WORLD_UNITS,
    CLUMP_DETAIL,
  );
  // LAMBERT, NOT BASIC: mud is part of the ground and has to take the scene's
  // light, or a slide would glow at night and read as flat by day. The day/night
  // plugin drives those lights, so this needs no light handling of its own.
  const material: Material = new MeshLambertMaterial({ color: new Color(color) });
  const mesh = new InstancedMesh(geometry, material, capacity);
  mesh.count = 0;
  // The instance matrices change every frame while a slide runs, and three's
  // default static hint makes each upload re-validate the whole buffer.
  mesh.frustumCulled = false;
  mesh.castShadow = false;
  mesh.receiveShadow = false;

  const scratch = new Object3D();

  return {
    mesh,
    apply(clumps: readonly Clump[], groundAt: GroundAt): void {
      let drawn = 0;
      for (const clump of clumps) {
        if (drawn >= capacity) break;
        // A THING STANDING ON THE GROUND, so terrainHeightAt is the right oracle
        // — see this file's header. Null means the cell's chunk has not streamed
        // in; the clump is simply not drawn, and this runs every frame so the
        // next one retries for free.
        const groundY = groundAt(clump.cellX, clump.cellY);
        if (groundY === null) continue;

        const offset = jitter(clump.cellX, clump.cellY, clump.index);
        scratch.position.set(
          (clump.cellX + 0.5) * CELL_WORLD_SIZE + offset.dx,
          groundY - CLUMP_RADIUS_WORLD_UNITS * clump.scale * CLUMP_SINK_FRACTION,
          (clump.cellY + 0.5) * CELL_WORLD_SIZE + offset.dz,
        );
        // Rotated by the same hash, so no two clumps present the same facet and
        // the field does not read as a grid of identical rocks.
        scratch.rotation.set(offset.dx * Math.PI, offset.dz * Math.PI, 0);
        scratch.scale.setScalar(clump.scale);
        scratch.updateMatrix();
        mesh.setMatrixAt(drawn, scratch.matrix);
        drawn++;
      }
      mesh.count = drawn;
      mesh.instanceMatrix.needsUpdate = true;
    },
    dispose(): void {
      mesh.dispose();
      geometry.dispose();
      material.dispose();
    },
  };
}

/** The moving mass of mud. */
export function createFrontField(): ClumpField {
  return createClumpField(MUD_COLOR, MAX_FRONT_INSTANCES);
}

/** What settles out behind it. */
export function createDebrisField(): ClumpField {
  return createClumpField(DEBRIS_COLOR, MAX_DEBRIS_INSTANCES);
}

export { FRONT_TAIL_CELLS, CLUMPS_PER_FRONT_CELL, MAX_DEBRIS_INSTANCES };

/**
 * The smallest and largest a settled clump is drawn, as a fraction of
 * CLUMP_RADIUS_WORLD_UNITS.
 *
 * Settled debris is drawn SMALLER than the moving front (whose clumps are drawn
 * at full size and above): the mass has spread out and sunk in. The range gives
 * the pile some variation without any per-clump randomness beyond the jitter hash.
 */
const DEBRIS_MIN_SCALE = 0.6;
const DEBRIS_MAX_SCALE = 0.95;

/**
 * Turns one deposited cell into the clumps that stand on it.
 *
 * DEEPER DEBRIS MEANS MORE CLUMPS, so the run-out's lobe is visibly thicker than
 * the veneer along the track — which is the shape the server's deposit rule
 * actually produces (slides.ts's MUDSLIDE_TRACK_DEPOSIT_FRACTION), and the only
 * way a viewer can see that it does.
 *
 * Depth arrives in HEIGHT units; a terrace BAND is the vertical quantum a viewer
 * can actually resolve, so the count is one clump per band, floored at one — a
 * deposit too thin to move the terrain a whole band still leaves a mark.
 */
export function debrisClumps(x: number, y: number, depthHeightUnits: number): Clump[] {
  const bands = Math.max(1, Math.round(depthHeightUnits / BAND_HEIGHT));
  const count = Math.min(CLUMPS_PER_FRONT_CELL, bands);
  const clumps: Clump[] = [];
  for (let index = 0; index < count; index++) {
    const t = count === 1 ? 0 : index / (count - 1);
    clumps.push({
      cellX: x,
      cellY: y,
      index,
      scale: DEBRIS_MIN_SCALE + t * (DEBRIS_MAX_SCALE - DEBRIS_MIN_SCALE),
    });
  }
  return clumps;
}
