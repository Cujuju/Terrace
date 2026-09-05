// The grazer: a real deer, imported.
//
// WHAT IT REPLACES, AND WHY (owner, 2026-09-04: every plugin may use textures
// and external model assets; the game must be able to import real, attractive
// third-party models). Until now this file AUTHORED the animal — a swept hull,
// a tapered neck, an ellipsoid head with a muzzle and ears, four tapered legs —
// which was already the second attempt at a grazer (2026-09-02, "substantially
// improve the model's fidelity"). It is now a CC0 Quaternius deer, normalised
// by tools/blender/import_model.py and shipped as ../assets/grazer-deer.glb;
// see ../assets/LICENSES.md for the source, the licence and the exact import
// command that produced the file.
//
// IT IS THE FIRST *DOWNLOADED* ASSET SPECIES, where the fish (./fish.ts) is the
// first BUILT one. Same contract, same ./assetSpecies.ts install and builder,
// same declared-envelope assertion. The one difference is that its skeleton was
// drawn by somebody else and converted by `--rigidify`, which is what
// `SpeciesAssetSpec.rigidified` and `.adopt` below are for — read those two
// fields and assetSpecies.ts's `modelAxisPivot` before changing anything here.
//
// WHAT DID NOT CHANGE. The walk. ./quadruped.ts's poseWalk still swings four
// named leg joints in diagonal pairs and bobs the body twice a stride, at the
// same rate and the same swing as before, and the head still nods on each
// footfall pair. The asset's bones were RENAMED AT IMPORT to the names that
// animation already speaks (--rename FrontUpperLeg.L=foreLeft and friends),
// rather than mapped to them here: a rename is recorded in the import command
// beside every other normalisation the file needed, while a runtime table
// would be a second place to look and a second place to be wrong.
//
// SCALE. Nothing scales the rig any more. The old body was authored at a full
// figure and shrunk by GRAZER_SCALE on the rig node; an asset's size is set
// once, at import, so the rig sits at scale 1 and the numbers this file states
// are the numbers the file measures.
//
// THE MODEL'S ANIMATION CLIPS ARE IGNORED. The source ships thirteen of them
// (Walk, Gallop, Idle, …) and the export carries none: this game poses a
// creature from poseWalk against rigid, one-bone-per-vertex skinning
// (client/src/render/rigSkin.ts), so a clip would have nothing to play into.
// Said here as well as in LICENSES.md so nobody goes hunting for them.

import { poseWalk } from './quadruped.ts';
import {
  assetSpeciesBuilder,
  type SpeciesAssetSpec,
  type SpeciesEnvelope,
} from './assetSpecies.ts';
import { TWO_PI } from './speciesModel.ts';

/**
 * Owner, 2026-08-24: grazers read oversized beside settlers. It is no longer a
 * scale applied to anything — the asset arrives at its final size — but it is
 * still the factor the height below is derived through, so the decision and the
 * number it produced stay together.
 */
export const GRAZER_SCALE = 0.4;

/**
 * The height of the hand-built figure this asset replaced, before GRAZER_SCALE.
 * Kept because the height is DERIVED from it rather than re-picked: the new
 * animal is deliberately the same height as the one players already know.
 */
const REPLACED_FIGURE_HEIGHT = 1.16;

/**
 * How tall the imported model stands, in world units.
 *
 * 0.464 — plainly under PILGRIM_HEIGHT (0.62, plugins/pilgrims/client/
 * models.ts:53), which is the owner's 2026-08-24 rule for grazers, and exactly
 * the height the previous grazer stood at, so nothing tuned against it (flame
 * columns, ground probes, the size classes) has to move. It is also the number
 * the import was fitted to: `--height 0.464` was the binding axis, so the file
 * measures it exactly rather than approximately.
 */
const GRAZER_HEIGHT_WORLD_UNITS = REPLACED_FIGURE_HEIGHT * GRAZER_SCALE;

/**
 * What this deer measures, in world units at model scale 1 — declared here and
 * asserted against the file at install (./assetSpecies.ts).
 *
 * A WALKER READS THIS TABLE DIFFERENTLY FROM A SWIMMER, and the difference is
 * the origin. A fish is authored about its body centre, so its crown and belly
 * straddle zero; a walker is authored at its FEET, so `bellyY` is zero and
 * `crownY` IS the standing height. ../placement.ts already knows this — its
 * BODY_COLUMNS row for a walker is `{ bellyY: 0, crownY: height }` — so the
 * same five numbers serve both families with no new field.
 *
 * MEASURED WITH Box3, the same measure ./assetSpecies.ts checks them with and
 * the same one tools/blender/stat_glb.py prints. On a converted asset that box
 * is the union of each part's own axis-aligned box transformed into place, so
 * it sits a little outside the vertex hull for anything rotated — up to ~0.04
 * behind the rearmost vertex here. That is the conservative number, and
 * conservative is the right direction for a ground probe.
 */
const GRAZER_ASSET_ENVELOPE: SpeciesEnvelope = {
  /** Nose to the rearmost point of the rump and hind legs. */
  length: 0.505,
  halfLength: 0.2525,
  /**
   * Half the model's width. On a deer with its head up the widest points are
   * the EAR TIPS, not the ribs, which is where the `flank` anchor sits — the
   * number is the model's half-width, and nothing places by it (a walker is
   * placed by its footprint and its height).
   */
  halfWidth: 0.0875,
  /** The ear tips. A walker's origin is at its feet, so this is its height. */
  crownY: GRAZER_HEIGHT_WORLD_UNITS,
  /** The hooves, which are the origin. */
  bellyY: 0,
};

/**
 * The same shape ../placement.ts asks a walker for, derived — never restated —
 * from the envelope the asset is checked against, so the two cannot drift.
 */
export const GRAZER_ENVELOPE = {
  /** Nose to tail tip. */
  length: GRAZER_ASSET_ENVELOPE.length,
  /**
   * Half the ground the FEET stand within, the half-extent placement.ts probes
   * terrain over. It equals `halfLength` on this deer and that is measured, not
   * assumed: the four leg joints' own subtrees (hooves included) reach x
   * -0.2525 to 0.1214, so the legs set the model's own rearmost extent.
   */
  bodyHalfLength: GRAZER_ASSET_ENVELOPE.halfLength,
  height: GRAZER_ASSET_ENVELOPE.crownY,
} as const;

/**
 * The joints poseWalk drives, by the names the import gave the asset's bones.
 * `rig` is not in the file — assetSpecies.ts synthesises it for a rigidified
 * import; see `SpeciesAssetSpec.rigidified`.
 *
 * WHICH PHYSICAL SIDE IS "LEFT" IS INVISIBLE and deliberately not chased: the
 * gait only needs the two DIAGONAL pairs (fore-left with hind-right), and the
 * asset's .L bones are consistently one side, so the pairing is right whichever
 * side that is. Mirroring the names would change nothing on screen.
 */
const GRAZER_JOINTS = ['rig', 'foreLeft', 'foreRight', 'hindLeft', 'hindRight', 'head'];

/**
 * The source rig's IK TARGETS, and the leg each one's geometry belongs under.
 *
 * Quaternius' animal rigs drive the legs through IK, and the target bones sit
 * at the ARMATURE ROOT rather than inside the limb chain — so after
 * --rigidify's dominant-weight split (which is honest about where the weights
 * were) each of these carries a hoof and a fetlock, ~170 vertices apiece, on a
 * node no animation reaches. Left alone the deer walks out of its own feet: the
 * legs swing and four hoof stubs stay standing on the ground (observed
 * 2026-09-04). Each is adopted by the leg it belongs to at install; its
 * children (FFL, FFBL and friends) come with it.
 *
 * THE NAMES HAVE NO DOTS, and that is not a typo. The bones are `IKFrontLeg.L`
 * in Blender and in the .glb; three's GLTFLoader sanitises node names on the
 * way in (PropertyBinding.sanitizeNodeName strips the characters its animation
 * paths use, `.` among them), so what `asset.node` can be asked for is
 * `IKFrontLegL`. The joints above dodge this only because the --rename gave
 * them dot-free names in the first place.
 */
const GRAZER_ADOPTIONS = [
  { node: 'IKFrontLegL', under: 'foreLeft' },
  { node: 'IKFrontLegR', under: 'foreRight' },
  { node: 'IKBackLegL', under: 'hindLeft' },
  { node: 'IKBackLegR', under: 'hindRight' },
];

/**
 * The asset this species is drawn from. The plugin's preload installs it
 * (../index.ts); Node feeds the same install from disk.
 */
export const GRAZER_ASSET: SpeciesAssetSpec = {
  species: 'grazer',
  file: 'grazer-deer.glb',
  joints: GRAZER_JOINTS,
  envelope: GRAZER_ASSET_ENVELOPE,
  rigidified: true,
  adopt: GRAZER_ADOPTIONS,
};

/**
 * Stride rate and swing, unchanged from the hand-built grazer.
 *
 * A grazer walks at 0.8 world units per second (../../server/species.ts,
 * halved 2026-09-02) on a body 0.505 long; two strides a second covers that at
 * a stride of roughly a body length, which is a walk. 0.32 rad (~18°) either
 * side of vertical is a walking swing, not a trot.
 */
const STRIDE_HZ = 2.0;
const LEG_SWING_RADIANS = 0.32;
/** In WORLD units — rig.position is in root space, and the rig is unscaled. */
const WALK_BOB_WORLD_UNITS = 0.012;
/** The head dips a little at each footfall pair. */
const HEAD_NOD_RADIANS = 0.05;

export const buildGrazer = assetSpeciesBuilder(GRAZER_ASSET, (joints, seconds, phase) => {
  const beat = seconds * STRIDE_HZ * TWO_PI + phase;
  poseWalk(joints, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
  joints.head!.rotation.z = Math.sin(beat * 2) * HEAD_NOD_RADIANS;
});
