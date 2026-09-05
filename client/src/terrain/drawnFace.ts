// RAY vs THE QUAD A RISER IS ACTUALLY DRAWN AS.
//
// The march in picking.ts walks the cell LATTICE, so the riser it finds is a
// face of the cell's box — the plane x = i ± 0.5 (cell units). The mesh draws
// that riser somewhere else: on the marching-squares contour of the band
// (terrain/capEmission.ts), which for a quantised step runs a fraction of a
// cell INSIDE the higher cell's box. A ray aimed at the face the player can
// see therefore crosses the box face first, earlier and higher.
//
// This module is the one piece of geometry that difference needs: the
// parametric t at which a ray meets a vertical quad standing on a world-space
// segment. Pure — no Three, no map, no config — so the refinement it serves
// can be probed headless.

import type { Vec3 } from './picking.ts';

/**
 * The parameter t ≥ 0 at which `origin + t·direction` meets the vertical quad
 * standing on the world-space segment (ax, az) → (bx, bz) between heights
 * `yLo` and `yHi`, or null when it misses.
 *
 * Null, not an arbitrary answer, in the three degenerate cases: a ray parallel
 * to the wall's plane (it either misses or lies in it, and a ray lying in a
 * face has no meeting point to report), a zero-length segment (no plane to
 * intersect), and a meeting behind the origin.
 *
 * The quad's own extent is CLOSED at both ends — a hit exactly on the lower
 * edge, the upper edge, or an endpoint counts. Contours are shared between
 * adjacent bands and adjacent segments, so rejecting the boundary would open a
 * seam through which a ray could pass between two faces that touch.
 */
export function intersectRayWithWall(
  origin: Vec3,
  direction: Vec3,
  ax: number,
  az: number,
  bx: number,
  bz: number,
  yLo: number,
  yHi: number,
): number | null {
  const ex = bx - ax;
  const ez = bz - az;
  const lengthSq = ex * ex + ez * ez;
  if (lengthSq === 0) return null;

  // The wall is vertical, so its plane normal is horizontal: the segment
  // direction turned a quarter turn in the XZ plane.
  const nx = ez;
  const nz = -ex;
  const denom = nx * direction.x + nz * direction.z;
  if (denom === 0) return null;

  const t = (nx * (ax - origin.x) + nz * (az - origin.z)) / denom;
  if (!(t >= 0)) return null;

  const py = origin.y + t * direction.y;
  if (py < yLo || py > yHi) return null;

  // Where along the segment the meeting fell — outside [0, 1] it met the
  // plane beyond the end of this wall.
  const px = origin.x + t * direction.x;
  const pz = origin.z + t * direction.z;
  const s = ((px - ax) * ex + (pz - az) * ez) / lengthSq;
  if (s < 0 || s > 1) return null;

  return t;
}
