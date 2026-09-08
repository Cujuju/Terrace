import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { deform, smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { addQuadrupedLegs, legJoints, poseSit, poseStand, poseWalk } from './quadruped.ts';
import type { SpeciesModelBuilder } from './speciesModel.ts';

export const BISON_SCALE = 0.4;

const BISON_BODY_COLOR = 0x4a3323;
const BISON_CAPE_COLOR = 0x3a2718;
const BISON_HORN_COLOR = 0x2b2420;
const BISON_EYE_COLOR = 0x120f0d;

const HUMP_TOP_Y = 1.32;
const H = HUMP_TOP_Y;

const BODY_LENGTH = 0.70 * 1.42 * H;
const MAX_HALF_WIDTH = 0.30;
const HULL_RINGS = 26;
const HULL_SEGMENTS = 14;

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

const CAPE_END_T = 0.45;
const CAPE_STEP_WIDTH_T = 0.08;
const CAPE_LOFT = 0.03;
const BARREL_BOXINESS = 0.35;

const HEAD_DROOP_RADIANS = 0.35;
const HEAD_LENGTH = 0.31 * H;

const HIP_Y = 0.53 * H;
const FORE_T = 0.30;
const HIND_T = 0.87;
const HALF_STANCE = 0.16;

export const BISON_STRIDE_WORLD_UNITS = 0.46;
const LEG_SWING_RADIANS = 0.26;
const WALK_BOB_WORLD_UNITS = 0.008;
const HEAD_SWAY_RADIANS = 0.07;

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

const NECK_TOP = new Vector3(hullX(0) + 0.20, 0.72 * H, 0);

export const BISON_ENVELOPE = {
  length: (BODY_LENGTH + 0.60 * H) * BISON_SCALE,
  bodyHalfLength: (BODY_LENGTH / 2) * BISON_SCALE,
  height: (HUMP_TOP_Y + CAPE_LOFT) * BISON_SCALE,
} as const;

export const buildBison: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(BISON_BODY_COLOR, { flatShading: false });
  const cape = pool.lambert(BISON_CAPE_COLOR, { flatShading: false });
  const horn = pool.lambert(BISON_HORN_COLOR, { flatShading: false });
  const eye = pool.lambert(BISON_EYE_COLOR, { flatShading: false });

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
    v.y += midline(hullT(v.x));
  }));

  const neck = pool.keepGeometry(taperedTube({
    path: [new Vector3(hullX(0) - 0.10, 0.66 * H, 0), new Vector3(hullX(0) + 0.06, 0.70 * H, 0), NECK_TOP],
    rootRadius: 0.26,
    tipRadius: 0.21,
    tubularSegments: 5,
    radialSegments: 12,
  }));

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
  const beard = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.40, -0.04, 0), new Vector3(0.44, -0.09, 0), new Vector3(0.47, -0.13, 0)],
    rootRadius: 0.06,
    tipRadius: 0.022,
    tubularSegments: 5,
    radialSegments: 8,
  }));
  const horns = [1, -1].map((sign) => pool.keepGeometry(taperedTube({
    path: [
      new Vector3(0.06, 0.12, sign * 0.12),
      new Vector3(0.02, 0.22, sign * 0.24),
      new Vector3(0.02, 0.30, sign * 0.24),
      new Vector3(0.05, 0.36, sign * 0.18),
    ],
    rootRadius: 0.05,
    tipRadius: 0.014,
    tubularSegments: 10,
    radialSegments: 8,
  })));

  const rumpX = hullX(1);
  const tail = pool.keepGeometry(taperedTube({
    path: [
      new Vector3(rumpX + 0.08, 0.72 * H, 0),
      new Vector3(rumpX - 0.04, 0.68 * H, 0),
      new Vector3(rumpX - 0.07, 0.59 * H, 0),
      new Vector3(rumpX - 0.04, 0.50 * H, 0),
    ],
    rootRadius: 0.045,
    tipRadius: 0.018,
    tubularSegments: 8,
    radialSegments: 6,
  }));

  const shoulder = pool.keepGeometry(smoothEllipsoid(0.38, 0.60, 0.28, 12, 8));
  const SHOULDER_SEAT_Y = -0.10;

  const { root, rig } = pool.rigged();
  rig.scale.setScalar(BISON_SCALE);
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(neck, cape, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));

  const headPivot = new Group();
  headPivot.position.copy(NECK_TOP);
  headPivot.rotation.z = -HEAD_DROOP_RADIANS;
  const HEAD_CENTRE_X = HEAD_LENGTH * 0.45;
  headPivot.add(pool.part(head, cape, HEAD_CENTRE_X, 0, 0));
  headPivot.add(pool.part(nose, horn, HEAD_CENTRE_X + HEAD_LENGTH * 0.5 + 0.04, -0.02, 0));
  headPivot.add(pool.part(beard, cape, 0, 0, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, HEAD_CENTRE_X + 0.08, 0.05, sign * 0.12));
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
    haunch: [0.36, 0.50, 0.22],
  }, body, horn, body);
  for (const fore of [legs.foreLeft, legs.foreRight]) {
    fore.add(pool.part(shoulder, cape, 0, SHOULDER_SEAT_Y, 0));
  }

  return {
    root,
    joints: { rig, head: headPivot, ...legJoints(legs) },
    posesByGait: true,
    animate(joints, seconds, phase, gait) {
      if (gait === 'stand' || gait === 'sit') {
        if (gait === 'stand') poseStand(joints, seconds, phase, WALK_BOB_WORLD_UNITS);
        else poseSit(joints, seconds, phase, WALK_BOB_WORLD_UNITS);
        joints.head!.rotation.y = 0;
        return;
      }
      const beat = phase;
      poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
      joints.head!.rotation.y = Math.sin(beat) * HEAD_SWAY_RADIANS;
    },
  };
};
