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

/**
 * How fast a drawn mover chases the ground under it, in world units per second.
 *
 * 1.0 — one BAND_WORLD_HEIGHT (0.25 world units, client/src/config.ts) every
 * quarter second. Derived from what the motion has to READ as rather than from
 * a tuning pass: stepping up onto a terrace is a STEP, and a quarter second is
 * the shape of one — fast enough that a walker never appears to float up a
 * riser it has already walked over, slow enough that the rise is visible motion
 * instead of a teleport.
 *
 * IT IS ALSO THE CEILING ON EVERY OTHER VERTICAL MOTION A MOVER HAS, which is
 * what makes one constant enough: a climb rises at
 * CLIMB_RISE_HEIGHT_UNITS_PER_SECOND (@terrace/shared) = 4 height units/s =
 * 0.0625 world units/s, sixteen times slower than this, so a climbing body is
 * drawn exactly where the server says it is rather than lagging behind it. A
 * FALL is the one motion faster than this, and it is drawn from the server's
 * own height for that reason (see the walkers' `climbHeight`).
 */
export const GROUND_FOLLOW_WORLD_UNITS_PER_SECOND = 1;

/**
 * A gap this big or bigger is not a step, so it is not eased — the mover is
 * simply drawn at the new height.
 *
 * 1.0 world units = four bands = the whole of MAX_RELIEF_WORLD_UNITS / 16. What
 * produces a gap that size is never walking: it is a spawn, a respawn, a
 * teleport home, a chunk arriving out of the fog, or a player sculpting the
 * ground out from under the mover. Easing through those would draw a body
 * sliding across the sky for a second, which is a worse lie than the snap this
 * function exists to remove.
 */
export const GROUND_FOLLOW_SNAP_WORLD_UNITS = 1;

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
  if (Math.abs(gap) >= snapGap) return targetY;
  const budget = ratePerSecond * Math.max(0, dt);
  return previousY + Math.max(-budget, Math.min(budget, gap));
}
