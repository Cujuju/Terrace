// The ibex, as anatomy: the crag climber.
//
// Read at a glance by two things the plain grazer has not got: a pair of long
// scimitar horns sweeping back over the neck, and a stockier build — shorter,
// thicker legs under a deeper barrel, the body of an animal that stands on
// ledges rather than one that runs from them. A beard under the chin, ears
// laid back beside the horns, and a short flag of a tail.
//
// Sized a little under the grazer (IBEX_SCALE): the horns add height, and the
// owner's 2026-08-24 rule that grazers stay plainly smaller than the settlers
// (PILGRIM_HEIGHT 0.62) has to hold at the horn tips, not the shoulder.
//
// GAIT: a bounding walk — a larger leg swing and a higher bob than the
// grazer's, because an ibex on broken ground steps up rather than along.
import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { addQuadrupedLegs, legJoints, poseWalk } from './quadruped.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

export const IBEX_SCALE = 0.36;

const IBEX_BODY_COLOR = 0x8b7b63; // grey-brown, the colour of the rock it stands on
const IBEX_LEG_COLOR = 0x5a4b3a;
const IBEX_HORN_COLOR = 0x3b3129;
const IBEX_EYE_COLOR = 0x1c1a17;

const BODY_LENGTH = 0.90;
const BODY_CENTRE_Y = 0.62;
const MAX_HALF_WIDTH = 0.22;
const HIP_Y = 0.46;
const FORE_X = 0.30;
const HIND_X = -0.30;
const HALF_STANCE = 0.12;
const HULL_RINGS = 18;
const HULL_SEGMENTS = 12;

/** Horn: root to tip, over the neck and back. */
const HORN_ROOT_RADIUS = 0.04;
const HORN_TIP_RADIUS = 0.012;
const HORN_SEGMENTS = 10;

const STRIDE_HZ = 2.2;
const LEG_SWING_RADIANS = 0.40;
/** WORLD units (root space). Higher than the grazer's: a step up, not along. */
const WALK_BOB_WORLD_UNITS = 0.02;
const HEAD_NOD_RADIANS = 0.06;

export const IBEX_ENVELOPE = {
  length: (0.90 + 0.55) * IBEX_SCALE,
  bodyHalfLength: (BODY_LENGTH / 2) * IBEX_SCALE,
  /** To the horn tips. */
  height: 1.42 * IBEX_SCALE,
} as const;

export const buildIbex: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(IBEX_BODY_COLOR, { flatShading: false });
  const leg = pool.lambert(IBEX_LEG_COLOR, { flatShading: false });
  const horn = pool.lambert(IBEX_HORN_COLOR, { flatShading: false });
  const eye = pool.lambert(IBEX_EYE_COLOR, { flatShading: false });

  // A barrel: fuller through the middle than the grazer, blunter at both ends.
  const width = profileFromPoints([
    [0.00, 0.62], [0.12, 0.92], [0.30, 1.00], [0.55, 0.98], [0.78, 0.92],
    [0.92, 0.78], [1.00, 0.55],
  ]);
  const heightRatio = profileFromPoints([
    [0.00, 1.05], [0.20, 1.22], [0.50, 1.15], [0.80, 1.08], [1.00, 0.92],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => halfWidth(t) * heightRatio(t);

  const hull = pool.keepGeometry(sweptHull({
    length: BODY_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.8,
    tailCapReach: 0.9,
  }));

  // A shorter, thicker neck carried lower than the grazer's.
  const NECK_TOP = new Vector3(0.58, 0.92, 0);
  const neck = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.22, 0.64, 0), new Vector3(0.44, 0.80, 0), NECK_TOP],
    rootRadius: 0.12,
    tipRadius: 0.075,
    tubularSegments: 8,
    radialSegments: 10,
  }));
  const head = pool.keepGeometry(smoothEllipsoid(0.30, 0.21, 0.17, 10, 8));
  const muzzle = pool.keepGeometry(smoothEllipsoid(0.18, 0.13, 0.12, 8, 6));
  const nose = pool.keepGeometry(smoothEllipsoid(0.05, 0.04, 0.05, 8, 6));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.04, 0.04, 0.04, 8, 6));
  // The beard: a short tuft hanging from the chin.
  const beard = pool.keepGeometry(taperedTube({
    path: [new Vector3(0, 0, 0), new Vector3(-0.02, -0.07, 0), new Vector3(-0.05, -0.14, 0)],
    rootRadius: 0.045,
    tipRadius: 0.012,
    tubularSegments: 5,
    radialSegments: 8,
  }));
  // Horns: up from the brow, then back over the neck in one scimitar sweep,
  // mirrored. Authored in HEAD-PIVOT space (relative to NECK_TOP).
  const horns = [1, -1].map((sign) => pool.keepGeometry(taperedTube({
    path: [
      new Vector3(0.06, 0.10, sign * 0.05),
      new Vector3(0.02, 0.26, sign * 0.08),
      new Vector3(-0.12, 0.40, sign * 0.12),
      new Vector3(-0.30, 0.44, sign * 0.16),
      new Vector3(-0.42, 0.40, sign * 0.19),
    ],
    rootRadius: HORN_ROOT_RADIUS,
    tipRadius: HORN_TIP_RADIUS,
    tubularSegments: HORN_SEGMENTS,
    radialSegments: 8,
  })));
  const ears = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(-0.05, s * 0.06, -0.04, s * 0.13);
    shape.quadraticCurveTo(0.02, s * 0.09, 0.03, 0);
    shape.lineTo(0, 0);
  }, sign, 0.012)));
  const tail = pool.keepGeometry(taperedTube({
    path: [new Vector3(-0.44, 0.76, 0), new Vector3(-0.52, 0.72, 0), new Vector3(-0.55, 0.64, 0)],
    rootRadius: 0.035,
    tipRadius: 0.015,
    tubularSegments: 5,
    radialSegments: 6,
  }));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.scale.setScalar(IBEX_SCALE);
  rig.add(pool.part(hull, body, 0, BODY_CENTRE_Y, 0));
  rig.add(pool.part(neck, body, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));

  const headPivot = new Group();
  headPivot.position.copy(NECK_TOP);
  headPivot.add(pool.part(head, body, 0.08, 0.02, 0));
  headPivot.add(pool.part(muzzle, body, 0.24, -0.03, 0));
  headPivot.add(pool.part(nose, horn, 0.33, -0.03, 0));
  headPivot.add(pool.part(beard, body, 0.20, -0.08, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, 0.14, 0.06, sign * 0.08));
    headPivot.add(pool.part(horns[sign === 1 ? 0 : 1]!, horn, 0, 0, 0));
    const ear = pool.part(ears[sign === 1 ? 0 : 1]!, body, -0.02, 0.08, sign * 0.07);
    // Laid back and out, beside the horns.
    ear.rotation.set(sign * 1.1, 0, -0.5);
    headPivot.add(ear);
  }
  rig.add(headPivot);

  const legs = addQuadrupedLegs(pool, rig, {
    hipY: HIP_Y,
    foreX: FORE_X,
    hindX: HIND_X,
    halfStance: HALF_STANCE,
    rootRadius: 0.065,
    tipRadius: 0.035,
    radialSegments: 6,
    heightSegments: 1,
    hoofHeight: 0.05,
    haunch: [0.22, 0.24, 0.12],
  }, leg, horn, body);

  return {
    root,
    joints: { rig, head: headPivot, ...legJoints(legs) },
    animate(joints, seconds, phase) {
      const beat = seconds * STRIDE_HZ * TWO_PI + phase;
      poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
      joints.head!.rotation.z = Math.sin(beat * 2) * HEAD_NOD_RADIANS;
    },
  };
};
