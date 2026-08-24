// The RIBBON builder: one river course drawn as a single connected strip of
// water, source to mouth (client/src/render/water/).
//
// WHY THIS EXISTS (2026-08-23, owner: "I would like that water source to be
// continuous from beginning to end with a series of vertex points so it draws
// as a single object"). The band-region pipeline that stood here groups wet
// cells BY TERRACE BAND, so a course crossing a band every cell or two is
// decomposed into one tiny marched lozenge per band, joined only by
// independently-classified fall sheets. On a steep face that reads as a chain
// of beads, and a fall reduced to a single boundary segment reads as a needle.
// The drawing unit was the band; it has to be the COURSE.
//
// `shared/src/rivers.ts` already documents `RiverCourse.points` as "a polyline
// a renderer can draw". This module is that renderer, and it is deliberately
// the SIMPLEST thing that is continuous by construction: a fixed-width strip
// whose consecutive cross-sections SHARE their vertices, so there is no join
// anywhere along a course that could open up. No probing, no classification,
// no separate fall primitive — a waterfall is just the stretch of the strip
// where two consecutive cross-sections sit at different heights.
//
// LAKES ARE NOT DRAWN HERE (owner, same session: "leave the lakes as they
// are"). A pooled stretch of a course is drawn by the marched region in
// water/waterTread.ts, which the owner has already signed off on; this module
// skips any segment with pooled cells at BOTH ends, and keeps the segment
// where a flowing point meets a pooled one so the ribbon still runs into the
// lake surface rather than stopping short of it.

import { CELL_WORLD_SIZE } from '../../config.ts';

/**
 * Half the drawn width of a channel, in CELLS.
 *
 * A half, because the trace in `shared/src/rivers.ts` steps one cell at a time
 * through four-connected neighbours — the water it describes occupies exactly
 * the cell it is standing in, so a full-width ribbon is one cell across and
 * its rim falls on the cell's own edges. Not derived from
 * `WATER_RISER_LEAN_CELLS`, which happened to share the value: that number
 * sized the horizontal FOOTPRINT of a fall against depth-buffer and
 * smoothed-contour margins, and has nothing to say about how wide a river is.
 */
export const COURSE_HALF_WIDTH_CELLS = 0.5;

/**
 * The drawn ground under a point, in world Y, given a position in CELL
 * coordinates — the terrain's own BAND-QUANTISED surface, which is what the
 * eye sees, not the smooth pre-terracing height.
 */
export type GroundSampler = (cellX: number, cellY: number) => number;

/** One prepared vertex of a course polyline, in cell coordinates. */
export interface CourseNode {
  /** Cell-space X of the cell CENTRE (cell x + 0.5). */
  readonly cellX: number;
  /** Cell-space Y (world Z) of the cell CENTRE (cell y + 0.5). */
  readonly cellY: number;
  /** World Y this node's water surface is drawn at. */
  readonly surfaceY: number;
  /** True where this point is part of a basin — the lake region draws it. */
  readonly pooled: boolean;
}

/**
 * Appends ONE course's ribbon to `out` as raw triangle positions.
 *
 * `groundYAt` PAINTS THE RIBBON ONTO THE MAP (owner 2026-08-23: "the water
 * surfaces need to actually be painted on to the map surface, never floating
 * off of it"). A cross-section is half a cell wide either side of the cell the
 * trace named, so where a course runs along the edge of a tread its outer rim
 * overhangs the step — and a rim carrying the CENTRE cell's height there is
 * water hanging in the air over the drop. Every rim vertex therefore takes the
 * ground under ITSELF, sampled once per node and side so the two segments
 * meeting at a node still share the vertex exactly.
 *
 * `seaSurfaceY` is the world Y of the sea plane (render/water.ts). No vertex
 * is ever written below it: the course is truncated at the first node whose
 * surface is at or under the ocean, and a terminal node is synthesised there
 * at exactly `seaSurfaceY`, so the ribbon runs down to the waterline and
 * stops (owner 2026-08-23: "it cannot draw below the ocean"). Freshwater
 * below sea level is not a thing this world can show — the sea plane is
 * already drawing every drop of it.
 */
export function appendCourseRibbon(
  nodes: readonly CourseNode[],
  groundYAt: GroundSampler,
  seaSurfaceY: number,
  out: number[],
): void {
  const clamped = truncateAtSea(nodes, seaSurfaceY);
  if (clamped.length < 2) return;

  // Cross-sections first, so consecutive segments SHARE their rim vertices by
  // construction rather than by two callsites agreeing on a formula.
  const leftX = new Float64Array(clamped.length);
  const leftZ = new Float64Array(clamped.length);
  const leftY = new Float64Array(clamped.length);
  const rightX = new Float64Array(clamped.length);
  const rightZ = new Float64Array(clamped.length);
  const rightY = new Float64Array(clamped.length);
  for (let i = 0; i < clamped.length; i++) {
    // The tangent is a central difference over the neighbours a node actually
    // has, so an end node uses its one-sided step and a smoothed interior node
    // bisects the turn. A degenerate (zero-length) tangent falls back to +X:
    // a course cannot repeat a cell (rivers.ts's budget forbids revisiting),
    // so this only fires on a one-point course, which emits nothing anyway.
    const before = clamped[Math.max(0, i - 1)]!;
    const after = clamped[Math.min(clamped.length - 1, i + 1)]!;
    let tangentX = after.cellX - before.cellX;
    let tangentZ = after.cellY - before.cellY;
    const length = Math.hypot(tangentX, tangentZ);
    if (length === 0) {
      tangentX = 1;
      tangentZ = 0;
    } else {
      tangentX /= length;
      tangentZ /= length;
    }
    const node = clamped[i]!;
    // Perpendicular in the ground plane, scaled to the channel's half width.
    const offsetX = -tangentZ * COURSE_HALF_WIDTH_CELLS;
    const offsetZ = tangentX * COURSE_HALF_WIDTH_CELLS;
    const leftCellX = node.cellX - offsetX;
    const leftCellY = node.cellY - offsetZ;
    const rightCellX = node.cellX + offsetX;
    const rightCellY = node.cellY + offsetZ;
    leftX[i] = leftCellX * CELL_WORLD_SIZE;
    leftZ[i] = leftCellY * CELL_WORLD_SIZE;
    rightX[i] = rightCellX * CELL_WORLD_SIZE;
    rightZ[i] = rightCellY * CELL_WORLD_SIZE;
    // A POOLED node keeps the lake's flat surface — a basin's water really is
    // level, and the region in water/waterTread.ts is drawing that same plane.
    // A FLOWING node is draped: its rim sits on the ground under the rim.
    //
    // The sea floor under the drape is the SECOND guard on "never below the
    // ocean": `truncateAtSea` ends the course at the mouth, and this catches
    // the case that outlives it — a rim of a still-above-water node reaching
    // sideways over the shoreline. Belt and suspenders, because a regression
    // in either one is visible from anywhere on the map.
    leftY[i] = node.pooled
      ? Math.max(seaSurfaceY, node.surfaceY)
      : Math.max(seaSurfaceY, groundYAt(leftCellX, leftCellY));
    rightY[i] = node.pooled
      ? Math.max(seaSurfaceY, node.surfaceY)
      : Math.max(seaSurfaceY, groundYAt(rightCellX, rightCellY));
  }

  for (let i = 0; i < clamped.length - 1; i++) {
    const a = clamped[i]!;
    const b = clamped[i + 1]!;
    // Both ends pooled: the lake's marched region owns this stretch.
    if (a.pooled && b.pooled) continue;

    // A STEP DOWN is measured on the rims themselves, not on the nodes'
    // centres, because the rims are what gets drawn — a cross-section draped
    // onto the ground can straddle a band the centre never crossed.
    const drop = Math.min(leftY[i]!, rightY[i]!) - Math.max(leftY[i + 1]!, rightY[i + 1]!);

    if (drop > 0) {
      // A DROP, in two quads that share the downstream rim verbatim: the tread
      // reaches out over the lip to the next cell's centre at ITS OWN heights,
      // then falls vertically there. The fall is placed at the DOWNSTREAM cell
      // rather than at the lip because that column is out in the air past the
      // terrace edge, where a vertical sheet is visible instead of buried in
      // the rock.
      pushQuad(
        leftX[i]!, leftY[i]!, leftZ[i]!,
        rightX[i]!, rightY[i]!, rightZ[i]!,
        rightX[i + 1]!, rightY[i]!, rightZ[i + 1]!,
        leftX[i + 1]!, leftY[i]!, leftZ[i + 1]!,
        out,
      );
      pushQuad(
        leftX[i + 1]!, leftY[i]!, leftZ[i + 1]!,
        rightX[i + 1]!, rightY[i]!, rightZ[i + 1]!,
        rightX[i + 1]!, rightY[i + 1]!, rightZ[i + 1]!,
        leftX[i + 1]!, leftY[i + 1]!, leftZ[i + 1]!,
        out,
      );
    } else {
      // Level, or the rare rise into a pool's surface: one quad, which the
      // drape may twist along its diagonal. Nothing here can leave a gap —
      // both cross-sections are the ones their neighbouring segments use.
      pushQuad(
        leftX[i]!, leftY[i]!, leftZ[i]!,
        rightX[i]!, rightY[i]!, rightZ[i]!,
        rightX[i + 1]!, rightY[i + 1]!, rightZ[i + 1]!,
        leftX[i + 1]!, leftY[i + 1]!, leftZ[i + 1]!,
        out,
      );
    }
  }
}

/**
 * The course up to the ocean: every node above `seaSurfaceY`, plus a terminal
 * node standing where the first at-or-below-sea node stands but pinned to the
 * sea surface itself.
 *
 * Returned rather than clamped in place so the caller's nodes stay the facts
 * the network reported; and terminated rather than flattened so a course that
 * runs on underwater does not paint a second, brighter sea over the real one.
 */
function truncateAtSea(
  nodes: readonly CourseNode[],
  seaSurfaceY: number,
): readonly CourseNode[] {
  const firstSubmerged = nodes.findIndex((node) => node.surfaceY <= seaSurfaceY);
  if (firstSubmerged < 0) return nodes;
  const kept = nodes.slice(0, firstSubmerged);
  const mouth = nodes[firstSubmerged]!;
  kept.push({
    cellX: mouth.cellX,
    cellY: mouth.cellY,
    surfaceY: seaSurfaceY,
    pooled: mouth.pooled,
  });
  return kept;
}

/** Two triangles for the quad p→q→r→s, appended as raw positions. */
function pushQuad(
  px: number, py: number, pz: number,
  qx: number, qy: number, qz: number,
  rx: number, ry: number, rz: number,
  sx: number, sy: number, sz: number,
  out: number[],
): void {
  out.push(px, py, pz, qx, qy, qz, rx, ry, rz);
  out.push(px, py, pz, rx, ry, rz, sx, sy, sz);
}
