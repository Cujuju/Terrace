// Waterfall curtains — work item W3 of docs/plans/water-painted-on-bands,
// replacing the retired apron (water/waterApron.ts).
//
// THE IDEA, and why it is not what failed twice before. The apron and the
// per-segment riser both BUILT A SEPARATE SURFACE and then tried to locate it
// against the terrain, and locating is where they floated (plan §"The defect,
// measured": zero of 6745 vertices sat at their intended clearance on `fork`).
// This module builds no surface of its own. A waterfall here is an ARC of the
// loop `waterTread.appendRegionSurface` already returned — extruded down the
// SAME ONE-BAND DROP the terrain's own skirt uses (capEmission.ts stacks one
// skirt per level, each hung off its own contour). It is smooth because that
// loop is Chaikin-smoothed; it is coincident with the rock because its numbers
// ARE the rock's numbers; and on a tall cliff it is a STAIRCASE because each
// level re-seats the arc onto that level's OWN contour, exactly the way
// capEmission.ts hangs each skirt off its own loop.
//
// Two decisions carry the whole design, and both are the negation of what the
// apron did wrong:
//
//   * Classification is PER SEGMENT, never per vertex. A segment has an exact
//     outward normal (right of travel — assembleLoops keeps the inside on the
//     left, the same handedness emitSkirtQuad assumes). A VERTEX normal is
//     undefined at a channel's snout tip and at a marching-tile seam — the two
//     places a fall actually lives — and the apron's averaged vertex normals
//     consequently emitted ZERO falling triangles on `fork` while emitting
//     1328 flat ones.
//
//   * Re-seating is by the RUN'S TWO ENDPOINTS, then walking that level's loop
//     between them in a consistent direction. Taking the nearest contour point
//     PER VERTEX (the plan's rejected draft) can reorder vertices and
//     self-intersect the arc.
//
// SCRATCH DISCIPLINE: every `DrawnGround` query marches synchronously to
// completion behind its memo (see drawnGround.ts's HAZARD note); this module
// adds no marching of its own and runs inside the rig's synchronous rebuild.

import { BAND_HEIGHT } from '@terrace/shared';
import { CELL_WORLD_SIZE } from '../../config.ts';
import {
  RECT_NONE,
  type ContourLoop,
  type ContourPoint,
} from '../../terrain/contours.ts';
import {
  drawnBandWorldY,
  type DrawnGround,
} from '../../terrain/drawnGround.ts';

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
 */
export const CURTAIN_PROBE_CELLS = 0.25;

/**
 * How far OUTSIDE the rock face the curtain stands, in WORLD UNITS — a
 * depth-buffer offset so a surface coincident with the skirt does not
 * z-fight it.
 *
 * This is the twin of the terrain skirt's pick inset (SKIRT_PICK_INSET,
 * capEmission.ts:895) with the OPPOSITE SIGN: that one pushes the riser INTO
 * the hillside so picking prefers it, this one pulls the curtain OFF the face
 * so the depth buffer does. The magnitude matches the water surface's own
 * clearance above the ground (riverRig.ts's RIVER_SURFACE_LIFT_WORLD_UNITS),
 * the smallest offset the renderer has already been shown to resolve.
 */
export const CURTAIN_OUTWARD_WORLD_UNITS = 1 / 64;

/**
 * How far off a level's own contour the re-seating may leave an ENDPOINT,
 * in CELLS, before the descent refuses rather than guesses.
 *
 * One band's drop puts the old arc within roughly a cell of the next level's
 * contour, and the measured rim disagreement between levels adds only 0.11
 * (issue #63); anything beyond two cells is not this run's continuation and
 * re-seating onto it would paint water across ground the fall never touched.
 */
const CURTAIN_RESEAT_TOLERANCE_CELLS = 2;

/**
 * Which of band 0's TWO levels the descent uses, passed to
 * `drawnBandWorldY`. The terrain's own skirt stack lands on the SUNK seabed
 * cap (-SEABED_CAP_SINK) wherever a drop reaches band 0 — makeLevels computes
 * `below` exactly that way — so the curtain does too: a fall that reaches the
 * shore pours down the seabed face the terrain actually drew, not onto a
 * dry-shore cap that exists only above sunken ground.
 */
const CURTAIN_LEVEL_SEABED = true;

/** One arc to hang a curtain from: the run's vertices, in walk order. */
type Run = readonly ContourPoint[];

/**
 * True when both endpoints lie on the SAME marching-tile edge. Such a segment
 * is the tile's CLOSING edge — interior water, not outline: across it lies the
 * same region's other half. A curtain there would be a wall of water standing
 * in the middle of the river.
 *
 * THE TEST IS A SHARED-AXIS MASK, not "either endpoint is on a border"
 * (W3's first draft, corrected here as W4's Pending-2 defect). `rect` is a
 * bitmask of the tile edges a point lies on (RECT_WEST|EAST|NORTH|SOUTH,
 * contours.ts:92), so `a.rect & b.rect` is the set of edges BOTH share, and
 * only a segment lying ALONG one of them is a closing edge. The literal test
 * also killed every genuine outline segment that merely TOUCHES the border —
 * the arc where a channel crosses a tile mid-fall — so its curtain stopped
 * short of the seam. This is exactly `isBorderSegment` (capEmission.ts:805);
 * water and rock now skip the same segments rather than disagreeing about
 * which ones they are.
 */
function isTileClosingSegment(a: ContourPoint, b: ContourPoint): boolean {
  return (a.rect & b.rect) !== RECT_NONE;
}

/**
 * The unit outward normal of segment a→b: right of travel, since
 * `assembleLoops` keeps the region INSIDE on the left (the handedness
 * emitSkirtQuad documents and relies on). Unlike a vertex normal this is
 * exact everywhere — including at snout tips and tile seams, where averaged
 * vertex normals pointed the apron into the water and silenced its falls.
 */
function outwardNormal(a: ContourPoint, b: ContourPoint): { x: number; z: number } {
  const dx = b.x - a.x;
  const dz = b.z - a.z;
  const length = Math.hypot(dx, dz);
  if (length === 0) return { x: 0, z: 0 };
  return { x: dz / length, z: -dx / length };
}

/**
 * Whether ANY segment of `run`, probed just outside its midpoint, finds the
 * drawn ground in a band LOWER than `level` — i.e. whether water standing at
 * `level` here has somewhere lower to pour.
 */
function poursSomewhere(
  ground: DrawnGround,
  run: Run,
  level: number,
): boolean {
  for (let i = 0; i < run.length - 1; i++) {
    const a = run[i]!;
    const b = run[i + 1]!;
    if (isTileClosingSegment(a, b)) continue;
    const normal = outwardNormal(a, b);
    const midX = (a.x + b.x) / 2 + normal.x * CURTAIN_PROBE_CELLS;
    const midZ = (a.z + b.z) / 2 + normal.z * CURTAIN_PROBE_CELLS;
    if (ground.bandAt(midX, midZ) < level) return true;
  }
  return false;
}

/**
 * Maximal runs of consecutive pouring segments of one loop, circularly.
 *
 * Returns VERTEX lists (segment i's run contributes vertices i..i+1 inclusive,
 * unrolled modulo the loop length), because the emitter and the re-seating
 * both think in vertices. A loop whose every segment pours yields one run
 * covering the whole ring.
 */
function pouringRuns(ground: DrawnGround, loop: ContourLoop, surfaceBand: number): Run[] {
  const n = loop.length;
  const pours = new Array<boolean>(n).fill(false);
  let anyPour = false;
  for (let i = 0; i < n; i++) {
    const a = loop[i]!;
    const b = loop[(i + 1) % n]!;
    if (isTileClosingSegment(a, b)) continue;
    const normal = outwardNormal(a, b);
    const midX = (a.x + b.x) / 2 + normal.x * CURTAIN_PROBE_CELLS;
    const midZ = (a.z + b.z) / 2 + normal.z * CURTAIN_PROBE_CELLS;
    if (ground.bandAt(midX, midZ) < surfaceBand) {
      pours[i] = true;
      anyPour = true;
    }
  }
  if (!anyPour) return [];

  // Break the circle at a non-pouring segment so no run straddles the array
  // seam; if every segment pours, the whole ring is one run.
  let head = 0;
  while (head < n && pours[head]) head++;
  if (head === n) {
    return [[...loop]];
  }

  const runs: Run[] = [];
  let i = head;
  while (i < n) {
    if (!pours[i]) {
      i++;
      continue;
    }
    let j = i;
    while (j + 1 < n && pours[j + 1]) j++;
    // Segments i..j pour → vertices i..j+1, in walk order.
    const run: ContourPoint[] = [];
    for (let v = i; v <= j + 1; v++) run.push(loop[v % n]!);
    runs.push(run);
    i = j + 1;
  }
  return runs;
}

/**
 * Walk `loop` between the two endpoint indices along the SHORTER arc, always
 * delivered in forward (inside-on-the-left) order — the consistent-direction
 * walk the plan specifies.
 *
 * WHY NOT ALWAYS FORWARD: the re-seated endpoints sit on the level below
 * almost radially under the old ones, so which of them comes first in loop
 * order is arbitrary; walking blindly forward would sometimes take the LONG
 * way round and paint the fall across half the terrace rim. Walking backward
 * instead, then REVERSING the collected points, restores forward orientation
 * between the endpoints — the arc's handedness, and therefore its outward
 * normals, stay outward without recomputing anything.
 */
function reseatArc(loop: ContourLoop, startIndex: number, endIndex: number): Run {
  const n = loop.length;
  const forwardSteps = (endIndex - startIndex + n) % n;
  const backwardSteps = (startIndex - endIndex + n) % n;
  const indices: number[] = [];
  if (forwardSteps <= backwardSteps) {
    for (let i = 0; i <= forwardSteps; i++) indices.push((startIndex + i) % n);
  } else {
    for (let i = 0; i <= backwardSteps; i++) indices.push((startIndex - i + n) % n);
    indices.reverse();
  }
  return indices.map((i) => loop[i]!);
}

/**
 * Emit one level's worth of quads — the TOP arc at `topY`, the BOTTOM arc at
 * `bottomY`, paired vertex-for-vertex up to the shorter of the two — standing
 * CURTAIN_OUTWARD_WORLD_UNITS off the rock face. Winding and normal follow
 * emitSkirtQuad (capEmission.ts:775): p→q top, then down; each row is inset
 * along its OWN segment's normal, so both rows hug their own contour.
 *
 * The rows are DIFFERENT ARCS, not one arc twice: the bottom row was re-seated
 * onto the lower level's own contour before this runs. That is what makes
 * every emitted vertex lie on a contour the terrain really draws (the W3
 * contract), and what turns a multi-band fall into a staircase of slabs
 * instead of one sheet cut through the intermediate treads. The two arcs come
 * from different marches and need not agree on vertex count, hence the pairing
 * bound — a slightly ragged hem beats inventing vertices no march produced.
 */
function emitLevel(
  top: Run,
  bottom: Run,
  topY: number,
  bottomY: number,
  out: number[],
): void {
  const insetCells = CURTAIN_OUTWARD_WORLD_UNITS / CELL_WORLD_SIZE;
  const count = Math.min(top.length, bottom.length);
  const seated = (p: ContourPoint, normal: { x: number; z: number }): [number, number] => [
    (p.x + normal.x * insetCells) * CELL_WORLD_SIZE,
    (p.z + normal.z * insetCells) * CELL_WORLD_SIZE,
  ];
  for (let i = 0; i < count - 1; i++) {
    if (
      isTileClosingSegment(top[i]!, top[i + 1]!) ||
      isTileClosingSegment(bottom[i]!, bottom[i + 1]!)
    ) {
      continue;
    }
    const topNormal = outwardNormal(top[i]!, top[i + 1]!);
    const bottomNormal = outwardNormal(bottom[i]!, bottom[i + 1]!);
    const [ax, az] = seated(top[i]!, topNormal);
    const [bx, bz] = seated(top[i + 1]!, topNormal);
    const [cx, cz] = seated(bottom[i + 1]!, bottomNormal);
    const [dx, dz] = seated(bottom[i]!, bottomNormal);
    out.push(ax, topY, az, bx, topY, bz, cx, bottomY, cz);
    out.push(ax, topY, az, cx, bottomY, cz, dx, bottomY, dz);
  }
}

/**
 * Re-seat the run onto `band`'s own contour: nearest contour vertex for each
 * ENDPOINT, then walk that loop between them along the shorter arc, always
 * delivered in forward (inside-on-the-left) order.
 *
 * WHY THE COLLAPSED CASE NEEDS ITS OWN RULE: on a LONG STRAIGHT fall the
 * contour is sparse — dropCollinear prunes every collinear vertex — so BOTH
 * endpoints can land on the same nearest vertex while sitting a full cell
 * apart along one segment. Walking between two equal indices degenerates to a
 * point and the descent would die after one level. There the honest answer is
 * the SEGMENT they both sit on: widen the arc to that segment's two
 * neighbours (vertices i-1 .. i+1) so the curtain keeps a footing.
 *
 * Returns null when the end point drifts too far from the start loop (an
 * artefact no correct descent should produce — refusing beats guessing).
 */
function reseatRun(ground: DrawnGround, run: Run, band: number): Run | null {
  const first = run[0]!;
  const last = run[run.length - 1]!;
  const start = ground.nearestOnContour(band * BAND_HEIGHT, first.x, first.z);
  const end = ground.nearestOnContour(band * BAND_HEIGHT, last.x, last.z);
  if (!start || !end) return null;
  // IDENTITY IS NOT CONTIGUITY. `nearestOnContour` marches the chunk holding
  // each query, and an arc that runs along a CHUNK BORDER gets its two
  // endpoints answered from DIFFERENT chunks — two marches of the SAME terrain
  // contour, two distinct arrays. Comparing loop objects would wrongly refuse.
  // So the end index is resolved GEOMETRICALLY onto the start's loop: the
  // nearest of its vertices to where the end query landed.
  const loop = start.loop;
  const n = loop.length;
  let endIndex = 0;
  let bestDriftSquared = Infinity;
  for (let i = 0; i < n; i++) {
    const dx = loop[i]!.x - end.x;
    const dz = loop[i]!.z - end.z;
    const d2 = dx * dx + dz * dz;
    if (d2 < bestDriftSquared) {
      bestDriftSquared = d2;
      endIndex = i;
    }
  }
  if (bestDriftSquared > CURTAIN_RESEAT_TOLERANCE_CELLS * CURTAIN_RESEAT_TOLERANCE_CELLS) {
    return null;
  }
  let startIndex = start.index;
  if (((endIndex - startIndex) % n + n) % n === 0) {
    // Collapsed onto one vertex: span that vertex's whole segment neighbourhood.
    startIndex = (((startIndex - 1) % n) + n) % n;
    endIndex = (endIndex + 1) % n;
  }
  const walked = reseatArc(loop, startIndex, endIndex);
  return walked.length >= 2 ? walked : null;
}

/**
 * Append waterfall curtains for one water region's boundary loops to the
 * triangle soup `out` (positions only, three floats per vertex, world units —
 * the same soup the tread builder writes).
 *
 * `loops` is EXACTLY what `appendRegionSurface` returned for the region whose
 * surface stands at `surfaceBand`; `seaWorldY` is the world height of the sea
 * plane, below which no curtain may reach. Per loop: classify each SEGMENT by
 * probing `ground.bandAt` just outside its midpoint, take maximal runs of
 * pouring segments, and walk each run down one band at a time — emitting a
 * quad per segment per level, re-seating onto each level's own contour by the
 * run's two endpoints — while the ground under the run stays lower and the
 * next level still sits above the sea.
 */
export function appendCurtains(
  ground: DrawnGround,
  loops: readonly ContourLoop[],
  surfaceBand: number,
  seaWorldY: number,
  out: number[],
): void {
  for (const loop of loops) {
    if (loop.length < 3) continue;
    for (const run of pouringRuns(ground, loop, surfaceBand)) {
      descend(ground, run, surfaceBand, seaWorldY, out);
    }
  }
}

/**
 * Walk one pouring run DOWN, one band at a time, exactly as capEmission.ts
 * stacks skirts: re-seat onto level k−1's own contour by the run's two
 * ENDPOINTS, emit the slab between the level-k arc and the re-seated arc, and
 * repeat while the ground beneath is still lower. Re-seating per level is what
 * paints a tall fall onto a STAIRCASE instead of cutting one flat sheet
 * through the intermediate treads — the failure mode that killed the apron
 * outright on thin spires (its emitSheet doc records the owner's photograph).
 *
 * ORDERING NOTE, deviating deliberately from the plan's letter: the draft text
 * emits the slab FIRST and re-seats after, which would leave every slab's
 * bottom row hanging at the UPPER arc's footprint — off the lower contour by
 * up to the measured 0.11-cell rim disagreement, violating the "every vertex
 * lies on the terrain's own contour" contract this work item is tested
 * against. Re-seating BEFORE emitting costs nothing and makes the bottom row
 * the next level's top row: every vertex is then a contour vertex of its own
 * level, and the slabs tile the fall without seams.
 *
 * Stops when: the next level down is band 0 (its slab is emitted first, cut
 * off at `seaWorldY` so nothing is drawn below the sea); the re-seat fails; or
 * the ground under
 * the re-seated run is no longer lower — the water has LANDED, and the slab
 * just emitted is the fall's foot, resting on a level the terrain really
 * draws. Every stop leaves the fall ending on drawn ground.
 */
function descend(
  ground: DrawnGround,
  run: Run,
  surfaceBand: number,
  seaWorldY: number,
  out: number[],
): void {
  let level = surfaceBand;
  let current = run;
  while (level > 0) {
    const below = level - 1;
    const bottomY = drawnBandWorldY(below, CURTAIN_LEVEL_SEABED);

    // BAND 0 IS NOT A LEVEL WITH ITS OWN CONTOUR. The marchers' threshold-0
    // region is the WHOLE DOMAIN — re-seating onto it would smear the fall's
    // foot across the chunk border. The terrain doesn't do that either: its
    // band-1 skirt hangs off the threshold-BAND_HEIGHT loop and drops straight
    // to the sunk seabed cap (makeLevels' `below`), and this final slab copies
    // that — same arc, vertical drop, no re-seat.
    //
    // THE SEA CLAMPS THIS SLAB, it does not delete it (corrected in W4). Band
    // 0's seabed cap sits BELOW the sea plane by construction
    // (-SEABED_CAP_SINK against SEA_LEVEL + WATER_SURFACE_LIFT), so a bare
    // `bottomY <= seaWorldY → return` discarded every fall that reaches the
    // shore — the one place a waterfall is most visible. The slab is cut off
    // AT the sea surface instead: nothing is emitted below `seaWorldY` (the W3
    // contract) and the fall still meets the water it pours into. Only band 0
    // can be at or under the sea — every higher band's cap is a whole
    // BAND_WORLD_HEIGHT above it — so this is the only level that needs the
    // clamp.
    if (below === 0) {
      const topY = drawnBandWorldY(level, CURTAIN_LEVEL_SEABED);
      const footY = Math.max(bottomY, seaWorldY);
      if (footY < topY) emitLevel(current, current, topY, footY, out);
      return;
    }
    const reseeded = reseatRun(ground, current, below);
    if (!reseeded) return;
    emitLevel(current, reseeded, drawnBandWorldY(level, CURTAIN_LEVEL_SEABED), bottomY, out);
    if (!poursSomewhere(ground, reseeded, below)) return;
    current = reseeded;
    level = below;
  }
}
