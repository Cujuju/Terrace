// The three places a LOADED model file does not fit the species contract, and
// the one helper each that bridges them.
//
// WHY THIS IS A FILE AND NOT A PARAGRAPH IN grazer.ts. Neither mismatch is
// about deer: both are true of ANY model that came out of
// tools/blender/import_model.py --rigidify, so the second asset-sourced species
// would otherwise copy them — and a copied bridge is a bridge that drifts.
// ./speciesModel.ts's AssetSpeciesModelBuilder is the contract; this is the
// only code that has to know how an imported file differs from a hand-built
// tree.
//
// 1. AN IMPORTED FILE HAS NO `rig` NODE. `SpeciesModelPool.rigged()` hands a
//    species a root/rig pair, and every animation in this directory moves `rig`
//    for the whole-body terms (the walk bob, the counter-sway, the body roll) —
//    a file's scene is one node with the model under it and nothing spare.
//    `riggedAsset` WRAPS rather than requiring the import to name a top node
//    `rig`: import_model.py stays generic (it normalises models for the whole
//    game, not for this plugin's animation vocabulary), the wrap is two
//    identity Groups whose cost is two bone matrices, and a downloaded model
//    whose author happened to call something "rig" cannot collide with it.
//
// 2. A BONE-DERIVED PIVOT IS NOT A HINGE THIS PLUGIN'S ANIMATIONS CAN DRIVE.
//    --rigidify puts an Empty at each bone's head carrying the BONE's rest
//    rotation (tools/blender/import_model.py, build_joint_empties), because
//    that is the only orientation the source actually states. Two things break
//    on that, and one helper fixes both:
//
//      * WRONG AXES. Every animation here drives MODEL axes — ./quadruped.ts's
//        poseWalk swings a leg with `rotation.z` because a model faces +X, so Z
//        is fore-and-aft — and a deer's femur points down and back, so
//        `rotation.z` on its Empty twists the leg sideways.
//      * A REST ROTATION THE ANIMATION DESTROYS. `joint.rotation.z = swing` is
//        an assignment to an EULER, and three rebuilds the whole quaternion
//        from it: x and y come back as zero and any rest rotation the node had
//        is gone. Every hand-built hinge in this directory rests at the
//        identity, so that has always been harmless; a bone's Empty does not,
//        and the model comes apart on the first posed frame (observed
//        2026-09-04 — the deer's legs lay flat and its hooves scattered).
//
//    `modelAxisPivot` therefore hangs a NEW, identity-oriented Group off the
//    species' `rig` at the joint's world position and re-homes the bone under
//    it. The pivot is what the animation drives: its rest transform is a pure
//    translation, so an Euler assignment has nothing to destroy, and its axes
//    are the model's. The limb keeps its own shape because the bone's rotation
//    moves down into the bone, which nothing addresses by name.
//
//    WHAT THIS GIVES UP, stated because it is a real constraint and not an
//    oversight: a driven joint no longer inherits from the bones ABOVE it, only
//    from `rig`. For the walkers here that changes nothing — the torso and neck
//    bones between the rig and a leg never move — but an animation that wanted
//    to swing a shoulder AND the leg under it would have to pivot both and
//    accept that the second does not follow the first.
//
// 3. GEOMETRY CAN HANG OFF A BONE THAT IS NOT IN THE SKELETON. See
//    `adoptKeepingTransform`.
//
// No helper here allocates a geometry, a material or a texture: everything
// drawn still belongs to the RigAsset, which frees it (../models.ts disposes
// the assets last, after every blueprint baked from them).

import { Group, Matrix4, type Object3D } from 'three';
// Render kit, reached by path the same way ../models.ts reaches it.
import type { RigAsset } from '../../../../client/src/render/rigAsset.ts';

/**
 * The root/rig pair an asset-sourced species starts from: root → rig → scene.
 *
 * `root` is unparented and at the identity, which is `bakeRig`'s contract for
 * an authored root, and `rig` is the whole-body handle the animation moves.
 * The asset's scene is re-parented under `rig` — it is consumed as data by the
 * bake and never drawn from this tree, so moving it costs nothing and leaves
 * the loader's own "identity, unparented" guarantee intact for the wrap.
 */
export function riggedAsset(asset: RigAsset): { root: Group; rig: Group } {
  const root = new Group();
  const rig = new Group();
  root.add(rig);
  rig.add(asset.scene);
  return { root, rig };
}

/** Scratch for the one decompose per re-home. Never escapes this module. */
const scratchMatrix = new Matrix4();

/**
 * Re-homes `node` under `host` without moving it: its transform is re-expressed
 * in the host's frame, so the model looks identical and only the tree changed.
 *
 * WHAT IT IS FOR. A source rig can hang geometry off a bone that is not part of
 * the skeleton at all — Quaternius' animal rigs put their IK targets at the
 * SCENE ROOT, and --rigidify's dominant-weight split honestly hands each such
 * bone the faces that weighed most on it (the hooves). Rigid binding then nails
 * those faces to a node no animation reaches, and the creature walks out of its
 * own feet. Moving them under the limb they belong to is the fix, and it is a
 * fact about the source file, so the species file states it.
 */
export function adoptKeepingTransform(node: Object3D, host: Object3D): void {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  localiseInto(node, host);
  host.add(node);
}

/** `node`'s world transform, rewritten as a local transform in `host`'s frame. */
function localiseInto(node: Object3D, host: Object3D): void {
  scratchMatrix
    .copy(host.matrixWorld)
    .invert()
    .multiply(node.matrixWorld)
    .decompose(node.position, node.quaternion, node.scale);
}

/**
 * Hangs an identity-oriented pivot for `node` off `host`, and returns it.
 *
 * `host` is the species' `rig`: it is at the identity inside the authored root,
 * so a pivot placed in its space is placed in the model's own frame. The pivot
 * takes the node's position there and NOTHING else — no rotation, no scale —
 * and the node hangs under it carrying the rotation and scale the pivot did not
 * take, so the model does not move by a hair. See this file's header for why
 * the pivot has to be a pure translation.
 */
export function modelAxisPivot(node: Object3D, host: Object3D): Group {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  // The node's transform in the host's frame, taken from world matrices so it
  // does not matter how many bones sit between the two.
  localiseInto(node, host);

  const pivot = new Group();
  pivot.name = `${node.name}:modelAxis`;
  // The pivot takes the POSITION and nothing else; the node keeps the rotation
  // and scale, so the two together are exactly the transform just computed.
  pivot.position.copy(node.position);
  host.add(pivot);

  node.position.set(0, 0, 0);
  pivot.add(node);
  return pivot;
}
