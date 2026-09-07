// Following the ground smoothly — the vertical half of drawing a mover.
//
// THE DEFECT (owner, 2026-09-05: "I want them to move smoothly from one band to
// another without just snapping to a different Z height"). Every ground mover in
// this repo drew itself at `terrainHeightAt` — a BAND-QUANTISED sample, i.e. a
// step function. A walker crossing a band boundary therefore teleported a whole
// BAND_WORLD_HEIGHT vertically between two frames, however slowly it was
// walking. Four plugins each wrote that same assignment, so it was four bugs,
// and wildlife had already fixed ITS half for swimmers only (placement.ts's
// `swimmerFrameY`, "ease toward their preferred depth instead of recomputing it
// from a band-quantised seabed each frame") — the fix was known, and it was
// stuck in one plugin behind a swimmer-shaped signature.
//
// SO THIS IS THE CONTRACT, and every mover's drawn Y goes through it: a target
// height is what the mover is standing on, and the drawn height CHASES it at a
// bounded rate. `swimmerFrameY` is now this function plus its water-column
// clamp, so the two can no longer ease differently.
//
// PURE ARITHMETIC, no three and no DOM, for the reason wildlife/client/
// placement.ts states about itself: it is consumed by plugin code that has to
// run in the node test environment.

import {
  SHEER_RISE_TO_RUN,
  CELL_WORLD_SIZE,
  WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND,
} from '@terrace/shared';

/**
 * The tallest vertical step a walker may take without it being a climb, in world
 * units. Anything taller is a climb, drawn from the server's own `climbHeight`
 * rather than eased.
 *
 * A sheer face is SHEER_RISE_TO_RUN of rise to one of run, so on the drawn scale
 * the limit is that many cell-widths tall — no second statement of the
 * height-to-world ratio, which is why this is not written against
 * SHEER_RISE_HEIGHT_UNITS_PER_CELL and the client's HEIGHT_WORLD_SCALE. That
 * pairing also drags client config, and Vite's `import.meta.env` with it, into
 * the node test environment this file's header promises to stay out of.
 */
export const TALLEST_WALKED_STEP_WORLD_UNITS = SHEER_RISE_TO_RUN * CELL_WORLD_SIZE;

/** Seconds a walker spends crossing one cell, at the repo's reference walking speed. */
const CELL_CROSSING_SECONDS = CELL_WORLD_SIZE / WALK_SPEED_FOR_COSTING_WORLD_UNITS_PER_SECOND;

/**
 * How fast a drawn mover chases the ground under it, in world units per second.
 *
 * DERIVED FROM THE TALLEST STEP AND THE CELL, not tuned: the body must be level
 * with the ground again by the time the walker leaves the cell it stepped into,
 * so the rate is the tallest legal walked step over one cell of walking.
 *
 * IT WAS 1.0 AND HAD TO BE RE-DERIVED (2026-09-06). That figure was written when
 * a walked step could not exceed MAX_STEP + RELAX_SLACK = 5 height units, or
 * 0.078 world units — eased in 0.078 s, far inside the 0.5 s a walker spends on
 * a cell, so the lag was invisible. SHEER_RISE_TO_RUN then widened a walked step
 * to 64 height units, a whole world unit and thirteen times as far, and at 1.0
 * that took a full second: two cells of walking. Measured on frostwick-hollows,
 * 2392 walkable pairs (1.69 %) left the body drawn more than a whole cell behind
 * the ground it was standing on — the owner's "peeps walk up to the edge and
 * keep walking".
 */
export const GROUND_FOLLOW_WORLD_UNITS_PER_SECOND =
  TALLEST_WALKED_STEP_WORLD_UNITS / CELL_CROSSING_SECONDS;

/**
 * A gap BIGGER than this is not a step, so it is not eased — the mover is
 * simply drawn at the new height.
 *
 * THE TALLEST STEP A WALKER MAY LEGALLY TAKE, and the comparison is strictly
 * greater for that reason: the maximal walked step is the case this function
 * exists to smooth, so it must not be the case that snaps. It was a hand-written
 * 1.0 whose comment argued that a four-band gap "is never walking" — true until
 * SHEER_RISE_TO_RUN made a four-band step exactly a walk, at which point 344 of
 * the live world's walkable pairs teleported (measured, 2026-09-06).
 *
 * What still exceeds it is never walking: a spawn, a respawn, a teleport home, a
 * chunk arriving out of the fog, or a player sculpting the ground out from under
 * the mover. Easing through those would draw a body sliding across the sky.
 */
export const GROUND_FOLLOW_SNAP_WORLD_UNITS = TALLEST_WALKED_STEP_WORLD_UNITS;

/**
 * One frame of vertical chase. `previousY` is where the mover was DRAWN last
 * frame — null on its first frame, when there is nothing to ease from and the
 * answer is the target itself.
 *
 * `ratePerSecond` defaults to the ground-follow rate above; the callers that
 * pass their own are the ones whose vertical motion is a different thing
 * (a swimmer easing to depth).
 */
export function followGroundY(
  previousY: number | null,
  targetY: number,
  dt: number,
  ratePerSecond: number = GROUND_FOLLOW_WORLD_UNITS_PER_SECOND,
  snapGap: number = GROUND_FOLLOW_SNAP_WORLD_UNITS,
): number {
  if (previousY === null) return targetY;
  const gap = targetY - previousY;
  if (Math.abs(gap) > snapGap) return targetY;
  const budget = ratePerSecond * Math.max(0, dt);
  return previousY + Math.max(-budget, Math.min(budget, gap));
}
