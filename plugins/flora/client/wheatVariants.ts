// wheatVariants.ts — THREE candidate wheat-stalk models, built for the owner
// to CHOOSE between from screenshots (run brief 2026-08-23). None of these is
// wired into cropModels.ts yet: that file keeps its current 138-triangle
// stalk until the owner picks, at which point the winning builder's constants
// move across wholesale.
//
// WHY BUILDERS, NOT BUILT GEOMETRY. Same argument fishingHuts.ts's header
// makes for structures: every caller wants its OWN copy of the merged
// geometries so it can dispose them independently; a shared prebuilt set
// would either leak on dispose or force reference counting no caller has
// asked for. A builder is cheap — it runs once per model creation, exactly
// where cropModels.ts's buildStalkGeometries already runs.
//
// THREE DELIBERATELY DIFFERENT READS OF "WHEAT":
//
//   0 botanical   a proper BOTANICAL ear — two opposite ranks of overlapping
//                 lemma-shaped grains up a tapered cob, long awns rising past
//                 the tip, on a JOINTED stem with visible node rings
//   1 bearded     BARLEY read — a shorter, fatter head whose silhouette is
//                 dominated by a dense fan of very long awns; bristles first,
//                 grains second
//   2 harvest     HARVEST-READY — a heavy head nodded far off vertical by its
//                 own grain weight, on a stem of several segments that bend
//                 PROGRESSIVELY, so the plant arcs instead of standing straight
//
// All three are authored piecewise, then MERGED into exactly two geometries
// per variant (stem+leaves under the stem material; cob+kernels+awns under
// the lighter ear material), following cropModels.ts's own merge pattern —
// the unit a thing is authored in is not the unit it is drawn in. Every
// staging geometry is disposed inside its builder before return.
//
// FOOTPRINT IS NOT NEGOTIATED HERE. The plot's span and the four-stalk
// planting both come from protocol.ts (CROP_PLOT_CLUSTER_CELL_SPAN,
// CROP_STALK_OFFSETS), so whichever variant is drawn drops into the renderer's
// apply() loop untouched. Each variant's horizontal reach is asserted against
// that plot at load.
//
// OPTION 2 SHIPS (owner, 2026-08-24). Harvest-heavy is what a crop plot draws
// as; the other two stay for the preview harness and as the start of a variant
// set if crops ever roll one per cell the way fishing huts do. Its leaves came
// off with the tilled bed in the same pass — see buildHarvestWheat.

import {
  BoxGeometry,
  CylinderGeometry,
  Euler,
  Matrix4,
  OctahedronGeometry,
  Quaternion,
  TetrahedronGeometry,
  Vector3,
  type BufferGeometry,
} from 'three';
import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CROP_PLOT_CLUSTER_CELL_SPAN,
  CROP_STALK_JITTER_IN_CLUSTER_SPANS,
  CROP_STALK_OFFSET_IN_CLUSTER_SPANS,
} from '../protocol.ts';

// ── Shared dimensions ─────────────────────────────────────────────────────

/** One crop CELL's worth of world units — the unit every dimension below speaks. */
const cells = (n: number): number => n * CELL_WORLD_SIZE;

/** Identity transform reused by placements that need none. */
const IDENTITY_MATRIX = new Matrix4();

/** The plot this cluster must fit inside. NOT chosen here — see the file banner. */
const CLUSTER_SPAN_IN_CELLS = CROP_PLOT_CLUSTER_CELL_SPAN;

/**
 * The planting, from protocol.ts. The variants differ in stalk SHAPE, never in
 * layout, so any difference between two of them is attributable to the plant.
 */
const STALK_OFFSET_IN_CLUSTER_SPANS = CROP_STALK_OFFSET_IN_CLUSTER_SPANS;

/**
 * Radial segments shared by every stem segment and cob in every variant:
 * five on stems reads round enough at plot scale; six on cobs because the
 * kernels sit ON the cob and a faceted cob silhouette shows there first.
 */
const STEM_RADIAL_SEGMENTS = 5;
const EAR_RADIAL_SEGMENTS = 6;

/** Leaves per stalk — three reads fuller than the baseline's two at close range. */
const LEAVES_PER_STALK = 3;
/** Radians below horizontal — wheat leaves arch outward and droop. */
const LEAF_DROOP_RADIANS = 0.95;
/** Yaw between successive leaves, fanned around the stem so no view is bare. */
const LEAF_YAW_STEP_RADIANS = Math.PI * 0.7;
const BLADE_LENGTH_IN_CELLS = 0.085;
const BLADE_WIDTH_IN_CELLS = 0.016;
const BLADE_THICKNESS_IN_CELLS = 0.005;

/**
 * A leaf's horizontal run: full length foreshortened by its droop. Identical
 * for all three variants (same blade constants), so it enters each variant's
 * reach guard as one shared number.
 */
const LEAF_HORIZONTAL_REACH_IN_CELLS =
  BLADE_LENGTH_IN_CELLS * Math.cos(LEAF_DROOP_RADIANS);

/**
 * The cluster's reach from plot centre for one variant: the planted corner
 * plus that variant's own widest horizontal part, which each caller supplies
 * (the leaf run for the two leafed variants, the nodded head for the leafless
 * one). Asserted
 * against half the bed at load — cropModels.ts makes the identical assertion
 * about its own stalk, and for the same reason: every input is a constant, so
 * this either always holds or never does, and wheat hanging off its own soil
 * is a defect visible from the first frame.
 */
function assertClusterFitsBed(headHorizontalReachInCells: number, label: string): void {
  // The jitter term is why this is a bound and not a measurement: a stalk is
  // planted at its lattice point PLUS a per-stalk wander (protocol.ts's
  // cropStalkVariation), so the worst case is the outermost lattice corner
  // pushed further out along both axes at once.
  const plantedCornerInCells =
    (STALK_OFFSET_IN_CLUSTER_SPANS + CROP_STALK_JITTER_IN_CLUSTER_SPANS) *
    CLUSTER_SPAN_IN_CELLS *
    Math.SQRT2;
  const clusterReach = plantedCornerInCells + headHorizontalReachInCells;
  if (clusterReach > CLUSTER_SPAN_IN_CELLS / 2) {
    throw new RangeError(
      `${label} wheat stalks reach ${clusterReach} cells, past the ${CLUSTER_SPAN_IN_CELLS / 2}-cell edge of their own bed`,
    );
  }
}

// ── Shared build helpers ──────────────────────────────────────────────────

/**
 * Bakes `source` through `local` into a standalone non-indexed geometry ready
 * for mergeGeometries — copied from cropModels.ts's `baked` (same contract:
 * whoever staged the source disposes it).
 */
function baked(source: BufferGeometry, local: Matrix4): BufferGeometry {
  const out = source.index === null ? source.clone() : source.toNonIndexed();
  out.applyMatrix4(local);
  return out;
}

/**
 * Adds an independent baked copy of `part`, transformed by `matrix`, to
 * `parts`. Purely staging — callers dispose each source geometry after its
 * last placement.
 */
function placePart(parts: BufferGeometry[], part: BufferGeometry, matrix: Matrix4): void {
  parts.push(baked(part, matrix));
}

/**
 * Builds the leaves every variant shares: thin slabs attached at even
 * fractions of the stem's middle half, drooped below horizontal and fanned
 * around by LEAF_YAW_STEP_RADIANS per leaf. Returns baked copies; the caller
 * owns nothing further (the one staging blade is disposed here).
 */
function buildLeaves(stemHeightInCells: number): BufferGeometry[] {
  const parts: BufferGeometry[] = [];
  const blade = new BoxGeometry(
    cells(BLADE_LENGTH_IN_CELLS),
    cells(BLADE_THICKNESS_IN_CELLS),
    cells(BLADE_WIDTH_IN_CELLS),
  );
  // Reach outward along +X from the attach point, like cropModels.ts's blades.
  blade.translate(cells(BLADE_LENGTH_IN_CELLS) / 2, 0, 0);

  const scratchMatrix = new Matrix4();
  const scratchQuat = new Quaternion();
  for (let i = 0; i < LEAVES_PER_STALK; i++) {
    // Spread across the stem's middle half — never at the soil, never
    // crowding the ear base above.
    const attachFraction = 0.35 + (i / (LEAVES_PER_STALK - 1)) * 0.3;
    scratchQuat.setFromEuler(
      new Euler(-LEAF_DROOP_RADIANS, i * LEAF_YAW_STEP_RADIANS, 0, 'YXZ'),
    );
    placePart(
      parts,
      blade,
      scratchMatrix.compose(
        new Vector3(0, cells(stemHeightInCells * attachFraction), 0),
        scratchQuat.clone(),
        new Vector3(1, 1, 1),
      ),
    );
  }
  blade.dispose();
  return parts;
}

/** Merges staged parts into one draw geometry, disposing each contributor. */
function mergeAndDispose(parts: BufferGeometry[]): BufferGeometry {
  const merged = mergeGeometries(parts)!;
  for (const part of parts) part.dispose();
  return merged;
}

/** One built variant: two merged geometries sharing a root at the stem base. */
export interface WheatStalkGeometries {
  /** Stem + leaves — draw under the darker stem material. */
  readonly stalk: BufferGeometry;
  /** Cob + kernels + awns — draw under the lighter ear material. */
  readonly ear: BufferGeometry;
}

// ══════════════════════════════════════════════════════════════════════════
// Variant 0 — BOTANICAL WHEAT
// ══════════════════════════════════════════════════════════════════════════

// The jointed stem: three short segments with a slight kink between them,
// marked by node rings slightly fatter than the stem. Real wheat culms are
// jointed; the baseline's single tapered tube reads as a grass blade once the
// camera resolves individual stalks, which is the failure this variant exists
// to beat.
const BOTANICAL_STEM_SEGMENTS = 3;
const BOTANICAL_SEGMENT_LENGTH_IN_CELLS = 0.105;
const BOTANICAL_STEM_BASE_RADIUS_IN_CELLS = 0.017;
const BOTANICAL_STEM_TOP_RADIUS_IN_CELLS = 0.010;
/** Kink between successive segments (radians) — visible joint, not a break. */
const BOTANICAL_NODE_KINK_RADIANS = 0.06;
/** Node rings: short open tubes a hair fatter than the local stem radius. */
const BOTANICAL_NODE_RING_OVERHANG = 1.35;
const BOTANICAL_NODE_RING_HEIGHT_IN_CELLS = 0.012;

// The ear: two opposite ranks of lemma-shaped grains overlapping like shingles
// up a tapered cob, then long awns rising past the tip. This is the variant
// whose grains are individually LEGIBLE — flattened octahedra scaled long and
// keeled, tilted outward-down so each overlaps the one below, exactly how a
// wheat spikelet ranks sit on the head.
const BOTANICAL_EAR_LENGTH_IN_CELLS = 0.12;
const BOTANICAL_EAR_RADIUS_IN_CELLS = 0.02;
const BOTANICAL_EAR_TIP_TAPER = 0.25;
const BOTANICAL_GRAIN_RANKS = 2;
/** Grain pairs (one per rank each) up the ear. */
const BOTANICAL_GRAIN_PAIRS = 8;
const BOTANICAL_GRAIN_SIZE_IN_CELLS = 0.013;
/** Grains are longer than wide, and flattened — lemma-shaped, not beads. */
const BOTANICAL_GRAIN_ELONGATION = 2.0;
const BOTANICAL_GRAIN_FLATTENING = 0.55;
/** Tilt each grain off the cob axis, opening its face to the camera. */
const BOTANICAL_GRAIN_TILT_RADIANS = 0.5;
/** Awns: thin bristles rising from the top grains, splayed but parallel-ish. */
const BOTANICAL_AWN_COUNT = 6;
const BOTANICAL_AWN_LENGTH_IN_CELLS = 0.09;
const BOTANICAL_AWN_THICKNESS_IN_CELLS = 0.004;
/** How far the awn fan spreads, end to end (radians). */
const BOTANICAL_AWN_FAN_RADIANS = 0.5;
/** The whole head nods modestly off vertical — unripe-but-formed wheat. */
const BOTANICAL_HEAD_NOD_RADIANS = 0.35;
const BOTANICAL_HEAD_YAW_RADIANS = Math.PI * 0.35;

function buildBotanicalWheat(): WheatStalkGeometries {
  const stemHeight =
    BOTANICAL_STEM_SEGMENTS * BOTANICAL_SEGMENT_LENGTH_IN_CELLS;
  const earLength = BOTANICAL_EAR_LENGTH_IN_CELLS;

  // Scratch transforms, used only during this one-shot build.
  const m = new Matrix4();
  const q = new Quaternion();

  // ── Jointed stem: kinked segments stacked with node rings at each joint.
  // Open-ended cylinders throughout — the bed hides the bottom rim and the
  // ear caps the top, so no cap earns its triangles.
  const stalkParts: BufferGeometry[] = [...buildLeaves(stemHeight)];
  let cursorY = 0;
  let cursorTilt = 0;
  for (let seg = 0; seg < BOTANICAL_STEM_SEGMENTS; seg++) {
    // Radius tapers linearly from base to top across all segments.
    const tBase = seg / BOTANICAL_STEM_SEGMENTS;
    const tTop = (seg + 1) / BOTANICAL_STEM_SEGMENTS;
    const rBase =
      BOTANICAL_STEM_BASE_RADIUS_IN_CELLS +
      (BOTANICAL_STEM_TOP_RADIUS_IN_CELLS - BOTANICAL_STEM_BASE_RADIUS_IN_CELLS) * tBase;
    const rTop =
      BOTANICAL_STEM_BASE_RADIUS_IN_CELLS +
      (BOTANICAL_STEM_TOP_RADIUS_IN_CELLS - BOTANICAL_STEM_BASE_RADIUS_IN_CELLS) * tTop;
    const segment = new CylinderGeometry(
      cells(rTop), cells(rBase),
      cells(BOTANICAL_SEGMENT_LENGTH_IN_CELLS),
      STEM_RADIAL_SEGMENTS, 1, true,
    );
    q.setFromEuler(new Euler(cursorTilt, 0, 0));
    placePart(
      stalkParts,
      segment,
      m.compose(new Vector3(0, cells(cursorY + BOTANICAL_SEGMENT_LENGTH_IN_CELLS / 2), 0), q, new Vector3(1, 1, 1)),
    );
    segment.dispose();

    // Node ring at the TOP of every segment except the last (the last meets
    // the ear, whose base already reads as a joint).
    if (seg < BOTANICAL_STEM_SEGMENTS - 1) {
      const ring = new CylinderGeometry(
        cells(rTop * BOTANICAL_NODE_RING_OVERHANG), cells(rTop * BOTANICAL_NODE_RING_OVERHANG),
        cells(BOTANICAL_NODE_RING_HEIGHT_IN_CELLS),
        STEM_RADIAL_SEGMENTS, 1, true,
      );
      placePart(
        stalkParts,
        ring,
        m.compose(
          new Vector3(0, cells(cursorY + BOTANICAL_SEGMENT_LENGTH_IN_CELLS), 0),
          new Quaternion(),
          new Vector3(1, 1, 1),
        ),
      );
      ring.dispose();
    }

    cursorY += BOTANICAL_SEGMENT_LENGTH_IN_CELLS;
    cursorTilt += BOTANICAL_NODE_KINK_RADIANS;
  }

  // ── Ear: tapered open cob, then two ranks of shingled lemma grains, then
  // the awn fan rising past the tip.
  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(BOTANICAL_EAR_RADIUS_IN_CELLS * BOTANICAL_EAR_TIP_TAPER),
    cells(BOTANICAL_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  // One grain shape, reused: a flattened, elongated octahedron — keeled like
  // a lemma, wide enough to OVERLAP its neighbour below (the shingle look).
  const grain = new OctahedronGeometry(cells(BOTANICAL_GRAIN_SIZE_IN_CELLS));
  const grainScale = new Vector3(1, BOTANICAL_GRAIN_ELONGATION, BOTANICAL_GRAIN_FLATTENING);
  for (let pair = 0; pair < BOTANICAL_GRAIN_PAIRS; pair++) {
    const alongEar =
      cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) +
      (pair / BOTANICAL_GRAIN_PAIRS) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - BOTANICAL_EAR_TIP_TAPER);
    const rankRadius = cells(BOTANICAL_EAR_RADIUS_IN_CELLS) * taper;
    for (let rank = 0; rank < BOTANICAL_GRAIN_RANKS; rank++) {
      // Two ranks exactly opposite (π apart) — the botanical spikelet layout,
      // deliberately NOT staggered whorls like the baseline's ear.
      const angle = Math.PI * rank + Math.PI / BOTANICAL_GRAIN_RANKS;
      // Tilt the grain out-and-DOWN off the vertical, so its flat face opens
      // toward a camera looking down the head — the overlap read depends on
      // seeing faces, not edges.
      q.setFromEuler(new Euler(-BOTANICAL_GRAIN_TILT_RADIANS, angle, 0, 'YXZ'));
      placePart(
        earParts,
        grain,
        m.compose(
          new Vector3(
            Math.cos(angle) * (rankRadius + cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) * 0.5),
            alongEar,
            Math.sin(angle) * (rankRadius + cells(BOTANICAL_GRAIN_SIZE_IN_CELLS) * 0.5),
          ),
          q,
          grainScale,
        ),
      );
    }
  }
  grain.dispose();

  // Awning fan: six thin bristles from just below the tip, splayed across a
  // narrow arc and leaning back with the head's own nod direction.
  const awn = new BoxGeometry(
    cells(BOTANICAL_AWN_THICKNESS_IN_CELLS),
    cells(BOTANICAL_AWN_LENGTH_IN_CELLS),
    cells(BOTANICAL_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(BOTANICAL_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < BOTANICAL_AWN_COUNT; a++) {
    const fanT = a / (BOTANICAL_AWN_COUNT - 1);
    q.setFromEuler(new Euler(
      BOTANICAL_AWN_FAN_RADIANS * 0.5 + BOTANICAL_AWN_FAN_RADIANS * fanT * 0.3,
      fanT * BOTANICAL_AWN_FAN_RADIANS * 2,
      0, 'YXZ',
    ));
    placePart(
      earParts,
      awn,
      m.compose(
        new Vector3(0, cells(earLength * 0.9), 0),
        q,
        new Vector3(1, 1, 1),
      ),
    );
  }
  awn.dispose();

  // Pivot the whole head about the stem top by yaw-then-nod, exactly the way
  // cropModels.ts pivots its ear — ripe-enough wheat leans, green wheat does
  // not stand bolt upright either.
  const headPivot = new Matrix4()
    .makeTranslation(0, cells(cursorY), 0)
    .multiply(
      new Matrix4().makeRotationFromEuler(
        new Euler(BOTANICAL_HEAD_NOD_RADIANS, BOTANICAL_HEAD_YAW_RADIANS, 0, 'YXZ'),
      ),
    );
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    Math.max(
      LEAF_HORIZONTAL_REACH_IN_CELLS,
      earLength * Math.sin(BOTANICAL_HEAD_NOD_RADIANS),
    ),
    'botanical',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

// ══════════════════════════════════════════════════════════════════════════
// Variant 1 — BEARDED BARLEY
// ══════════════════════════════════════════════════════════════════════════

// Shorter and FATTER than the botanical ear: barley heads are squat and dense,
// and their silhouette is dominated by the beard — a fan of very long awns
// that more than doubles the head's visual height. At plot distance the head
// should read as BRISTLES with grain behind them, not as beads with bristles
// on top; that inversion is what separates this variant from option 0.
const BEARDED_STEM_HEIGHT_IN_CELLS = 0.26;
const BEARDED_STEM_BASE_RADIUS_IN_CELLS = 0.018;
const BEARDED_STEM_TOP_RADIUS_IN_CELLS = 0.011;

const BEARDED_EAR_LENGTH_IN_CELLS = 0.095;
const BEARDED_EAR_RADIUS_IN_CELLS = 0.026;
const BEARDED_EAR_TIP_TAPER = 0.45;
/** Dense grain packing: four staggered whorls of six plump tetrahedra. */
const BEARDED_KERNEL_WHORLS = 4;
const BEARDED_KERNELS_PER_WHORL = 6;
const BEARDED_KERNEL_SIZE_IN_CELLS = 0.012;

/** The beard: many long awns, the head's dominant feature. */
const BEARDED_AWN_COUNT = 12;
const BEARDED_AWN_LENGTH_IN_CELLS = 0.14;
const BEARDED_AWN_THICKNESS_IN_CELLS = 0.0035;
/** Total arc the beard fans across — wide enough to read from any quarter turn. */
const BEARDED_AWN_FAN_ARC_RADIANS = Math.PI * 1.6;
/** Awns lean back away from the head by this much at the fan's widest. */
const BEARDED_AWN_LEAN_RADIANS = 0.55;

function buildBeardedBarley(): WheatStalkGeometries {
  const earLength = BEARDED_EAR_LENGTH_IN_CELLS;
  const m = new Matrix4();
  const q = new Quaternion();

  // Straight single-tube stem — barley culms read plain next to the showy
  // head; spending triangles there would dilute the silhouette this variant
  // is about.
  const stalkParts: BufferGeometry[] = [...buildLeaves(BEARDED_STEM_HEIGHT_IN_CELLS)];
  const stem = new CylinderGeometry(
    cells(BEARDED_STEM_TOP_RADIUS_IN_CELLS), cells(BEARDED_STEM_BASE_RADIUS_IN_CELLS),
    cells(BEARDED_STEM_HEIGHT_IN_CELLS), STEM_RADIAL_SEGMENTS, 1, true,
  );
  stem.translate(0, cells(BEARDED_STEM_HEIGHT_IN_CELLS) / 2, 0);
  placePart(stalkParts, stem, IDENTITY_MATRIX);
  stem.dispose();

  // Fat, nearly untapered cob — barley heads swell rather than spike.
  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(BEARDED_EAR_RADIUS_IN_CELLS * BEARDED_EAR_TIP_TAPER),
    cells(BEARDED_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  // Dense kernel packing: four staggered whorls of six small tetrahedra —
  // cheaper than octahedra because there are MANY of them, and at this size
  // a 4-triangle chip reads exactly as granular as an 8-triangle bead.
  const kernel = new TetrahedronGeometry(cells(BEARDED_KERNEL_SIZE_IN_CELLS));
  for (let w = 0; w < BEARDED_KERNEL_WHORLS; w++) {
    const alongEar =
      cells(BEARDED_KERNEL_SIZE_IN_CELLS) +
      (w / (BEARDED_KERNEL_WHORLS - 1)) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - BEARDED_EAR_TIP_TAPER);
    const whorlRadius = cells(BEARDED_EAR_RADIUS_IN_CELLS) * taper;
    for (let k = 0; k < BEARDED_KERNELS_PER_WHORL; k++) {
      const angle =
        (Math.PI * 2 * k) / BEARDED_KERNELS_PER_WHORL +
        (w % 2) * (Math.PI / BEARDED_KERNELS_PER_WHORL);
      q.setFromEuler(new Euler((w % 2 ? 1 : -1) * 0.6, angle, 0, 'YXZ'));
      placePart(
        earParts,
        kernel,
        m.compose(
          new Vector3(
            Math.cos(angle) * (whorlRadius + cells(BEARDED_KERNEL_SIZE_IN_CELLS) * 0.35),
            alongEar,
            Math.sin(angle) * (whorlRadius + cells(BEARDED_KERNEL_SIZE_IN_CELLS) * 0.35),
          ),
          q,
          new Vector3(1, 1.4, 1),
        ),
      );
    }
  }
  kernel.dispose();

  // THE BEARD: twelve long thin awns launched from around the head's upper
  // half, fanned across a wide arc AND leaned backward, so from any side the
  // head's outline ends in a crown of bristles well above the grain itself.
  const awn = new BoxGeometry(
    cells(BEARDED_AWN_THICKNESS_IN_CELLS),
    cells(BEARDED_AWN_LENGTH_IN_CELLS),
    cells(BEARDED_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(BEARDED_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < BEARDED_AWN_COUNT; a++) {
    const around = (Math.PI * 2 * a) / BEARDED_AWN_COUNT;
    const fan = Math.sin(a * 2.4); // deterministic pseudo-spread within the arc
    q.setFromEuler(new Euler(
      BEARDED_AWN_LEAN_RADIANS * (0.4 + 0.6 * Math.abs(fan)),
      around,
      0, 'YXZ',
    ));
    placePart(
      earParts,
      awn,
      m.compose(
        new Vector3(0, cells(earLength * 0.75), 0),
        q,
        new Vector3(1, 1, 1),
      ),
    );
  }
  awn.dispose();

  // Barley nods only slightly — its stiff beard holds the head near vertical.
  const beardedNodRadians = 0.25;
  const headPivot = new Matrix4()
    .makeTranslation(0, cells(BEARDED_STEM_HEIGHT_IN_CELLS), 0)
    .multiply(new Matrix4().makeRotationFromEuler(new Euler(beardedNodRadians, Math.PI * 0.2, 0, 'YXZ')));
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    Math.max(
      LEAF_HORIZONTAL_REACH_IN_CELLS,
      // The beard's backward lean, not the nod, sets this variant's head run.
      BEARDED_AWN_LENGTH_IN_CELLS *
        Math.sin(beardedNodRadians + BEARDED_AWN_LEAN_RADIANS),
    ),
    'bearded',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

// ══════════════════════════════════════════════════════════════════════════
// Variant 2 — HARVEST-HEAVY WHEAT
// ══════════════════════════════════════════════════════════════════════════

// The ripe read: a big, plump head carried FAR off vertical by its own weight,
// on a stem that visibly ARCS — four progressively-bent segments instead of
// one straight tube. Options 0 and 1 both stand essentially upright; this one
// is about the curve of the whole plant, golden and sagging, ready to cut.
const HEAVY_STEM_SEGMENTS = 4;
const HEAVY_SEGMENT_LENGTH_IN_CELLS = 0.075;
const HEAVY_STEM_BASE_RADIUS_IN_CELLS = 0.019;
const HEAVY_STEM_TOP_RADIUS_IN_CELLS = 0.011;
/**
 * Bend added PER SEGMENT (radians) — cumulative, hence the arc. Tuned against
 * the bed-edge guard below: the stem-top drift plus the nodded ear's own run
 * must stay inside the ~0.116-cell slack the shared 0.22-offset cluster
 * leaves past the bed's half-width, which caps how dramatic the sag can be.
 */
const HEAVY_BEND_PER_SEGMENT_RADIANS = 0.075;

const HEAVY_EAR_LENGTH_IN_CELLS = 0.105;
const HEAVY_EAR_RADIUS_IN_CELLS = 0.024;
const HEAVY_EAR_TIP_TAPER = 0.3;
/** Plump kernels: four whorls of six full octahedra — the fat, heavy read. */
const HEAVY_KERNEL_WHORLS = 4;
const HEAVY_KERNELS_PER_WHORL = 6;
const HEAVY_KERNEL_SIZE_IN_CELLS = 0.015;
const HEAVY_KERNEL_ELONGATION = 1.7;
/** The heavy head hangs further over than the other two variants. */
const HEAVY_HEAD_NOD_RADIANS = 0.22;
const HEAVY_HEAD_YAW_RADIANS = Math.PI * 0.3;
/**
 * Short stubble awns on the ripe head: real harvest-stage wheat keeps broken
 * awn stubs, and they add silhouette roughness that reads as "ripe", not
 * "barren" — deliberately far shorter than options 0 and 1, whose long awns
 * are their own identities.
 */
const HEAVY_AWN_COUNT = 5;
const HEAVY_AWN_LENGTH_IN_CELLS = 0.05;
const HEAVY_AWN_THICKNESS_IN_CELLS = 0.004;

function buildHarvestWheat(): WheatStalkGeometries {
  const earLength = HEAVY_EAR_LENGTH_IN_CELLS;
  const stemHeight = HEAVY_STEM_SEGMENTS * HEAVY_SEGMENT_LENGTH_IN_CELLS;
  const m = new Matrix4();
  const q = new Quaternion();

  // NO LEAVES (owner, 2026-08-24: "make the arm-like appendages go away").
  // buildLeaves attaches blades as thin slabs at a fixed droop, and at this
  // size they read as straight arms stuck out at right angles rather than as
  // anything botanical — the one thing every reviewer noticed in the three
  // option renders. A bare culm under a heavy head is also the truer harvest
  // silhouette: by the time wheat sags like this its lower leaves have dried
  // off. The other two variants keep theirs; this is not a shared change.
  //
  // Arcing stem: each segment is placed rotated by the cumulative bend, and
  // translated along the PREVIOUS direction, so the stem sweeps through a
  // real curve rather than kinking at joints (that is option 0's trick).
  const stalkParts: BufferGeometry[] = [];
  const position = new Vector3(0, 0, 0);
  const direction = new Vector3(0, 1, 0);
  let cumulativeBend = 0;
  for (let seg = 0; seg < HEAVY_STEM_SEGMENTS; seg++) {
    const tBase = seg / HEAVY_STEM_SEGMENTS;
    const rBase =
      HEAVY_STEM_BASE_RADIUS_IN_CELLS +
      (HEAVY_STEM_TOP_RADIUS_IN_CELLS - HEAVY_STEM_BASE_RADIUS_IN_CELLS) * tBase;
    const rTop =
      HEAVY_STEM_BASE_RADIUS_IN_CELLS +
      (HEAVY_STEM_TOP_RADIUS_IN_CELLS - HEAVY_STEM_BASE_RADIUS_IN_CELLS) * ((seg + 1) / HEAVY_STEM_SEGMENTS);
    const segment = new CylinderGeometry(
      cells(rTop), cells(rBase),
      cells(HEAVY_SEGMENT_LENGTH_IN_CELLS),
      STEM_RADIAL_SEGMENTS, 1, true,
    );
    // Orient the cylinder (+Y) along the current direction of the arc.
    q.setFromUnitVectors(new Vector3(0, 1, 0), direction);
    const mid = position.clone().addScaledVector(direction, cells(HEAVY_SEGMENT_LENGTH_IN_CELLS) / 2);
    placePart(stalkParts, segment, m.compose(mid, q, new Vector3(1, 1, 1)));
    segment.dispose();

    position.addScaledVector(direction, cells(HEAVY_SEGMENT_LENGTH_IN_CELLS));
    cumulativeBend += HEAVY_BEND_PER_SEGMENT_RADIANS;
    // Rotate the walk direction one more step around Z — the arc plane is X-Y.
    direction.applyAxisAngle(new Vector3(0, 0, 1), -HEAVY_BEND_PER_SEGMENT_RADIANS).normalize();
  }

  // Big plump head, assembled along local +Y then swung far over.
  const earParts: BufferGeometry[] = [];
  const cob = new CylinderGeometry(
    cells(HEAVY_EAR_RADIUS_IN_CELLS * HEAVY_EAR_TIP_TAPER),
    cells(HEAVY_EAR_RADIUS_IN_CELLS),
    cells(earLength), EAR_RADIAL_SEGMENTS, 1, true,
  );
  cob.translate(0, cells(earLength) / 2, 0);
  placePart(earParts, cob, IDENTITY_MATRIX);
  cob.dispose();

  const kernel = new OctahedronGeometry(cells(HEAVY_KERNEL_SIZE_IN_CELLS));
  const kernelScale = new Vector3(1, HEAVY_KERNEL_ELONGATION, 1.1);
  for (let w = 0; w < HEAVY_KERNEL_WHORLS; w++) {
    const alongEar =
      cells(HEAVY_KERNEL_SIZE_IN_CELLS) +
      (w / (HEAVY_KERNEL_WHORLS - 1)) * cells(earLength) * 0.85;
    const taper = 1 - (alongEar / cells(earLength)) * (1 - HEAVY_EAR_TIP_TAPER);
    const whorlRadius = cells(HEAVY_EAR_RADIUS_IN_CELLS) * taper;
    for (let k = 0; k < HEAVY_KERNELS_PER_WHORL; k++) {
      const angle =
        (Math.PI * 2 * k) / HEAVY_KERNELS_PER_WHORL +
        (w % 2) * (Math.PI / HEAVY_KERNELS_PER_WHORL);
      placePart(
        earParts,
        kernel,
        m.compose(
          new Vector3(
            Math.cos(angle) * (whorlRadius + cells(HEAVY_KERNEL_SIZE_IN_CELLS) * 0.4),
            alongEar,
            Math.sin(angle) * (whorlRadius + cells(HEAVY_KERNEL_SIZE_IN_CELLS) * 0.4),
          ),
          q.identity(),
          kernelScale,
        ),
      );
    }
  }
  kernel.dispose();

  // Broken awn stubs from the tip — short, splayed around the axis, leaning
  // on with the head's own nod so they extend the sag rather than fight it.
  const awn = new BoxGeometry(
    cells(HEAVY_AWN_THICKNESS_IN_CELLS),
    cells(HEAVY_AWN_LENGTH_IN_CELLS),
    cells(HEAVY_AWN_THICKNESS_IN_CELLS),
  );
  awn.translate(0, cells(HEAVY_AWN_LENGTH_IN_CELLS) / 2, 0);
  for (let a = 0; a < HEAVY_AWN_COUNT; a++) {
    const around = (Math.PI * 2 * a) / HEAVY_AWN_COUNT;
    q.setFromEuler(new Euler(0.3, around, 0, 'YXZ'));
    placePart(
      earParts,
      awn,
      m.compose(new Vector3(0, cells(earLength * 0.95), 0), q, new Vector3(1, 1, 1)),
    );
  }
  awn.dispose();

  // Swing the head over by the stem's FINAL bend direction plus the extra nod,
  // so the head continues the arc instead of restarting a new angle — the
  // continuous sag is the whole point of this variant.
  const headPivot = new Matrix4()
    .makeTranslation(position.x, position.y, position.z)
    .multiply(
      new Matrix4().makeRotationFromEuler(
        new Euler(cumulativeBend + HEAVY_HEAD_NOD_RADIANS, HEAVY_HEAD_YAW_RADIANS, 0, 'YXZ'),
      ),
    );
  for (const part of earParts) part.applyMatrix4(headPivot);

  assertClusterFitsBed(
    // No leaf term: this variant has no leaves, so its head IS its widest
    // part — the stem top's own lateral drift plus the nodded ear beyond it.
    // `position` is in world units, i.e. `cells(…)` numbers — convert back.
    Math.abs(position.x) / CELL_WORLD_SIZE +
      earLength * Math.sin(cumulativeBend + HEAVY_HEAD_NOD_RADIANS),
    'harvest',
  );

  return { stalk: mergeAndDispose(stalkParts), ear: mergeAndDispose(earParts) };
}

// ══════════════════════════════════════════════════════════════════════════
// Exports — builders and names, in matching order, fishingHuts.ts style.
// ══════════════════════════════════════════════════════════════════════════

/** Builders, not built geometry — see the file banner for the dispose reason. */
export const WHEAT_VARIANT_BUILDERS: ReadonlyArray<() => WheatStalkGeometries> = [
  buildBotanicalWheat,
  buildBeardedBarley,
  buildHarvestWheat,
];

/** Display names for the preview harness's page title and the report. */
export const WHEAT_VARIANT_NAMES: ReadonlyArray<string> = [
  'Botanical',
  'Bearded barley',
  'Harvest-heavy',
];

/**
 * Which variant a crop plot actually draws as (owner's pick, 2026-08-24).
 *
 * An INDEX into the arrays above rather than a direct export of the builder,
 * so the shipped model and the previewed model can never drift apart: the
 * preview harness reaches the same builder through the same array, and there
 * is one place to change when the pick changes.
 */
export const SHIPPED_WHEAT_VARIANT = 2;
