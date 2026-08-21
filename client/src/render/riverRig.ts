// Rivers, pools and waterfalls: CLIENT-SIDE PRESENTATION of a pure, derived
// fact of the heightmap (shared/src/rivers.ts, mechanics cards 27 & 40).
//
// Design decision Q3 extended to flowing water (docs/DESIGN.md, "Decisions
// made 2026-08-19"): a river is never synced or simulated state. It is
// recomputed HERE, on the client's own copy of the terrain, on the same
// cadence-decoupling throttle the server keeps for its own copy
// (World.riverNetwork in server/src/world/world.ts) — two clients looking at
// the same terrain draw the same rivers without either being told to.
//
// RULES THIS FILE KEEPS (the house pattern — see plugins/weather/client/
// rig.ts's own header, which states these first):
//   * Geometry and materials are built once and MUTATED IN PLACE on each
//     throttled recompute — never rebuilt inside the animation loop. A
//     recompute happens at most every RIVER_RECOMPUTE_INTERVAL_MS, which is
//     not "per frame" by a wide margin (60+ frames apart at 60 fps), so
//     replacing a BufferGeometry there is the same "rebuild is fine, not per
//     edit" allowance render/water.ts already documents for its own resize.
//   * NO PER-FRAME ALLOCATIONS in the animation path: the mist's gentle bob
//     rewrites an existing Float32Array's Y values; it never creates one.
//     — AMENDED 2026-08-20: the mist puffs are gone (see the dated block over
//     the legacy MIST_* constants below) but the rule stands unchanged for
//     their replacement: the spring rings/dome animation rewrites existing
//     Float32Arrays' values in place, never allocating in the frame handler.
//   * ONE OWNER: everything this module creates is freed by its own
//     dispose().
//   * PHOTOSENSITIVITY: the mist bob is the only animated element here and it
//     STOPS under prefers-reduced-motion — the mist simply holds still,
//     mirroring weather's "the whole sky holds still" rule. There is nothing
//     here anywhere near that rule's actual concern (flashing light); this is
//     satisfied out of consistency with the house standard, not because a
//     pulsing mist puff was ever a flash risk.
//     — AMENDED 2026-08-20: still true of the spring effect that replaced the
//     mist. Its fastest element is one ripple ring birth every
//     SPRING_RIPPLE_PERIOD_SECONDS / SPRING_RING_COUNT seconds (~0.67 Hz),
//     continuous motion rather than flashing, far under weather's 3 Hz bar;
//     the shared animation clock freezing under prefers-reduced-motion
//     freezes every part of it at once.
//   * SOUND: card 40 says "mist, sound". This project has no audio system at
//     all (confirmed against the whole client tree) and this change does not
//     add one — the card's audio half is DEFERRED, named here rather than
//     silently dropped.

import {
  BufferAttribute,
  BufferGeometry,
  DoubleSide,
  DynamicDrawUsage,
  Mesh,
  MeshStandardMaterial,
  type Object3D,
} from 'three';
import {
  BAND_HEIGHT,
  bandOf,
  chunkIndexOfCell,
  computeRiverNetwork,
  quantizeToBand,
  type RiverNetwork,
} from '@terrace/shared';
import { CELL_WORLD_SIZE, HEIGHT_WORLD_SCALE } from '../config.ts';
import { sampleHeight, type TerrainMirror } from '../terrain/mirror.ts';
import { CONTOUR_SAMPLE_CLEARANCE } from '../terrain/contours.ts';
import { WATER_COLOR } from './water.ts';

// ── Recompute throttle ───────────────────────────────────────────────────────

/**
 * Minimum real time between recomputes, in milliseconds — the client-side
 * twin of server/src/world/world.ts's RIVER_RECOMPUTE_INTERVAL_MS (see that
 * constant's doc comment for the full cost argument; the two are independent
 * numbers on purpose, since determinism only requires "same heightmap in,
 * same network out", never "computed at the same moment" — see
 * docs/DESIGN.md).
 *
 * 500 ms (2 Hz) rather than the server's 250 ms: the server's number is sized
 * against every connected player's combined edit rate hitting ONE shared
 * cost budget, while this is a single client redrawing its own screen —
 * update latency here is a feel question, not a fairness or a shared-CPU one,
 * and a river visibly settling a beat after the last click of a held stroke
 * reads as fine as terrain relaxation already does (SMOOTH_PASS_LIMIT strokes
 * are not instant either). Halving the server's rate also means this rebuild
 * is never the bottleneck the moment a terrainDiff message re-triggers it.
 */
const RIVER_RECOMPUTE_INTERVAL_MS = 500;

// ── Channel & lake geometry ──────────────────────────────────────────────────

/**
 * Half-width, in cells, of a FLOWING channel — DERIVED from how wide the
 * terrain actually draws a one-cell channel, not chosen.
 *
 * The terrain's band outline sits CONTOUR_SAMPLE_CLEARANCE's documented
 * quarter of a cell INSIDE the higher of the two cells it separates
 * (terrain/contours.ts). So a channel one cell wide, cut one band below its
 * banks, is rendered as a groove only half a cell across — and the 0.6-cell
 * ribbon this started as had a sixth of its width tucked under the bank caps
 * on each side, which is what made a river look like it stopped and restarted
 * wherever the groove narrowed or turned. Matching the groove is the honest
 * width: the water fills the channel the player can see, exactly.
 */
const FLOW_HALF_WIDTH_CELLS = 0.5 - CONTOUR_SAMPLE_CLEARANCE / BAND_HEIGHT / 2;

/**
 * Chaikin corner-cutting passes applied to a course's centre-line before it
 * is extruded into a ribbon (see `smoothPolyline`).
 *
 * WHY A RIBBON AT ALL (2026-08-21, owner: rivers "render as square blocks…
 * we need them path smoothed so that they render like polylines"). A course
 * is a 4-connected cell walk, so every turn in it is a hard 90°; drawing one
 * axis-aligned quad per cell made a staircase of separate squares rather than
 * a stream. The centre-line is the honest primitive — the cell walk IS a
 * polyline — so it is smoothed once and extruded into one continuous strip.
 *
 * TWO PASSES. Each pass replaces every interior vertex with two points at the
 * quarter and three-quarter marks of its segments, so it quadruples the
 * sample count and rounds each 90° corner into a 4-sample arc: enough to read
 * as a curve at orbit distance, where a third pass (16× the samples) is
 * invisible. Cost is bounded by the same per-river cell budget the course
 * itself is (RIVER_TRACE_BUDGET_WORLD_SIZE_MULTIPLIER, shared/src/rivers.ts)
 * times 2^RIVER_SMOOTHING_PASSES, and is paid at most once per
 * RIVER_RECOMPUTE_INTERVAL_MS — never per frame.
 */
const RIVER_SMOOTHING_PASSES = 2;

/**
 * How far, in CELLS, a smoothed sample may sit from the cell walk it came
 * from.
 *
 * Chaikin converges on a quadratic B-spline, whose corner sits a quarter of a
 * segment inside the corner it rounds — a quarter of a cell here. That is
 * exactly the half-width of the groove the terrain draws for a one-cell
 * channel (see FLOW_HALF_WIDTH_CELLS), so an unbounded corner cut walks the
 * whole ribbon out of the channel and under the bank on the inside of every
 * turn. Bounding the cut keeps the curve — the rounding is still visible —
 * while keeping the water in the channel a player can see. 0.15 leaves a
 * tenth of a cell of clearance inside that groove for the ribbon's own edge.
 */
const MAX_SMOOTHING_DEVIATION_CELLS = 0.15;

/**
 * Half-width of a POOLED (lake) tile. 0.5 → a full 1×1 cell, so adjacent
 * pooled cells tile edge-to-edge into one continuous flat lake surface with
 * no gaps between them. A lake stays a tile field — see `pushQuad`.
 */
const POOL_HALF_WIDTH_CELLS = 0.5;

/**
 * How far above the terrain river water is lifted, in world units — the same
 * role WATER_SURFACE_LIFT plays for the sea (render/water.ts): without it a
 * surface sitting exactly at the band-quantised ground height z-fights the
 * terrain mesh it is drawn over. Half of WATER_SURFACE_LIFT's own margin: a
 * river surface is narrow and always drawn a beat after the terrain it
 * follows, so it needs less clearance than the sea's single world-spanning
 * plane.
 */
const RIVER_SURFACE_LIFT_WORLD_UNITS = CELL_WORLD_SIZE / 64;

/**
 * How far downstream a terrace fall's vertical curtain is carried off the
 * terrace face it drops over, in world units — the horizontal twin of
 * RIVER_SURFACE_LIFT_WORLD_UNITS, and the same size for the same reason: it
 * is the smallest offset that reliably keeps two coplanar surfaces from
 * fighting, and anything larger would visibly detach the water from the lip.
 */
const RIVER_FALL_CLEARANCE_WORLD_UNITS = RIVER_SURFACE_LIFT_WORLD_UNITS;

/** Translucency for the flowing channel — a shade more opaque than the sea. */
const FLOW_OPACITY = 0.72;
/** Pooled water reads calmer/deeper: a touch more opaque again. */
const POOL_OPACITY = 0.8;

const RIVER_ROUGHNESS = 0.85;
const RIVER_METALNESS = 0;

/**
 * Appends one flat XZ quad, centred at (`cx`, `y`, `cz`) and `halfWidthWorld`
 * to a side, to a triangle-soup position list.
 *
 * The ONLY primitive that is still a square, and deliberately so: a lake is a
 * field of full-cell tiles that must meet edge to edge with no seam
 * (POOL_HALF_WIDTH_CELLS = 0.5), which a ribbon cannot express. It also
 * covers the degenerate flowing run of a SINGLE cell — one point has no
 * direction to extrude a ribbon along, so the cell is drawn as the small
 * square it geometrically is.
 */
function pushQuad(cx: number, y: number, cz: number, halfWidthWorld: number, out: number[]): void {
  const x0 = cx - halfWidthWorld;
  const x1 = cx + halfWidthWorld;
  const z0 = cz - halfWidthWorld;
  const z1 = cz + halfWidthWorld;
  out.push(x0, y, z0, x1, y, z0, x1, y, z1);
  out.push(x0, y, z0, x1, y, z1, x0, y, z1);
}

/**
 * One sample of a ribbon's centre-line: its world XZ, plus `t` — where it sits
 * along the ORIGINAL cell walk, as a fractional index into that walk.
 *
 * `t` is carried through the smoothing rather than recovered afterwards
 * because the ribbon's HEIGHT is a question about the COURSE, not about the
 * plane. A river runs cell centre to cell centre, so it travels along lattice
 * edges — the one-dimensional case the terrain's contour rule is actually
 * defined on (see `renderedBandAt`). Chaikin is an affine combination, so
 * smoothing `t` alongside x and z leaves it monotonically increasing: a valid
 * parameterisation of the smoothed curve.
 */
type CentreSample = readonly [x: number, z: number, t: number];

/**
 * Chaikin corner-cutting, `passes` times, with the two ENDPOINTS PINNED.
 *
 * Each pass replaces the interior of every segment with points a quarter and
 * three quarters along it, which rounds corners without introducing the
 * overshoot an interpolating spline (Catmull-Rom) would: an overshooting
 * river bulges outside the cells it actually flows through, which would put
 * water on land that is not wet as far as freshwater.ts is concerned. Pinning
 * the endpoints keeps a course anchored to its spring and to the sea, and
 * keeps a branch's first point exactly on its parent's centre-line.
 *
 * XZ ONLY. Height is deliberately NOT smoothed — it is resampled from the
 * band-quantised terrain at each resulting sample (see `buildRibbon`), so the
 * ribbon steps down the terraces it crosses instead of tunnelling through
 * their lips.
 */
function smoothPolyline(points: readonly CentreSample[], passes: number): CentreSample[] {
  /** The unsmoothed walk's own position at parameter `t` — a plain lerp. */
  const originalAt = (t: number): readonly [number, number] => {
    const last = points.length - 1;
    const i = Math.min(Math.max(Math.floor(t), 0), Math.max(last - 1, 0));
    const f = Math.min(Math.max(t - i, 0), 1);
    const [ax, az] = points[i]!;
    const [bx, bz] = points[Math.min(i + 1, last)]!;
    return [ax + (bx - ax) * f, az + (bz - az) * f];
  };

  let current = points as CentreSample[];
  for (let pass = 0; pass < passes && current.length >= 3; pass++) {
    const next: CentreSample[] = [current[0]!];
    for (let i = 0; i < current.length - 1; i++) {
      const [ax, az, at] = current[i]!;
      const [bx, bz, bt] = current[i + 1]!;
      next.push([ax * 0.75 + bx * 0.25, az * 0.75 + bz * 0.25, at * 0.75 + bt * 0.25]);
      next.push([ax * 0.25 + bx * 0.75, az * 0.25 + bz * 0.75, at * 0.25 + bt * 0.75]);
    }
    next.push(current[current.length - 1]!);
    current = next;
  }

  // Pull anything that wandered too far off the walk back toward it. Done once
  // at the end rather than per pass: the bound is on the FINAL shape, and
  // clamping between passes would just be re-smoothed away.
  const maxDeviation = MAX_SMOOTHING_DEVIATION_CELLS * CELL_WORLD_SIZE;
  return current.map(([x, z, t]) => {
    const [ox, oz] = originalAt(t);
    const dx = x - ox;
    const dz = z - oz;
    const deviation = Math.hypot(dx, dz);
    if (deviation <= maxDeviation) return [x, z, t] as CentreSample;
    const scale = maxDeviation / deviation;
    return [ox + dx * scale, oz + dz * scale, t] as CentreSample;
  });
}

/**
 * Which terrace band the TERRAIN RENDERS at parameter `t` along a course's
 * cell walk, given that walk's per-cell heights.
 *
 * THIS IS THE RULE THE FIRST RIBBON GOT WRONG (2026-08-21, owner: the water is
 * "not painting" at the steps). The terrain is not a field of per-cell blocks
 * — it is marching squares over the cell lattice (terrain/contours.ts), and a
 * band boundary crosses the edge between two cell centres at
 * `crossingFraction`, which pushes each sample CONTOUR_SAMPLE_CLEARANCE clear
 * of the threshold before interpolating. For a one-band step that puts the
 * riser A QUARTER OF A CELL inside the higher cell, not at the half-way mark.
 * A ribbon that stepped down at the half-way mark spent a quarter cell below
 * the cap it was still crossing, was drawn under it, and reappeared on the far
 * side — the square-cut gap at every terrace.
 *
 * So this reproduces the terrain's rule rather than approximating it: along a
 * lattice edge the effective field is a straight line from (lower − clearance)
 * to (higher + clearance), which is algebraically the line `crossingFraction`
 * inverts. Verified against the drawn mesh by raycasting it under the finished
 * ribbon: the water sits exactly its own lift above the ground at every
 * sample. Importing the terrain's constant rather than restating it is
 * deliberate — the two must agree by construction, and a copy is a second
 * place to forget.
 *
 * A 2-D (x, z) form of this was tried and REJECTED: the clearance is defined
 * per lattice edge, so a separable extension applies it twice on the diagonal
 * and lands a whole band out at a cell corner, which put the water under the
 * terrain in exactly the places this exists to fix. The one-dimensional rule
 * along the course is the case that is actually exact.
 */
function renderedBandAt(heights: readonly number[], t: number): number {
  const last = heights.length - 1;
  if (last <= 0) return bandOf(heights[0] ?? 0);
  const i = Math.min(Math.max(Math.floor(t), 0), last - 1);
  const f = Math.min(Math.max(t - i, 0), 1);
  const a = heights[i]!;
  const b = heights[i + 1]!;
  if (a === b) return bandOf(a);
  const low = Math.min(a, b);
  const high = Math.max(a, b);
  // Measured from the LOW end, the direction crossingFraction's
  // "outside → inside" runs in.
  const fromLow = a < b ? f : 1 - f;
  const height =
    low - CONTOUR_SAMPLE_CLEARANCE + fromLow * (high - low + 2 * CONTOUR_SAMPLE_CLEARANCE);
  // The clearance deliberately pushes the field past both real samples; the
  // terrain classifies a sample itself by a plain comparison, so the band may
  // never leave the pair being interpolated.
  return Math.min(Math.max(bandOf(height), bandOf(low)), bandOf(high));
}

/**
 * Bisection steps used to locate a band boundary between two ribbon samples.
 *
 * `renderedBandAt` is a step function, so there is nothing to solve
 * analytically once smoothing has moved the samples off the lattice edge —
 * but it IS monotonic in `t` within a segment, which is all bisection needs.
 * 24 halvings resolve the boundary to about a millionth of a cell, far under
 * any visible error, and cost 24 cheap evaluations per fall.
 */
const FALL_BISECTION_STEPS = 24;

/**
 * Falls resolved between one pair of ribbon samples before the search gives
 * up. A single cliff can span many bands (a stamped spire drops dozens), and
 * each band is its own skirt in the terrain, so each gets its own curtain —
 * but the loop must terminate even if `renderedBandAt` is handed something
 * pathological. 64 is the whole band range of a MAX_HEIGHT world.
 */
const MAX_FALLS_PER_SEGMENT = 64;

/**
 * How far downstream of a lip the ribbon stays narrowed, in CELLS, and how far
 * it narrows to.
 *
 * WHY A RIVER PINCHES AT A FALL, and why this is a shape decision rather than
 * a fudge. The terrain's band outline is a smoothed 2-D loop, and where a
 * course steps down inside a carved channel that loop does not cross the
 * channel square-on: it lags at the banks, so for roughly half a cell past the
 * lip the LOWER terrace exists only along the middle of the channel and the
 * upper terrace's cap still covers the sides. A full-width ribbon there is
 * drawn, but two thirds of it is inside the hillside — which is the last thing
 * that still read as "the river stops and restarts" once the height rule and
 * the curtain were right.
 *
 * Reproducing that loop per vertex would mean re-running marching squares for
 * the water (tried as a separable approximation, and it was worse than useless
 * — see `renderedBandAt`). Narrowing through the fall instead is honest about
 * what the terrain shows AND is what water does at a lip: it necks in as it
 * goes over. Half a cell is the distance the pinch actually lasts; 0.45 is the
 * narrowest that still reads as a river rather than a thread.
 */
const FALL_TAPER_CELLS = 0.5;
const FALL_TAPER_MIN_SCALE = 0.45;

/**
 * Extrudes one smoothed centre-line into a ribbon, appending its triangles
 * (non-indexed, two per segment) to `out`.
 *
 * Each sample's cross-section is `halfWidthWorld` either side of the
 * centre-line along the perpendicular of its LOCAL TANGENT — the central
 * difference of its neighbours, so the seam between two segments is one shared
 * cross-section and the strip has no gap or overlap at the joint. Ends use the
 * one segment they have. Vertex normals are left to `computeVertexNormals` on
 * the merged geometry, exactly as the pool tiles do.
 *
 * THE WATER PAINTS DOWN EVERY TERRACE FACE IT CROSSES (2026-08-21, owner:
 * "I would like it to also paint down the side of the layer"). Height comes
 * from `bandAt`, the band the TERRAIN renders at that point of the course
 * (`renderedBandAt`); wherever that changes between two samples the exact
 * crossing is bisected and the ribbon is built through it as three pieces —
 * the tread carried to the lip, a full-width vertical curtain down the face,
 * and the tread resuming at its foot. A cliff spanning several bands becomes
 * several curtains, one per band, because the terrain draws it as several
 * stacked skirts. The curtain is nudged RIVER_FALL_CLEARANCE_WORLD_UNITS
 * downstream so it stands in front of the face rather than inside it — the
 * same argument RIVER_SURFACE_LIFT_WORLD_UNITS makes vertically. Through the
 * fall the strip necks in; see FALL_TAPER_CELLS.
 */
function buildRibbon(
  centre: readonly CentreSample[],
  halfWidthWorld: number,
  bandAt: (t: number) => number,
  bandWorldY: (band: number) => number,
  out: number[],
): void {
  if (centre.length < 2) return;

  /** One full-width cross-section of the ribbon, ready to stitch to the next. */
  interface Section {
    readonly leftX: number;
    readonly leftZ: number;
    readonly rightX: number;
    readonly rightZ: number;
    readonly y: number;
  }

  const taperWorld = FALL_TAPER_CELLS * CELL_WORLD_SIZE;
  /** Full width once `travelled` world units past the last lip. */
  const widthAfterFall = (travelled: number): number => {
    if (travelled >= taperWorld) return halfWidthWorld;
    const eased = FALL_TAPER_MIN_SCALE + (1 - FALL_TAPER_MIN_SCALE) * (travelled / taperWorld);
    return halfWidthWorld * eased;
  };

  const sectionAt = (
    cx: number,
    cz: number,
    tx: number,
    tz: number,
    band: number,
    halfWidth: number,
  ): Section => ({
    leftX: cx + tz * halfWidth,
    leftZ: cz - tx * halfWidth,
    rightX: cx - tz * halfWidth,
    rightZ: cz + tx * halfWidth,
    y: bandWorldY(band),
  });

  // Unit tangents per sample, by central difference.
  const tangentX = new Float64Array(centre.length);
  const tangentZ = new Float64Array(centre.length);
  for (let i = 0; i < centre.length; i++) {
    const [px, pz] = centre[i === 0 ? 0 : i - 1]!;
    const [nx, nz] = centre[i === centre.length - 1 ? i : i + 1]!;
    let tx = nx - px;
    let tz = nz - pz;
    const length = Math.hypot(tx, tz);
    // A zero-length tangent means two coincident samples (a course whose
    // junction point repeats its parent's cell). Fall back to +X so the
    // cross-section is still well defined; the degenerate quad it produces is
    // invisible either way.
    if (length === 0) {
      tx = 1;
      tz = 0;
    } else {
      tx /= length;
      tz /= length;
    }
    tangentX[i] = tx;
    tangentZ[i] = tz;
  }

  const sections: Section[] = [];
  /** World distance since the last lip, for the taper. Starts wide open. */
  let sinceLip = Number.POSITIVE_INFINITY;

  for (let i = 0; i < centre.length; i++) {
    const [cx, cz, t] = centre[i]!;
    if (i > 0) {
      const [px, pz] = centre[i - 1]!;
      sinceLip += Math.hypot(cx - px, cz - pz);
    }
    const band = bandAt(t);
    sections.push(sectionAt(cx, cz, tangentX[i]!, tangentZ[i]!, band, widthAfterFall(sinceLip)));

    const nextSample = centre[i + 1];
    if (nextSample === undefined) continue;
    const [nx, nz, nextT] = nextSample;
    if (bandAt(nextT) === band) continue;

    const spanX = nx - cx;
    const spanZ = nz - cz;
    const spanLength = Math.hypot(spanX, spanZ);
    const clearance =
      spanLength === 0 ? 0 : Math.min(RIVER_FALL_CLEARANCE_WORLD_UNITS / spanLength, 0.25);

    // Walk the band changes across this segment, one curtain each.
    let cursorAt = 0;
    let cursorBand = band;
    for (let fall = 0; fall < MAX_FALLS_PER_SEGMENT && cursorBand !== bandAt(nextT); fall++) {
      // Bisect for the first point past the cursor whose band differs.
      let lo = cursorAt;
      let hi = 1;
      for (let step = 0; step < FALL_BISECTION_STEPS; step++) {
        const mid = (lo + hi) / 2;
        if (bandAt(t + (nextT - t) * mid) === cursorBand) lo = mid;
        else hi = mid;
      }
      const landedBand = bandAt(t + (nextT - t) * hi);
      const lipAt = Math.min(hi + clearance, 1);
      const lipX = cx + spanX * lipAt;
      const lipZ = cz + spanZ * lipAt;
      // The lip keeps the width it arrived with; everything past it restarts
      // the taper, which is what necks the water through the pinch below.
      const arrivingWidth = widthAfterFall(sinceLip + spanLength * lipAt);
      sections.push(sectionAt(lipX, lipZ, tangentX[i]!, tangentZ[i]!, cursorBand, arrivingWidth));
      sections.push(
        sectionAt(lipX, lipZ, tangentX[i]!, tangentZ[i]!, landedBand, widthAfterFall(0)),
      );
      sinceLip = -spanLength * (1 - lipAt);
      cursorAt = hi;
      cursorBand = landedBand;
      if (hi >= 1) break;
    }
  }

  for (let i = 0; i < sections.length - 1; i++) {
    const a = sections[i]!;
    const b = sections[i + 1]!;
    // Two triangles: (La, Ra, Lb) and (Lb, Ra, Rb).
    out.push(a.leftX, a.y, a.leftZ, a.rightX, a.y, a.rightZ, b.leftX, b.y, b.leftZ);
    out.push(b.leftX, b.y, b.leftZ, a.rightX, a.y, a.rightZ, b.rightX, b.y, b.rightZ);
  }
}

/** Wraps a finished triangle-soup position list as a geometry. */
function geometryFromTriangles(positions: readonly number[]): BufferGeometry {
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new BufferAttribute(Float32Array.from(positions), 3));
  geometry.computeVertexNormals();
  return geometry;
}

// ── Waterfall mist (SUPERSEDED) ──────────────────────────────────────────────
// ---------------------------------------------------------------------------
// SUPERSEDED 2026-08-20 (owner report): the eight point sprites per waterfall
// below rendered, at orbit distance, as "white cubes" — a square un-rotated
// sprite has no silhouette that reads as water. Replaced by the plunge-pool
// treatment in the "Spring / plunge-pool effect" section that follows:
// concentric ripple rings expanding from the plunge point plus a faceted
// upwelling foam dome. The MIST_* constants remain below, unreferenced, as
// the record of the treatment this replaces — the same convention
// terrain/bandColors.ts keeps for seabedRimColor.
// ---------------------------------------------------------------------------

/**
 * Particles per waterfall's mist puff. A small, fixed column rather than
 * anything resembling weather's precipitation counts (tens to hundreds per
 * system) — this is a "small... aura" (the card's own words for the mana
 * effect it marks) and there are at most a couple of dozen waterfalls in a
 * network at all (MAX_SPRINGS_PER_NETWORK, shared/src/rivers.ts).
 */
const MIST_PARTICLES_PER_WATERFALL = 8;
/** How far the mist puff spreads horizontally from the plunge point, in cells. */
const MIST_SPREAD_CELLS = 0.4;
/** How tall the puff stands above the plunge pool, in world units. */
const MIST_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.6;
const MIST_COLOR = 0xf4fbff;
const MIST_OPACITY = 0.55;
const MIST_SPRITE_SIZE = CELL_WORLD_SIZE * 0.5;

/**
 * The bob's period, in seconds, and how far it moves — gentle enough to read
 * as drifting spray, slow enough to sit far under any photosensitivity
 * concern (weather's own bar is 3 Hz; this is 1/6 Hz).
 */
const MIST_BOB_PERIOD_SECONDS = 6;
const MIST_BOB_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.15;

const TWO_PI = Math.PI * 2;

// ── Spring / plunge-pool effect ──────────────────────────────────────────────
// The waterfall marker that replaced the mist puffs (2026-08-20, owner
// directive: springs must LOOK like springs). Two merged meshes cover every
// waterfall in the network:
//
//   1. RIPPLE RINGS — SPRING_RING_COUNT flat concentric annuli per waterfall,
//      each cycling from SPRING_RING_MIN_RADIUS_CELLS out to
//      SPRING_RING_MAX_RADIUS_CELLS. A ring's band width follows
//      sin(π · progress): zero at birth, widest mid-life, zero again as it
//      dies at full radius — so rings appear and dissolve with no popping and
//      WITHOUT animating material opacity (one shared material serves every
//      waterfall; per-ring opacity would need per-vertex alpha machinery for
//      no extra legibility at orbit distance).
//   2. FOAM DOME — a faceted low-poly dome over the plunge point that swells
//      and settles like water welling up, in the flat-shaded style of the
//      rest of the world.
//
// Both geometries are built once per throttled recompute and their position
// buffers are MUTATED IN PLACE per frame (house rule #1/#2 in the module
// header). Per-waterfall cost is fixed and small — see the budget note under
// SPRING_RING_SEGMENTS.

/**
 * Concurrent ripple rings per waterfall. Three staggered thirds of a cycle
 * apart read as a continuous "welling" train; two leaves a visible dead gap
 * between ripples, four adds cost with no legibility gain at orbit distance.
 */
const SPRING_RING_COUNT = 3;

/**
 * Straight segments per ripple ring. 12 is the coarsest count whose polygon
 * still reads as a CIRCLE rather than a hexagon-ish blob at orbit distance,
 * and its faceting matches the world's flat-shaded style anyway.
 *
 * BUDGET, per waterfall: rings are SPRING_RING_COUNT × (2 ×
 * SPRING_RING_SEGMENTS) = 72 vertices / 72 triangles; the dome is
 * 2 × SPRING_DOME_SEGMENTS + 1 = 17 vertices / 24 triangles. Total 89
 * vertices / 96 triangles per waterfall. Network-wide: at most
 * MAX_SPRINGS_PER_NETWORK = 24 rivers (shared/src/rivers.ts), each dropping
 * one waterfall PER BAND CROSSED — a typical mountain course is a handful,
 * so a network is a few thousand triangles, far below one terrain chunk.
 * (The index buffers are Uint32 rather than Uint16 because that per-river
 * multiplier is unbounded by a constant — a pathological all-cliff world
 * could pass 65 535 ring vertices.)
 */
const SPRING_RING_SEGMENTS = 12;

/**
 * A ring is born at this centre-line radius, in cells — just outside the foam
 * dome's edge (SPRING_DOME_RADIUS_CELLS), so ripples visibly emanate FROM the
 * upwelling rather than materialising over it.
 */
const SPRING_RING_MIN_RADIUS_CELLS = 0.18;

/**
 * ...and dies at this radius. 0.45 keeps the ripple train inside the plunge
 * cell (half a cell is 0.5): it may lap the channel edge — read as spray
 * wetting the bank — but never marches across neighbouring cells.
 */
const SPRING_RING_MAX_RADIUS_CELLS = 0.45;

/**
 * A ring's radial band width at mid-life (its widest), in cells. Wide enough
 * to survive at orbit distance; narrower than the ring spacing so consecutive
 * rings never merge into a solid disc.
 */
const SPRING_RING_MAX_WIDTH_CELLS = 0.1;

/**
 * One ring's full birth-to-death cycle, in seconds. With SPRING_RING_COUNT
 * rings staggered evenly, a new ripple is born every 4.5 / 3 = 1.5 s
 * (~0.67 Hz) — an unhurried welling pace, far under the 3 Hz photosensitivity
 * ceiling weather documents, and continuous motion rather than flashing
 * besides.
 */
const SPRING_RIPPLE_PERIOD_SECONDS = 4.5;

/**
 * Foam near-white — the same value the superseded mist used (MIST_COLOR): it
 * was the right COLOUR for aerated water; the failure was sprite shape, not
 * palette.
 */
const SPRING_FOAM_COLOR = 0xf4fbff;

/**
 * Rings are see-through foam wash: translucent enough that the river's own
 * blue reads through them, opaque enough to register against it.
 */
const SPRING_RING_OPACITY = 0.5;

/** Radius of the upwelling foam dome, in cells — comfortably inside the
 * 0.6-cell-wide flowing channel ribbon so the dome sits ON the water. */
const SPRING_DOME_RADIUS_CELLS = 0.16;

/**
 * The dome's rest height above the plunge-pool surface, in world units. A low
 * mound — water welling up — not a hemisphere boulder; kept well under one
 * band (BAND_WORLD_HEIGHT = CELL_WORLD_SIZE) so it never reads as terrain.
 */
const SPRING_DOME_HEIGHT_WORLD_UNITS = CELL_WORLD_SIZE * 0.12;

/**
 * Radial segments of the dome. 8 gives the faceted low-poly silhouette the
 * rest of the world uses (trees, boulders); the budget arithmetic under
 * SPRING_RING_SEGMENTS assumes this value.
 */
const SPRING_DOME_SEGMENTS = 8;

/**
 * The dome's mid ring sits at 45° up the profile: cos 45° of the radius,
 * sin 45° of the height (≈ 0.7071 each) — one named constant since the two
 * are the same number by construction.
 */
const SPRING_DOME_MID_PROFILE = Math.SQRT1_2;

/** The dome is denser foam than the rings — nearly solid. */
const SPRING_DOME_OPACITY = 0.85;

/**
 * How far the dome swells above/below its rest height, as a fraction of that
 * height, and how long one swell takes. 1/6 Hz — the exact period the
 * superseded mist bob used, kept because it already read as "gently alive"
 * and sits far under the photosensitivity bar.
 */
const SPRING_DOME_SWELL_FRACTION = 0.15;
const SPRING_DOME_SWELL_PERIOD_SECONDS = 6;

/**
 * Rings float this far above the river surface under them (which itself sits
 * RIVER_SURFACE_LIFT_WORLD_UNITS above terrain). Double that lift: the same
 * z-fighting argument, applied one layer up — the rings must clear the water
 * by at least as much as the water clears the ground.
 */
const SPRING_EFFECT_LIFT_WORLD_UNITS = RIVER_SURFACE_LIFT_WORLD_UNITS * 2;

/**
 * Everything the frame handler needs to animate the spring meshes without
 * allocating: flat per-vertex arrays captured at rebuild time. All arrays are
 * indexed by vertex (rings) or by vertex/dome as commented.
 */
interface SpringState {
  readonly ringMesh: Mesh;
  readonly ringGeometry: BufferGeometry;
  /** Per ring-vertex plunge-point centre, world X/Z. */
  readonly ringCentreX: Float32Array;
  readonly ringCentreZ: Float32Array;
  /** Per ring-vertex unit direction out from the centre. */
  readonly ringDirX: Float32Array;
  readonly ringDirZ: Float32Array;
  /** Per ring-vertex: 0 = inner edge of the band, 1 = outer edge. */
  readonly ringEdge: Float32Array;
  /** Per ring-vertex cycle offset in [0, 1), staggering the rings. */
  readonly ringCycleOffset: Float32Array;

  readonly domeMesh: Mesh;
  readonly domeGeometry: BufferGeometry;
  /** Per dome-vertex rest height above the plunge surface (0 for the base ring). */
  readonly domeRestOffsetY: Float32Array;
  /** Per dome-vertex plunge surface world Y (constant within one dome). */
  readonly domeSurfaceY: Float32Array;
  /** Per dome-vertex swell phase (constant within one dome, staggered across domes). */
  readonly domePhase: Float32Array;
}

// ── The rig ──────────────────────────────────────────────────────────────────

export interface RiverRig {
  /**
   * Recomputes the river network from the mirror's CURRENT terrain and
   * rebuilds every ribbon, lake tile and spring effect — throttled internally to
   * RIVER_RECOMPUTE_INTERVAL_MS, so calling this from every terrainDiff (as
   * client/src/world.ts does, alongside the terrain mesh patch) costs nothing
   * extra: most calls are a no-op elapsed-time check.
   */
  refresh(mirror: TerrainMirror): void;
  /**
   * Rebuilds immediately, bypassing the throttle, and resets it so the next
   * ordinary `refresh` call is timed from now. For the ONE case a throttle is
   * wrong: a fresh join or rejoin (client/src/world.ts's onSnapshot), where
   * `mirror` is a brand-new session's and the previous session's tiles must
   * not be left on screen for up to RIVER_RECOMPUTE_INTERVAL_MS just because
   * this rig happened to recompute recently for a DIFFERENT world. Every
   * other caller wants the throttle — see `refresh`.
   */
  forceRefresh(mirror: TerrainMirror): void;
  dispose(): void;
}

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference live. A near-duplicate of the same
 * small watcher plugins/weather/client/index.ts, the mana gauge and the
 * monsters plugin's dread already each keep their own copy of — this module
 * lives in core (rivers are not a plugin — see docs/DESIGN.md), which has no
 * shared client utility module to hang one shared copy on, so a fourth small
 * copy here follows the same house pattern rather than inventing a new one.
 */
function watchReducedMotion(): { matches(): boolean; stop(): void } {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  if (query === null) return { matches: () => false, stop: () => {} };

  let reduced = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
  };
  query.addEventListener('change', onChange);
  return {
    matches: () => reduced,
    stop: () => query.removeEventListener('change', onChange),
  };
}

export function createRiverRig(
  parent: Object3D,
  onFrame: (handler: (dt: number) => void) => () => void,
): RiverRig {
  const flowMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: FLOW_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false, // see render/water.ts: lets submerged/underlying terrain show through
    side: DoubleSide,
  });
  const poolMaterial = new MeshStandardMaterial({
    color: WATER_COLOR,
    transparent: true,
    opacity: POOL_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide,
  });

  const flowMesh = new Mesh(new BufferGeometry(), flowMaterial);
  const poolMesh = new Mesh(new BufferGeometry(), poolMaterial);
  parent.add(flowMesh);
  parent.add(poolMesh);

  // Spring materials — one shared instance each across every waterfall in
  // the network (the rings/dome geometries are merged, so one draw call per
  // mesh). depthWrite stays false like the water tiles': the effect layers
  // over translucent water and must not punch holes in what renders behind.
  const springRingMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_RING_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    side: DoubleSide, // rings are flat annuli; visible from below a terrace lip too
  });
  const springDomeMaterial = new MeshStandardMaterial({
    color: SPRING_FOAM_COLOR,
    transparent: true,
    opacity: SPRING_DOME_OPACITY,
    roughness: RIVER_ROUGHNESS,
    metalness: RIVER_METALNESS,
    depthWrite: false,
    flatShading: true, // faceted low-poly dome, in the world's house style
  });
  let spring: SpringState | null = null;

  let lastRebuildMs = Number.NEGATIVE_INFINITY;

  /** Band-quantised render height, in world Y units, for one mirror cell. */
  const quantizeToBandWorldY = (mirror: TerrainMirror, x: number, y: number): number =>
    quantizeToBand(sampleHeight(mirror, x, y)) * HEIGHT_WORLD_SCALE;

  /**
   * Rebuilds the spring effect from scratch, one ripple-ring set and one foam
   * dome per waterfall, merged into two indexed geometries (one draw call
   * each). Vertex POSITIONS here are only placeholders for the animated
   * components — the frame handler below overwrites ring X/Z and dome Y every
   * frame from the flat per-vertex arrays captured in SpringState — but the
   * static components (ring Y, dome X/Z) and both index buffers are final.
   *
   * Cycle offsets are staggered per ring AND per waterfall (`w /
   * waterfalls.length`) for the same reason the superseded mist staggered its
   * bob phases across the whole buffer: no two springs pulsing in visible
   * lockstep.
   */
  const rebuildSprings = (mirror: TerrainMirror, network: RiverNetwork): void => {
    if (spring !== null) {
      parent.remove(spring.ringMesh);
      parent.remove(spring.domeMesh);
      spring.ringGeometry.dispose();
      spring.domeGeometry.dispose();
      spring = null;
    }

    const waterfalls = network.rivers.flatMap((river) => river.waterfalls);
    if (waterfalls.length === 0) return;

    // ── Ripple rings ──
    const ringVertsPerRing = SPRING_RING_SEGMENTS * 2; // inner edge + outer edge
    const ringVertsPerWaterfall = SPRING_RING_COUNT * ringVertsPerRing;
    const ringVertexCount = waterfalls.length * ringVertsPerWaterfall;
    const ringPositions = new Float32Array(ringVertexCount * 3);
    const ringNormals = new Float32Array(ringVertexCount * 3);
    const ringCentreX = new Float32Array(ringVertexCount);
    const ringCentreZ = new Float32Array(ringVertexCount);
    const ringDirX = new Float32Array(ringVertexCount);
    const ringDirZ = new Float32Array(ringVertexCount);
    const ringEdge = new Float32Array(ringVertexCount);
    const ringCycleOffset = new Float32Array(ringVertexCount);
    // Two triangles per segment per ring. Uint32: see the budget note under
    // SPRING_RING_SEGMENTS for why Uint16 cannot be assumed safe here.
    const ringIndices = new Uint32Array(
      waterfalls.length * SPRING_RING_COUNT * SPRING_RING_SEGMENTS * 2 * 3,
    );

    // ── Foam domes ──
    // Base octagon + mid octagon + apex point.
    const domeVertsPerDome = SPRING_DOME_SEGMENTS * 2 + 1;
    const domeVertexCount = waterfalls.length * domeVertsPerDome;
    const domePositions = new Float32Array(domeVertexCount * 3);
    const domeRestOffsetY = new Float32Array(domeVertexCount);
    const domeSurfaceY = new Float32Array(domeVertexCount);
    const domePhase = new Float32Array(domeVertexCount);
    // Base→mid band is 2 triangles per segment; mid→apex fan is 1. Uint32 for
    // the same reason as the ring indices.
    const domeIndices = new Uint32Array(waterfalls.length * SPRING_DOME_SEGMENTS * 3 * 3);

    let ringIndexWrite = 0;
    let domeIndexWrite = 0;
    for (let w = 0; w < waterfalls.length; w++) {
      const waterfall = waterfalls[w]!;
      const centreX = waterfall.x * CELL_WORLD_SIZE;
      const centreZ = waterfall.y * CELL_WORLD_SIZE;
      // The effect's resting surface: the river's height at the plunge cell,
      // plus its own anti-z-fight lift over that water.
      const surfaceY =
        quantizeToBandWorldY(mirror, waterfall.x, waterfall.y) +
        RIVER_SURFACE_LIFT_WORLD_UNITS +
        SPRING_EFFECT_LIFT_WORLD_UNITS;
      const waterfallStagger = w / waterfalls.length;

      // Rings: static per-vertex data. X/Z are animated, so positions get a
      // throwaway 0 there; Y is FINAL here and never rewritten.
      for (let r = 0; r < SPRING_RING_COUNT; r++) {
        const ringBase = w * ringVertsPerWaterfall + r * ringVertsPerRing;
        const cycleOffset = (r / SPRING_RING_COUNT + waterfallStagger) % 1;
        for (let s = 0; s < SPRING_RING_SEGMENTS; s++) {
          const angle = (s / SPRING_RING_SEGMENTS) * TWO_PI;
          const dirX = Math.cos(angle);
          const dirZ = Math.sin(angle);
          for (let edge = 0; edge < 2; edge++) {
            const v = ringBase + s + edge * SPRING_RING_SEGMENTS;
            ringCentreX[v] = centreX;
            ringCentreZ[v] = centreZ;
            ringDirX[v] = dirX;
            ringDirZ[v] = dirZ;
            ringEdge[v] = edge;
            ringCycleOffset[v] = cycleOffset;
            ringPositions[v * 3 + 1] = surfaceY;
            ringNormals[v * 3 + 1] = 1; // flat annulus: straight up, forever
          }
          // Segment s spans to its wrapped neighbour sn.
          const sn = (s + 1) % SPRING_RING_SEGMENTS;
          const innerS = ringBase + s;
          const innerSn = ringBase + sn;
          const outerS = ringBase + SPRING_RING_SEGMENTS + s;
          const outerSn = ringBase + SPRING_RING_SEGMENTS + sn;
          ringIndices[ringIndexWrite++] = innerS;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = innerSn;
          ringIndices[ringIndexWrite++] = outerS;
          ringIndices[ringIndexWrite++] = outerSn;
        }
      }

      // Dome: X/Z are FINAL here; Y is animated (the swell), so the frame
      // handler recomputes it from surfaceY + restOffsetY.
      const domeBase = w * domeVertsPerDome;
      const apex = domeBase + SPRING_DOME_SEGMENTS * 2;
      const domeSwellPhase = waterfallStagger * TWO_PI;
      for (let s = 0; s < SPRING_DOME_SEGMENTS; s++) {
        const angle = (s / SPRING_DOME_SEGMENTS) * TWO_PI;
        const dirX = Math.cos(angle);
        const dirZ = Math.sin(angle);
        const baseV = domeBase + s;
        const midV = domeBase + SPRING_DOME_SEGMENTS + s;
        // Base ring: on the surface, full radius.
        domePositions[baseV * 3] = centreX + dirX * SPRING_DOME_RADIUS_CELLS * CELL_WORLD_SIZE;
        domePositions[baseV * 3 + 2] = centreZ + dirZ * SPRING_DOME_RADIUS_CELLS * CELL_WORLD_SIZE;
        domeRestOffsetY[baseV] = 0;
        // Mid ring: 45° up the dome profile.
        domePositions[midV * 3] =
          centreX + dirX * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * CELL_WORLD_SIZE;
        domePositions[midV * 3 + 2] =
          centreZ + dirZ * SPRING_DOME_RADIUS_CELLS * SPRING_DOME_MID_PROFILE * CELL_WORLD_SIZE;
        domeRestOffsetY[midV] = SPRING_DOME_HEIGHT_WORLD_UNITS * SPRING_DOME_MID_PROFILE;

        const sn = (s + 1) % SPRING_DOME_SEGMENTS;
        const baseVn = domeBase + sn;
        const midVn = domeBase + SPRING_DOME_SEGMENTS + sn;
        // Base→mid band.
        domeIndices[domeIndexWrite++] = baseV;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = baseVn;
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = midVn;
        // Mid→apex fan.
        domeIndices[domeIndexWrite++] = midV;
        domeIndices[domeIndexWrite++] = apex;
        domeIndices[domeIndexWrite++] = midVn;
      }
      domePositions[apex * 3] = centreX;
      domePositions[apex * 3 + 2] = centreZ;
      domeRestOffsetY[apex] = SPRING_DOME_HEIGHT_WORLD_UNITS;
      for (let v = domeBase; v < domeBase + domeVertsPerDome; v++) {
        domeSurfaceY[v] = surfaceY;
        domePhase[v] = domeSwellPhase;
        domePositions[v * 3 + 1] = surfaceY + domeRestOffsetY[v]!;
      }
    }

    const ringGeometry = new BufferGeometry();
    const ringPositionAttribute = new BufferAttribute(ringPositions, 3);
    ringPositionAttribute.setUsage(DynamicDrawUsage);
    ringGeometry.setAttribute('position', ringPositionAttribute);
    ringGeometry.setAttribute('normal', new BufferAttribute(ringNormals, 3));
    ringGeometry.setIndex(new BufferAttribute(ringIndices, 1));
    const ringMesh = new Mesh(ringGeometry, springRingMaterial);
    // The rings' animated radius means their static bounding sphere (computed
    // from birth-radius placeholder positions) would be wrong; the whole
    // effect is small and cheap enough that skipping culling is the honest
    // fix, and the dome mesh matches for consistency.
    ringMesh.frustumCulled = false;
    parent.add(ringMesh);

    const domeGeometry = new BufferGeometry();
    const domePositionAttribute = new BufferAttribute(domePositions, 3);
    domePositionAttribute.setUsage(DynamicDrawUsage);
    domeGeometry.setAttribute('position', domePositionAttribute);
    domeGeometry.setIndex(new BufferAttribute(domeIndices, 1));
    domeGeometry.computeVertexNormals();
    const domeMesh = new Mesh(domeGeometry, springDomeMaterial);
    domeMesh.frustumCulled = false;
    parent.add(domeMesh);

    spring = {
      ringMesh,
      ringGeometry,
      ringCentreX,
      ringCentreZ,
      ringDirX,
      ringDirZ,
      ringEdge,
      ringCycleOffset,
      domeMesh,
      domeGeometry,
      domeRestOffsetY,
      domeSurfaceY,
      domePhase,
    };
  };

  const rebuild = (mirror: TerrainMirror): void => {
    const network = computeRiverNetwork(mirror.map, {
      isActive: (x, y) => mirror.received.has(chunkIndexOfCell(mirror.map.size, x, y)),
    });

    const flowTriangles: number[] = [];
    const poolTriangles: number[] = [];
    const flowHalfWidthWorld = FLOW_HALF_WIDTH_CELLS * CELL_WORLD_SIZE;

    /** World Y of a rendered terrace band, water lift included. */
    const bandWorldY = (band: number): number =>
      band * BAND_HEIGHT * HEIGHT_WORLD_SCALE + RIVER_SURFACE_LIFT_WORLD_UNITS;


    for (const river of network.rivers) {
      // ONE RIBBON PER COURSE, and a river has as many courses as the water
      // has paths (shared/src/rivers.ts's split rule) — so a fork is drawn as
      // two strips that meet, not as one strip that had to pick a side.
      for (const course of river.courses) {
        // A course is flowing points interrupted by pooled ones; each
        // unbroken FLOWING run is one ribbon, and every pooled point is a
        // lake tile at its basin's one flat surface height.
        let run: CentreSample[] = [];
        // The run's per-cell heights, indexed the way its samples' `t` is —
        // what `renderedBandAt` interpolates between.
        let runHeights: number[] = [];
        const flushRun = (): void => {
          if (run.length === 1) {
            const [soloX, soloZ] = run[0]!;
            pushQuad(
              soloX,
              bandWorldY(bandOf(runHeights[0]!)),
              soloZ,
              flowHalfWidthWorld,
              flowTriangles,
            );
          } else if (run.length > 1) {
            const heights = runHeights;
            buildRibbon(
              smoothPolyline(run, RIVER_SMOOTHING_PASSES),
              flowHalfWidthWorld,
              (t) => renderedBandAt(heights, t),
              bandWorldY,
              flowTriangles,
            );
          }
          run = [];
          runHeights = [];
        };

        for (const point of course.points) {
          const worldX = point.x * CELL_WORLD_SIZE;
          const worldZ = point.y * CELL_WORLD_SIZE;
          if (point.pooled) {
            flushRun();
            const surfaceY =
              (point.poolHeight ?? 0) * HEIGHT_WORLD_SCALE + RIVER_SURFACE_LIFT_WORLD_UNITS;
            pushQuad(
              worldX,
              surfaceY,
              worldZ,
              POOL_HALF_WIDTH_CELLS * CELL_WORLD_SIZE,
              poolTriangles,
            );
          } else {
            run.push([worldX, worldZ, run.length]);
            runHeights.push(sampleHeight(mirror, point.x, point.y));
          }
        }
        flushRun();
      }
    }

    flowMesh.geometry.dispose();
    flowMesh.geometry = geometryFromTriangles(flowTriangles);

    poolMesh.geometry.dispose();
    poolMesh.geometry = geometryFromTriangles(poolTriangles);

    rebuildSprings(mirror, network);
    // A rebuild leaves the rings' animated X/Z as placeholders — pose them
    // immediately so the effect is correct even if the frame handler never
    // runs again (prefers-reduced-motion: the spring holds THIS still frame,
    // exactly as the superseded mist held its rest pose).
    applySpringPose(elapsedSeconds);
  };

  /**
   * Writes one animation instant into the spring meshes' position buffers, in
   * place (house rule: no allocation here — every value comes from
   * SpringState's flat arrays).
   *
   * Rings: progress ∈ [0, 1) sweeps a ring's centre-line from birth to death
   * radius; the band's half-width follows sin(π·progress) so it is zero at
   * both ends (see the section comment). Only X/Z move — Y was final at
   * rebuild. Domes: only Y moves, scaled by the swell factor.
   */
  const applySpringPose = (seconds: number): void => {
    if (spring === null) return;

    const ringAttribute = spring.ringGeometry.getAttribute('position') as BufferAttribute;
    const ringArray = ringAttribute.array as Float32Array;
    const ringCycle = seconds / SPRING_RIPPLE_PERIOD_SECONDS;
    const radiusSpanCells = SPRING_RING_MAX_RADIUS_CELLS - SPRING_RING_MIN_RADIUS_CELLS;
    for (let i = 0; i < spring.ringEdge.length; i++) {
      const progress = (ringCycle + spring.ringCycleOffset[i]!) % 1;
      const centreLineRadiusCells = SPRING_RING_MIN_RADIUS_CELLS + radiusSpanCells * progress;
      const halfWidthCells = (SPRING_RING_MAX_WIDTH_CELLS * Math.sin(Math.PI * progress)) / 2;
      // edge 0 → inner (−halfWidth), edge 1 → outer (+halfWidth).
      const radiusWorld =
        (centreLineRadiusCells + (spring.ringEdge[i]! * 2 - 1) * halfWidthCells) * CELL_WORLD_SIZE;
      ringArray[i * 3] = spring.ringCentreX[i]! + spring.ringDirX[i]! * radiusWorld;
      ringArray[i * 3 + 2] = spring.ringCentreZ[i]! + spring.ringDirZ[i]! * radiusWorld;
    }
    ringAttribute.needsUpdate = true;

    const domeAttribute = spring.domeGeometry.getAttribute('position') as BufferAttribute;
    const domeArray = domeAttribute.array as Float32Array;
    const swellAngle = (seconds / SPRING_DOME_SWELL_PERIOD_SECONDS) * TWO_PI;
    for (let i = 0; i < spring.domeRestOffsetY.length; i++) {
      const swell = 1 + SPRING_DOME_SWELL_FRACTION * Math.sin(swellAngle + spring.domePhase[i]!);
      domeArray[i * 3 + 1] = spring.domeSurfaceY[i]! + spring.domeRestOffsetY[i]! * swell;
    }
    domeAttribute.needsUpdate = true;
  };

  // The animation clock STOPS ADVANCING under prefers-reduced-motion (the
  // same pattern plugins/weather/client/index.ts documents on its own
  // `animationSeconds`), which is what lets the pose update below skip its
  // own reduced-motion branch: a frozen clock is a frozen `sin(...)`.
  const reducedMotion = watchReducedMotion();
  let elapsedSeconds = 0;
  const unregisterFrame = onFrame((dt: number) => {
    if (!reducedMotion.matches()) elapsedSeconds += dt;
    if (spring === null || reducedMotion.matches()) return;
    applySpringPose(elapsedSeconds);
  });

  return {
    refresh(mirror: TerrainMirror): void {
      const now = performance.now();
      if (now - lastRebuildMs < RIVER_RECOMPUTE_INTERVAL_MS) return;
      lastRebuildMs = now;
      rebuild(mirror);
    },

    forceRefresh(mirror: TerrainMirror): void {
      lastRebuildMs = performance.now();
      rebuild(mirror);
    },

    dispose(): void {
      unregisterFrame();
      reducedMotion.stop();
      parent.remove(flowMesh);
      parent.remove(poolMesh);
      flowMesh.geometry.dispose();
      poolMesh.geometry.dispose();
      flowMaterial.dispose();
      poolMaterial.dispose();
      springRingMaterial.dispose();
      springDomeMaterial.dispose();
      if (spring !== null) {
        parent.remove(spring.ringMesh);
        parent.remove(spring.domeMesh);
        spring.ringGeometry.dispose();
        spring.domeGeometry.dispose();
      }
    },
  };
}
