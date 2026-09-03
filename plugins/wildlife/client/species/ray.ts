// The ray, as anatomy: the bottom glider.
//
// A flattened disc of a body with two great triangular wings, a pair of
// cephalic lobes curling forward at the mouth, eyes on top, and a whip of a
// tail longer than the body. Seen from above — this game's camera — a ray is
// nearly all wing, which is what separates it from every other swimmer here
// at any distance.
//
// MOTION: the wings FLAP, slowly, each hinged at the body's flank and beating
// in opposite senses so both tips rise together (the same sign discipline as
// the bird's wings: rotation about X sends +Z and -Z the opposite way). The
// tail trails. There is no tail-beat at all: a ray is propelled by its wings.
//
// ENVELOPE. RAY_ENVELOPE is what placement.ts reads. The wings are the
// binding dimension both across (half the span) and vertically (a tip at the
// top of its beat).
import { Group, Vector3 } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, taperedTube } from './bodyKit.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

const RAY_BODY_COLOR = 0x3f4b5a; // slate blue-grey: seabed-coloured from above
const RAY_EYE_COLOR = 0x0f1114;

const BODY_LENGTH = 0.55;
const MAX_HALF_WIDTH = 0.14;
const MAX_HALF_HEIGHT = 0.05;
const HULL_RINGS = 16;
const HULL_SEGMENTS = 12;
/** Where each wing hinges on the flank, and how far its tip reaches out. */
const WING_ROOT_X = 0.04;
const WING_ROOT_Z = 0.09;
const WING_SPAN = 0.50;
const WING_THICKNESS = 0.02;
/** The whip tail, from the disc's rear to the tip. */
const TAIL_ROOT_X = -0.26;
const TAIL_TIP_X = -0.76;

/**
 * Wing beat: slow and wide. 0.6 Hz is a glide with an occasional stroke;
 * 0.30 rad (~17°) lifts a 0.5 wing tip ~0.15 either side of level.
 */
const WING_FLAP_HZ = 0.6;
const WING_FLAP_RADIANS = 0.30;
/** The tail lags the wing beat and waves a little in the wake. */
const TAIL_WAVE_RADIANS = 0.12;
const TAIL_LAG_RADIANS = 1.2;

export const RAY_ENVELOPE = {
  /** Cephalic lobes to tail tip. */
  length: 0.33 + -TAIL_TIP_X,
  halfLength: (0.33 + -TAIL_TIP_X) / 2,
  /** Half the wingspan, the disc's own width being inside it. */
  halfWidth: WING_ROOT_Z + WING_SPAN,
  /** A wing tip at the top of its beat, plus the eyes on the crown. */
  crownY: (WING_ROOT_Z + WING_SPAN) * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT,
  /** A wing tip at the bottom of its beat. */
  bellyY: -((WING_ROOT_Z + WING_SPAN) * Math.sin(WING_FLAP_RADIANS) + MAX_HALF_HEIGHT),
} as const;

export const buildRay: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(RAY_BODY_COLOR, { flatShading: false });
  const eye = pool.lambert(RAY_EYE_COLOR, { flatShading: false });

  // The disc: broad and flat, widest a third of the way back.
  const width = profileFromPoints([
    [0.00, 0.50], [0.15, 0.90], [0.35, 1.00], [0.60, 0.88], [0.85, 0.55], [1.00, 0.30],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => (halfWidth(t) / MAX_HALF_WIDTH) * MAX_HALF_HEIGHT;
  const hull = pool.keepGeometry(sweptHull({
    length: BODY_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.6,
    tailCapReach: 0.5,
  }));

  // Wings: a swept triangle from the root, tip well aft of the leading edge's
  // start, trailing edge curving back in to the body.
  const wings = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0.20, 0);
    shape.quadraticCurveTo(0.14, s * 0.22, -0.04, s * WING_SPAN);
    shape.quadraticCurveTo(-0.20, s * 0.30, -0.28, s * 0.10);
    shape.lineTo(-0.28, 0);
    shape.lineTo(0.20, 0);
  }, sign, WING_THICKNESS)));

  // Cephalic lobes: two small paddles curling forward at the mouth.
  const lobes = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0, 0);
    shape.quadraticCurveTo(0.09, s * 0.02, 0.11, s * 0.05);
    shape.quadraticCurveTo(0.08, s * 0.07, 0.0, s * 0.05);
    shape.lineTo(0, 0);
  }, sign, WING_THICKNESS * 0.7)));

  const tail = pool.keepGeometry(taperedTube({
    path: [
      new Vector3(0, 0, 0),
      new Vector3((TAIL_TIP_X - TAIL_ROOT_X) * 0.5, 0.01, 0),
      new Vector3(TAIL_TIP_X - TAIL_ROOT_X, 0.03, 0),
    ],
    rootRadius: 0.025,
    tipRadius: 0.004,
    tubularSegments: 10,
    radialSegments: 6,
  }));
  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.035, 0.03, 0.035, 8, 6));

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.add(pool.part(hull, body, 0, 0, 0));
  for (const sign of [1, -1]) {
    rig.add(pool.part(eyeGeometry, eye, 0.14, MAX_HALF_HEIGHT * 0.9, sign * 0.075));
    rig.add(pool.part(lobes[sign === 1 ? 0 : 1]!, body, 0.24, -0.01, sign * 0.04));
  }

  const wingHinges = [1, -1].map((sign) => {
    const hinge = new Group();
    hinge.position.set(WING_ROOT_X, 0, sign * WING_ROOT_Z);
    hinge.add(pool.part(wings[sign === 1 ? 0 : 1]!, body, 0, 0, 0));
    rig.add(hinge);
    return hinge;
  });

  const tailHinge = new Group();
  tailHinge.position.set(TAIL_ROOT_X, 0, 0);
  tailHinge.add(pool.part(tail, body, 0, 0, 0));
  rig.add(tailHinge);

  return {
    root,
    joints: { rig, leftWing: wingHinges[0]!, rightWing: wingHinges[1]!, tail: tailHinge },
    animate(joints, seconds, phase) {
      const beat = seconds * WING_FLAP_HZ * TWO_PI + phase;
      const flap = Math.sin(beat) * WING_FLAP_RADIANS;
      // Opposite signs send both tips the same way (see the header).
      joints.leftWing!.rotation.x = -flap;
      joints.rightWing!.rotation.x = flap;
      joints.tail!.rotation.y = Math.sin(beat - TAIL_LAG_RADIANS) * TAIL_WAVE_RADIANS;
    },
  };
};
