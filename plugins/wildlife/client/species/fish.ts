// The shallow-water fish, as anatomy.
//
// WHAT IT REPLACES (owner, 2026-09-02: "fix the fin movement and shape for the
// existing fish. Fish tails move from side to side, not up and down, and they
// don't rotate"). The shipped fish was a 6-segment ellipsoid with a 4-sided
// cone for a tail, and two things were wrong with how it moved:
//
//   1. The tail cone pivoted about ITS OWN CENTRE (a Mesh's rotation is about
//      its origin, and the cone's origin was half-way along it), so the stroke
//      read as the tail SPINNING on a pin behind the body rather than sweeping
//      from a hinge at the peduncle. Here the caudal fin hangs under a Group
//      whose origin IS the peduncle; the fin's outline starts a hair forward of
//      it and everything behind it swings.
//   2. The body counter-motion was `rig.rotation.z`. This model faces +X, so Z
//      is the PITCH axis — the whole fish nodded up and down in time with its
//      tail. A swimming fish yaws: the head swings a little the other way from
//      the tail. The counter-motion is now `rotation.y`, and there is no pitch
//      term anywhere in this file.
//
// THE BODY is a swept hull (../whaleHull.ts), laterally compressed — taller
// than wide through the middle, as a shallow-water fish is — with a forked
// caudal fin, a soft dorsal, an anal fin, paired pectorals that flutter, and
// two eyes. Smooth-shaded: on a swept surface faceting is banding, not style.
//
// ENVELOPE. The placement contract (../placement.ts SWIM_PROFILES.fish) allows
// 0.3 of water above the origin and 0.25 below at model scale 1, and the large
// class is drawn at 1.4×. FISH_ENVELOPE below is what this body measures and
// is what placement reads; the dorsal crown is the binding dimension.
import { Group } from 'three';
import { profileFromPoints, sweptHull, type BodyProfile } from '../whaleHull.ts';
import { flatFin, smoothEllipsoid, uprightFin } from './bodyKit.ts';
import { TWO_PI, type SpeciesModelBuilder } from './speciesModel.ts';

const FISH_BODY_COLOR = 0xe8a13c; // warm orange against blue shallows (unchanged)
const FISH_FIN_COLOR = 0xf3c46e; // a shade lighter: fins are thinner and catch light
const FISH_EYE_COLOR = 0x1c1a17;

/** Nose-to-peduncle length of the hull. The caudal fin adds to it behind. */
const HULL_LENGTH = 0.56;
/** Where the hull is centred so the nose lands at +0.30 and the peduncle at -0.26. */
const HULL_CENTRE_X = 0.02;
const MAX_HALF_WIDTH = 0.08;
/** Peduncle: the hinge the tail swings from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Behind the peduncle the caudal fin reaches this far back. */
const CAUDAL_REACH = 0.16;
const CAUDAL_HALF_SPAN = 0.13;

const HULL_RINGS = 24;
const HULL_SEGMENTS = 14;
/**
 * How far a fin root is sunk into the hull. The hull is a swept surface, so
 * its true top at a fin's station sits a little under the profile's value
 * between rings; 0.04 is what closes the hairline of daylight the wiring
 * review found at 0.02.
 */
const FIN_SEAT_BITE = 0.04;
const FIN_THICKNESS = 0.012;
const EYE_RADIUS = 0.016;
const EYE_SEGMENTS = 6;

/**
 * Tail beat, and how far the tail swings either side of the body line. 3.2 Hz
 * is the rate the old fish beat at and the eye is used to it; 0.45 rad (~26°)
 * is a cruising sweep rather than a burst — the caudal fin's own tip travels
 * ~0.07 either way at that angle, about a body width, which is what a small
 * fish's tail does at cruise.
 */
export const FISH_TAIL_HZ = 3.2;
export const FISH_TAIL_SWING_RADIANS = 0.45;
/**
 * The head's counter-yaw as a fraction of the tail's swing, OPPOSITE in sign.
 * A fish's body is a lever about its centre of mass: the tail goes one way and
 * the nose a little the other. Small, because the head is the stiff half.
 */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/** How far the pectorals angle down from the flank at rest. */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
/** Pectoral flutter: a slower, smaller beat that lags the tail. */
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/**
 * What this body measures, in world units at model scale 1 — the numbers
 * placement.ts fits the fish into its water column with. Read them; do not
 * restate them there.
 */
export const FISH_ENVELOPE = {
  /** Nose tip to caudal tip. */
  length: 0.30 + -PEDUNCLE_X + CAUDAL_REACH,
  halfLength: (0.30 + -PEDUNCLE_X + CAUDAL_REACH) / 2,
  halfWidth: MAX_HALF_WIDTH,
  /** Top of the dorsal fin above the origin. */
  crownY: 0.17,
  /** Bottom of the anal fin below the origin. */
  bellyY: -0.17,
} as const;

export const buildFish: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(FISH_BODY_COLOR, { flatShading: false });
  const fin = pool.lambert(FISH_FIN_COLOR, { flatShading: false });
  const eye = pool.lambert(FISH_EYE_COLOR, { flatShading: false });

  // Half-width along the body: a blunt-ish snout, widest a third of the way
  // back, tapering to a narrow peduncle.
  const width = profileFromPoints([
    [0.00, 0.18], [0.08, 0.55], [0.20, 0.88], [0.35, 1.00], [0.50, 0.95],
    [0.65, 0.76], [0.80, 0.46], [0.92, 0.26], [1.00, 0.20],
  ]);
  // Height over width: laterally compressed, deepest just behind the head.
  const heightRatio = profileFromPoints([
    [0.00, 1.00], [0.15, 1.40], [0.35, 1.65], [0.55, 1.60], [0.75, 1.40],
    [0.90, 1.10], [1.00, 0.95],
  ]);
  const halfWidth: BodyProfile = (t) => width(t) * MAX_HALF_WIDTH;
  const halfHeight: BodyProfile = (t) => halfWidth(t) * heightRatio(t);
  /** Body t for a station x, on the authored hull. */
  const bodyT = (x: number): number => (HULL_CENTRE_X + HULL_LENGTH / 2 - x) / HULL_LENGTH;

  const hull = sweptHull({
    length: HULL_LENGTH,
    rings: HULL_RINGS,
    segments: HULL_SEGMENTS,
    halfWidth,
    halfHeight,
    noseCapReach: 0.7,
    tailCapReach: 0.4,
  });
  hull.translate(HULL_CENTRE_X, 0, 0);
  pool.keepGeometry(hull);

  // Soft dorsal along the back, seated a bite into the body so no daylight
  // shows under its root.
  const DORSAL_X = -0.02;
  const dorsal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.14, 0);
    shape.quadraticCurveTo(0.04, 0.06, -0.12, 0.045);
    shape.lineTo(-0.16, 0);
    shape.lineTo(0.14, 0);
  }, FIN_THICKNESS));
  const dorsalSeatY = halfHeight(bodyT(DORSAL_X)) - FIN_SEAT_BITE;

  const ANAL_X = -0.13;
  const anal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.06, 0);
    shape.quadraticCurveTo(0.0, -0.055, -0.07, -0.05);
    shape.lineTo(-0.08, 0);
    shape.lineTo(0.06, 0);
  }, FIN_THICKNESS));
  const analSeatY = -halfHeight(bodyT(ANAL_X)) + FIN_SEAT_BITE;

  // Forked caudal: two lobes and a notch, authored with x = 0 AT THE HINGE.
  const caudal = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.03, 0);
    shape.quadraticCurveTo(-0.05, 0.05, -CAUDAL_REACH, CAUDAL_HALF_SPAN);
    shape.quadraticCurveTo(-0.10, 0.04, -0.09, 0);
    shape.quadraticCurveTo(-0.10, -0.04, -CAUDAL_REACH, -CAUDAL_HALF_SPAN);
    shape.quadraticCurveTo(-0.05, -0.05, 0.03, 0);
  }, FIN_THICKNESS));

  const PECTORAL_X = 0.10;
  const pectoralGeometries = [1, -1].map((sign) => pool.keepGeometry(flatFin((shape, s) => {
    // Swept back IN THE OUTLINE: the root edge stays on the flank whatever
    // the hinge's dihedral, which a yaw on the hinge would not (it swings the
    // root out of the body).
    shape.moveTo(0.03, 0);
    shape.quadraticCurveTo(-0.01, s * 0.05, -0.09, s * 0.09);
    shape.quadraticCurveTo(-0.09, s * 0.04, -0.05, 0);
    shape.lineTo(0.03, 0);
  }, sign, FIN_THICKNESS * 0.8)));

  const eyeGeometry = pool.keepGeometry(
    smoothEllipsoid(EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_SEGMENTS, EYE_SEGMENTS),
  );
  const EYE_X = 0.21;
  const eyeZ = halfWidth(bodyT(EYE_X)) * 0.92;

  // ── Assembly ──────────────────────────────────────────────────────────────
  const { root, rig } = pool.rigged();
  rig.add(pool.part(hull, body, 0, 0, 0));
  rig.add(pool.part(dorsal, fin, DORSAL_X, dorsalSeatY, 0));
  rig.add(pool.part(anal, fin, ANAL_X, analSeatY, 0));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.03, eyeZ));
  rig.add(pool.part(eyeGeometry, eye, EYE_X, 0.03, -eyeZ));

  // THE HINGE. The tail Group sits at the peduncle; the fin is a child at the
  // Group's origin, so rotating the Group about Y sweeps the fin from its
  // root — side to side, the way a fish tail moves.
  const tailHinge = new Group();
  tailHinge.position.set(PEDUNCLE_X, 0, 0);
  tailHinge.add(pool.part(caudal, fin, 0, 0, 0));
  rig.add(tailHinge);

  // Pectorals hinge at their root on the flank, swept back and angled down.
  const pectoralSeatZ = halfWidth(bodyT(PECTORAL_X)) * 0.8;
  const pectorals = pectoralGeometries.map((geometry, i) => {
    const sign = i === 0 ? 1 : -1;
    const hinge = new Group();
    hinge.position.set(PECTORAL_X, -0.03, sign * pectoralSeatZ);
    hinge.rotation.set(sign * PECTORAL_DIHEDRAL_RADIANS, 0, 0);
    hinge.add(pool.part(geometry, fin, 0, 0, 0));
    rig.add(hinge);
    return hinge;
  });

  return {
    root,
    joints: { rig, tail: tailHinge, leftPectoral: pectorals[0]!, rightPectoral: pectorals[1]! },
    animate(joints, seconds, phase) {
      const beat = seconds * FISH_TAIL_HZ * TWO_PI + phase;
      const swing = Math.sin(beat);
      // Side to side about the peduncle. Nothing here touches pitch (Z).
      joints.tail!.rotation.y = swing * FISH_TAIL_SWING_RADIANS;
      joints.rig!.rotation.y = -swing * FISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
      const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
      joints.leftPectoral!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
      joints.rightPectoral!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
    },
  };
};
