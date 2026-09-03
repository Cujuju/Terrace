// The eel, as anatomy: the bottom ribbon.
//
// A long near-cylindrical hull — blunt snout, widest just behind the head,
// tapering to a thin tail stem — with a low dorsal ridge along its rear half,
// a small rounded tail paddle, tiny paired pectorals, and two eyes flush on
// the snout. Olive above, pale beneath. Smooth-shaded like the fish: on a
// swept surface faceting is banding, not style.
//
// MOTION: nothing here beats. An eel swims as a wave through its whole length,
// so the tail hinge swings wide and slow (1.6 Hz / 0.5 rad against the fish's
// 3.2 / 0.45) and the body's counter-yaw is twice the fish's fraction — most
// of the animal is the wave. The pectorals barely stir.
//
// ENVELOPE. EEL_ENVELOPE is what placement.ts reads. The ridge crown is the
// binding dimension above; the length is nose to paddle tip.
import { Group } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, uprightFin } from './bodyKit.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

const EEL_BODY_COLOR = 0x3d4220; // dark olive against pale sand
const EEL_BELLY_COLOR = 0x8c8a66; // pale underside
const EEL_FIN_COLOR = 0x333a1c; // ridge and paddle a shade darker
const EEL_EYE_COLOR = 0x0f0f0c;

/** Nose-to-stem length of the hull. The paddle adds to it behind. */
const HULL_LENGTH = 1.15;
/** Where the hull is centred so the nose lands at +0.595 and the stem at -0.555. */
const HULL_CENTRE_X = 0.02;
const MAX_HALF_WIDTH = 0.075;
/** Stem: the hinge the paddle waves from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Behind the stem the paddle reaches this far back. */
const PADDLE_REACH = 0.14;
const PADDLE_HALF_SPAN = 0.075;

const HULL_RINGS = 28;
const HULL_SEGMENTS = 12;
/** See fish.ts FIN_SEAT_BITE; a thin hull needs a shallow bite. */
const FIN_SEAT_BITE = 0.025;
const FIN_THICKNESS = 0.012;
const EYE_RADIUS = 0.02;
const EYE_SEGMENTS = 6;

/**
 * The travelling wave: 1.6 Hz, half the fish's rate, and a wider swing —
 * 0.5 rad (~29°) puts the paddle tip ~0.07 either way, about a body width,
 * the same proportion as the fish's cruise but at a ribbon's tempo.
 */
export const EEL_TAIL_HZ = 1.6;
export const EEL_TAIL_SWING_RADIANS = 0.5;
/**
 * The body's share of the wave, OPPOSITE in sign to the tail. Twice the
 * fish's fraction: a fish is a stiff front half with a tail on it, an eel is
 * the wave all the way up.
 */
const BODY_WAVE_FRACTION = 0.35;
/** The pectorals barely stir — a slow small beat that lags the wave. */
const PECTORAL_FLUTTER_RADIANS = 0.10;
const PECTORAL_LAG_RADIANS = 1.1;

/**
 * The hull's lines, module-level so the envelope below is derived from the
 * same numbers the builder assembles rather than restated beside them.
 * Near-cylindrical: a blunt snout, widest just behind the head, a long taper
 * to a thin stem. Barely taller than wide — an eel is a tube.
 */
const eelWidth = profileFromPoints([
  [0.00, 0.55], [0.08, 0.85], [0.20, 1.00], [0.45, 0.95], [0.65, 0.75],
  [0.85, 0.45], [1.00, 0.30],
]);
const eelHeightRatio = profileFromPoints([
  [0.00, 1.00], [0.20, 1.15], [0.50, 1.15], [0.80, 1.10], [1.00, 1.00],
]);
const eelHalfWidth: BodyProfile = (t) => eelWidth(t) * MAX_HALF_WIDTH;
const eelHalfHeight: BodyProfile = (t) => eelHalfWidth(t) * eelHeightRatio(t);
/** Body t for a station x, on the authored hull. */
const eelBodyT = (x: number): number => (HULL_CENTRE_X + HULL_LENGTH / 2 - x) / HULL_LENGTH;

/** Where the dorsal ridge sits, and the water it stands in. */
const RIDGE_X = -0.30;
const ridgeSeatY = eelHalfHeight(eelBodyT(RIDGE_X)) - FIN_SEAT_BITE;
/** Peak of the ridge outline above its seat (the outline's own high point). */
const RIDGE_PEAK = 0.05;
/** Deepest the hull runs: width and ratio peaks coincide just behind the head. */
const HULL_BELLY = MAX_HALF_WIDTH * 1.15;

/**
 * What this body measures, in world units at model scale 1 — the numbers
 * placement.ts fits the eel into its water column with. Read them; do not
 * restate them there.
 */
export const EEL_ENVELOPE = {
  /** Nose tip to paddle tip. */
  length: 0.595 + -PEDUNCLE_X + PADDLE_REACH,
  halfLength: (0.595 + -PEDUNCLE_X + PADDLE_REACH) / 2,
  halfWidth: MAX_HALF_WIDTH,
  /** Top of the dorsal ridge above the origin. */
  crownY: ridgeSeatY + RIDGE_PEAK,
  /** Belly line below the origin. */
  bellyY: -HULL_BELLY,
} as const;

export const buildEel: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(EEL_BODY_COLOR, { flatShading: false });
  const belly = pool.lambert(EEL_BELLY_COLOR, { flatShading: false });
  const fin = pool.lambert(EEL_FIN_COLOR, { flatShading: false });
  const eye = pool.lambert(EEL_EYE_COLOR, { flatShading: false });

  // The hull's lines live at module level (eelHalfWidth/eelHalfHeight/eelBodyT)
  // so the envelope derives from them; the builder just sweeps them.
  const hull = sweptHull({
    length: HULL_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth: eelHalfWidth,
    halfHeight: eelHalfHeight,
    noseCapReach: 0.6,
    tailCapReach: 0.5,
  });
  hull.translate(HULL_CENTRE_X, 0, 0);
  pool.keepGeometry(hull);

  // A pale underside: the hull's own lower half, hung a hair low so a thin
  // crescent of it stands proud of the skin below (0.008 clears the 0.04h
  // skin gap everywhere on this hull) while its crown and flanks stay buried.
  // Same sweep, same signature — still one surface after the bake.
  const underside = sweptHull({
    length: HULL_LENGTH * 0.98,
    rings: HULL_RINGS,
    segments: 6,
    halfWidth: (t) => eelHalfWidth(t) * 0.96,
    halfHeight: (t) => eelHalfHeight(t) * 0.96,
    noseCapReach: 0.6,
    tailCapReach: 0.5,
  });
  underside.translate(HULL_CENTRE_X, -0.008, 0);
  pool.keepGeometry(underside);

  // Low dorsal ridge along the rear half, seated a bite into the body.
  const ridge = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.30, 0);
    shape.quadraticCurveTo(0.0, 0.055, -0.28, 0.05);
    shape.lineTo(-0.30, 0);
    shape.lineTo(0.30, 0);
  }, FIN_THICKNESS));

  // Rounded paddle — an eel's tail is a fan, not a fork — authored with
  // x = 0 AT THE HINGE like the fish's caudal.
  const paddle = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.02, 0);
    shape.quadraticCurveTo(-0.06, 0.06, -PADDLE_REACH, PADDLE_HALF_SPAN);
    shape.quadraticCurveTo(-PADDLE_REACH - 0.02, 0, -PADDLE_REACH, -PADDLE_HALF_SPAN);
    shape.quadraticCurveTo(-0.06, -0.06, 0.02, 0);
  }, FIN_THICKNESS));

  const PECTORAL_X = 0.40;
  const pectoralGeometries = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    shape.moveTo(0.02, 0);
    shape.quadraticCurveTo(-0.01, s * 0.03, -0.06, s * 0.055);
    shape.quadraticCurveTo(-0.055, s * 0.02, -0.03, 0);
    shape.lineTo(0.02, 0);
  }, sign, FIN_THICKNESS * 0.8)));

  const eyeGeometry = pool.keepGeometry(
    smoothEllipsoid(EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_SEGMENTS, EYE_SEGMENTS),
  );
  const EYE_X = 0.50;
  const eyeZ = eelHalfWidth(eelBodyT(EYE_X)) * 0.85;

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(underside, belly, 0, 0, 0));
  rig.add(pool.part(ridge, fin, RIDGE_X, ridgeSeatY, 0));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.02, eyeZ));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.02, -eyeZ));

  // THE HINGE at the stem, as in fish.ts: rotation about Y sweeps the paddle
  // side to side.
  const tailHinge = new Group();
  tailHinge.position.set(PEDUNCLE_X, 0, 0);
  tailHinge.add(pool.part(paddle, fin, 0, 0, 0));
  rig.add(tailHinge);

  const pectoralSeatZ = eelHalfWidth(eelBodyT(PECTORAL_X)) * 0.8;
  const pectorals = pectoralGeometries.map((geometry, i) => {
    const sign = i === 0 ? 1 : -1;
    const hinge = new Group();
    hinge.position.set(PECTORAL_X, -0.03, sign * pectoralSeatZ);
    hinge.rotation.set(sign * 0.5, 0, 0);
    hinge.add(pool.part(geometry, fin, 0, 0, 0));
    rig.add(hinge);
    return hinge;
  });

  return {
    root,
    joints: { rig, tail: tailHinge, leftPectoral: pectorals[0]!, rightPectoral: pectorals[1]! },
    animate(joints, seconds, phase) {
      const beat = seconds * EEL_TAIL_HZ * TWO_PI + phase;
      const swing = Math.sin(beat);
      // The wave: tail one way, body a good share the other. Nothing touches
      // pitch (Z) — same discipline as the fish.
      joints.tail!.rotation.y = swing * EEL_TAIL_SWING_RADIANS;
      joints.rig!.rotation.y = -swing * EEL_TAIL_SWING_RADIANS * BODY_WAVE_FRACTION;
      const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
      joints.leftPectoral!.rotation.x = 0.5 + flutter;
      joints.rightPectoral!.rotation.x = -0.5 - flutter;
    },
  };
};
