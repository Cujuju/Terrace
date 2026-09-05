// The grazer: a real deer, imported.
//
// WHAT IT REPLACES, AND WHY (owner, 2026-09-04: every plugin may use textures
// and external model assets; the game must be able to import real, attractive
// third-party models). Until now this file AUTHORED the animal — a swept hull,
// a tapered neck, an ellipsoid head with a muzzle and ears, four tapered legs —
// which was already the second attempt at a grazer (2026-09-02, "substantially
// improve the model's fidelity"). It is now a CC0 Quaternius deer, normalised
// by tools/blender/import_model.py and shipped as assets/grazer-deer.glb; see
// ../assets/LICENSES.md for the source, the licence and the exact import
// command that produced the file.
//
// WHAT DID NOT CHANGE. The walk. ./quadruped.ts's poseWalk still swings four
// named leg joints in diagonal pairs and bobs the body twice a stride, at the
// same rate and the same swing as before, and the head still nods on each
// footfall pair. The asset's bones were RENAMED AT IMPORT to the names that
// animation already speaks (--rename FrontUpperLeg.L=foreLeft and friends),
// rather than mapped to them here: a rename is recorded in the import command
// beside every other normalisation the file needed, while a runtime table
// would be a second place to look and a second place to be wrong. The bones'
// own ORIENTATION is bridged generically by ./assetSpecies.ts — see its header.
//
// SCALE. Nothing scales the rig any more. The old body was authored at a full
// figure and shrunk by GRAZER_SCALE on the rig node; an asset's size is set
// once, at import, by the --footprint/--height budget below, so the rig sits at
// scale 1 and the numbers this file states are the numbers the file measures.
//
// THE MODEL'S ANIMATION CLIPS ARE IGNORED. The source ships thirteen of them
// (Walk, Gallop, Idle, …) and the export carries none: this game poses a
// creature from poseWalk against rigid, one-bone-per-vertex skinning
// (client/src/render/rigSkin.ts), so a clip would have nothing to play into.
// Said here as well as in LICENSES.md so nobody goes hunting for them.

import { Box3, Vector3 } from 'three';
// Render kit, reached by path the same way ../models.ts reaches it.
import {
  ASSET_FIT_TOLERANCE_CELLS,
  assertAssetFits,
  type AssetFootprintCells,
  type RigAsset,
} from '../../../../client/src/render/rigAsset.ts';
import { poseWalk } from './quadruped.ts';
import { adoptKeepingTransform, modelAxisPivot, riggedAsset } from './assetSpecies.ts';
import { TWO_PI, type AssetSpeciesModelBuilder } from './speciesModel.ts';

/**
 * Owner, 2026-08-24: grazers read oversized beside settlers. It is no longer a
 * scale applied to anything — the asset arrives at its final size — but it is
 * still the factor the height budget below is derived through, so the decision
 * and the number it produced stay together.
 */
export const GRAZER_SCALE = 0.4;

/**
 * The height of the hand-built figure this asset replaced, before GRAZER_SCALE.
 * Kept because the budget is DERIVED from it rather than re-picked: the new
 * animal is deliberately the same height as the one players already know.
 */
const REPLACED_FIGURE_HEIGHT = 1.16;

/**
 * The height the imported model was fitted to, in world units.
 *
 * 0.464 — plainly under PILGRIM_HEIGHT (0.62, plugins/pilgrims/client/
 * models.ts:53), which is the owner's 2026-08-24 rule for grazers, and exactly
 * the height the previous grazer stood at so nothing else that was tuned
 * against it (flame columns, ground probes, the size classes) has to move.
 */
const GRAZER_HEIGHT_WORLD_UNITS = REPLACED_FIGURE_HEIGHT * GRAZER_SCALE;

/**
 * The nose-to-tail length of the same replaced figure, in world units: the
 * ground budget the import was given. It is a BUDGET, not a target — the
 * importer scales uniformly and takes the binding axis, which for a deer
 * standing with its head up is the height, so the animal comes out shorter
 * than this (see GRAZER_ENVELOPE.length, which is what it actually measures).
 */
const REPLACED_FIGURE_LENGTH_WORLD_UNITS = (0.95 + 0.6) * GRAZER_SCALE;

/**
 * The ground square and the height the imported model must fit inside.
 *
 * IN WORLD UNITS, not cells, despite `AssetFootprintCells` — the type compares
 * a Box3 against three numbers and the caller chooses their unit. Every model
 * dimension in this plugin is world units (../placement.ts converts to cells at
 * one boundary, cellsAcross), and mixing the two here is the exact bug that
 * header records.
 *
 * The ground budget is SQUARE at the body's length because a creature yaws to
 * its heading: a footprint that fitted only along X would overrun it broadside.
 */
export const GRAZER_ASSET_FOOTPRINT: AssetFootprintCells = {
  x: REPLACED_FIGURE_LENGTH_WORLD_UNITS,
  z: REPLACED_FIGURE_LENGTH_WORLD_UNITS,
  y: GRAZER_HEIGHT_WORLD_UNITS,
};

/**
 * What the imported body MEASURES in world units at model scale 1.
 *
 * DECLARED HERE AND RE-MEASURED AT LOAD, not read off the asset: ../placement.ts
 * builds its per-species tables at module evaluation, long before any file has
 * been fetched, so these numbers have to exist without one. They are not
 * guesses — each was measured off assets/grazer-deer.glb with Box3 (the same
 * measure tools/blender/stat_glb.py prints) — and `assertGrazerAsset` measures
 * the loaded file against every one of them at preload, so an asset re-imported
 * at a different size fails at boot instead of quietly mis-seating flames and
 * ground probes.
 */
export const GRAZER_ENVELOPE = {
  /** Nose to rump: the model's full X extent. */
  length: 0.505,
  /**
   * Half the ground the FEET stand within, about the origin — the half-extent
   * ../placement.ts probes terrain over. Measured as the X reach of the four
   * leg joints' subtrees plus the hooves (IK_TARGET_BONES), which on this deer
   * is the whole body length: its hind legs sweep back to the rearmost point of
   * the animal.
   */
  bodyHalfLength: 0.2525,
  /** Hooves to the tips of the ears. */
  height: GRAZER_HEIGHT_WORLD_UNITS,
} as const;

/** The model's full Z extent, measured the same way. Nothing places by it; it is
 * here because the fit check has three axes and a silent one is a gap. */
const GRAZER_WIDTH_WORLD_UNITS = 0.175;

/**
 * The joints ./quadruped.ts's poseWalk drives, by the names the import gave the
 * asset's bones. Exported because plugins/wildlife/test/assetSpecies.test.ts
 * asserts every one of them survives the bake.
 *
 * WHICH PHYSICAL SIDE IS "LEFT" IS INVISIBLE and deliberately not chased: the
 * gait only needs the two DIAGONAL pairs (fore-left with hind-right), and the
 * asset's .L bones are consistently one side, so the pairing is right whichever
 * side that is. Mirroring the names would change nothing on screen.
 */
export const GRAZER_LEG_JOINT_NAMES = ['foreLeft', 'foreRight', 'hindLeft', 'hindRight'] as const;
/** The head hinge, nodded on each footfall pair. */
export const GRAZER_HEAD_JOINT_NAME = 'head';

/**
 * The source rig's IK TARGETS, and the leg each one's geometry belongs under.
 *
 * Quaternius' animal rigs drive the legs through IK, and the target bones sit
 * at the ARMATURE ROOT rather than inside the limb chain — so after
 * --rigidify's dominant-weight split (which is honest about where the weights
 * were) each of these carries a hoof and a fetlock, ~170 vertices apiece, on a
 * node no animation reaches. Left alone the deer walks out of its own feet: the
 * legs swing and four hoof stubs stay standing on the ground (observed
 * 2026-09-04). Each is adopted by the leg it belongs to before anything is
 * posed; its children (FF.L, FFB.L and friends) come with it.
 *
 * A FACT ABOUT THE SOURCE FILE, so it lives beside the source file's other
 * facts — the bone names, the axis, the drop — and not in the shared adapter.
 *
 * THE NAMES HAVE NO DOTS, and that is not a typo. The bones are `IKFrontLeg.L`
 * in Blender and in the .glb; three's GLTFLoader sanitises node names on the
 * way in (PropertyBinding.sanitizeNodeName strips the characters its animation
 * paths use, `.` among them), so what `asset.node` can be asked for is
 * `IKFrontLegL`. The joints above dodge this only because the --rename gave
 * them dot-free names in the first place.
 */
const IK_TARGET_BONES: ReadonlyArray<{ readonly bone: string; readonly leg: string }> = [
  { bone: 'IKFrontLegL', leg: 'foreLeft' },
  { bone: 'IKFrontLegR', leg: 'foreRight' },
  { bone: 'IKBackLegL', leg: 'hindLeft' },
  { bone: 'IKBackLegR', leg: 'hindRight' },
];

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

/**
 * Every dimension the rest of the plugin was told this animal has, checked
 * against the file that arrived.
 *
 * WHY BOTH DIRECTIONS. `assertAssetFits` answers "does it overrun its budget",
 * which is the question the ground and the height rule ask. It cannot catch an
 * envelope that is too GENEROUS, and a generous envelope is just as wrong in
 * the other direction: BODY_COLUMNS would hang a flame in the air above the
 * animal and the ground probe would sample cells it never stands on. So the
 * measured box is compared to GRAZER_ENVELOPE for equality, inside the render
 * kit's own float-dust tolerance.
 *
 * Called from ../index.ts's preload (and the preview harnesses), before
 * anything bakes: a wrong asset must fail where the failure names the asset.
 */
export function assertGrazerAsset(asset: RigAsset): void {
  try {
    assertAssetFits(asset, GRAZER_ASSET_FOOTPRINT);
  } catch (cause) {
    // Rethrown for the MEANING, not the measurement: the shared error already
    // names the axis and the number. What it cannot say is that a grazer over
    // this height stops reading as smaller than a settler.
    throw new Error(
      'grazer asset: the imported deer breaks the footprint it was imported for — ' +
        'a grazer must stay plainly under PILGRIM_HEIGHT (owner, 2026-08-24)',
      { cause },
    );
  }

  asset.scene.updateMatrixWorld(true);
  const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
  // The legs AND the hooves the source hung off IK targets: together they are
  // the parts that touch the ground, which is what bodyHalfLength claims to be.
  const legs = new Box3();
  for (const name of GRAZER_LEG_JOINT_NAMES) {
    legs.union(new Box3().setFromObject(asset.node(name)));
  }
  for (const { bone } of IK_TARGET_BONES) {
    legs.union(new Box3().setFromObject(asset.node(bone)));
  }
  const measuredHalfLength = Math.max(Math.abs(legs.min.x), Math.abs(legs.max.x));

  const mismatches: string[] = [];
  const check = (axis: string, measured: number, declared: number): void => {
    if (Math.abs(measured - declared) > ASSET_FIT_TOLERANCE_CELLS) {
      mismatches.push(`${axis} ${measured.toFixed(4)} != ${String(declared)}`);
    }
  };
  check('length', size.x, GRAZER_ENVELOPE.length);
  check('height', size.y, GRAZER_ENVELOPE.height);
  check('width', size.z, GRAZER_WIDTH_WORLD_UNITS);
  check('bodyHalfLength', measuredHalfLength, GRAZER_ENVELOPE.bodyHalfLength);
  if (mismatches.length > 0) {
    throw new Error(
      `grazer asset: it no longer measures what GRAZER_ENVELOPE says ` +
        `(${mismatches.join('; ')}, tolerance ${String(ASSET_FIT_TOLERANCE_CELLS)}) — ` +
        're-measure the envelope in species/grazer.ts against the new import',
    );
  }
}

export const buildGrazer: AssetSpeciesModelBuilder = (asset) => {
  const { root, rig } = riggedAsset(asset);
  // Each named bone gets an identity-oriented pivot on the rig, so poseWalk's
  // `rotation.z` is fore-and-aft on this deer exactly as it was on the tree
  // this file used to build — and so an Euler assignment has no rest rotation
  // to destroy. See ./assetSpecies.ts for both halves of that.
  const joints: Record<string, ReturnType<typeof modelAxisPivot>> = {};
  for (const name of GRAZER_LEG_JOINT_NAMES) joints[name] = modelAxisPivot(asset.node(name), rig);
  joints[GRAZER_HEAD_JOINT_NAME] = modelAxisPivot(asset.node(GRAZER_HEAD_JOINT_NAME), rig);
  // The hooves, which the source hung off IK targets outside the skeleton.
  for (const { bone, leg } of IK_TARGET_BONES) {
    adoptKeepingTransform(asset.node(bone), joints[leg]!);
  }

  return {
    root,
    joints: { rig, ...joints },
    animate(posed, seconds, phase) {
      const beat = seconds * STRIDE_HZ * TWO_PI + phase;
      poseWalk(posed, beat, LEG_SWING_RADIANS, WALK_BOB_WORLD_UNITS);
      posed[GRAZER_HEAD_JOINT_NAME]!.rotation.z = Math.sin(beat * 2) * HEAD_NOD_RADIANS;
    },
  };
};
