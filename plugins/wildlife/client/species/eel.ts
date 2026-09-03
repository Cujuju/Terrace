// The eel, as anatomy: the bottom ribbon.
//
// A long near-cylindrical hull — blunt snout, widest just behind the head,
// tapering to a thin tail stem — with a low dorsal ridge along its rear half,
// a small rounded tail paddle, tiny paired pectorals, and two eyes flush on
// the snout. Olive above, pale beneath. Smooth-shaded like the fish: on a
// swept surface faceting is banding, not style.
//
// MOTION: nothing here beats — the eel IS the wave. The hull is sliced into
// five overlapping rigid segments hung on a spine chain (head to stem), each
// swinging a little wider and a little later than the one before it, so a
// travelling S runs nose to tail at 1.6 Hz with the head nearly still and the
// paddle flourishing last. Rigid weights are all the baker does (see
// rigSkin.ts: weight 1.0 to the node a part hangs under), so a bend MUST be a
// chain of joints — one hinge under the whole hull could only ever yaw it
// like a fish. The slices overlap their neighbours by 0.04 of body length,
// which is what hides the seams at these small per-joint angles.
//
// ENVELOPE. EEL_ENVELOPE is what placement.ts reads. The ridge crown is the
// binding dimension above; the length is nose to paddle tip.
import { BufferGeometry, Float32BufferAttribute, Group } from 'three';
import { profileFromPoints, type BodyProfile } from '../whaleHull.ts';
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

const SLICE_SEGMENTS = 12;
/** See fish.ts FIN_SEAT_BITE; a thin hull needs a shallow bite. */
const FIN_SEAT_BITE = 0.025;
const FIN_THICKNESS = 0.012;
const EYE_RADIUS = 0.02;
const EYE_SEGMENTS = 6;

/**
 * The travelling wave: 1.6 Hz, half the fish's rate. Amplitudes grow
 * head-to-tail (an anguilliform wave is a whisper at the head and a flourish
 * at the paddle) and each joint lags the one before it by just over a radian,
 * so roughly one full S fits along the body at any moment.
 */
export const EEL_TAIL_HZ = 1.6;
const SPINE_AMPLITUDES = [0.05, 0.09, 0.13, 0.17, 0.21] as const;
const SPINE_LAG_RADIANS = 1.1;
/** The paddle's own flourish at the wave's end, further lagged. */
export const EEL_TAIL_SWING_RADIANS = 0.40;
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
/** Rig-space x of a body station t. */
const stationX = (t: number): number => HULL_CENTRE_X + HULL_LENGTH / 2 - t * HULL_LENGTH;

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
 * restate them there. (A bent eel is shorter than a straight one, so the
 * straight length stays the conservative reading.)
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

/** Where the five spine joints sit, head to stem, as body stations. */
const SPINE_T = [0.06, 0.26, 0.46, 0.66, 0.84] as const;
/** What each spine joint carries: overlapping slices that hide the seams. */
const SLICES: ReadonlyArray<{ t0: number; t1: number; capNose: boolean; capTail: boolean }> = [
  { t0: 0.00, t1: 0.24, capNose: true, capTail: false },
  { t0: 0.20, t1: 0.44, capNose: false, capTail: false },
  { t0: 0.40, t1: 0.64, capNose: false, capTail: false },
  { t0: 0.60, t1: 0.84, capNose: false, capTail: false },
  { t0: 0.80, t1: 1.00, capNose: false, capTail: true },
];

/**
 * One open (or end-capped) sweep over a body interval — a link of the chain.
 * Same section math as sweptHull (wrapped, seam-free rings; identical winding
 * and cap construction) over [t0, t1] instead of the whole body, so a slice
 * meets its neighbours exactly where they overlap.
 */
function tubeSlice(
  t0: number,
  t1: number,
  rings: number,
  hw: BodyProfile,
  hh: BodyProfile,
  capNose: boolean,
  capTail: boolean,
): BufferGeometry {
  const S = SLICE_SEGMENTS;
  const positions: number[] = [];
  const indices: number[] = [];
  const ringStarts: number[] = [];
  function ring(x: number, a: number, b: number): void {
    ringStarts.push(positions.length / 3);
    for (let j = 0; j < S; j++) {
      const theta = (j / S) * Math.PI * 2;
      positions.push(x, b * Math.sin(theta), a * Math.cos(theta));
    }
  }
  let poleNose = -1;
  if (capNose) {
    const a = hw(t0);
    const b = hh(t0);
    const reach = Math.max(a, b) * 0.6;
    poleNose = positions.length / 3;
    positions.push(stationX(t0) + reach, 0, 0);
    const sc = Math.sin(Math.PI / 4);
    ring(stationX(t0) + reach * Math.cos(Math.PI / 4), a * sc, b * sc);
  }
  for (let i = 0; i <= rings; i++) {
    const t = t0 + ((t1 - t0) * i) / rings;
    ring(stationX(t), hw(t), hh(t));
  }
  let poleTail = -1;
  if (capTail) {
    const a = hw(t1);
    const b = hh(t1);
    const reach = Math.max(a, b) * 0.5;
    const sc = Math.sin(Math.PI / 4);
    ring(stationX(t1) - reach * Math.cos(Math.PI / 4), a * sc, b * sc);
    poleTail = positions.length / 3;
    positions.push(stationX(t1) - reach, 0, 0);
  }
  if (poleNose >= 0) {
    const r0 = ringStarts[0]!;
    for (let j = 0; j < S; j++) indices.push(poleNose, r0 + ((j + 1) % S), r0 + j);
  }
  for (let r = 0; r < ringStarts.length - 1; r++) {
    const cur = ringStarts[r]!;
    const nxt = ringStarts[r + 1]!;
    for (let j = 0; j < S; j++) {
      const k = (j + 1) % S;
      indices.push(cur + j, cur + k, nxt + j);
      indices.push(nxt + j, cur + k, nxt + k);
    }
  }
  if (poleTail >= 0) {
    const last = ringStarts[ringStarts.length - 1]!;
    for (let j = 0; j < S; j++) indices.push(poleTail, last + j, last + ((j + 1) % S));
  }
  const geometry = new BufferGeometry();
  geometry.setAttribute('position', new Float32BufferAttribute(positions, 3));
  geometry.setIndex(indices);
  geometry.computeVertexNormals();
  return geometry;
}

export const buildEel: SpeciesModelBuilder = (pool) => {
  const body = pool.lambert(EEL_BODY_COLOR, { flatShading: false });
  const belly = pool.lambert(EEL_BELLY_COLOR, { flatShading: false });
  const fin = pool.lambert(EEL_FIN_COLOR, { flatShading: false });
  const eye = pool.lambert(EEL_EYE_COLOR, { flatShading: false });

  // ── The spine: five nested hinges, head to stem ────────────────────────────
  const { root, rig } = pool.rigged();
  const spines: Group[] = [];
  {
    let parent: Group = rig;
    let parentX = 0;
    for (const t of SPINE_T) {
      const x = stationX(t);
      const joint = new Group();
      joint.position.set(x - parentX, 0, 0);
      parent.add(joint);
      spines.push(joint);
      parent = joint;
      parentX = x;
    }
  }
  const spineName = (i: number): string => `spine${i}`;

  // One hull slice + one underside crescent per spine joint, authored in rig
  // space and hung under the joint with the joint's own station subtracted —
  // so each link carries exactly the flesh around it.
  SPINE_T.forEach((_t, i) => {
    const joint = spines[i]!;
    const x = stationX(SPINE_T[i]!);
    const s = SLICES[i]!;
    const hull = pool.keepGeometry(tubeSlice(s.t0, s.t1, 8, eelHalfWidth, eelHalfHeight, s.capNose, s.capTail));
    joint.add(pool.part(hull, body, -x, 0, 0));
    const underside = pool.keepGeometry(
      tubeSlice(
        s.t0, s.t1, 4,
        (t) => eelHalfWidth(t) * 0.96,
        (t) => eelHalfHeight(t) * 0.96,
        s.capNose, s.capTail,
      ),
    );
    underside.translate(0, -0.008, 0);
    joint.add(pool.part(underside, belly, -x, 0, 0));
  });

  // The ridge in two halves, each riding the joint under its middle — a whole
  // rigid ridge would lift off the bending back at its ends.
  const ridgeA = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.15, 0);
    shape.quadraticCurveTo(0.05, 0.05, -0.13, 0.048);
    shape.lineTo(-0.15, 0);
    shape.lineTo(0.15, 0);
  }, FIN_THICKNESS));
  const ridgeB = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.15, 0);
    shape.quadraticCurveTo(-0.05, 0.055, -0.13, 0.05);
    shape.lineTo(-0.15, 0);
    shape.lineTo(0.15, 0);
  }, FIN_THICKNESS));
  // Abs anchors -0.15 and -0.45; seats read off the hull like the envelope's.
  const seatA = eelHalfHeight(eelBodyT(-0.15)) - FIN_SEAT_BITE;
  const seatB = eelHalfHeight(eelBodyT(-0.45)) - FIN_SEAT_BITE;
  spines[3]!.add(pool.part(ridgeA, fin, -0.15 - stationX(SPINE_T[3]!), seatA, 0));
  spines[4]!.add(pool.part(ridgeB, fin, -0.45 - stationX(SPINE_T[4]!), seatB, 0));

  // Rounded paddle — an eel's tail is a fan, not a fork — hung off the last
  // spine link at the stem, swinging with the wave's final lag.
  const paddle = pool.keepGeometry(uprightFin((shape) => {
    shape.moveTo(0.02, 0);
    shape.quadraticCurveTo(-0.06, 0.06, -PADDLE_REACH, PADDLE_HALF_SPAN);
    shape.quadraticCurveTo(-PADDLE_REACH - 0.02, 0, -PADDLE_REACH, -PADDLE_HALF_SPAN);
    shape.quadraticCurveTo(-0.06, -0.06, 0.02, 0);
  }, FIN_THICKNESS));
  const tailHinge = new Group();
  tailHinge.position.set(PEDUNCLE_X - stationX(SPINE_T[4]!), 0, 0);
  tailHinge.add(pool.part(paddle, fin, 0, 0, 0));
  spines[4]!.add(tailHinge);

  // Eyes and pectorals ride the head link.
  const eyeGeometry = pool.keepGeometry(
    smoothEllipsoid(EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_RADIUS * 2, EYE_SEGMENTS, EYE_SEGMENTS),
  );
  const EYE_X = 0.50;
  const eyeZ = eelHalfWidth(eelBodyT(EYE_X)) * 0.85;
  const headX = stationX(SPINE_T[0]!);
  spines[0]!.add(pool.part(eyeGeometry, eye, EYE_X - headX, 0.02, eyeZ));
  spines[0]!.add(pool.part(eyeGeometry, eye, EYE_X - headX, 0.02, -eyeZ));

  const PECTORAL_X = 0.40;
  const pectoralSeatZ = eelHalfWidth(eelBodyT(PECTORAL_X)) * 0.8;
  const pectorals = [1, -1].map((sign) => {
    const geometry = pool.keepGeometry(flatFin((shape, s) => {
      shape.moveTo(0.02, 0);
      shape.quadraticCurveTo(-0.01, s * 0.03, -0.06, s * 0.055);
      shape.quadraticCurveTo(-0.055, s * 0.02, -0.03, 0);
      shape.lineTo(0.02, 0);
    }, sign, FIN_THICKNESS * 0.8));
    const hinge = new Group();
    hinge.position.set(PECTORAL_X - headX, -0.03, sign * pectoralSeatZ);
    hinge.rotation.set(sign * 0.5, 0, 0);
    hinge.add(pool.part(geometry, fin, 0, 0, 0));
    spines[0]!.add(hinge);
    return hinge;
  });

  const joints: Record<string, object> = { rig };
  spines.forEach((spine, i) => {
    joints[spineName(i)] = spine;
  });
  joints['tail'] = tailHinge;
  joints['leftPectoral'] = pectorals[0]!;
  joints['rightPectoral'] = pectorals[1]!;

  return {
    root,
    joints: joints as Record<string, import('three').Object3D>,
    animate(joints, seconds, phase) {
      const beat = seconds * EEL_TAIL_HZ * TWO_PI + phase;
      // The S: each link a little wider and a little later than the last.
      // Nothing here touches pitch (Z) — side to side, the way a fish tail
      // moves, all the way up the body.
      for (let i = 0; i < SPINE_T.length; i++) {
        joints[spineName(i)]!.rotation.y =
          Math.sin(beat - i * SPINE_LAG_RADIANS) * SPINE_AMPLITUDES[i]!;
      }
      joints.tail!.rotation.y =
        Math.sin(beat - SPINE_T.length * SPINE_LAG_RADIANS) * EEL_TAIL_SWING_RADIANS;
      joints.rig!.rotation.y = Math.sin(beat + 0.6) * 0.03;
      const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
      joints.leftPectoral!.rotation.x = 0.5 + flutter;
      joints.rightPectoral!.rotation.x = -0.5 - flutter;
    },
  };
};
