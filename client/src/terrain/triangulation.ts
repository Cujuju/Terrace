// Triangulation — pipeline step 3 of vertexGrid.ts's overview: grouping a
// level's loops into outer polygons with holes, splicing the holes in with
// ray-cast bridges, and ear clipping the merged polygons. Split out of
// vertexGrid.ts (issue #10); see that facade for the pipeline overview. The
// exact-triangle-count prediction (a polygon of V vertices with H holes
// triangulates to V + 2H − 2) that capEmission.ts's verification depends on is
// held up by earClip's split bookkeeping here.

import { CHUNK_SIZE } from '@terrace/shared';
import { RECT_NONE, samePoint, type ContourLoop, type ContourPoint } from './contours.ts';

/**
 * How many candidate bridges the fallback search in bridgeHole tries before it
 * gives up and takes the nearest one regardless.
 *
 * The search only runs when the straight ray-cast bridge is obstructed, which
 * needs a genuinely convoluted outline; 64 nearest candidates is far more than
 * such a case has ever needed and bounds the work at O(64 × outline) so one
 * awkward hole cannot become a stall.
 */
const BRIDGE_SEARCH_LIMIT = 64;

/**
 * Width, in cell units, of the sliver a hole bridge is opened to. See
 * bridgeHole: a zero-width bridge leaves the merged polygon only weakly simple,
 * and ear clipping is not guaranteed to finish on one of those.
 */
const BRIDGE_SLIT_WIDTH = 1e-6;

// ---------------------------------------------------------------------------
// Triangulation — outer loops with holes, by ear clipping
// ---------------------------------------------------------------------------

function signedArea(loop: ContourLoop): number {
  let sum = 0;
  for (let i = 0; i < loop.length; i++) {
    const a = loop[i];
    const b = loop[(i + 1) % loop.length];
    sum += a.x * b.z - b.x * a.z;
  }
  return sum / 2;
}

function pointInLoop(px: number, pz: number, loop: ContourLoop): boolean {
  let inside = false;
  for (let i = 0, j = loop.length - 1; i < loop.length; j = i++) {
    const a = loop[i];
    const b = loop[j];
    if (a.z > pz !== b.z > pz) {
      const t = (pz - a.z) / (b.z - a.z);
      if (px < a.x + t * (b.x - a.x)) inside = !inside;
    }
  }
  return inside;
}

function turn(ax: number, az: number, bx: number, bz: number, cx: number, cz: number): number {
  return (bx - ax) * (cz - az) - (bz - az) * (cx - ax);
}

/**
 * Containment in a triangle, edges included and winding irrelevant — the caller
 * (bridgeHole's refinement) builds its triangle from a ray and cannot know
 * which way round it came out.
 */
function pointInTriangle(
  ax: number,
  az: number,
  bx: number,
  bz: number,
  cx: number,
  cz: number,
  px: number,
  pz: number,
): boolean {
  const d1 = turn(ax, az, bx, bz, px, pz);
  const d2 = turn(bx, bz, cx, cz, px, pz);
  const d3 = turn(cx, cz, ax, az, px, pz);
  const anyNegative = d1 < 0 || d2 < 0 || d3 < 0;
  const anyPositive = d1 > 0 || d2 > 0 || d3 > 0;
  return !(anyNegative && anyPositive);
}

/**
 * Whether the point (px,pz) lies on the INSIDE of `loop` as seen from the
 * loop's vertex `i` — i.e. inside the wedge that vertex's two edges cut out of
 * the plane. A convex corner's wedge is the one between its edges; a reflex
 * corner's is everything except the wedge between them.
 *
 * It is a local test, not a containment test, and that is exactly what
 * bridgeHole's refinement needs: a candidate landing vertex whose wedge does
 * not face the hole cannot be the end of a bridge that runs through the
 * interior, however close it is. (earcut calls this locallyInside.)
 */
function seesPoint(loop: ContourLoop, i: number, px: number, pz: number): boolean {
  const n = loop.length;
  const a = loop[i];
  const prev = loop[(i + n - 1) % n];
  const next = loop[(i + 1) % n];
  if (turn(prev.x, prev.z, a.x, a.z, next.x, next.z) > 0) {
    return (
      turn(a.x, a.z, px, pz, next.x, next.z) <= 0 &&
      turn(a.x, a.z, prev.x, prev.z, px, pz) <= 0
    );
  }
  return (
    turn(a.x, a.z, px, pz, prev.x, prev.z) > 0 ||
    turn(a.x, a.z, next.x, next.z, px, pz) > 0
  );
}

function segmentsCross(
  a: ContourPoint,
  b: ContourPoint,
  c: ContourPoint,
  d: ContourPoint,
): boolean {
  const d1 = turn(a.x, a.z, b.x, b.z, c.x, c.z);
  const d2 = turn(a.x, a.z, b.x, b.z, d.x, d.z);
  const d3 = turn(c.x, c.z, d.x, d.z, a.x, a.z);
  const d4 = turn(c.x, c.z, d.x, d.z, b.x, b.z);
  // Strict crossing only: touching at a shared endpoint (which every bridge
  // does, at both ends) must not count as a blocked line of sight.
  return d1 * d2 < 0 && d3 * d4 < 0;
}

/**
 * Splices a hole into its outer loop with a two-way bridge, so the pair becomes
 * one simple polygon the ear clipper can eat.
 *
 * The bridge runs from the hole's RIGHTMOST vertex straight out along +x to the
 * first outer edge the ray meets, and lands on that edge's right-hand endpoint
 * — the classic ray-cast bridge. Nothing can lie between the hole and that edge
 * except outer vertices that stick back INTO the ray's triangle, so the search
 * is refined over those (and only those) by picking the one at the shallowest
 * angle, which is always visible from the hole.
 *
 * COST, and it is the reason for the shape of this function: bridging is the
 * hot spot of the whole builder on fragmented terrain. A chunk of alternating
 * stamped cells makes ~100 holes inside one region, and the outer polygon grows
 * with every bridge spliced into it, so an O(outer × hole) candidate search
 * with a sort — the obvious "shortest clear bridge" — measured 330 ms per chunk
 * on that terrain. This one is a single O(outer) pass per hole: the same chunk
 * measures ~10 ms.
 */
export function bridgeHole(outer: ContourLoop, hole: ContourLoop): ContourLoop {
  let holeIndex = 0;
  for (let j = 1; j < hole.length; j++) {
    if (hole[j].x > hole[holeIndex].x) holeIndex = j;
  }
  const hx = hole[holeIndex].x;
  const hz = hole[holeIndex].z;

  // Nearest outer edge to the right of the hole, on the ray z = hz.
  let hitX = Infinity;
  let outerIndex = -1;
  for (let i = 0; i < outer.length; i++) {
    const a = outer[i];
    const b = outer[(i + 1) % outer.length];
    if (a.z === b.z) continue;
    if (hz < Math.min(a.z, b.z) || hz > Math.max(a.z, b.z)) continue;
    const x = a.x + ((hz - a.z) / (b.z - a.z)) * (b.x - a.x);
    if (x < hx || x >= hitX) continue;
    hitX = x;
    outerIndex = a.x > b.x ? i : (i + 1) % outer.length;
  }
  // REFINEMENT, and it is what the ray cast alone gets wrong (measured
  // 2026-08-14). The hit edge's larger-x end is the right landing vertex only
  // when nothing stands between the hole and it, and on a chunk-sized outline
  // that is usually FALSE: the hit edge is the domain's own east border, whose
  // larger-x end is a corner sixteen cells away, and almost anything — the
  // hole's own far side above all — stands in the way. Every such obstruction
  // is an outer vertex lying inside the triangle (hole point, ray hit, that
  // endpoint): a vertex outside the triangle cannot block a sight line that
  // stays inside it. So one O(outer) pass over exactly those vertices, keeping
  // the one at the shallowest angle to the ray, lands the bridge on a vertex
  // the hole can actually see. This is earcut's findHoleBridge refinement,
  // mirrored (our ray runs +x, so "closer to the hole" is SMALLER x).
  //
  // The comment this replaces claimed the refinement was already here; it was
  // not, and the cost fell on the fallback search below — which fired on
  // essentially every crater bridge and, at O(outer × hole) plus a sort plus
  // BRIDGE_SEARCH_LIMIT visibility passes, was over HALF the build time of a
  // chunk with three craters in it (2.13 ms of 4.17 ms).
  if (outerIndex >= 0) {
    const mx = outer[outerIndex].x;
    const mz = outer[outerIndex].z;
    let bestTangent = Infinity;
    for (let i = 0; i < outer.length; i++) {
      if (i === outerIndex) continue;
      const p = outer[i];
      // Only vertices strictly beyond the ray's start and no further out than
      // the current landing vertex can be in the way.
      if (p.x <= hx || p.x > mx) continue;
      if (!pointInTriangle(hx, hz, hitX, hz, mx, mz, p.x, p.z)) continue;
      if (!seesPoint(outer, i, hx, hz)) continue;
      // Tangent of the angle between the ray and the candidate: the smallest
      // one is visible from the hole, because anything that could hide it would
      // itself sit at a smaller angle and be picked instead.
      const tangent = Math.abs(hz - p.z) / (p.x - hx);
      if (tangent < bestTangent || (tangent === bestTangent && p.x < outer[outerIndex].x)) {
        bestTangent = tangent;
        outerIndex = i;
      }
    }
  }

  // The refined landing point is the usual answer, but not a guaranteed one:
  // the refinement assumes an outline that is simple to begin with. Verifying
  // costs one more O(outer + hole) pass, and only when it fails does the search
  // widen to "the nearest vertex with a clear line", which is what the first
  // version of this function did for EVERY hole — and what made it 300 ms.
  const clear = (i: number, j: number): boolean => {
    const a = outer[i];
    const b = hole[j];
    for (let k = 0; k < outer.length; k++) {
      if (segmentsCross(a, b, outer[k], outer[(k + 1) % outer.length])) return false;
    }
    for (let k = 0; k < hole.length; k++) {
      if (segmentsCross(a, b, hole[k], hole[(k + 1) % hole.length])) return false;
    }
    return true;
  };

  if (outerIndex < 0 || !clear(outerIndex, holeIndex)) {
    const candidates: { outerIndex: number; holeIndex: number; distance: number }[] = [];
    for (let i = 0; i < outer.length; i++) {
      for (let j = 0; j < hole.length; j++) {
        candidates.push({
          outerIndex: i,
          holeIndex: j,
          distance: (outer[i].x - hole[j].x) ** 2 + (outer[i].z - hole[j].z) ** 2,
        });
      }
    }
    candidates.sort((a, b) => a.distance - b.distance);
    let found = false;
    for (const candidate of candidates.slice(0, BRIDGE_SEARCH_LIMIT)) {
      if (!clear(candidate.outerIndex, candidate.holeIndex)) continue;
      outerIndex = candidate.outerIndex;
      holeIndex = candidate.holeIndex;
      found = true;
      break;
    }
    if (!found && outerIndex < 0) {
      outerIndex = candidates[0].outerIndex;
      holeIndex = candidates[0].holeIndex;
    }
  }

  // The bridge is walked out and back, and the classic splice walks it over the
  // SAME two points twice — a zero-width slit. That makes the merged polygon
  // only weakly simple, and a weakly simple polygon has no guaranteed ear: ear
  // clipping stalls at the slit, and (measured, before this) leaves a fifth of
  // a band's cap untriangulated, which shows as a hole in the terrain. Opening
  // the slit to BRIDGE_SLIT_WIDTH makes the polygon strictly simple, so the two
  // ears theorem applies again and the triangulation always completes. The
  // width is a millionth of a cell: seven orders of magnitude above the
  // arithmetic's noise at the far corner of the largest world, and utterly
  // invisible. Skirts are built from the un-merged contour loops, so they never
  // see it at all.
  const bridgeX = outer[outerIndex].x - hole[holeIndex].x;
  const bridgeZ = outer[outerIndex].z - hole[holeIndex].z;
  const bridgeLength = Math.hypot(bridgeX, bridgeZ) || 1;
  const slitX = (-bridgeZ / bridgeLength) * BRIDGE_SLIT_WIDTH;
  const slitZ = (bridgeX / bridgeLength) * BRIDGE_SLIT_WIDTH;

  const merged: ContourLoop = [];
  for (let i = 0; i <= outerIndex; i++) merged.push(outer[i]);
  for (let j = 0; j < hole.length; j++) {
    merged.push(hole[(holeIndex + j) % hole.length]);
  }
  merged.push({
    x: hole[holeIndex].x + slitX,
    z: hole[holeIndex].z + slitZ,
    rect: RECT_NONE,
  });
  merged.push({
    x: outer[outerIndex].x + slitX,
    z: outer[outerIndex].z + slitZ,
    rect: RECT_NONE,
  });
  for (let i = outerIndex + 1; i < outer.length; i++) merged.push(outer[i]);
  return merged;
}

/**
 * Ear clipping for a counter-clockwise simple polygon.
 *
 * O(n²) in the worst case, which is the right trade here: n is a smoothed
 * contour inside ONE chunk (tens to a few hundred vertices), and the
 * alternatives that beat it asymptotically all need either a dependency or a
 * sweepline whose degenerate cases are exactly the ones marching squares
 * produces. The iteration guard means a polygon we somehow made non-simple
 * costs a bounded amount of work and loses a few triangles rather than hanging
 * the render loop.
 */
export function earClip(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): void {
  // A queue rather than one pass: a polygon that stalls (see clipEars) is cut
  // in two along a diagonal and both halves go back in. Splitting conserves the
  // triangle count exactly — an n-gon split at a diagonal becomes an n₁-gon and
  // an n₂-gon with n₁ + n₂ = n + 2, and (n₁−2) + (n₂−2) = n−2 — which is what
  // keeps the caller's exact triangle prediction (and therefore its capacity
  // and its verification) honest.
  const pending: ContourLoop[] = [polygon];
  let splits = 0;
  while (pending.length > 0) {
    const poly = pending.pop() as ContourLoop;
    const stalled = clipEars(poly, emit);
    if (stalled === null) continue;
    if (splits >= EAR_CLIP_SPLIT_LIMIT) continue;
    const halves = splitPolygon(stalled);
    if (halves === null) continue;
    splits++;
    pending.push(halves[0], halves[1]);
  }
}

/**
 * How many times one polygon may be cut in two before triangulation gives up
 * and lets the caller fall back to blocky geometry.
 *
 * Splitting is the rare path — it needs a polygon whose bridges left it
 * pinched, which is a handful per thousand chunks — and each split is an O(n²)
 * diagonal search, so the limit is what keeps a pathological outline from
 * turning into a long chain of searches. 64 is far beyond anything measured.
 */
const EAR_CLIP_SPLIT_LIMIT = 64;

/**
 * Twice the area of the triangle below which a point counts as lying ON a
 * segment rather than beside it. Contour coordinates are cell-scale, so 1e-9
 * is far below any real geometry and far above the rounding of the arithmetic
 * that produced it.
 */
const COLLINEAR_TOUCH_EPSILON = 1e-9;

/**
 * Clips ears until none is left. Returns null when the polygon was fully
 * triangulated, or the vertices that remain when no ear can be found — which
 * happens on polygons that are simple but PINCHED, the shape hole bridging
 * naturally produces (a bridge is a zero-width slit, and a vertex on one side
 * of a slit sits exactly on the other side's edge).
 */
function clipEars(
  polygon: ContourLoop,
  emit: (a: ContourPoint, b: ContourPoint, c: ContourPoint) => void,
): ContourLoop | null {
  const n = polygon.length;
  if (n < 3) return null;
  const live: number[] = [];
  for (let i = 0; i < n; i++) live.push(i);

  let guard = n * n + n;
  while (live.length > 3 && guard-- > 0) {
    let clipped = false;
    for (let k = 0; k < live.length; k++) {
      const a = polygon[live[(k + live.length - 1) % live.length]];
      const b = polygon[live[k]];
      const c = polygon[live[(k + 1) % live.length]];
      if (turn(a.x, a.z, b.x, b.z, c.x, c.z) <= 0) continue; // reflex/degenerate
      let blocked = false;
      for (let m = 0; m < live.length; m++) {
        if (
          m === k ||
          m === (k + live.length - 1) % live.length ||
          m === (k + 1) % live.length
        ) {
          continue;
        }
        const p = polygon[live[m]];
        // Coincident vertices DO block. A bridge walks the same two points
        // twice, and clipping an ear that ignored its twin would tear the slit
        // open and leave a polygon that is no longer simple. Getting stuck at a
        // bridge instead is fine: splitPolygon resolves it.
        if (
          turn(a.x, a.z, b.x, b.z, p.x, p.z) >= 0 &&
          turn(b.x, b.z, c.x, c.z, p.x, p.z) >= 0 &&
          turn(c.x, c.z, a.x, a.z, p.x, p.z) >= 0
        ) {
          blocked = true;
          break;
        }
      }
      if (blocked) continue;
      emit(a, b, c);
      live.splice(k, 1);
      clipped = true;
      break;
    }
    if (!clipped) break;
  }
  if (live.length === 3) {
    emit(polygon[live[0]], polygon[live[1]], polygon[live[2]]);
    return null;
  }
  if (live.length < 3) return null;
  return live.map((index) => polygon[index]);
}

/**
 * Cuts a stalled polygon in two along a valid diagonal: a segment between two
 * non-adjacent vertices that crosses no edge and runs through the polygon's
 * inside. Returns null when the polygon has no such diagonal, which a simple
 * polygon of four or more vertices always does — so null means the polygon was
 * not simple, and the caller's verification will send the chunk to the blocky
 * fallback.
 */
function splitPolygon(polygon: ContourLoop): [ContourLoop, ContourLoop] | null {
  const n = polygon.length;
  for (let i = 0; i < n; i++) {
    for (let j = i + 2; j < n; j++) {
      if (i === 0 && j === n - 1) continue; // adjacent around the wrap
      const a = polygon[i];
      const b = polygon[j];
      if (samePoint(a, b)) continue;
      let blocked = false;
      for (let k = 0; k < n && !blocked; k++) {
        const c = polygon[k];
        const d = polygon[(k + 1) % n];
        if (segmentsCross(a, b, c, d)) blocked = true;
      }
      if (blocked) continue;
      // No OTHER vertex may sit on the diagonal. Bridged holes leave
      // zero-width slits in the outline, and a diagonal that runs along one
      // touches it without ever "crossing" an edge — splitting there would cut
      // the polygon in a place that is not actually inside it.
      for (let k = 0; k < n && !blocked; k++) {
        if (k === i || k === j) continue;
        const p = polygon[k];
        if (Math.abs(turn(a.x, a.z, b.x, b.z, p.x, p.z)) > COLLINEAR_TOUCH_EPSILON) {
          continue;
        }
        const withinX = p.x >= Math.min(a.x, b.x) && p.x <= Math.max(a.x, b.x);
        const withinZ = p.z >= Math.min(a.z, b.z) && p.z <= Math.max(a.z, b.z);
        if (withinX && withinZ) blocked = true;
      }
      if (blocked) continue;
      // The diagonal must run INSIDE, not across a concavity.
      const midX = (a.x + b.x) / 2;
      const midZ = (a.z + b.z) / 2;
      if (!pointInLoop(midX, midZ, polygon)) continue;
      const first = polygon.slice(i, j + 1);
      const second = polygon.slice(j).concat(polygon.slice(0, i + 1));
      if (first.length < 3 || second.length < 3) continue;
      // Belt and braces: a genuine diagonal leaves both halves wound the same
      // way as the whole. A half that came out backwards would be triangulated
      // inside out, and its triangles would paint over the very hole the
      // outline exists to cut.
      if (signedArea(first) <= 0 || signedArea(second) <= 0) continue;
      return [first, second];
    }
  }
  return null;
}

/** Groups a level's loops into outer polygons with their holes. */
export interface CapPolygon {
  outer: ContourLoop;
  /**
   * Sorted by descending `rightmostX`, which is the order they MUST be bridged
   * in — see the ordering argument at the end of groupLoops.
   */
  holes: ContourLoop[];
}

/** The x of the vertex bridgeHole casts its ray from. */
function rightmostX(loop: ContourLoop): number {
  let x = -Infinity;
  for (const p of loop) {
    if (p.x > x) x = p.x;
  }
  return x;
}

export function groupLoops(loops: ContourLoop[]): CapPolygon[] {
  const outers: CapPolygon[] = [];
  const holes: ContourLoop[] = [];
  for (const loop of loops) {
    if (signedArea(loop) > 0) outers.push({ outer: loop, holes: [] });
    else holes.push(loop);
  }
  for (const hole of holes) {
    // Assign to the SMALLEST outer loop that contains it: nested plateaus mean
    // a hole can sit inside more than one, and it belongs to its immediate
    // parent.
    let best = -1;
    let bestArea = Infinity;
    for (let i = 0; i < outers.length; i++) {
      if (!pointInLoop(hole[0].x, hole[0].z, outers[i].outer)) continue;
      const area = signedArea(outers[i].outer);
      if (area < bestArea) {
        bestArea = area;
        best = i;
      }
    }
    if (best >= 0) outers[best].holes.push(hole);
  }
  // BRIDGING ORDER, and it is a correctness requirement rather than a
  // preference (2026-08-14, found on an ordinary stamped crater).
  //
  // bridgeHole splices one hole at a time into an outline that already contains
  // every bridge spliced before it, and it picks its bridge by casting +x from
  // the hole's rightmost vertex and checking the line of sight against the
  // outer loop and THAT hole. It cannot check against holes not spliced yet —
  // they are not part of the outline it is looking at — so in an arbitrary
  // order a bridge can be run straight THROUGH a hole that is still to come.
  // Splicing that hole afterwards then crosses the earlier bridge's corridor:
  // the merged polygon is no longer simple, ear clipping stalls on an inverted
  // remnant, the exact triangle prediction fails, and the verification in
  // writeChunkVertexData sends the WHOLE CHUNK to the blocky fallback. Two
  // craters dug on one diagonal are enough — the second bowl sits on the first
  // bowl's bridge — which is one half of the "ordinary terrain went blocky"
  // report this ordering fixes.
  //
  // Descending rightmost x removes the possibility rather than detecting it: a
  // bridge from the rightmost vertex of hole h lands on a vertex whose x is at
  // least h's own (the ray travels +x and the landing vertex is never behind
  // the hit point), so h's corridor lies entirely in the half-plane
  // x ≥ rightmostX(h), while every hole still unspliced has rightmostX ≤ that
  // and so lies entirely in the closed half-plane on the other side. The two
  // can meet only ON the line x = rightmostX(h), which takes two holes with the
  // same rightmost x AND a vertical bridge to be a crossing rather than a
  // touch; that residue is still caught, blockily, by the verification door.
  //
  // Same ordering earcut's eliminateHoles uses, for the same reason, mirrored
  // left-to-right because our ray runs +x.
  for (const polygon of outers) {
    polygon.holes.sort((a, b) => rightmostX(b) - rightmostX(a));
  }
  return outers;
}
