// Keeps the camera above the ground it is flying over.
//
// WHY THIS EXISTS. OrbitControls' `minDistance` is measured from the ORBIT
// TARGET, and that target lives on a horizontal plane: core sets it at y = 0
// (render/scene.ts's focusWorld), our trackpad pan translates it with
// horizontal ground axes only (input/wheelCamera.ts's groundPanOffset), and
// OrbitControls' own zoom-to-cursor re-places it by intersecting the view ray
// with a horizontal plane THROUGH THE CURRENT TARGET (OrbitControls.js in
// three 0.185.1, update(): `_plane.setFromNormalAndCoplanarPoint(object.up,
// target)`), never by raycasting geometry. So the zoom clamp measures distance
// to a flat base plane, and the distance to the LANDSCAPE — the thing a player
// is actually approaching — was unbounded in both directions: over a
// maximum-relief peak (MAX_RELIEF_WORLD_UNITS = 16) the closest zoom put
// the camera underneath the summit, inside the mountain.
//
// This module is the missing half: a per-frame floor under the camera's Y,
// applied AFTER OrbitControls has moved it. That ordering is the whole point —
// a lift applied before `controls.update()` is simply overwritten by it, which
// is why this is not an `onFrame` callback (those run before the update).
//
// LIFTING THE CAMERA ALONE, NOT THE WHOLE RIG. The correction moves
// `camera.position.y` and leaves `controls.target` where it is, so at the
// floor the orbit stops descending instead of the view sliding off what the
// player was looking at. OrbitControls re-derives its spherical offset from
// `position - target` at the top of every update (same reasoning as the
// direct camera writes in input/wheelCamera.ts), so the lift is picked up as
// the new orbit rather than fought.
//
// RESIDUAL FAILURE MODE, deliberately not addressed here: this clears the
// terrain DIRECTLY UNDER the camera and nothing else. A ridge standing between
// the camera and its target can still cross the view, and a camera beside a
// cliff face is still beside it — correctly, since it is not over that column.
// Fixing the first would need a swept test along the camera-to-target segment;
// it is a different feature (occlusion), not this floor.

import { CAMERA_GROUND_CLEARANCE_WORLD_UNITS } from '../config.ts';

/**
 * World-space Y of the rendered terrain surface under a world-space (x, z),
 * or null where there is no answer — outside the world, or before the first
 * snapshot has defined a world at all. Null means "do not clamp": an unknown
 * ground is not a ground at sea level, and guessing one would yank the camera.
 */
export type GroundHeightSampler = (
  worldX: number,
  worldZ: number,
) => number | null;

/** The clearance in world units. Cells are the world unit, so this is a rename. */
const CLEARANCE_WORLD_UNITS = CAMERA_GROUND_CLEARANCE_WORLD_UNITS;

/**
 * The camera's Y, raised if it sits below its clearance over the ground.
 * Pure, and the whole of the policy: everything else in this module is the
 * plumbing that decides which ground height to hand it.
 */
export function clearedCameraY(cameraY: number, groundY: number): number {
  const floor = groundY + CLEARANCE_WORLD_UNITS;
  return cameraY < floor ? floor : cameraY;
}

/**
 * Applies the floor to a camera position in place, returning whether it moved.
 * A null sample (off-world, or no world yet) leaves the camera untouched.
 */
export function applyGroundClearance(
  position: { x: number; y: number; z: number },
  sampleGroundY: GroundHeightSampler,
): boolean {
  const groundY = sampleGroundY(position.x, position.z);
  if (groundY === null) return false;
  const cleared = clearedCameraY(position.y, groundY);
  if (cleared === position.y) return false;
  position.y = cleared;
  return true;
}
