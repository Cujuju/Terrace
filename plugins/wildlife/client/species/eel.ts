// The eel: the bottom ribbon, and the FOURTH species drawn from a Blender-built
// asset — the first whose body is a CHAIN.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish.ts, shark.ts and ray.ts went first, this file follows
// them). The body used to be built here out of five overlapping tube slices,
// extruded fins and ellipsoid eyes (../whaleHull.ts's profileFromPoints,
// ./bodyKit.ts). It is now ../assets/eel.glb, authored by
// tools/blender/build_eel.py and loaded through ./assetSpecies.ts. Those two
// helpers are NOT orphaned — ibex, bison and angelfish still build on both,
// the whale bodies on whaleHull, and quadruped.ts on bodyKit.
//
// WHAT DID NOT CHANGE, and must not:
//   * EEL_ENVELOPE. It is the placement contract (../placement.ts's
//     SWIM_PROFILES.eel and BODY_COLUMNS.eel read it): the same five numbers,
//     written from the same constants by the same formulas, so the eel sits in
//     the same water it always did. The one derived value, crownY, is now a
//     full-precision literal with its derivation beside it (below).
//   * The animation. Same 1.6 Hz wave, same five growing amplitudes and lag,
//     same paddle flourish, rig wobble and pectoral flutter — the asset
//     supplies joints, never motion.
//   * The colours. 0x3d4220 body (dark olive against pale sand), 0x8c8a66
//     belly, 0x333a1c fins, 0x0f0f0c eyes: the owner reads a species by its
//     colour, and build_eel.py paints the same four.
//
// THE MOTION, restated because it is the thing an asset could silently break:
// the eel IS the wave. Nothing on it beats. rigSkin.ts binds every mesh
// rigidly to the node it hangs under (weight 1.0 — bakeRig's bindRigidly),
// so a bend can only be a chain of hinges, and bakeRig composes a child
// node's rotation onto its parent's (`collect` records the parent index per
// bone; `instantiateRig` parents the Bones by it). The file therefore carries
// five NESTED spine Empties, head to stem — spine1 a child of spine0, and so
// on — each carrying one rigid hull slice, and `animate` yaws each a little
// wider and a little later than the one before, so a travelling S runs nose
// to tail with the head nearly still and the paddle flourishing last.
// Nothing here touches pitch (Z) — side to side, the way a fish tail moves,
// all the way up the body.
//
// ONE ENVELOPE. The eel's extremes are static at rest: the nose, the paddle
// tip, the ridge crest and the belly are all authored where the envelope says
// and no hinge `animate` drives moves them (the pectorals are rolled to their
// dihedral every frame and are NOT extremes — the belly is the hull's). A bent
// eel is shorter than a straight one, so the straight file is the conservative
// reading, as the procedural body always said.
//
// JOINT NAMES. Not SWIMMER_JOINTS: a swimmer has one tail hinge and two
// pectorals; the eel has those AND five spine hinges. `pectoral_port` /
// `pectoral_starboard` replace the procedural body's `leftPectoral` /
// `rightPectoral`. Port is -Z (docs/model-assets.md: with +X forward and +Y
// up, left = up × forward = Y × X = -Z), and the old `leftPectoral` was the
// `sign = +1` hinge at +Z — the STARBOARD fin under a misnomer. The sign
// mapping is carried, not the name: what `leftPectoral` got, `pectoral_starboard`
// gets.
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

/** Nose-to-stem length of the hull. The paddle adds to it behind. */
const HULL_LENGTH = 1.15;
/** Where the hull is centred so the nose lands at +0.595 and the stem at -0.555. */
const HULL_CENTRE_X = 0.02;
/** The nose tip: the model's forward extreme, the `nose` anchor. */
const NOSE_X = 0.595;
/** The body's widest half-width, the `flank` anchor. */
const MAX_HALF_WIDTH = 0.075;
/** Stem: the hinge the paddle waves from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Behind the stem the paddle reaches this far back — to the `tail_tip` anchor. */
const PADDLE_REACH = 0.14;

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
/** The whole body's small counter-sway, a little ahead of the wave. */
const RIG_SWAY_RADIANS = 0.03;
const RIG_SWAY_LEAD_RADIANS = 0.6;
/**
 * How far the pectorals angle down from the flank at rest.
 *
 * IT LIVES HERE, NOT IN THE ASSET. The hinge Empties in eel.glb are authored
 * at rest identity (flat) and `animate` assigns their rotation outright, so a
 * rest pose baked into the file would be overwritten on the first frame.
 */
const PECTORAL_DIHEDRAL_RADIANS = 0.5;
/** The pectorals barely stir — a slow small beat that lags the wave. */
const PECTORAL_FLUTTER_RADIANS = 0.10;
const PECTORAL_LAG_RADIANS = 1.1;

/**
 * The dorsal ridge's crest above the origin: the envelope's crownY and the
 * `crown` anchor. The procedural body derived it from its hull lines — the
 * hull's half-height at x = -0.30 (Catmull-Rom width and height-ratio
 * profiles through whaleHull.ts's profileFromPoints: 0.04564932759133065)
 * minus a 0.025 fin-seat bite plus a 0.05 ridge peak — and this is that
 * value to the last digit, so placement reads exactly what it always read.
 * build_eel.py builds the ridge to put a vertex at it.
 */
const RIDGE_CROWN_Y = 0.07064932759133065;
/** Deepest the hull runs: width and ratio peaks coincide just behind the head. */
const HULL_BELLY = MAX_HALF_WIDTH * 1.15;

/**
 * What this body measures, in world units at model scale 1 — the numbers
 * placement.ts fits the eel into its water column with. Read them; do not
 * restate them there, and do not derive them from the asset: they are the
 * contract the asset is CHECKED against (./assetSpecies.ts). (A bent eel is
 * shorter than a straight one, so the straight length stays the conservative
 * reading.)
 */
export const EEL_ENVELOPE = {
  /** Nose tip to paddle tip. */
  length: NOSE_X + -PEDUNCLE_X + PADDLE_REACH,
  halfLength: (NOSE_X + -PEDUNCLE_X + PADDLE_REACH) / 2,
  halfWidth: MAX_HALF_WIDTH,
  /** Top of the dorsal ridge above the origin. */
  crownY: RIDGE_CROWN_Y,
  /** Belly line below the origin. */
  bellyY: -HULL_BELLY,
} as const;

/** The five spine hinges, head to stem, by the names they carry in eel.glb. */
const SPINE_JOINTS = ['spine0', 'spine1', 'spine2', 'spine3', 'spine4'] as const;

/**
 * The joints this species drives, by the names they carry in eel.glb. NOT
 * SWIMMER_JOINTS: the five spine hinges are nested head to stem (spine1 under
 * spine0, …), `tail` hangs under spine4 at the stem, and the two pectoral
 * hinges under spine0.
 */
const EEL_JOINTS: readonly string[] = [
  'rig',
  ...SPINE_JOINTS,
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk.
 */
export const EEL_ASSET: SpeciesAssetSpec = {
  species: 'eel',
  file: 'eel.glb',
  joints: EEL_JOINTS,
  envelope: EEL_ENVELOPE,
};

export const buildEel = assetSpeciesBuilder(EEL_ASSET, (joints, seconds, phase) => {
  const beat = seconds * EEL_TAIL_HZ * TWO_PI + phase;
  // The S: each link a little wider and a little later than the last. A child
  // hinge's yaw composes onto its parent's, so these are RELATIVE bends.
  for (let i = 0; i < SPINE_JOINTS.length; i++) {
    joints[SPINE_JOINTS[i]!]!.rotation.y =
      Math.sin(beat - i * SPINE_LAG_RADIANS) * SPINE_AMPLITUDES[i]!;
  }
  joints.tail!.rotation.y =
    Math.sin(beat - SPINE_JOINTS.length * SPINE_LAG_RADIANS) * EEL_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = Math.sin(beat + RIG_SWAY_LEAD_RADIANS) * RIG_SWAY_RADIANS;
  // A rotation about +X by θ moves a point at +Z to y' = -z·sin θ: it sends
  // the starboard (+Z) fin DOWN for positive θ and the port (-Z) fin down for
  // negative θ. So starboard takes +dihedral +flutter and port the negation,
  // and both fins hang down and flutter together. (The procedural body gave
  // its +Z hinge `0.5 + flutter` under the name leftPectoral and its -Z hinge
  // `-0.5 - flutter` as rightPectoral; the motion is the same, only the names
  // now say which side is which.)
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
