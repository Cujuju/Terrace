// The deep-sea anglerfish: the NINTH and last swimmer drawn from a
// Blender-built asset, and the only one with an UNLIT part.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish, shark, ray, eel, angelfish and the three whales
// went first, this file closes the list). The body used to be authored in
// ../models.ts in the spheres-and-cones idiom — an ellipsoid, a jaw cone, a
// stalk box and a lure sphere under a `lure` Group with an unlit
// MeshBasicMaterial — and animated there. It is now ../assets/deepsea.glb,
// authored by tools/blender/build_deepsea.py and loaded through
// ./assetSpecies.ts; models.ts herds it as an asset species like any in this
// directory. Nothing shared was touched: the pool's `unlit()` STAYS in
// models.ts because it is the SpeciesModelPool contract
// (./speciesModel.ts), implemented by client/src/previewSpecies.ts too.
//
// WHAT DID NOT CHANGE, and must not:
//   * crownY 0.35 and bellyY -0.35. They are the placement contract
//     (../placement.ts's BODY_COLUMNS.deepsea reads them; SWIM_PROFILES.deepsea
//     is HAND-SET against the 2026-08-14 seabed-clipping report and reads
//     nothing from here). The same two literals, moved from models.ts, so the
//     angler sits in the same water it always did. length / halfLength /
//     halfWidth are NEW fields — what the file measures, asserted at install
//     (./assetSpecies.ts) — and placement does not read them.
//   * The animation. Same 0.7 Hz sway, same 0.22 rad yaw of the whole body,
//     same 0.05 lure bob lagging the sway by one radian — the asset supplies
//     joints, never motion.
//   * The colours. 0x161c26 body (an abyssal silhouette), 0xa8fbff lure (the
//     one bright thing down there, UNLIT): the owner reads a species by its
//     colour, and build_deepsea.py paints the same two — plus one very dark
//     tooth-and-eye tone (0x3a4150).
//
// THE LURE IS UNLIT IN THE FILE. A second glTF material carrying
// KHR_materials_unlit, which three's GLTFLoader turns into a
// MeshBasicMaterial; client/src/render/rigSkin.ts's materialSignature keys
// on material.type, so the herd bakes to exactly TWO surfaces — the count
// ../index.ts asserts (TWO_SURFACE_SPECIES), as the procedural body did.
//
// ONE ENVELOPE, and what each extreme is (the species sheet's decision):
//   crown   the dorsal fin's tip, a BODY extreme at rest. NEVER the lure:
//           the bulb bobs +-DEEPSEA_LURE_BOB, so its top at rest sits at
//           0.29 and at the top of its bob at 0.34, under the crown
//           (build_deepsea.py asserts it). The old body let the lure
//           overshoot to 0.43 against a declared 0.35; this file honours
//           the declaration, as the eel did.
//   belly   the hull's throat plateau under the huge mouth. The jaw's
//           underside, the anal fin and the pectorals all stay above it
//           (asserted). The old jaw cone reached -0.42.
//   nose    the lower jaw's tip (x max); the bulb stays behind it.
//   tail_tip the caudal fan's rear vertex (x min).
//   flank   the hull's width plateau (halfWidth 0.275, the procedural
//           ellipsoid's own 0.55 across); the drooping pectorals reach
//           further and are the upper-bound case the install allows.
//
// THE LURE JOINT. `lure` is an Empty at the bulb's rest position, identity
// rotation, the bulb alone under it; the illicium (stalk) is body geometry
// whose tip ends at the bulb's CENTRE, and the bulb's radius (0.06) exceeds
// the bob (0.05), so the tip never leaves the bulb (build_deepsea.py proves
// it by parity at rest and at both extremes). `animate` drives the joint in
// POSITION about DEEPSEA_LURE_REST_Y — a named constant equal to the
// Empty's y in the file (plugins/wildlife/.verify-deepsea-asset.mts prints
// both), rather than a value read off the joint at first animate: the
// assignment is absolute, so the rest must be known before the first frame
// and must not depend on which frame ran first.
import { TWO_PI } from './speciesModel.ts';
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';

/**
 * Idle sway, in cycles per second: the slowest of the small swimmers — an
 * angler hangs in the water rather than swimming through it. Unchanged from
 * models.ts's DEEPSEA_SWAY_HZ.
 */
const DEEPSEA_SWAY_HZ = 0.7;
/** How far the whole body yaws either side of its heading, in radians. */
const DEEPSEA_SWAY_RADIANS = 0.22;
/** How far the lure bobs on its stalk, in world units. */
const DEEPSEA_LURE_BOB = 0.05;
/**
 * The lure lags the body by this phase, in radians — what sells it as
 * dangling from the stalk rather than bolted to the head.
 */
const DEEPSEA_LURE_LAG_RADIANS = 1;
/**
 * The `lure` joint's rest height: the y of the Empty in deepsea.glb
 * (build_deepsea.py LURE_REST). The bob is written about it.
 */
const DEEPSEA_LURE_REST_Y = 0.23;

/**
 * The jaw tip and the caudal fan's rear, in world units at model scale 1 —
 * the two stations the asset's `nose` and `tail_tip` anchors sit at, and the
 * only place the angler's length is written down. Half of it is 0.5, the
 * value SWIM_PROFILES.deepsea has always hand-set as its halfLength.
 */
const DEEPSEA_NOSE_X = 0.50;
const DEEPSEA_TAIL_TIP_X = -0.50;
const DEEPSEA_LENGTH = DEEPSEA_NOSE_X - DEEPSEA_TAIL_TIP_X;

/**
 * What this angler measures, in world units at model scale 1. crownY and
 * bellyY are the numbers placement.ts's BODY_COLUMNS.deepsea reads — moved
 * here from models.ts unchanged; the other three are the file's own and the
 * contract the asset is CHECKED against (./assetSpecies.ts).
 */
export const DEEPSEA_ENVELOPE = {
  /** Jaw tip to caudal tip. */
  length: DEEPSEA_LENGTH,
  halfLength: DEEPSEA_LENGTH / 2,
  /** The hull's widest half-width, on its width plateau. */
  halfWidth: 0.275,
  /** The dorsal fin's tip above the origin. */
  crownY: 0.35,
  /** The hull's throat below the origin. */
  bellyY: -0.35,
} as const;

/**
 * The joints `animate` drives: the whole body, and the lure bulb — a joint
 * driven in POSITION, the one such in this directory.
 */
export const DEEPSEA_JOINTS: readonly string[] = ['rig', 'lure'];

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk.
 */
export const DEEPSEA_ASSET: SpeciesAssetSpec = {
  species: 'deepsea',
  file: 'deepsea.glb',
  joints: DEEPSEA_JOINTS,
  envelope: DEEPSEA_ENVELOPE,
};

export const buildDeepsea = assetSpeciesBuilder(DEEPSEA_ASSET, (joints, seconds, phase) => {
  const beat = seconds * DEEPSEA_SWAY_HZ * TWO_PI + phase;
  joints.rig!.rotation.y = Math.sin(beat) * DEEPSEA_SWAY_RADIANS;
  joints.lure!.position.y = DEEPSEA_LURE_REST_Y + Math.sin(beat - DEEPSEA_LURE_LAG_RADIANS) * DEEPSEA_LURE_BOB;
});
