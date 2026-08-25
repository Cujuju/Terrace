// Waterfall curtains — flat vertical sheets down the face of a band.
//
// WHAT THIS DRAWS. Each boundary segment of a water region that has lower
// ground just outside it gets ONE vertical quad: the segment's own two points
// at the top, the same two points directly below at the height of the ground
// it pours onto. No horizontal component, no footprint, no staircase — a fall
// is a 2D sheet hanging on the side of the bands, top to bottom.
//
// WHY IT IS THIS AND NOT THE STAIRCASE (owner, 2026-08-24). The previous
// design walked a run of segments DOWN one band at a time, re-seating the arc
// onto each level's own contour so the fall was painted onto every tread it
// passed. It worked, in the sense that nothing floated any more — but the
// owner's verdict on seeing it was that vertices were being lost or mistraced
// between layers, and that the outward step the re-seating produced was not
// wanted: "I'd like to pause that part and just worry about drawing it from
// top to bottom in a completely 2D fashion."
//
// That verdict is also structurally right, and worth recording rather than
// treating as taste. The re-seating had THREE ways to lose geometry, all of
// them inherent to pairing two independently-marched arcs:
//
//   * the two arcs came from different marches and need not have the same
//     vertex count, so the emitter paired only `min(top, bottom)` of them and
//     silently DROPPED the remainder — a ragged hem by construction;
//   * `nearestOnContour` could land the run's two endpoints on the same vertex
//     of a sparse (dropCollinear-pruned) contour, which needed its own
//     special case to avoid collapsing the arc to a point;
//   * a re-seat that drifted past tolerance returned null and ended the
//     descent early, truncating the fall.
//
// A vertical sheet has none of them, because there is no second arc: the
// bottom row IS the top row, at a lower Y. Every vertex the marcher produced
// is used exactly once, and no correspondence between two curves has to be
// guessed. The staircase is paused, not deleted — the reasoning and the
// oracle (`nearestOnContour`, `loopsAt`) it needs are still in
// terrain/drawnGround.ts, and docs/plans/water-painted-on-bands.md still
// carries its derivation.
//
// WHAT SURVIVES FROM THE STAIRCASE, because it was never the problem: the
// heights are still the TERRAIN'S OWN NUMBERS. Top and foot are both
// `drawnBandWorldY` of a band the terrain really draws a cap at, and the
// plan-view outline is the contour loop `waterTread.appendRegionSurface`
// already marched and Chaikin-smoothed — so the sheet is coincident with the
// rock face and is not cell-shaped. That contract is the whole point of
// docs/plans/water-painted-on-bands.md and this change does not touch it.
//
// CLASSIFICATION IS PER SEGMENT, never per vertex. A segment has an exact
// outward normal (right of travel — assembleLoops keeps the inside on the
// left, the same handedness emitSkirtQuad assumes). A VERTEX normal is
// undefined at a channel's snout tip and at a marching-tile seam — the two
// places a fall actually lives — and the retired apron's averaged vertex
// normals consequently emitted ZERO falling triangles on `fork` while emitting
// 1328 flat ones.
//
// SCRATCH DISCIPLINE: every `DrawnGround` query marches synchronously to
// completion behind its memo (see drawnGround.ts's HAZARD note); this module
// adds no marching of its own and runs inside the rig's synchronous rebuild.

import { CELL_WORLD_SIZE } from '../../config.ts';
import {
  RECT_NONE,
  type ContourLoop,
  type ContourPoint,
} from '../../terrain/contours.ts';
import { type DrawnGround } from '../../terrain/drawnGround.ts';

/**
 * How far outside a segment's midpoint the classification probe steps, in
 * CELLS.
 *
 * It must exceed the residual disagreement between the smoothed water rim and
 * the smoothed rock rim — measured at 0.11 cell (docs/DESIGN.md, issue #63) —
 * or the probe lands inside the band the water already stands on and reports
 * it as ground to pour onto. It must stay under half a cell so it cannot reach
 * PAST the next face down and read a band two steps below as the immediate
 * neighbour. 0.25 sits between the two with margin either way.
 *
 * It is also the STEP of the foot search below, for the same reasons: fine
 * enough to resolve the levels a sheer face crams into one cell, coarse
 * enough not to re-read the band it started on.
 */
export const CURTAIN_PROBE_CELLS = 0.25;

/**
 * How far out from a segment the foot search may walk, in CELLS, before it
 * accepts the lowest ground it has found.
 *
 * ONE CELL, and the bound is structural rather than tuned. A sheer drop has NO
 * horizontal extent in the heightmap — it is one cell of ground at the high
 * band abutting one cell at the low band — so every intermediate contour the
 * marcher draws across that face is packed into the single cell between those
 * two centres. One cell of reach therefore spans a sheer face completely, and
 * nothing wider than a sheer face is one.
 *
 * WHY THE SEARCH EXISTS AT ALL, measured 2026-08-24 on the east-cliff fixture
 * (a 3-band sheer drop): probing at CURTAIN_PROBE_CELLS alone reported band 2,
 * not the pit floor at band 0, because the terrain really does draw its band-2
 * and band-1 skirt levels inside that half cell — the marcher interpolates the
 * crossing. A single probe therefore reads the TOP STEP of the terrain's own
 * skirt stack and the sheet stopped one band down, leaving a 20-band cliff
 * with water on its first band only. The search walks the face to its bottom
 * instead.
 */
const CURTAIN_FOOT_SEARCH_MAX_CELLS = 1;

/**
 * True when both endpoints lie on the SAME marching-tile edge. Such a segment
 * is the tile's CLOSING edge — interior water, not outline: across it lies the
 * same region's other half. A curtain there would be a wall of water standing
 * in the middle of the river.
 *
 * THE TEST IS A SHARED-AXIS MASK, not "either endpoint is on a border".
 * `rect` is a bitmask of the tile edges a point lies on (RECT_WEST|EAST|
 * NORTH|SOUTH, contours.ts:92), so `a.rect & b.rect` is the set of edges BOTH
 * share, and only a segment lying ALONG one of them is a closing edge. The
 * literal "either endpoint" test also killed every genuine outline segment
 * that merely TOUCHES the border — the arc where a channel crosses a tile
 * mid-fall — so its curtain stopped short of the seam. This is exactly
 * `isBorderSegment` (capEmission.ts:805); water and rock now skip the same
 * segments rather than disagreeing about which ones they are.
 */
function isTileClosingSegment(a: ContourPoint, b: ContourPoint): boolean {
  return (a.rect & b.rect) !== RECT_NONE;
}

/**
 * The unit outward normal of segment a→b: right of travel, since
 * `assembleLoops` keeps the region INSIDE on the left (the handedness
 * emitSkirtQuad documents and relies on). Unlike a vertex normal this is
 * exact everywhere — including at snout tips and tile seams, where averaged
 * vertex normals pointed the retired apron into the water and silenced its
 * falls.
 */
function outwardNormal(a: ContourPoint, b: ContourPoint): { x: number; z: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return { x: 0, z: 0 };
  return { x: dz / length, z: -dx / length };
}

/**
 * The band a segment's water lands on: walk straight out from its midpoint in
 * CURTAIN_PROBE_CELLS steps and return the lowest band the face reaches.
 *
 * TWO PHASES, and keeping them distinct is the whole correctness argument.
 *
 *   1. LOOKING FOR THE DROP. Until the ground has fallen below the water's own
 *      band, a step that reads the SAME band means nothing yet — the rim of
 *      the water and the rim of the rock disagree by up to 0.11 cell (issue
 *      #63), and on a smoothed contour that disagreement varies along the arc.
 *      So this phase keeps walking. It gives up only when the ground RISES,
 *      which means a bank, not a lip.
 *   2. FOLLOWING THE FACE DOWN. Once the ground has started falling, a step
 *      that stops falling is the floor, and the walk ends there.
 *
 * MEASURED, 2026-08-24, which is why phase 1 exists: with a single break on
 * "stopped falling" counted from the water's own band, a straight channel down
 * a terraced slope poured on 5 of its 9 lip segments at one cell wide, 9 of 13
 * at two cells, 6 of 10 at four. The ones lost were the OUTER segments of every
 * lip — the arc's shoulders, where the rim disagreement is largest — so a fall
 * came out narrower than the pool feeding it, and on a short lip it could
 * vanish entirely. The owner's screenshot of two courses down a terraced
 * hillside showed exactly that: the wider course had falls, the narrower one
 * had none at all between its pools.
 *
 * RESIDUAL, named rather than hidden: in phase 2 a face that goes momentarily
 * flat — one probe step reading the same band as the last — ends the walk
 * there. The sheet then stops on a level the terrain genuinely draws, so it
 * rests on real ground and never hangs in air; it is only shorter than the
 * full drop. Refining that needs a finer step, not a different rule.
 */
function footBandOf(
  ground: DrawnGround,
  a: ContourPoint,
  b: ContourPoint,
  normal: { x: number; z: number },
  surfaceBand: number,
): number {
  const midX = (a.x + b.x) / 2;
  const midZ = (a.z + b.z) / 2;
  const steps = Math.round(CURTAIN_FOOT_SEARCH_MAX_CELLS / CURTAIN_PROBE_CELLS);
  let lowest = surfaceBand;
  let falling = false;
  for (let step = 1; step <= steps; step++) {
    const reach = step * CURTAIN_PROBE_CELLS;
    const band = ground.bandAt(midX + normal.x * reach, midZ + normal.z * reach);
    if (band < lowest) {
      lowest = band;
      falling = true;
      continue;
    }
    // Phase 2: the face bottomed out. Phase 1: rising ground is a bank, and
    // level ground is not yet an answer — keep looking outward.
    if (falling || band > lowest) break;
  }
  return lowest;
}

/**
 * Append waterfall curtains for one water region's boundary loops to the
 * triangle soup `out` (positions only, three floats per vertex, world units —
 * the same soup the tread builder writes).
 *
 * `loops` is EXACTLY what `appendRegionSurface` returned for the region whose
 * surface stands at `surfaceBand`. `bandSurfaceY` gives the world height of
 * water standing on a band — the rig's own rule, the one the TREAD was built
 * with. `seaWorldY` is the sea plane, below which no curtain may reach.
 *
 * One vertical quad per pouring segment, welded to the pool above it.
 */
export function appendCurtains(
  ground: DrawnGround,
  loops: readonly ContourLoop[],
  surfaceBand: number,
  bandSurfaceY: (band: number) => number,
  seaWorldY: number,
  out: number[],
): void {
  // WELDED, NOT MERELY ADJACENT (owner, 2026-08-24: "the vertices from the
  // flat pool to the vertical wall aren't connected and they need to be").
  //
  // The top row is the loop's OWN points at the pool's OWN surface height, so
  // each top vertex is numerically identical to a boundary vertex of the tread
  // triangulated from that same loop: one shared edge, no crack, nothing to
  // line up. The previous version pushed the sheet 1/64 of a world unit
  // outward along each segment's normal and hung it from the terrain cap
  // rather than the water surface — two separate 1/64 discrepancies, which is
  // precisely the hairline the owner saw, and the doubled bright lines were
  // neighbouring quads offset along their own differing normals.
  //
  // The depth-buffer bias that offset used to provide now lives on the water
  // MATERIAL as a polygon offset (riverRig.ts's WATER_DEPTH_BIAS_*), which is
  // where a depth-buffer concern belongs: it biases the comparison without
  // moving a single vertex, so geometry can be exactly coincident and exactly
  // welded at the same time.
  const topY = bandSurfaceY(surfaceBand);

  for (const loop of loops) {
    if (loop.length < 3) continue;
    const n = loop.length;
    for (let i = 0; i < n; i++) {
      const a = loop[i]!;
      const b = loop[(i + 1) % n]!;
      if (isTileClosingSegment(a, b)) continue;

      const normal = outwardNormal(a, b);
      const landingBand = footBandOf(ground, a, b, normal, surfaceBand);
      if (landingBand >= surfaceBand) continue;

      // The foot lands at the height water on THAT band stands at, not at the
      // bare rock cap — so where a pool really is down there, the sheet's
      // bottom edge meets that pool's surface plane exactly, the same way its
      // top edge meets the pool above. Clamped at the sea: nothing is drawn
      // below the surface the sea plane already covers.
      const bottomY = Math.max(bandSurfaceY(landingBand), seaWorldY);
      if (bottomY >= topY) continue;

      const ax = a.x * CELL_WORLD_SIZE;
      const az = a.z * CELL_WORLD_SIZE;
      const bx = b.x * CELL_WORLD_SIZE;
      const bz = b.z * CELL_WORLD_SIZE;

      // Winding follows emitSkirtQuad (capEmission.ts:775): a→b along the top,
      // then down.
      out.push(ax, topY, az, bx, topY, bz, bx, bottomY, bz);
      out.push(ax, topY, az, bx, bottomY, bz, ax, bottomY, az);
    }
  }
}
