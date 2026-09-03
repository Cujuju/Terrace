// The bison, as anatomy: the herd animal.
//
// Authored from MEASUREMENTS of the reference photograph (side profile,
// .claude/orchestration/refs/bison/3.png), not from a description of one.
// With the hump top at 1.0 and the hooves at 0.0, the animal measures:
//
//   nose to rump      1.42  — compact: barely half again as long as it is tall
//   hump peak         at 40% of the length from the nose; the rise starts
//                     right behind the head, the fall behind it is SLOW —
//                     the back is still at 0.87 nine-tenths of the way back
//   belly             0.35 the whole way; the chest floor 0.31 under the hump
//   legs              the lowest 0.35, thick and short; the forelegs feathered
//   head              0.31 long, 0.38 tall with the beard — a third of the
//                     animal's height; the crown 0.15 below the hump
//   rump              rounded and SMALLER than the barrel: the hull tucks in
//                     behind the hips and the thighs bulge past it — the
//                     hind legs, not the hull, carry the mass back there;
//                     the tail hangs to 0.50
//
// Every number below is one of those, scaled so the hump top sits at
// HUMP_TOP_Y authoring units. The body is authored as two silhouette lines
// (back and belly) along the hull; the swept hull takes half their gap as its
// half-height and a deform afterwards lifts each ring to their midline.
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

/** Hump top above the hooves, authoring units: the photo's 1.0. */
const HUMP_TOP_Y = 1.32;
/** Photo heights (hump = 1) to authoring units. */
const H = HUMP_TOP_Y;

/** The hull runs from the chest front (25% of the photo) to the rump (95%). */
const BODY_LENGTH = 0.70 * 1.42 * H;
const MAX_HALF_WIDTH = 0.30;
const HULL_RINGS = 26;
const HULL_SEGMENTS = 14;

/**
 * The two silhouette lines as heights above the ground at t along the hull
 * (0 = chest front, 1 = rump), read off the photo every 5% of its length.
 */
const BACK_LINE = profileFromPoints([
  [0.00, 0.90 * H], [0.07, 0.98 * H], [0.21, 1.00 * H], [0.36, 0.98 * H],
  [0.50, 0.95 * H], [0.64, 0.92 * H], [0.79, 0.91 * H], [0.86, 0.88 * H],
  [0.93, 0.83 * H], [1.00, 0.70 * H],
]);
const BELLY_LINE = profileFromPoints([
  [0.00, 0.42 * H], [0.07, 0.35 * H], [0.21, 0.31 * H], [0.36, 0.31 * H],
  [0.50, 0.35 * H], [0.64, 0.35 * H], [0.79, 0.40 * H], [0.93, 0.52 * H],
  [1.00, 0.62 * H],
]);

/** The cape: a loft over the forequarters, stepping down to the hind coat. */
const CAPE_END_T = 0.45;
const CAPE_STEP_WIDTH_T = 0.08;
const CAPE_LOFT = 0.03;
/** Flank flatness (0 = elliptical, 1 = rounded square): a barrel, not an egg. */
const BARREL_BOXINESS = 0.35;

/**
 * The head hangs from the front of the cape, nose-down by this much (radians
 * about Z). The photo's head is carried level; the lowered head is the herd
 * animal's resting pose and the silhouette the owner asked for.
 */
const HEAD_DROOP_RADIANS = 0.35;
/** The skull, nose to crown: the photo's 0.31. */
const HEAD_LENGTH = 0.31 * H;

/** Legs hinge inside the body; the photo's leg column is the lowest 0.35. */
const HIP_Y = 0.53 * H;
/**
 * Fore and hind leg stations, as t along the hull (photo 40–52%, 76–90%).
 * The hind column stands at the BACK of its band: a straight leg has no hock
 * to carry the thigh rearward, so the column itself sits under the rump.
 */
const FORE_T = 0.30;
const HIND_T = 0.87;
const HALF_STANCE = 0.16;

const STRIDE_HZ = 1.3;
const LEG_SWING_RADIANS = 0.26;
/** WORLD units (root space). A ton of animal does not bounce. */
const WALK_BOB_WORLD_UNITS = 0.008;
const HEAD_SWAY_RADIANS = 0.07;

/** Where along the hull an authored X falls, clamped for the end caps. */
function hullX(t: number): number {
  return BODY_LENGTH / 2 - t * BODY_LENGTH;
}
function hullT(x: number): number {
  return Math.max(0, Math.min(1, (BODY_LENGTH / 2 - x) / BODY_LENGTH));
}

function smoothstep(edge0: number, edge1: number, x: number): number {
  const u = Math.max(0, Math.min(1, (x - edge0) / (edge1 - edge0)));
  return u * u * (3 - 2 * u);
}

/** Where the skull hangs from: the front of the cape, above the chest. */
const NECK_TOP = new Vector3(hullX(0) + 0.20, 0.72 * H, 0);

export const BISON_ENVELOPE = {
  /** Nose to tail tip. */
  length: (BODY_LENGTH + 0.60 * H) * BISON_SCALE,
  bodyHalfLength: (BODY_LENGTH / 2) * BISON_SCALE,
  /** To the top of the hump, cape included. */
  height: (HUMP_TOP_Y + CAPE_LOFT) * BISON_SCALE,
} as const;

export const buildBison: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(BISON_BODY_COLOR, { flatShading: false });
  const cape = pool.lambert(BISON_CAPE_COLOR, { flatShading: false });
  const horn = pool.lambert(BISON_HORN_COLOR, { flatShading: false });
  const eye = pool.lambert(BISON_EYE_COLOR, { flatShading: false });

  // ── Body ──────────────────────────────────────────────────────────────────
  // Widest through the cape and shoulders, narrowing steadily to the hips,
  // where it is narrower than the haunches that hang beside it.
  const width = profileFromPoints([
    [0.00, 0.85], [0.20, 1.00], [0.50, 0.85], [0.80, 0.62], [1.00, 0.45],
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
    tailCapReach: 0.4,
    boxiness: () => BARREL_BOXINESS,
    displace: (t) => CAPE_LOFT * (1 - smoothstep(CAPE_END_T - CAPE_STEP_WIDTH_T, CAPE_END_T + CAPE_STEP_WIDTH_T, t)),
  }), (v) => {
    // Lift every ring from the hull's centred axis to the authored midline.
    v.y += midline(hullT(v.x));
  }));

  // ── Neck ──────────────────────────────────────────────────────────────────
  // There is no visible neck on a bison: the skull joins the cape directly.
  // A short thick tube bridges the hull's front cap to the head, rooted
  // INSIDE the hull so its ring never shows through the shoulder.
  const neck = pool.keepGeometry(taperedTube({
    path: [new Vector3(hullX(0) - 0.10, 0.66 * H, 0), new Vector3(hullX(0) + 0.06, 0.70 * H, 0), NECK_TOP],
    rootRadius: 0.26,
    tipRadius: 0.21,
    tubularSegments: 5,
    radialSegments: 12,
  }));

  // ── Head ──────────────────────────────────────────────────────────────────
  // A wedge, not a ball: narrow at the nose, broad and tall at the crown.
  // Authored nose toward +X with its centre at the origin, then hung from the
  // head pivot.
  const headWidth = profileFromPoints([[0.00, 0.09], [0.30, 0.13], [0.65, 0.18], [1.00, 0.19]]);
  const headHeight = profileFromPoints([[0.00, 0.10], [0.30, 0.15], [0.65, 0.20], [1.00, 0.20]]);
  const head = pool.keepGeometry(sweptHull({
    length: HEAD_LENGTH,
    rings: 8,
    segments: 10,
    halfWidth: (t) => headWidth(t),
    halfHeight: (t) => headHeight(t),
    noseCapReach: 0.55,
    tailCapReach: 0.75,
  }));
  const nose = pool.keepGeometry(smoothEllipsoid(0.08, 0.07, 0.13, 8, 6));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.05, 0.05, 0.05, 8, 6));
  const ear = pool.keepGeometry(smoothEllipsoid(0.08, 0.07, 0.15, 8, 6));
  // The goatee: a short tuft at the very edge of the chin, just under the
  // nose, hanging straight DOWN in the world. The pivot it lives in is
  // drooped by HEAD_DROOP_RADIANS, so world-down in pivot space leans
  // forward: (sin droop, -cos droop). The path follows that direction.
  const beard = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.36, -0.09, 0), new Vector3(0.39, -0.17, 0), new Vector3(0.415, -0.24, 0)],
    rootRadius: 0.07,
    tipRadius: 0.025,
    tubularSegments: 5,
    radialSegments: 8,
  }));
  // Short, thick horns: out from the sides of the crown, then up and in.
  const horns = [1, -1].map((sign) => pool.keepGeometry(taperedTube({
    path: [
      new Vector3(-0.02, 0.14, sign * 0.14),
      new Vector3(-0.04, 0.22, sign * 0.24),
      new Vector3(-0.02, 0.30, sign * 0.24),
      new Vector3(0.02, 0.36, sign * 0.18),
    ],
    rootRadius: 0.05,
    tipRadius: 0.014,
    tubularSegments: 10,
    radialSegments: 8,
  })));

  // ── Hindquarters and tail ─────────────────────────────────────────────────
  const rumpX = hullX(1);
  const tail = pool.keepGeometry(taperedTube({
    path: [
      new Vector3(rumpX - 0.02, 0.73 * H, 0),
      new Vector3(rumpX - 0.12, 0.65 * H, 0),
      new Vector3(rumpX - 0.14, 0.50 * H, 0),
    ],
    rootRadius: 0.035,
    tipRadius: 0.02,
    tubularSegments: 6,
    radialSegments: 6,
  }));
  const tuft = pool.keepGeometry(smoothEllipsoid(0.08, 0.14, 0.08, 8, 6));

  // ── Legs ──────────────────────────────────────────────────────────────────
  // The forelegs are feathered with cape hair down to the knee, which is what
  // makes the front pair read heavier than the hind.
  const foreShag = pool.keepGeometry(smoothEllipsoid(0.26, 0.42, 0.24, 8, 6));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.scale.setScalar(BISON_SCALE);
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(neck, cape, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));
  rig.add(pool.part(tuft, cape, rumpX - 0.15, 0.46 * H, 0));

  const headPivot = new Group();
  headPivot.position.copy(NECK_TOP);
  headPivot.rotation.z = -HEAD_DROOP_RADIANS;
  const HEAD_CENTRE_X = HEAD_LENGTH * 0.45;
  headPivot.add(pool.part(head, cape, HEAD_CENTRE_X, 0, 0));
  headPivot.add(pool.part(nose, horn, HEAD_CENTRE_X + HEAD_LENGTH * 0.5 + 0.04, -0.02, 0));
  headPivot.add(pool.part(beard, cape, 0, 0, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, HEAD_CENTRE_X + 0.08, 0.05, sign * 0.16));
    headPivot.add(pool.part(ear, cape, -0.06, 0.06, sign * 0.24));
    headPivot.add(pool.part(horns[sign === 1 ? 0 : 1]!, horn, 0, 0, 0));
  }
  rig.add(headPivot);

  const legs = addQuadrupedLegs(pool, rig, {
    hipY: HIP_Y,
    foreX: hullX(FORE_T),
    hindX: hullX(HIND_T),
    halfStance: HALF_STANCE,
    rootRadius: 0.095,
    tipRadius: 0.06,
    radialSegments: 7,
    heightSegments: 1,
    hoofHeight: 0.07,
    // Bigger than the hull's hip section: the thighs stand proud of the flank.
    haunch: [0.36, 0.50, 0.22],
  }, body, horn, body);
  for (const fore of [legs.foreLeft, legs.foreRight]) {
    fore.add(pool.part(foreShag, cape, 0, -0.12, 0));
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
