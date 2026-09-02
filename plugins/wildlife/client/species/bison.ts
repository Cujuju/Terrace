// The bison, as anatomy: the herd animal.
//
// Recognised by its silhouette before anything else: a massive shoulder hump
// falling away to narrow hindquarters, a huge low-slung head carried BELOW the
// shoulder line, short curved horns, a beard, and a shaggy cape over the
// forequarters. The hindquarters are almost bare by comparison — the front
// half is the animal.
//
// Twice the grazer's bulk at the same authoring scale, which is what a herd of
// six reads as from the camera: dark, heavy, and moving together.
//
// GAIT: a slow, heavy walk — a small leg swing at a low stride rate, the body
// barely rising, the head swinging a little from side to side with the stride.
import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { addQuadrupedLegs, legJoints, poseWalk } from './quadruped.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

export const BISON_SCALE = 0.4;

const BISON_BODY_COLOR = 0x4a3323; // dark brown
const BISON_CAPE_COLOR = 0x3a2718; // darker still: the shaggy forequarters and head
const BISON_HORN_COLOR = 0x2b2420;
const BISON_EYE_COLOR = 0x120f0d;

const BODY_LENGTH = 1.70;
const BODY_CENTRE_Y = 0.72;
const MAX_HALF_WIDTH = 0.30;
const HIP_Y = 0.55;
const FORE_X = 0.48;
const HIND_X = -0.55;
const HALF_STANCE = 0.17;
const HULL_RINGS = 36;
const HULL_SEGMENTS = 20;

/** The hump: where along the body it peaks (t from the nose), how high. */
const HUMP_CENTRE_T = 0.20;
const HUMP_WIDTH_T = 0.13;
const HUMP_HEIGHT = 0.13;
/** The cape's shag, as a fine relief over the front half of the body. */
const CAPE_END_T = 0.48;
const SHAG_DEPTH = 0.018;
const SHAG_AROUND = 9;
const SHAG_ALONG = 34;

const STRIDE_HZ = 1.3;
const LEG_SWING_RADIANS = 0.26;
/** WORLD units (root space). A ton of animal does not bounce. */
const WALK_BOB_WORLD_UNITS = 0.008;
const HEAD_SWAY_RADIANS = 0.07;

export const BISON_ENVELOPE = {
  /** Nose to tail tip. */
  length: 2.15 * BISON_SCALE,
  bodyHalfLength: (BODY_LENGTH / 2) * BISON_SCALE,
  /** To the top of the hump. */
  height: 1.32 * BISON_SCALE,
} as const;

export const buildBison: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(BISON_BODY_COLOR, { flatShading: false });
  const cape = pool.lambert(BISON_CAPE_COLOR, { flatShading: false });
  const horn = pool.lambert(BISON_HORN_COLOR, { flatShading: false });
  const eye = pool.lambert(BISON_EYE_COLOR, { flatShading: false });

  // Front-heavy: full through the shoulders, falling away to the hips.
  const width = profileFromPoints([
    [0.00, 0.72], [0.12, 0.96], [0.30, 1.00], [0.50, 0.90], [0.72, 0.78],
    [0.90, 0.66], [1.00, 0.48],
  ]);
  // Tall over the shoulders (the hump rides on top of this), lower behind.
  const heightRatio = profileFromPoints([
    [0.00, 1.30], [0.18, 1.50], [0.40, 1.28], [0.70, 1.10], [1.00, 0.95],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => halfWidth(t) * heightRatio(t);

  const hull = pool.keepGeometry(sweptHull({
    length: BODY_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.7,
    tailCapReach: 0.9,
    displace: (t, theta) => {
      const up = Math.cos(theta - Math.PI / 2); // +1 on the back, -1 on the belly
      let d = HUMP_HEIGHT * Math.exp(-Math.pow((t - HUMP_CENTRE_T) / HUMP_WIDTH_T, 2)) * Math.max(0, up);
      if (t < CAPE_END_T) {
        // Shag fades out toward the hindquarters rather than stopping dead.
        const fade = 1 - t / CAPE_END_T;
        d += SHAG_DEPTH * fade * Math.sin(theta * SHAG_AROUND) * Math.sin(t * SHAG_ALONG);
      }
      return d;
    },
  }));

  // The head is carried low: the neck drops from the shoulder to a skull whose
  // crown is below the hump. Authored in head-pivot space relative to NECK_TOP.
  const NECK_TOP = new Vector3(0.92, 0.70, 0);
  const neck = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.66, 0.84, 0), new Vector3(0.80, 0.78, 0), NECK_TOP],
    rootRadius: 0.24,
    tipRadius: 0.17,
    tubularSegments: 6,
    radialSegments: 12,
  }));
  const head = pool.keepGeometry(smoothEllipsoid(0.44, 0.36, 0.32, 16, 12));
  const muzzle = pool.keepGeometry(smoothEllipsoid(0.24, 0.20, 0.20, 12, 8));
  const nose = pool.keepGeometry(smoothEllipsoid(0.08, 0.06, 0.09, 8, 6));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.05, 0.05, 0.05, 8, 6));
  const beard = pool.keepGeometry(taperedTube({
    path: [new Vector3(0, 0, 0), new Vector3(-0.03, -0.10, 0), new Vector3(-0.08, -0.20, 0)],
    rootRadius: 0.08,
    tipRadius: 0.02,
    tubularSegments: 5,
    radialSegments: 8,
  }));
  // Short horns: out from the skull, then up and in.
  const horns = [1, -1].map((sign) => pool.keepGeometry(taperedTube({
    path: [
      new Vector3(0.06, 0.12, sign * 0.12),
      new Vector3(0.05, 0.18, sign * 0.22),
      new Vector3(0.07, 0.28, sign * 0.24),
      new Vector3(0.10, 0.36, sign * 0.20),
    ],
    rootRadius: 0.045,
    tipRadius: 0.012,
    tubularSegments: 10,
    radialSegments: 8,
  })));
  const tail = pool.keepGeometry(taperedTube({
    path: [new Vector3(-0.84, 0.78, 0), new Vector3(-0.92, 0.62, 0), new Vector3(-0.94, 0.44, 0)],
    rootRadius: 0.035,
    tipRadius: 0.02,
    tubularSegments: 6,
    radialSegments: 6,
  }));
  const tuft = pool.keepGeometry(smoothEllipsoid(0.08, 0.14, 0.08, 8, 6));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.scale.setScalar(BISON_SCALE);
  rig.add(pool.part(hull, body, 0, BODY_CENTRE_Y, 0));
  rig.add(pool.part(neck, cape, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));
  rig.add(pool.part(tuft, cape, -0.94, 0.40, 0));

  const headPivot = new Group();
  headPivot.position.copy(NECK_TOP);
  headPivot.add(pool.part(head, cape, 0.12, -0.06, 0));
  headPivot.add(pool.part(muzzle, cape, 0.36, -0.14, 0));
  headPivot.add(pool.part(nose, horn, 0.47, -0.15, 0));
  headPivot.add(pool.part(beard, cape, 0.28, -0.22, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, 0.24, 0.0, sign * 0.15));
    headPivot.add(pool.part(horns[sign === 1 ? 0 : 1]!, horn, 0, 0, 0));
  }
  rig.add(headPivot);

  const legs = addQuadrupedLegs(pool, rig, {
    hipY: HIP_Y,
    foreX: FORE_X,
    hindX: HIND_X,
    halfStance: HALF_STANCE,
    rootRadius: 0.085,
    tipRadius: 0.045,
    radialSegments: 8,
    heightSegments: 3,
    hoofHeight: 0.06,
    haunch: [0.32, 0.36, 0.18],
  }, body, horn, body);

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
