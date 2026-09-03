// The bison, as anatomy: the herd animal.
//
// Recognised by its silhouette before anything else: a massive shoulder hump
// that is the highest point of the animal, a back that slopes steadily away to
// narrow hindquarters, a huge low-slung head carried BELOW the shoulder line
// with the nose down near the knees, short in-curving horns, a beard, and a
// shaggy cape over the forequarters that stops mid-body with a visible step to
// the short hind coat. The legs are short for the depth of the body, the front
// pair heavier than the hind. The front half is the animal.
//
// The body is authored as two SILHOUETTE LINES — the back and the belly, each
// as heights above the ground along the body — rather than as a centred hull
// with a hump stuck on. That is how the animal is judged (does the hump peak
// above the hips? does the brisket hang below the flank?), so it is how it is
// stated. The swept hull gets half the gap as its half-height, and a deform
// afterwards lifts each ring to the midline between the two lines.
//
// Twice the grazer's bulk at the same authoring scale, which is what a herd of
// six reads as from the camera: dark, heavy, and moving together.
//
// GAIT: a slow, heavy walk — a small leg swing at a low stride rate, the body
// barely rising, the head swinging a little from side to side with the stride.
import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { deform, smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { addQuadrupedLegs, legJoints, poseWalk } from './quadruped.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

export const BISON_SCALE = 0.4;

const BISON_BODY_COLOR = 0x4a3323; // dark brown
const BISON_CAPE_COLOR = 0x3a2718; // darker still: the shaggy forequarters and head
const BISON_HORN_COLOR = 0x2b2420;
const BISON_EYE_COLOR = 0x120f0d;

/** Hull nose-to-tail, in authoring units; the head hangs beyond the nose. */
const BODY_LENGTH = 1.70;
const MAX_HALF_WIDTH = 0.30;
const HULL_RINGS = 26;
const HULL_SEGMENTS = 14;

/**
 * The two silhouette lines, as heights above the ground at t along the hull
 * (0 = nose end, 1 = tail end). The back peaks at the hump just behind the
 * head and falls all the way to the rump; the belly hangs deepest at the
 * brisket and rises toward the tail.
 */
const HUMP_TOP_Y = 1.32;
const BACK_LINE = profileFromPoints([
  [0.00, 1.06], [0.10, 1.22], [0.22, HUMP_TOP_Y], [0.36, 1.25], [0.55, 1.13],
  [0.75, 1.05], [0.90, 1.00], [1.00, 0.94],
]);
const BELLY_LINE = profileFromPoints([
  [0.00, 0.62], [0.12, 0.48], [0.30, 0.46], [0.55, 0.50], [0.80, 0.56],
  [1.00, 0.66],
]);

/** The cape: a loft over the front half of the body, stepping down mid-body. */
const CAPE_END_T = 0.50;
/** How far the step from cape to hind coat is smeared along the body. */
const CAPE_STEP_WIDTH_T = 0.10;
const CAPE_LOFT = 0.035;
/**
 * The cape's shag, as a fine relief over the loft. It dies out BEFORE the step
 * so the step's edge is a clean line: shag running through the step makes the
 * edge a zigzag that reads as torn geometry rather than as hair.
 */
const SHAG_DEPTH = 0.016;
const SHAG_FADE_START_T = CAPE_END_T - 0.22;
const SHAG_FADE_END_T = CAPE_END_T - 0.08;
const SHAG_AROUND = 4;
const SHAG_ALONG = 34;

/** The head hangs nose-down from the neck by this much (radians about Z). */
const HEAD_DROOP_RADIANS = 0.45;

const HIP_Y = 0.62;
const FORE_X = 0.42;
const HIND_X = -0.58;
const HALF_STANCE = 0.17;

const STRIDE_HZ = 1.3;
const LEG_SWING_RADIANS = 0.26;
/** WORLD units (root space). A ton of animal does not bounce. */
const WALK_BOB_WORLD_UNITS = 0.008;
const HEAD_SWAY_RADIANS = 0.07;

export const BISON_ENVELOPE = {
  /** Nose to tail tip. */
  length: 2.50 * BISON_SCALE,
  bodyHalfLength: (BODY_LENGTH / 2) * BISON_SCALE,
  /** To the top of the hump, cape included. */
  height: (HUMP_TOP_Y + CAPE_LOFT) * BISON_SCALE,
} as const;

/** Where along the hull an authored X falls, clamped for the end caps. */
function hullT(x: number): number {
  return Math.max(0, Math.min(1, (BODY_LENGTH / 2 - x) / BODY_LENGTH));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return u * u * (3 - 2 * u);
}

export const buildBison: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(BISON_BODY_COLOR, { flatShading: false });
  const cape = pool.lambert(BISON_CAPE_COLOR, { flatShading: false });
  const horn = pool.lambert(BISON_HORN_COLOR, { flatShading: false });
  const eye = pool.lambert(BISON_EYE_COLOR, { flatShading: false });

  // Front-heavy: full through the shoulders, falling away to the hips.
  const width = profileFromPoints([
    [0.00, 0.74], [0.12, 0.96], [0.30, 1.00], [0.50, 0.90], [0.72, 0.80],
    [0.90, 0.66], [1.00, 0.46],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => (BACK_LINE(t) - BELLY_LINE(t)) / 2;
  const midline = (t: number): number => (BACK_LINE(t) + BELLY_LINE(t)) / 2;

  const hull = pool.keepGeometry(deform(sweptHull({
    length: BODY_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.7,
    tailCapReach: 0.9,
    displace: (t, theta) => {
      // The cape: lofted over the front half, stepping down to the hind coat.
      const capeWeight = 1 - smoothstep(CAPE_END_T - CAPE_STEP_WIDTH_T, CAPE_END_T + CAPE_STEP_WIDTH_T, t);
      const shagWeight = 1 - smoothstep(SHAG_FADE_START_T, SHAG_FADE_END_T, t);
      return capeWeight * CAPE_LOFT
        + shagWeight * SHAG_DEPTH * Math.sin(theta * SHAG_AROUND) * Math.sin(t * SHAG_ALONG);
    },
  }), (v) => {
    // Lift every ring from the hull's centred axis to the authored midline.
    v.y += midline(hullT(v.x));
  }));

  // The head hangs low: a short, thick neck leaves the front of the cape and
  // the skull droops from its end, nose toward the ground. Authored in
  // head-pivot space relative to NECK_TOP, before the droop.
  const NECK_TOP = new Vector3(0.98, 0.80, 0);
  const neck = pool.keepGeometry(taperedTube({
    // The root sits INSIDE the hull (hull half-width ~0.29 here): a root ring
    // wider than the flank shows through it as a ragged seam at the shoulder.
    path: [new Vector3(0.66, 0.88, 0), new Vector3(0.84, 0.84, 0), NECK_TOP],
    rootRadius: 0.22,
    tipRadius: 0.24,
    tubularSegments: 6,
    radialSegments: 12,
  }));
  // Huge and broad, short in the face: a bison's head is a third of its height.
  const head = pool.keepGeometry(smoothEllipsoid(0.62, 0.56, 0.50, 10, 8));
  const muzzle = pool.keepGeometry(smoothEllipsoid(0.34, 0.28, 0.30, 8, 6));
  const nose = pool.keepGeometry(smoothEllipsoid(0.10, 0.08, 0.14, 8, 6));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.05, 0.05, 0.05, 8, 6));
  const ear = pool.keepGeometry(smoothEllipsoid(0.10, 0.08, 0.16, 8, 6));
  // The beard hangs under the chin; authored leaning forward so it hangs
  // near-vertical once the head droops.
  const beard = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.40, -0.20, 0), new Vector3(0.43, -0.34, 0), new Vector3(0.45, -0.44, 0)],
    rootRadius: 0.11,
    tipRadius: 0.03,
    tubularSegments: 5,
    radialSegments: 8,
  }));
  // Short, thick horns: out from the sides of the crown, then up and in.
  const horns = [1, -1].map((sign) => pool.keepGeometry(taperedTube({
    path: [
      new Vector3(0.02, 0.16, sign * 0.16),
      new Vector3(0.00, 0.24, sign * 0.27),
      new Vector3(0.02, 0.34, sign * 0.28),
      new Vector3(0.06, 0.42, sign * 0.22),
    ],
    rootRadius: 0.06,
    tipRadius: 0.015,
    tubularSegments: 10,
    radialSegments: 8,
  })));
  const tail = pool.keepGeometry(taperedTube({
    path: [new Vector3(-0.88, 0.90, 0), new Vector3(-0.97, 0.72, 0), new Vector3(-1.00, 0.52, 0)],
    rootRadius: 0.035,
    tipRadius: 0.02,
    tubularSegments: 6,
    radialSegments: 6,
  }));
  const tuft = pool.keepGeometry(smoothEllipsoid(0.08, 0.14, 0.08, 8, 6));
  // The shaggy pantaloons on the forelegs: what makes the front pair heavy.
  const foreShag = pool.keepGeometry(smoothEllipsoid(0.26, 0.36, 0.24, 8, 6));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.scale.setScalar(BISON_SCALE);
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(neck, cape, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));
  rig.add(pool.part(tuft, cape, -1.00, 0.46, 0));

  const headPivot = new Group();
  headPivot.position.copy(NECK_TOP);
  headPivot.rotation.z = -HEAD_DROOP_RADIANS;
  headPivot.add(pool.part(head, cape, 0.16, -0.02, 0));
  headPivot.add(pool.part(muzzle, cape, 0.46, -0.12, 0));
  headPivot.add(pool.part(nose, horn, 0.62, -0.14, 0));
  headPivot.add(pool.part(beard, cape, 0, 0, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, 0.30, 0.02, sign * 0.22));
    headPivot.add(pool.part(ear, cape, 0.02, 0.10, sign * 0.27));
    headPivot.add(pool.part(horns[sign === 1 ? 0 : 1]!, horn, 0, 0, 0));
  }
  rig.add(headPivot);

  const legs = addQuadrupedLegs(pool, rig, {
    hipY: HIP_Y,
    foreX: FORE_X,
    hindX: HIND_X,
    halfStance: HALF_STANCE,
    rootRadius: 0.10,
    tipRadius: 0.055,
    radialSegments: 6,
    heightSegments: 1,
    hoofHeight: 0.07,
    haunch: [0.34, 0.40, 0.20],
  }, body, horn, body);
  for (const fore of [legs.foreLeft, legs.foreRight]) {
    fore.add(pool.part(foreShag, cape, 0, -0.06, 0));
  }

  return {
    root,
    joints: { rig, head: headPivot, ...legJoints(legs) },
    animate(joints, seconds, phase) {
      const beat = seconds * STRIDE_HZ * TWO_PI + phase;
      poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
      // The head swings with the stride, not the footfall: once per cycle.
      joints.head!.rotation.y = Math.sin(beat) * HEAD_SWAY_RADIANS;
    },
  };
};
