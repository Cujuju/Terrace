// The sea: a single flat translucent plane at SEA_LEVEL.
//
// Design decision Q3 (docs/DESIGN.md): water is a DERIVED fact of the
// heightmap, never simulated state — anything at or below SEA_LEVEL is
// underwater. So there is nothing to sync and nothing to update per tick; this
// is one static quad. Phase 1 deliberately adds no wave or shimmer animation:
// the doc allows it as a purely client-side visual, but it earns nothing yet
// and a still sea makes the terrace steps easier to judge while tuning them.

import {
  DoubleSide,
  Mesh,
  MeshStandardMaterial,
  PlaneGeometry,
  type Object3D,
} from 'three';
import { SEA_LEVEL } from '@terrace/shared';
import {
  CELL_WORLD_SIZE,
  HEIGHT_WORLD_SCALE,
  WATER_SURFACE_LIFT,
} from '../config.ts';

const WATER_COLOR = 0x2f6f9e;
/** Translucent enough to show the seabed colour and submerged terraces. */
const WATER_OPACITY = 0.62;
const WATER_ROUGHNESS = 0.15;
const WATER_METALNESS = 0.1;

/**
 * Cells of open ocean drawn beyond the world's edge. Purely cosmetic: it stops
 * the sea ending in a visible straight edge when the camera looks outward past
 * a small revealed area.
 */
const WATER_MARGIN_CELLS = 256;

/** Quarter turn: PlaneGeometry is built in XY, and the sea lies in XZ. */
const PLANE_TO_GROUND_ROTATION_X = -Math.PI / 2;

export interface Water {
  /** Re-sizes and re-centres the sea once the world's size is known. */
  setWorldSize(worldSize: number): void;
  dispose(): void;
}

export function createWater(parent: Object3D, initialWorldSize: number): Water {
  const material = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: WATER_OPACITY,
    roughness: WATER_ROUGHNESS,
    metalness: WATER_METALNESS,
    // Terrain is opaque and therefore drawn first; the sea then blends over
    // it. Not writing depth is what lets submerged terrain remain visible
    // through the surface instead of being hidden by it.
    depthWrite: false,
    // Visible from below, for when the camera dips toward the horizon.
    side: DoubleSide,
  });

  const mesh = new Mesh(new PlaneGeometry(1, 1), material);
  mesh.rotation.x = PLANE_TO_GROUND_ROTATION_X;
  // Lifted off the SEA_LEVEL plane on purpose — band-0 terrain renders exactly
  // there and would z-fight. See WATER_SURFACE_LIFT for the full reasoning.
  mesh.position.y = SEA_LEVEL * HEIGHT_WORLD_SCALE + WATER_SURFACE_LIFT;
  parent.add(mesh);

  const setWorldSize = (worldSize: number): void => {
    const span = (worldSize - 1 + WATER_MARGIN_CELLS * 2) * CELL_WORLD_SIZE;
    const centre = ((worldSize - 1) * CELL_WORLD_SIZE) / 2;
    // Rebuilding this geometry is fine: it happens once per join, not per
    // edit. The no-rebuild rule is about the terrain patch path.
    mesh.geometry.dispose();
    mesh.geometry = new PlaneGeometry(span, span);
    mesh.position.x = centre;
    mesh.position.z = centre;
  };

  setWorldSize(initialWorldSize);

  return {
    setWorldSize,
    dispose(): void {
      parent.remove(mesh);
      mesh.geometry.dispose();
      material.dispose();
    },
  };
}
