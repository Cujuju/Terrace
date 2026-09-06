// THE TREAD AT THE FOOT OF A STRUCK FACE — where a brush press on a riser
// actually means to act (issue #347, owner report 2026-09-05).
//
// A riser hit names the column whose FACE the ray entered, which is the UPPER
// cell of the step (terrain/picking.ts's march: the pick is cell `i, j` with
// `hitRiser: true` when the ray was already inside that span on entry). A
// Stamp anchored there targets the upper cell's own ceiling plus one band, so
// `fillTowardTarget` raises the clicked band AND the band above it in one
// stroke — the player clicks the side of a step and gets two.
//
// The cell the player meant is the tread they can see at the foot of that
// face: the cell the ray occupied just BEFORE it entered the struck column.
//
// PURE, AND SEPARATE FROM sculptInput.ts ON PURPOSE: its only inputs are a
// pick, the ray's direction and the world size, so the contract can be stated
// against a fixture instead of against a live pointer.

import { CELL_WORLD_SIZE } from '../config.ts';
import { worldPointToCell, type TerrainRayPick, type Vec3 } from './picking.ts';

/**
 * How far PAST the struck cell's plan boundary to look for the cell before it,
 * as a fraction of a cell.
 *
 * A cell owns the half-cell either side of its centre (worldPointToCell
 * rounds), so any step strictly between 0 and half a cell past the boundary
 * lands in the neighbour and no further. A quarter is the midpoint of that
 * interval — the greatest distance from both failure modes (a step too small
 * to leave the struck cell, a step long enough to skip the neighbour).
 */
const FOOT_STEP_BACK_CELLS = 0.25;

/**
 * Below this, the ray's horizontal direction is not a direction: a straight-
 * down ray has no "cell before", and normalising it would amplify float noise
 * into an arbitrary compass bearing. One part in ten thousand of a unit ray.
 */
const MIN_HORIZONTAL_DIRECTION = 1e-4;

/** A cell's plan box reaches half a cell either side of its centre. */
const HALF_CELL = 0.5;

/**
 * The cell a brush press at this pick should anchor to.
 *
 * Returns the pick's OWN cell unchanged when the pick is not a riser hit, and
 * when the ray descends too steeply to name a cell before the struck one.
 *
 * THE STEP GOES BACK TO THE CELL'S PLAN BOUNDARY FIRST, not a fixed distance
 * from the hit. A drawn-face hit (picking.ts's contour refinement) puts
 * `hitX/hitZ` at the smoothed contour, which wanders anywhere inside the
 * struck cell's box; a fixed quarter-cell step from there can stay in the
 * struck cell and hand back the very column the fix exists to avoid. The ray
 * entered the box through one side, and that side is where the cell before
 * it lies.
 *
 * NO OFF-MAP CASE TO REFUSE. The step-back point goes through the one
 * plan-point → cell rule (terrain/picking.ts's `worldPointToCell`), whose
 * settled answer for a point past the border is the nearest EDGE cell (issue
 * #281 A) — and a ray that entered a border column from outside the world has
 * that same border column as its nearest edge cell, so the clamp already
 * yields the fallback a refusal would have to hand back. Null is therefore
 * only what `worldPointToCell` itself calls unanswerable: a non-finite point.
 */
export function footOfFaceCell(
  pick: TerrainRayPick,
  direction: Vec3,
  worldSize: number,
): { x: number; y: number } | null {
  if (!pick.hitRiser) return { x: pick.x, y: pick.y };
  const horizontal = Math.sqrt(direction.x * direction.x + direction.z * direction.z);
  if (!(horizontal > MIN_HORIZONTAL_DIRECTION)) return { x: pick.x, y: pick.y };
  const toEntry = distanceBackToBoxEntry(pick, direction);
  const step = toEntry + (FOOT_STEP_BACK_CELLS * CELL_WORLD_SIZE) / horizontal;
  return worldPointToCell(pick.hitX - direction.x * step, pick.hitZ - direction.z * step, worldSize);
}

/**
 * Ray parameter from the hit point back to where the ray entered the struck
 * cell's plan box: the nearer of the two sides it came in through. Zero when
 * the hit already sits on the boundary (a lattice riser hit).
 */
function distanceBackToBoxEntry(pick: TerrainRayPick, direction: Vec3): number {
  let back = Infinity;
  if (direction.x !== 0) {
    const side = (pick.x + (direction.x > 0 ? -HALF_CELL : HALF_CELL)) * CELL_WORLD_SIZE;
    back = Math.min(back, (pick.hitX - side) / direction.x);
  }
  if (direction.z !== 0) {
    const side = (pick.y + (direction.z > 0 ? -HALF_CELL : HALF_CELL)) * CELL_WORLD_SIZE;
    back = Math.min(back, (pick.hitZ - side) / direction.z);
  }
  return back === Infinity || back < 0 ? 0 : back;
}
