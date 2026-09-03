// The grazer, as anatomy: a slight, deer-like ungulate.
//
// WHAT IT REPLACES (owner, 2026-09-02: "substantially improve the model's
// fidelity — it is currently too blocky"). The shipped grazer was a box with a
// 6-segment ellipsoid for a head and four box legs, bobbing as one rigid lump.
// This one is a swept body with a proper chest-to-rump taper, a neck that
// rises to a head with a muzzle, ears and eyes, a tail, and four tapered legs
// that WALK — hinged at the hip and shoulder, diagonal pairs together — with
// the body bobbing at each footfall. Smooth-shaded throughout.
//
// SCALE. Everything is authored at a full figure and passed through
// GRAZER_SCALE, the owner's 2026-08-24 decision that grazers read oversized
// beside settlers (0.4 puts the shoulder at ~0.37 world units against
// PILGRIM_HEIGHT 0.62). The scale is applied to the RIG node, so the authored
// numbers below keep their proportions readable and the bake carries the
// scale in the rig bone's rest transform. The walk bob is the one number in
// world units (rig.position is in root space), and says so.
//
// FOOTPRINT. ../placement.ts's WALKER_FOOTPRINT_HALF_EXTENT was derived from
// the old body's 0.44 length; GRAZER_ENVELOPE below is what this body measures
// so placement can read it rather than restate it.
import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { addQuadrupedLegs, legJoints, poseWalk } from './quadruped.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

/** Owner, 2026-08-24 — see the header. */
export const GRAZER_SCALE = 0.4;

const GRAZER_BODY_COLOR = 0xa8814f; // tan, warmer than any terrain band (unchanged)
const GRAZER_LEG_COLOR = 0x6d5334;
const GRAZER_HOOF_COLOR = 0x2e2419;
const GRAZER_EYE_COLOR = 0x1c1a17;

// Authored dimensions, full figure.
const BODY_LENGTH = 0.95;
const BODY_CENTRE_Y = 0.66;
const MAX_HALF_WIDTH = 0.20;
const HIP_Y = 0.52;
const FORE_X = 0.32;
const HIND_X = -0.32;
const HALF_STANCE = 0.11;
const HULL_RINGS = 18;
const HULL_SEGMENTS = 12;

/**
 * Stride rate and swing. A grazer walks at 0.8 world units per second
 * (server/species.ts, halved 2026-09-02) on a body ~0.38 long; two strides a
 * second covers that at a stride of roughly a body length, which is a walk.
 * 0.32 rad (~18°) either side of vertical is a walking swing, not a trot.
 */
const STRIDE_HZ = 2.0;
const LEG_SWING_RADIANS = 0.32;
/** In WORLD units — rig.position is in root space, above the rig's scale. */
const WALK_BOB_WORLD_UNITS = 0.012;
/** The head dips a little at each footfall pair. */
const HEAD_NOD_RADIANS = 0.05;

/** What this body measures in WORLD units at model scale 1. */
export const GRAZER_ENVELOPE = {
  /** Nose to tail tip. */
  length: (0.95 + 0.6) * GRAZER_SCALE,
  /** Half the BODY's length, the footprint the feet stand within. */
  bodyHalfLength: (BODY_LENGTH / 2) * GRAZER_SCALE,
  height: 1.16 * GRAZER_SCALE,
} as const;

export const buildGrazer: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(GRAZER_BODY_COLOR, { flatShading: false });
  const leg = pool.lambert(GRAZER_LEG_COLOR, { flatShading: false });
  const hoof = pool.lambert(GRAZER_HOOF_COLOR, { flatShading: false });
  const eye = pool.lambert(GRAZER_EYE_COLOR, { flatShading: false });

  // Deep chest, narrow waist, rounded rump.
  const width = profileFromPoints([
    [0.00, 0.55], [0.12, 0.90], [0.28, 1.00], [0.50, 0.92], [0.72, 0.90],
    [0.88, 0.78], [1.00, 0.50],
  ]);
  const heightRatio = profileFromPoints([
    [0.00, 1.05], [0.20, 1.28], [0.45, 1.15], [0.75, 1.10], [1.00, 0.90],
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

  // Neck: a tapered tube rising from the chest to the poll.
  const neck = pool.keepGeometry(taperedTube({
    path: [new Vector3(0.26, 0.68, 0), new Vector3(0.48, 0.88, 0), new Vector3(0.62, 1.02, 0)],
    rootRadius: 0.10,
    tipRadius: 0.065,
    tubularSegments: 8,
    radialSegments: 10,
  }));
  const HEAD_X = 0.70;
  const HEAD_Y = 1.04;
  const head = pool.keepGeometry(smoothEllipsoid(0.30, 0.20, 0.16, 10, 8));
  const muzzle = pool.keepGeometry(smoothEllipsoid(0.20, 0.13, 0.11, 8, 6));
  const nose = pool.keepGeometry(smoothEllipsoid(0.05, 0.04, 0.05, 8, 6));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.04, 0.04, 0.04, 8, 6));
  const ears = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(-0.05, s * 0.08, -0.03, s * 0.15);
    shape.quadraticCurveTo(0.03, s * 0.10, 0.03, 0);
    shape.lineTo(0, 0);
  }, sign, 0.012)));
  const tail = pool.keepGeometry(taperedTube({
    path: [new Vector3(-0.46, 0.80, 0), new Vector3(-0.54, 0.74, 0), new Vector3(-0.58, 0.64, 0)],
    rootRadius: 0.03,
    tipRadius: 0.012,
    tubularSegments: 5,
    radialSegments: 6,
  }));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.scale.setScalar(GRAZER_SCALE);
  rig.add(pool.part(hull, body, 0, BODY_CENTRE_Y, 0));
  rig.add(pool.part(neck, body, 0, 0, 0));
  rig.add(pool.part(tail, body, 0, 0, 0));

  // The head hangs under its own hinge at the top of the neck so it can nod.
  const headPivot = new Group();
  headPivot.position.set(0.62, 1.02, 0);
  headPivot.add(pool.part(head, body, HEAD_X - 0.62, HEAD_Y - 1.02, 0));
  headPivot.add(pool.part(muzzle, body, 0.84 - 0.62, 0.99 - 1.02, 0));
  headPivot.add(pool.part(nose, hoof, 0.94 - 0.62, 0.99 - 1.02, 0));
  for (const sign of [1, -1]) {
    headPivot.add(pool.part(eyeGeometry, eye, 0.75 - 0.62, 1.08 - 1.02, sign * 0.075));
    const ear = pool.part(ears[sign === 1 ? 0 : 1]!, body, 0.62 - 0.62, 1.12 - 1.02, sign * 0.06);
    ear.rotation.set(sign * 1.0, 0, 0.3);
    headPivot.add(ear);
  }
  rig.add(headPivot);

  const legs = addQuadrupedLegs(pool, rig, {
    hipY: HIP_Y,
    foreX: FORE_X,
    hindX: HIND_X,
    halfStance: HALF_STANCE,
    rootRadius: 0.055,
    tipRadius: 0.03,
    radialSegments: 6,
    heightSegments: 1,
    hoofHeight: 0.05,
    haunch: [0.20, 0.24, 0.10],
  }, leg, hoof, body);

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
