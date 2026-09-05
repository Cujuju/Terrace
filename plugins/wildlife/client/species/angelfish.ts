// The angelfish: the striped disc, and the FIFTH species drawn from a
// Blender-built asset.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish, shark, ray and eel went first, this file follows
// them). The body used to be built here out of a swept hull, extruded fins,
// two bar slabs and ellipsoid eyes (../whaleHull.ts's sweptHull and
// profileFromPoints, ./bodyKit.ts's uprightFin, flatFin and smoothEllipsoid).
// It is now ../assets/angelfish.glb, authored by tools/blender/build_angelfish.py
// and loaded through ./assetSpecies.ts. Those two helpers are NOT orphaned —
// ibex and bison still build on both, the whale bodies on whaleHull, and
// quadruped.ts on bodyKit.
//
// WHAT DID NOT CHANGE, and must not:
//   * ANGELFISH_ENVELOPE. It is the placement contract (../placement.ts's
//     SWIM_PROFILES.angelfish and BODY_COLUMNS.angelfish read it): the same
//     five numbers, written from the same constants by the same formulas, so
//     the angelfish sits in the same water it always did. The two derived
//     values, crownY and bellyY, are now full-precision literals with their
//     derivations beside them (below).
//   * The animation. Same 2.2 Hz beat, same 0.35 rad swing, same counter-yaw
//     fraction, same pectoral dihedral, flutter and lag — the asset supplies
//     joints, never motion. ANGELFISH_TAIL_HZ and ANGELFISH_TAIL_SWING_RADIANS
//     stay exported.
//   * The colours. 0xe8b83c body (golden against blue shallows), 0x23232a
//     bars, 0xdfa838 fins, 0x141310 eyes: the owner reads a species by its
//     colour, and build_angelfish.py paints the same four.
//
// THE BARS ARE GEOMETRY — the design decision made for this pass, and why.
// The envelope's halfWidth (0.085) is a BAR's outer face, 0.015 proud of a
// hull that is 0.07 across at its widest: the procedural body hung two thin
// slabs through the flanks and declared the slab's face as the fish's width.
// installSpeciesAsset checks the file's `flank` anchor against that number,
// so the bars cannot become paint without changing the contract. The file
// therefore carries them as a locally thickened section: the hull's own
// surface, raised by a lens-shaped bump that peaks at exactly 0.085 on the
// front bar's centre ring and feathers to nothing at the bar's rim, painted
// near-black, and shaded with the smooth hull's normals so the bump is a
// silhouette fact (the flank anchor) and not a shading fact — a marking, not
// a plate. Nothing is hung through anything.
//
// THE MOTION, unchanged from the procedural body: the tail sweeps side to
// side about a hinge AT THE PEDUNCLE (fish.ts says why that is a yaw about a
// hinge and nothing else), at a disc's tempo between the fish's dart and the
// eel's pour, with the fish's own counter-yaw fraction and fluttering
// pectorals. Nothing here touches pitch (Z).
//
// ONE ENVELOPE. The crown is the dorsal tip and the belly the anal tip, both
// rigid fins authored where the envelope says; the pectorals are rolled to
// their dihedral every frame and are NOT extremes (flat in the file they
// reach 0.124, past the flank — the upper-bound case the install allows).
//
// JOINT NAMES. SWIMMER_JOINTS: `pectoral_port` / `pectoral_starboard`
// replace the procedural body's `leftPectoral` / `rightPectoral`. Port is -Z
// (docs/model-assets.md: with +X forward and +Y up, left = up × forward =
// Y × X = -Z), and the old `leftPectoral` was the `sign = +1` hinge at +Z —
// the STARBOARD fin under a misnomer. The sign mapping is carried, not the
// name: what `leftPectoral` got, `pectoral_starboard` gets.
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

/** Nose-to-peduncle length of the hull. The caudal fin adds to it behind. */
const HULL_LENGTH = 0.50;
/** Centred: nose at +0.25, peduncle at -0.25. */
const HULL_CENTRE_X = 0.0;
/** The nose tip: the model's forward extreme, the `nose` anchor. */
const NOSE_X = 0.25;
/** Peduncle: the hinge the tail swings from. */
const PEDUNCLE_X = HULL_CENTRE_X - HULL_LENGTH / 2;
/** Behind the peduncle the caudal fin reaches this far back — to the `tail_tip` anchor. */
const CAUDAL_REACH = 0.13;
/**
 * How far a bar stands proud of each flank: the `flank` anchor, on the front
 * bar's outer face. The hull is 0.07 across at its widest and the bar's bump
 * carries it to 0.085 there (see the header).
 */
const BAR_HALF_THICKNESS = 0.085;

/**
 * Tail beat: 2.2 Hz between the fish's dart and the eel's pour, 0.35 rad —
 * the caudal tip travels ~0.05 either way, a crisp flick for a small disc.
 */
export const ANGELFISH_TAIL_HZ = 2.2;
export const ANGELFISH_TAIL_SWING_RADIANS = 0.35;
/** The head's counter-yaw as a fraction of the tail's swing (fish.ts). */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/**
 * How far the pectorals angle down from the flank at rest.
 *
 * IT LIVES HERE, NOT IN THE ASSET. The hinge Empties in angelfish.glb are
 * authored at rest identity (flat) and `animate` assigns their rotation
 * outright, so a rest pose baked into the file would be overwritten on the
 * first frame.
 */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
/** Pectoral flutter, same character as the fish's. */
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/**
 * The dorsal tip above the origin: the envelope's crownY and the `crown`
 * anchor. The procedural body derived it from its hull lines — the hull's
 * half-height at x = -0.06 (Catmull-Rom width and height-ratio profiles
 * through whaleHull.ts's profileFromPoints: 0.12377411123027341) minus a
 * 0.035 fin-seat bite plus a 0.24 dorsal peak — and this is that value to
 * the last digit, so placement reads exactly what it always read.
 * build_angelfish.py builds the dorsal to put a vertex at it.
 */
const DORSAL_CROWN_Y = 0.3287741112302734;
/**
 * The anal tip below the origin: the envelope's bellyY and the `belly`
 * anchor, derived the same way — minus the hull's half-height at x = -0.05
 * (0.13027641296386721) plus the bite, minus a 0.22 anal depth.
 */
const ANAL_BELLY_Y = -0.3152764129638672;

/**
 * What this body measures, in world units at model scale 1 — the numbers
 * placement.ts fits the angelfish into its water column with. Read them; do
 * not restate them there, and do not derive them from the asset: they are
 * the contract the asset is CHECKED against (./assetSpecies.ts).
 */
export const ANGELFISH_ENVELOPE = {
  /** Nose tip to caudal tip. */
  length: NOSE_X + -PEDUNCLE_X + CAUDAL_REACH,
  halfLength: (NOSE_X + -PEDUNCLE_X + CAUDAL_REACH) / 2,
  /** To a bar's outer face. */
  halfWidth: BAR_HALF_THICKNESS,
  /** Top of the dorsal fin above the origin. */
  crownY: DORSAL_CROWN_Y,
  /** Bottom of the anal fin below the origin. */
  bellyY: ANAL_BELLY_Y,
} as const;

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk.
 */
export const ANGELFISH_ASSET: SpeciesAssetSpec = {
  species: 'angelfish',
  file: 'angelfish.glb',
  joints: SWIMMER_JOINTS,
  envelope: ANGELFISH_ENVELOPE,
};

export const buildAngelfish = assetSpeciesBuilder(ANGELFISH_ASSET, (joints, seconds, phase) => {
  const beat = seconds * ANGELFISH_TAIL_HZ * TWO_PI + phase;
  const swing = Math.sin(beat);
  // Side to side about the peduncle. Nothing here touches pitch (Z).
  joints.tail!.rotation.y = swing * ANGELFISH_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * ANGELFISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
  // A rotation about +X by θ moves a point at +Z to y' = -z·sin θ: it sends
  // the starboard (+Z) fin DOWN for positive θ and the port (-Z) fin down for
  // negative θ. So starboard takes +dihedral +flutter and port the negation,
  // and both fins hang down and flutter together. (The procedural body gave
  // its +Z hinge `0.55 + flutter` under the name leftPectoral and its -Z
  // hinge `-0.55 - flutter` as rightPectoral; the motion is the same, only
  // the names now say which side is which.)
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
