// The shark: the hunter, and the SECOND species drawn from a Blender-built asset.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; the fish went first, this file follows fish.ts). The body
// used to be built here out of a swept hull and extruded fins (../whaleHull.ts,
// ./bodyKit.ts). It is now ../assets/shark.glb, authored by
// tools/blender/build_shark.py and loaded through ./assetSpecies.ts. Those two
// helpers are NOT orphaned — ibex and bison still build on both, the whale
// bodies on whaleHull, and quadruped.ts on bodyKit.
//
// WHAT DID NOT CHANGE, and must not:
//   * SHARK_ENVELOPE. It is the placement contract (../placement.ts's
//     SWIM_PROFILES.shark and BODY_COLUMNS.shark read it), so it stays DECLARED
//     here and the asset is asserted against it at install. A re-export that
//     moved the first dorsal is a load error naming the file, never a shark
//     that quietly needs deeper water. The five values are the procedural
//     shark's, now written as the explicit stations they always encoded.
//   * The animation. Same rate, same swing, same counter-yaw fraction, and
//     the same NOTHING on the pectorals — the asset supplies joints, never
//     motion.
//   * The colours. 0x6b7886 body, 0x5a6674 fins, 0x0f1114 eyes: the owner
//     reads a species by its colour, and build_shark.py paints the same three
//     (plus a darker line for the gill slits and mouth).
//
// THE ANHEDRAL IS IN THE MESH — the one place this file departs from fish.ts,
// and the rule it establishes (docs/model-assets.md, "Wildlife species"). The
// fish authors its pectorals flat and sets their rest dihedral in `animate`,
// because it flutters them. The shark's placement contract makes its ANGLED
// pectoral tip BOTH the envelope's bellyY (-0.26) and its halfWidth (0.42), and
// installSpeciesAsset measures the file AT REST, before any `animate` runs. A
// flat-authored pectoral would leave the file's y-min at the pelvics and the
// install would throw. So: any part that is an envelope extreme is authored in
// its rest pose in the file. The shark's pectoral hinges are still there
// (SWIMMER_JOINTS names them, and the install resolves them), at identity, with
// the anhedral baked into the blade beneath each — and `animate` leaves them
// alone, exactly as the procedural shark did.
//
// THE MOTION, unchanged from the procedural body: the tail sweeps side to side
// about a hinge AT THE PEDUNCLE (fish.ts says why that is a yaw about a hinge
// and nothing else), slower and wider than the fish's — a big animal's cruise
// — and the body counter-yaws more, because a shark swims with more of its
// length than a small fish does. Nothing here touches pitch (Z).
import { TWO_PI } from './speciesModel.ts';
import {
  SWIMMER_JOINTS,
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
} from './assetSpecies.ts';

/**
 * Tail beat: slower and wider than the fish's 3.2 Hz / 0.45 rad — a cruise,
 * not a dart. 1.1 Hz on a 1.72-unit animal; 0.30 rad puts the upper lobe's tip
 * ~0.1 either side of the body line.
 */
const TAIL_HZ = 1.1;
const TAIL_SWING_RADIANS = 0.30;
/** Counter-yaw of the head, as a fraction of the tail's swing (opposite sign). */
const BODY_COUNTER_YAW_FRACTION = 0.28;

/**
 * The snout and the upper caudal lobe's tip, in world units at model scale 1 —
 * the two stations the asset's `nose` and `tail_tip` anchors sit at, and the
 * only place the shark's length is written down. The procedural shark wrote
 * the tail tip as hull half-length 0.70 + peduncle 0.68 + upper-lobe reach
 * 0.34 = 1.02 behind the origin; this is that sum.
 */
const SHARK_NOSE_X = 0.70;
const SHARK_TAIL_TIP_X = -1.02;
const SHARK_LENGTH = SHARK_NOSE_X - SHARK_TAIL_TIP_X;

/**
 * What this shark measures, in world units at model scale 1 — the numbers
 * placement.ts fits the shark into its water column with. Read them; do not
 * restate them there, and do not derive them from the asset: they are the
 * contract the asset is CHECKED against (./assetSpecies.ts).
 */
export const SHARK_ENVELOPE = {
  /** Snout to the upper caudal lobe's tip. */
  length: SHARK_LENGTH,
  halfLength: SHARK_LENGTH / 2,
  /**
   * To a PECTORAL TIP, swept and angled down as it sits in the file — not the
   * body, which is 0.13 wide. placement.ts fits the swim column to the fins.
   */
  halfWidth: 0.42,
  /** Top of the first dorsal above the origin. */
  crownY: 0.40,
  /** Bottom of a pectoral tip below the origin — the same angled tip. */
  bellyY: -0.26,
} as const;

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk.
 */
export const SHARK_ASSET: SpeciesAssetSpec = {
  species: 'shark',
  file: 'shark.glb',
  joints: SWIMMER_JOINTS,
  envelope: SHARK_ENVELOPE,
};

export const buildShark = assetSpeciesBuilder(SHARK_ASSET, (joints, seconds, phase) => {
  const swing = Math.sin(seconds * TAIL_HZ * TWO_PI + phase);
  // Side to side about the peduncle; the head a little the other way. The
  // pectoral hinges are deliberately untouched: their rest pose is the file's.
  joints.tail!.rotation.y = swing * TAIL_SWING_RADIANS;
  joints.rig!.rotation.y = -swing * TAIL_SWING_RADIANS * BODY_COUNTER_YAW_FRACTION;
});
