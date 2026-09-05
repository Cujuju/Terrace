// The shallow-water fish: the FIRST species drawn from a Blender-built asset.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass). The body used to be built here out of a swept hull and
// extruded fins (../whaleHull.ts, ./bodyKit.ts). It is now
// ../assets/fish.glb, authored by tools/blender/build_fish.py and loaded
// through ./assetSpecies.ts. Those two helpers are NOT orphaned — grazer,
// ibex, bison, ray, shark, eel and angelfish all still build on them, and the
// whale bodies build on whaleHull too.
//
// WHAT DID NOT CHANGE, and must not:
//   * FISH_ENVELOPE. It is the placement contract (../placement.ts's
//     SWIM_PROFILES.fish and BODY_COLUMNS.fish read it), so it stays DECLARED
//     here and the asset is asserted against it at install. A re-export that
//     moved the dorsal is a load error naming the file, never a fish that
//     quietly needs deeper water.
//   * The animation. Same rate, same swing, same counter-yaw fraction, same
//     pectoral flutter and lag — the asset supplies joints, never motion.
//   * The colours. 0xe8a13c body, 0xf3c46e fins, near-black eyes: the owner
//     reads a species by its colour, and build_fish.py paints the same three.
//
// THE MOTION, unchanged from the procedural body and worth restating because
// it is the thing an asset could silently break: a fish YAWS. The tail sweeps
// side to side about a hinge AT THE PEDUNCLE (never about the fin's own
// centre, which reads as a propeller), the head swings a little the other way,
// and nothing here touches pitch (Z) at all.
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

/**
 * Tail beat, and how far the tail swings either side of the body line. 3.2 Hz
 * is the rate the fish has always beaten at and the eye is used to it; 0.45 rad
 * (~26°) is a cruising sweep rather than a burst — the caudal fin's own tip
 * travels ~0.07 either way at that angle, about a body width, which is what a
 * small fish's tail does at cruise.
 */
export const FISH_TAIL_HZ = 3.2;
export const FISH_TAIL_SWING_RADIANS = 0.45;
/**
 * The head's counter-yaw as a fraction of the tail's swing, OPPOSITE in sign.
 * A fish's body is a lever about its centre of mass: the tail goes one way and
 * the nose a little the other. Small, because the head is the stiff half.
 */
const BODY_COUNTER_YAW_FRACTION = 0.18;
/**
 * How far the pectorals angle down from the flank at rest.
 *
 * IT LIVES HERE, NOT IN THE ASSET. The hinge Empties in fish.glb are authored
 * at rest identity and `animate` assigns their rotation outright, so a rest
 * pose baked into the file would be overwritten on the first frame and the
 * fish would snap. What IS baked into the file is the fin's swept OUTLINE,
 * which is rigid and therefore cannot swing the root out of the flank.
 */
const PECTORAL_DIHEDRAL_RADIANS = 0.55;
/** Pectoral flutter: a slower, smaller beat that lags the tail. */
const PECTORAL_FLUTTER_RADIANS = 0.14;
const PECTORAL_LAG_RADIANS = 0.9;

/**
 * The nose and caudal tip, in world units at model scale 1 — the two stations
 * the asset's `nose` and `tail_tip` anchors sit at, and the only place the
 * fish's length is written down.
 */
const FISH_NOSE_X = 0.30;
const FISH_TAIL_TIP_X = -0.42;
const FISH_LENGTH = FISH_NOSE_X - FISH_TAIL_TIP_X;

/**
 * What this fish measures, in world units at model scale 1 — the numbers
 * placement.ts fits the fish into its water column with. Read them; do not
 * restate them there, and do not derive them from the asset: they are the
 * contract the asset is CHECKED against (./assetSpecies.ts).
 */
export const FISH_ENVELOPE = {
  /** Nose tip to caudal tip. */
  length: FISH_LENGTH,
  halfLength: FISH_LENGTH / 2,
  /**
   * The BODY's widest half-width, at the shoulder. The pectorals reach about
   * 0.137 at rest; the swim column is fitted to the body, as it always was.
   */
  halfWidth: 0.08,
  /** Top of the dorsal fin above the origin. */
  crownY: 0.17,
  /** Bottom of the anal fin below the origin. */
  bellyY: -0.17,
} as const;

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (../index.ts); Node feeds the same install from disk.
 */
export const FISH_ASSET: SpeciesAssetSpec = {
  species: 'fish',
  file: 'fish.glb',
  joints: SWIMMER_JOINTS,
  envelope: FISH_ENVELOPE,
};

export const buildFish = assetSpeciesBuilder(FISH_ASSET, (joints, seconds, phase) => {
  const beat = seconds * FISH_TAIL_HZ * TWO_PI + phase;
  const swing = Math.sin(beat);
  // Side to side about the peduncle. Nothing here touches pitch (Z).
  joints.tail!.rotation.y = swing * FISH_TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * FISH_TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
  const flutter = Math.sin(beat - PECTORAL_LAG_RADIANS) * PECTORAL_FLUTTER_RADIANS;
  // Opposite signs, because the two fins sit on opposite sides of the body: a
  // roll about +X that drops one fin lifts the other. Port is -Z (see
  // SWIMMER_JOINTS), which is why it takes the negative half.
  joints.pectoral_starboard!.rotation.x = PECTORAL_DIHEDRAL_RADIANS + flutter;
  joints.pectoral_port!.rotation.x = -PECTORAL_DIHEDRAL_RADIANS - flutter;
});
