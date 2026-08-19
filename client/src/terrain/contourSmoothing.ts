// Contour smoothing — pipeline step 2 of vertexGrid.ts's overview: Chaikin
// corner cutting with border vertices pinned (seam contract S4), the
// cell-centre guard (the honesty invariant's belt) and collinear-vertex
// simplification. Split out of vertexGrid.ts (issue #10); see that facade for
// the pipeline overview and the contracts this code implements.

import {
  CONTOUR_CELL_CENTRE_GUARD,
  RECT_NONE,
  samePoint,
  type ContourLoop,
  type ContourPoint,
} from './contours.ts';

/**
 * Corner-cutting passes over each contour. Each pass replaces every vertex with
 * two points a quarter of the way along its two edges, so the polyline gets 2×
 * the vertices and visibly rounder.
 *
 * TWO passes. One still shows the 45° facets marching squares produces on a
 * diagonal run; three costs 8× the vertices (and 8× the cap triangles) for a
 * change no longer visible at the camera distances the game allows, and starts
 * to shrink small features enough to matter. Two is where the outline reads as
 * drawn rather than sampled.
 */
export const CHAIKIN_ITERATIONS = 2;

/**
 * Where Chaikin cuts each corner. 1/4 is the classical value: the limit curve
 * is a quadratic B-spline, and the cut points stay inside the original polyline
 * (they are convex combinations of its vertices), which is exactly the property
 * the cell-centre guard leans on.
 */
export const CHAIKIN_CUT = 1 / 4;

/**
 * Cell units of deviation below which a smoothed vertex is dropped as
 * collinear. Chaikin subdivides straight runs as eagerly as curved ones, and a
 * contour crossing a flat plateau edge is mostly straight runs; dropping the
 * redundant vertices costs one pass and removes cap triangles that carry no
 * shape. 1/4096 of a cell is far under a pixel at any camera distance, so
 * nothing visible is simplified away.
 */
export const CONTOUR_SIMPLIFY_EPSILON = 1 / 4096;

// ---------------------------------------------------------------------------
// Smoothing
// ---------------------------------------------------------------------------

/**
 * One Chaikin pass over a CLOSED loop, with border vertices pinned.
 *
 * Ordinary vertices are replaced by two points a CHAIKIN_CUT fraction in from
 * each end of their edges, which rounds the corner. A vertex on the chunk
 * border keeps its exact position and its corner is not cut (seam contract S4),
 * so a run of border vertices stays a straight line along the border and an arc
 * arriving at the border still arrives at precisely the neighbour's point.
 */
function chaikinPass(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 3) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % n];
    const aPinned = a.rect !== RECT_NONE;
    const bPinned = b.rect !== RECT_NONE;
    const first = aPinned
      ? a
      : {
          x: a.x + (b.x - a.x) * CHAIKIN_CUT,
          z: a.z + (b.z - a.z) * CHAIKIN_CUT,
          rect: RECT_NONE,
        };
    const second = bPinned
      ? b
      : {
          x: a.x + (b.x - a.x) * (1 - CHAIKIN_CUT),
          z: a.z + (b.z - a.z) * (1 - CHAIKIN_CUT),
          rect: RECT_NONE,
        };
    pushDistinct(out, first);
    pushDistinct(out, second);
  }
  // The wrap-around can duplicate the first point; the loop is implicit.
  if (out.length > 1 && samePoint(out[0], out[out.length - 1])) out.pop();
  return out;
}

function pushDistinct(out: ContourLoop, p: ContourPoint): void {
  if (out.length > 0 && samePoint(out[out.length - 1], p)) return;
  out.push(p);
}

/**
 * Pushes any smoothed vertex back out of the guard disc around its nearest cell
 * centre — the belt to the crossing clamp's braces (see
 * CONTOUR_CELL_CENTRE_GUARD). Border vertices are exempt: they lie on the
 * lattice lines that run THROUGH cell centres, they are shared with the
 * neighbouring chunk, and moving them would break the seam. What that costs is
 * bounded and stated: the guarantee is over cell centres strictly inside a
 * chunk's domain; on the domain border the two chunks agree with each other,
 * which is what keeps the surface watertight there.
 */
function enforceCentreGuard(loop: ContourLoop): void {
  for (const p of loop) {
    if (p.rect !== RECT_NONE) continue;
    const cx = Math.round(p.x);
    const cz = Math.round(p.z);
    const dx = p.x - cx;
    const dz = p.z - cz;
    const d = Math.sqrt(dx * dx + dz * dz);
    if (d >= CONTOUR_CELL_CENTRE_GUARD) continue;
    if (d === 0) {
      // Exactly on a centre: push along +x, deterministically.
      p.x = cx + CONTOUR_CELL_CENTRE_GUARD;
      continue;
    }
    const scale = CONTOUR_CELL_CENTRE_GUARD / d;
    p.x = cx + dx * scale;
    p.z = cz + dz * scale;
  }
}

/** Drops vertices that carry no shape (see CONTOUR_SIMPLIFY_EPSILON). */
function dropCollinear(loop: ContourLoop): ContourLoop {
  const n = loop.length;
  if (n < 4) return loop;
  const out: ContourLoop = [];
  for (let i = 0; i < n; i++) {
    const prev = out.length > 0 ? out[out.length - 1] : loop[(i + n - 1) % n];
    const here = loop[i];
    const next = loop[(i + 1) % n];
    if (here.rect !== RECT_NONE) {
      out.push(here);
      continue;
    }
    const area = Math.abs(
      (here.x - prev.x) * (next.z - prev.z) - (here.z - prev.z) * (next.x - prev.x),
    );
    const base = Math.hypot(next.x - prev.x, next.z - prev.z);
    if (base > 0 && area / base < CONTOUR_SIMPLIFY_EPSILON) continue;
    out.push(here);
  }
  return out.length >= 3 ? out : loop;
}

export function smoothLoop(loop: ContourLoop): ContourLoop {
  let current = loop;
  for (let pass = 0; pass < CHAIKIN_ITERATIONS; pass++) {
    current = chaikinPass(current);
  }
  enforceCentreGuard(current);
  return dropCollinear(current);
}
