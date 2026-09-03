// The shark, as anatomy: the hunter.
//
// A long fusiform body, round in section and flattened a little along the
// belly; a tall triangular first dorsal amidships (the fin everyone knows), a
// small second dorsal and an anal fin aft; broad swept pectorals; five gill
// slits behind the head; and the tell that no other fish here has — a
// HETEROCERCAL tail, the upper lobe far longer than the lower. Twice the
// fish's length and grey against its orange.
//
// MOTION: the tail sweeps side to side about the peduncle, exactly as the
// fish's does (see fish.ts for why that is a yaw about a hinge and nothing
// else), but slower and wider — a big animal's cruise — and the body
// counter-yaws more than the fish's, because a shark swims with more of its
// length than a small fish does.
//
// ENVELOPE. SHARK_ENVELOPE is what placement.ts reads. The first dorsal is the
// binding dimension above, the pectorals across.
import { Group } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { deform, flatFin, smoothEllipsoid, uprightFin } from './bodyKit.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

const SHARK_BODY_COLOR = 0x6b7886; // grey
const SHARK_FIN_COLOR = 0x5a6674; // fins a shade darker
const SHARK_EYE_COLOR = 0x0f1114;

const HULL_LENGTH = 1.40;
const MAX_HALF_WIDTH = 0.13;
const PEDUNCLE_X = -HULL_LENGTH / 2 + 0.02;
const HULL_RINGS = 32;
const HULL_SEGMENTS = 16;
/** See fish.ts FIN_SEAT_BITE; a bigger hull needs a deeper bite. */
const FIN_SEAT_BITE = 0.05;
const FIN_THICKNESS = 0.02;
/** How much the belly is flattened relative to the back (1 = round). */
const BELLY_FLATTEN = 0.82;
/** Gill slits: five grooves on the flanks just behind the head. */
const GILL_START_T = 0.20;
const GILL_END_T = 0.30;
const GILL_COUNT = 5;
const GILL_DEPTH = 0.006;
/** The caudal's upper lobe reaches this far back and up from the peduncle. */
const CAUDAL_UPPER_REACH = 0.34;
const CAUDAL_UPPER_RISE = 0.36;
const CAUDAL_LOWER_REACH = 0.22;
const CAUDAL_LOWER_DROP = 0.16;
/** How far the paired fins angle down from the flank. */
const PECTORAL_DIHEDRAL_RADIANS = 0.35;
const PELVIC_DIHEDRAL_RADIANS = 0.5;
/** First dorsal: height above its seat. */
const DORSAL_HEIGHT = 0.27;

/**
 * Tail beat: slower and wider than the fish's 3.2 Hz / 0.45 rad — a cruise,
 * not a dart. 1.1 Hz on a 1.7-unit animal; 0.30 rad puts the upper lobe's tip
 * ~0.1 either side of the body line.
 */
const TAIL_HZ = 1.1;
const TAIL_SWING_RADIANS = 0.30;
/** Counter-yaw of the head, as a fraction of the tail's swing (opposite sign). */
const BODY_COUNTER_YAW_FRACTION = 0.28;

export const SHARK_ENVELOPE = {
  /** Snout to caudal tip. */
  length: HULL_LENGTH / 2 + -PEDUNCLE_X + CAUDAL_UPPER_REACH,
  halfLength: (HULL_LENGTH / 2 + -PEDUNCLE_X + CAUDAL_UPPER_REACH) / 2,
  /** To a pectoral tip, swept and angled as assembled. */
  halfWidth: 0.42,
  /** Top of the first dorsal above the origin. */
  crownY: 0.16 + DORSAL_HEIGHT - 0.03,
  /** Bottom of a pectoral tip below the origin. */
  bellyY: -0.26,
} as const;

export const buildShark: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(SHARK_BODY_COLOR, { flatShading: false });
  const fin = pool.lambert(SHARK_FIN_COLOR, { flatShading: false });
  const eye = pool.lambert(SHARK_EYE_COLOR, { flatShading: false });

  // A pointed snout, widest just behind the pectorals, a long taper to a
  // narrow peduncle.
  const width = profileFromPoints([
    [0.00, 0.10], [0.08, 0.50], [0.20, 0.85], [0.35, 1.00], [0.55, 0.88],
    [0.75, 0.60], [0.90, 0.34], [1.00, 0.20],
  ]);
  // Rounder than the fish; the peduncle keel makes the last station taller.
  const heightRatio = profileFromPoints([
    [0.00, 0.85], [0.20, 1.10], [0.40, 1.22], [0.70, 1.12], [0.92, 0.95], [1.00, 1.30],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => halfWidth(t) * heightRatio(t);
  const bodyT = (x: number): number => (HULL_LENGTH / 2 - x) / HULL_LENGTH;

  const hull = pool.keepGeometry(deform(sweptHull({
    length: HULL_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.9,
    tailCapReach: 0.4,
    displace: (t, theta) => {
      if (t < GILL_START_T || t > GILL_END_T) return 0;
      // Grooves on the flanks only: |cos θ| is 1 at the sides, 0 top and bottom.
      const flank = Math.pow(Math.abs(Math.cos(theta)), 3);
      const along = (t - GILL_START_T) / (GILL_END_T - GILL_START_T);
      const groove = 0.5 - 0.5 * Math.cos(along * TWO_PI * GILL_COUNT);
      return -GILL_DEPTH * groove * flank;
    },
  }), (v) => {
    if (v.y < 0) v.y *= BELLY_FLATTEN;
  }));

  const DORSAL_X = 0.05;
  const dorsal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.22, 0);
    shape.quadraticCurveTo(0.08, DORSAL_HEIGHT * 0.7, -0.06, DORSAL_HEIGHT);
    shape.quadraticCurveTo(-0.10, DORSAL_HEIGHT * 0.5, -0.20, 0);
    shape.lineTo(0.22, 0);
  }, FIN_THICKNESS));
  const dorsalSeatY = halfHeight(bodyT(DORSAL_X)) - FIN_SEAT_BITE;

  const SECOND_DORSAL_X = -0.46;
  const secondDorsal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.08, 0);
    shape.quadraticCurveTo(0.02, 0.07, -0.04, 0.08);
    shape.quadraticCurveTo(-0.05, 0.04, -0.08, 0);
    shape.lineTo(0.08, 0);
  }, FIN_THICKNESS));
  const secondDorsalSeatY = halfHeight(bodyT(SECOND_DORSAL_X)) - FIN_SEAT_BITE;

  const ANAL_X = -0.50;
  const anal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.07, 0);
    shape.quadraticCurveTo(0.01, -0.06, -0.05, -0.07);
    shape.quadraticCurveTo(-0.05, -0.03, -0.07, 0);
    shape.lineTo(0.07, 0);
  }, FIN_THICKNESS));
  const analSeatY = -halfHeight(bodyT(ANAL_X)) * BELLY_FLATTEN + FIN_SEAT_BITE;

  // Heterocercal caudal, authored with x = 0 at the hinge: a long upper lobe
  // sweeping up and back, a short lower lobe, a notch between.
  const caudal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.03, 0.02);
    shape.quadraticCurveTo(-0.10, 0.12, -CAUDAL_UPPER_REACH, CAUDAL_UPPER_RISE);
    shape.quadraticCurveTo(-0.24, 0.16, -0.16, 0.03);
    shape.lineTo(-0.14, 0);
    shape.quadraticCurveTo(-0.16, -0.08, -CAUDAL_LOWER_REACH, -CAUDAL_LOWER_DROP);
    shape.quadraticCurveTo(-0.10, -0.08, 0.03, -0.02);
    shape.lineTo(0.03, 0.02);
  }, FIN_THICKNESS));

  const PECTORAL_X = 0.15;
  const pectorals = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    // Swept back in the outline (see fish.ts): only a dihedral on the mesh.
    shape.moveTo(0.08, 0);
    shape.quadraticCurveTo(-0.02, s * 0.18, -0.30, s * 0.32);
    shape.quadraticCurveTo(-0.26, s * 0.14, -0.16, 0);
    shape.lineTo(0.08, 0);
  }, sign, FIN_THICKNESS)));
  const PELVIC_X = -0.30;
  const pelvics = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0.04, 0);
    shape.quadraticCurveTo(-0.01, s * 0.06, -0.10, s * 0.10);
    shape.quadraticCurveTo(-0.09, s * 0.04, -0.06, 0);
    shape.lineTo(0.04, 0);
  }, sign, FIN_THICKNESS * 0.8)));

  const eyeGeometry = pool.keepGeometry(smoothEllipsoid(0.035, 0.035, 0.035, 8, 6));
  const EYE_X = 0.52;
  const eyeZ = halfWidth(bodyT(EYE_X)) * 0.95;

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(dorsal, fin, DORSAL_X, dorsalSeatY, 0));
  rig.add(pool.part(secondDorsal, fin, SECOND_DORSAL_X, secondDorsalSeatY, 0));
  rig.add(pool.part(anal, fin, ANAL_X, analSeatY, 0));
  for (const sign of [1, -1]) {
    rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.02, sign * eyeZ));
    const pectoral = pool.part(
      pectorals[sign === 1 ? 0 : 1]!,
      fin,
      PECTORAL_X,
      -0.06,
      sign * halfWidth(bodyT(PECTORAL_X)) * 0.8,
    );
    // Swept back and angled down, like a wing with anhedral.
    pectoral.rotation.set(sign * PECTORAL_DIHEDRAL_RADIANS, 0, 0);
    rig.add(pectoral);
    const pelvic = pool.part(
      pelvics[sign === 1 ? 0 : 1]!,
      fin,
      PELVIC_X,
      -halfHeight(bodyT(PELVIC_X)) * BELLY_FLATTEN + 0.02,
      sign * halfWidth(bodyT(PELVIC_X)) * 0.6,
    );
    pelvic.rotation.set(sign * PELVIC_DIHEDRAL_RADIANS, 0, 0);
    rig.add(pelvic);
  }

  // The hinge at the peduncle, as in fish.ts.
  const tailHinge = new Group();
  tailHinge.position.set(PEDUNCLE_X, 0, 0);
  tailHinge.add(pool.part(caudal, fin, 0, 0, 0));
  rig.add(tailHinge);

  return {
    root,
    joints: { rig, tail: tailHinge },
    animate(joints, seconds, phase) {
      const swing = Math.sin(seconds * TAIL_HZ * TWO_PI + phase);
      joints.tail!.rotation.y = swing * TAIL_SWING_RADIANS;
      joints.rig!.rotation.y = -swing * TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
    },
  };
};
