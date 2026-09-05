// The ASSET-SOURCED species path: a Blender-built .glb standing in for a
// procedural ./<species>.ts body, against the same SpeciesModelBuilder contract
// the hand-authored files answer.
//
// WHY THIS EXISTS (owner, 2026-09-04). Every fish and whale in this plugin
// becomes a Blender asset, one species per pass. The species files are not
// going away — an asset supplies a BODY, and a body is only half of what
// ./speciesModel.ts calls a species. So the split this module fixes is:
//
//   the ASSET supplies  the part tree and the joints, addressed BY NAME;
//   the .ts supplies    the envelope it claims to measure, the joint names it
//                       drives, and `animate`.
//
// TWO KINDS OF FILE COME THROUGH HERE, and only one of them was foreseen. A
// BUILT asset (fish.glb, tools/blender/build_fish.py) is authored straight to
// the convention: it carries a `rig` Empty, its pivots rest at the identity,
// and nothing below has to touch it. A DOWNLOADED one (grazer-deer.glb, a CC0
// Quaternius deer) is somebody else's armature put through
// `import_model.py --rigidify`, and a converted armature is not yet a set of
// hinges these animations can drive. `SpeciesAssetSpec.rigidified` says which
// kind a species is, and `prepareRigidified` is the whole of the difference —
// applied ONCE, at install, never per bake.
//
// Nothing else moves. `models.ts`'s bakeSpecies / herdFor / drawInto never
// learn that a species came from a file: `assetSpeciesBuilder` returns the same
// `AuthoredSpecies` shape a hand-authored `buildIbex` does, and `speciesDrawable`
// (../models.ts) bakes and herds it identically.
//
// WHY THE ENVELOPE IS ASSERTED RATHER THAN READ. placement.ts fits a swimmer
// into its water column from the species file's envelope constants
// (SWIM_PROFILES, BODY_COLUMNS), and those are a CONTRACT with the server's
// spawn rules, not a description that may drift. Taking them from whatever
// .glb happened to be installed would let a re-export silently move every
// fish in the world; asserting the file against them turns the same re-export
// into a load error naming the file. So the constants stay declared in the
// species .ts and the asset must MEASURE them.
//
// WHO OWNS WHAT, AND THE ORDER THINGS ARE FREED IN — the one thing a reader
// of this file most needs:
//
//   | thing                                   | owner            | freed by |
//   |-----------------------------------------|------------------|----------|
//   | the .glb's geometries/materials/textures| the RigAsset     | disposeSpeciesAssets() |
//   | the baked merged geometry + material    | the RigBlueprint | models.dispose() |
//   | anything from SpeciesModelPool          | nobody: an asset-sourced species allocates NONE |
//
// An asset-sourced builder never calls `pool.keepGeometry` or `pool.lambert`:
// the buffers it draws with came out of the file and the file frees them. And
// the blueprint MUST go first — bakeRig's surfaces sample the asset's own
// texture objects by reference (client/src/render/rigSkin.ts:472-500,
// `vertexColoured`), so freeing the asset while a blueprint lives pulls the
// texels out from under a drawn rig. Hence: ../index.ts disposes `models`
// (every blueprint) and only then calls disposeSpeciesAssets().

import { Box3, Group, Matrix4, type Object3D } from 'three';
import type { RigAsset } from '../../../../client/src/render/rigAsset.ts';
import type { AuthoredSpecies, SpeciesJoints, SpeciesModelBuilder } from './speciesModel.ts';

/**
 * The shape numbers a species file declares and placement.ts reads. Every
 * asset-sourced species asserts its .glb against exactly these.
 */
export interface SpeciesEnvelope {
  /** Nose tip to tail tip, in world units at model scale 1. */
  readonly length: number;
  /** Half of it — what placement.ts's swim profiles are written against. */
  readonly halfLength: number;
  /** The BODY's widest half-width. Fins may reach further; see `flank`. */
  readonly halfWidth: number;
  /** The highest point of the creature above its origin. */
  readonly crownY: number;
  /** The lowest point below it (negative). */
  readonly bellyY: number;
}

/** One species' asset: what file, what joints, what shape it must measure. */
export interface SpeciesAssetSpec {
  /**
   * The species key. One asset per key; installing twice replaces (and frees)
   * the previous one, which is what a plugin remount does.
   */
  readonly species: string;
  /** The file's name, used verbatim in every error this module throws. */
  readonly file: string;
  /**
   * Every node `animate` will address, by the name it carries in the .glb.
   * MUST include `rig` — see AuthoredSpecies.joints.
   */
  readonly joints: readonly string[];
  /** What the file must measure, within ENVELOPE_TOLERANCE_WORLD_UNITS. */
  readonly envelope: SpeciesEnvelope;
  /**
   * The file came out of `tools/blender/import_model.py --rigidify` — a
   * DOWNLOADED model whose skeleton was converted to this game's pivot
   * convention — rather than being authored to it by a build script.
   *
   * Two things are true of every such file and of no hand-built one, which is
   * why one flag covers both (see `prepareRigidified`):
   *
   *   * IT HAS NO `rig` NODE. A converted armature has the bones the artist
   *     drew and nothing spare, so the whole-body node every animation moves is
   *     SYNTHESISED here rather than demanded of the import. `rig` therefore
   *     must still be listed in `joints`, and must NOT exist in the file.
   *   * ITS PIVOTS ARE ORIENTED LIKE THE BONES THEY CAME FROM. Every other
   *     joint named in `joints` is a bone Empty and is driven through a
   *     model-axis pivot instead of directly.
   */
  readonly rigidified?: boolean;
  /**
   * Nodes the source file hung OUTSIDE the driven skeleton, and the joint that
   * has to carry each one.
   *
   * `--rigidify` splits a skinned mesh by dominant vertex weight and parents
   * each piece under the bone that weighed most on it. That is the honest
   * split, but a rig is free to contain bones that are not in the limb chain at
   * all — IK targets, commonly at the armature ROOT — and geometry that lands
   * on one is nailed to a node no animation reaches. Naming it here moves it,
   * unmoved, under the joint it belongs to. Empty for a hand-built asset.
   */
  readonly adopt?: readonly { readonly node: string; readonly under: string }[];
}

/**
 * The whole-body node every species must expose, by name — the one joint the
 * animations here all move (counter-yaw, walk bob, body roll) and the one a
 * rigidified import does not bring with it.
 */
const RIG_JOINT = 'rig';

/**
 * The joint convention for a SWIMMER, written down once (docs/model-assets.md,
 * "Wildlife species") and shared by every fish and whale that follows the
 * fish through this path.
 *
 *   rig                 an Empty at the origin; the whole body hangs under it,
 *                       and the counter-yaw acts on it.
 *   tail                an Empty AT THE PEDUNCLE, the caudal mesh its child —
 *                       so a yaw sweeps the fin from its root rather than
 *                       spinning it about its own centre.
 *   pectoral_port /     Empties at the flank root, authored at REST IDENTITY.
 *   pectoral_starboard  The fin's sweep is baked into its outline (rigid, so
 *                       it cannot swing the root out of the body); the rest
 *                       dihedral is animation and belongs to the species .ts.
 *
 * PORT IS -Z. With +X forward and +Y up in a right-handed frame,
 * left = up x forward = Y x X = -Z. Getting this backwards is a fish whose
 * fins flutter in antiphase, which is invisible in a still and wrong in motion.
 */
export const SWIMMER_JOINTS: readonly string[] = [
  'rig',
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

/**
 * The anchor Empties a swimmer's envelope is measured from, and the extreme of
 * the model's own bounding box each one must sit at.
 *
 * `flank` is deliberately absent from this table: the pectorals reach further
 * than the body does (0.137 against 0.080 for the fish), so the bounding box's
 * z-extent is NOT the envelope's halfWidth. It is checked separately below.
 */
const ENVELOPE_ANCHORS = [
  { anchor: 'nose', axis: 'x', side: 'max' },
  { anchor: 'tail_tip', axis: 'x', side: 'min' },
  { anchor: 'crown', axis: 'y', side: 'max' },
  { anchor: 'belly', axis: 'y', side: 'min' },
] as const;

/**
 * How far a measured extreme may sit from the constant it is checked against,
 * in WORLD UNITS at model scale 1 — the units every number in a SpeciesEnvelope
 * and every anchor position in this file is expressed in.
 *
 * A hundredth of a world unit. It is chosen from BOTH ends: far above the
 * float32 dust a glTF round trip adds to a position (glTF stores accessors as
 * float32, whose relative error at 0.3 is about 2e-8), and far below anything a
 * player could see — 0.01 world units is a seventieth of the fish's 0.72-unit
 * length (../species/fish.ts FISH_LENGTH), well under a pixel at the play
 * camera. So it absorbs the file format and nothing else: a fin that really
 * moved would move by more than this or not be worth moving.
 */
export const ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01;

/**
 * One installed species: the file, and the authoring tree + joint handles the
 * bake is given.
 *
 * PREPARED ONCE, AT INSTALL, not per build. A hand-built asset needs no
 * preparation and these are simply the file's own scene and nodes; a
 * `--rigidify` import needs the wrap and the pivots below, and those MUTATE the
 * asset's tree. Doing that per build would nest a second pivot inside the first
 * on the second bake, so it happens exactly once, here, and every later bake
 * reads the same prepared tree — which is what keeps `assetSpeciesBuilder`'s
 * promise that a scene survives repeated bakes.
 */
interface InstalledSpecies {
  readonly asset: RigAsset;
  /** Unparented and at the identity, as bakeRig's `authoredRoot` requires. */
  readonly root: Object3D;
  readonly joints: Readonly<Record<string, Object3D>>;
}

/** Installed assets by species key. Written only by installSpeciesAsset. */
const installed = new Map<string, InstalledSpecies>();

/**
 * Installs one parsed asset for a species, after checking everything about it
 * that is checkable.
 *
 * THE ONE INSTALL PATH. The browser reaches it through a plugin's `preload`
 * (loadRigAsset over HTTP); Node — a test, a verification script — reaches it
 * with bytes off disk through parseRigAsset. Two feeders, one function, so the
 * two cannot drift: a file that installs under Vitest installs in the browser.
 *
 * Checked BEFORE anything is stored, so a rejected asset leaves the previous
 * one (if any) untouched:
 *   * every joint the species declares exists, by name;
 *   * the four envelope anchors exist and sit at the model's own extremes;
 *   * the anchors agree with the species' declared envelope constants;
 *   * `flank` agrees with the declared halfWidth and does not exceed the
 *     model's z-extent.
 */
export function installSpeciesAsset(spec: SpeciesAssetSpec, asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  if (!spec.joints.includes('rig')) {
    throw new Error(
      `${spec.file}: the species declares no "rig" joint — every AuthoredSpecies ` +
        'must expose the whole-body node (see species/speciesModel.ts)',
    );
  }
  // Every joint must resolve NOW. asset.node throws naming the file and the
  // node; finding a typo at the first bake (or the first frame) instead would
  // turn an authoring mistake into a runtime surprise.
  //
  // `rig` is the one exception, and only for a rigidified import: there it is
  // synthesised below rather than present in the file (SpeciesAssetSpec).
  for (const joint of spec.joints) {
    if (spec.rigidified === true && joint === RIG_JOINT) continue;
    asset.node(joint);
  }

  const bounds = new Box3().setFromObject(asset.scene);
  const min = bounds.min;
  const max = bounds.max;
  const measured: Record<string, number> = {};
  for (const { anchor, axis, side } of ENVELOPE_ANCHORS) {
    const position = asset.anchor(anchor);
    const extreme = side === 'max' ? max[axis] : min[axis];
    assertClose(spec, `anchor "${anchor}" (${axis})`, position[axis], extreme, 'the model’s own extent');
    measured[anchor] = position[axis];
  }

  const flank = asset.anchor('flank');
  const halfWidth = Math.abs(flank.z);
  const zExtent = Math.max(Math.abs(min.z), Math.abs(max.z));
  if (halfWidth > zExtent + ENVELOPE_TOLERANCE_WORLD_UNITS) {
    throw new Error(
      `${spec.file}: the "flank" anchor is ${halfWidth.toFixed(4)} from the centreline but ` +
        `nothing in the model reaches past ${zExtent.toFixed(4)}`,
    );
  }

  const envelope = spec.envelope;
  assertClose(spec, 'length', measured.nose! - measured.tail_tip!, envelope.length, 'envelope.length');
  assertClose(spec, 'halfLength', (measured.nose! - measured.tail_tip!) / 2, envelope.halfLength, 'envelope.halfLength');
  assertClose(spec, 'crownY', measured.crown!, envelope.crownY, 'envelope.crownY');
  assertClose(spec, 'bellyY', measured.belly!, envelope.bellyY, 'envelope.bellyY');
  assertClose(spec, 'halfWidth', halfWidth, envelope.halfWidth, 'envelope.halfWidth');

  // Prepared only after every check has passed, so a rejected file is never
  // mutated and the previously installed one is never disturbed.
  installed.get(spec.species)?.asset.dispose();
  installed.set(
    spec.species,
    spec.rigidified === true ? prepareRigidified(spec, asset) : prepareAuthored(spec, asset),
  );
}

/** The plain case: the file's own scene is the authoring tree. */
function prepareAuthored(spec: SpeciesAssetSpec, asset: RigAsset): InstalledSpecies {
  const joints: Record<string, Object3D> = {};
  for (const name of spec.joints) joints[name] = asset.node(name);
  // The file's scene IS the authored root: it is unparented and at the
  // identity, which is exactly what bakeRig requires, so no placement step
  // sits between the file and the bake.
  return { asset, root: asset.scene, joints };
}

/**
 * The converted case: wrap the file, and give every declared joint a pivot the
 * animations here can actually drive.
 *
 * THE WRAP. `root` → `rig` → the file's scene, two identity Groups costing two
 * bone matrices. Wrapping rather than requiring the import to name a top node
 * `rig` keeps tools/blender/import_model.py generic — it normalises models for
 * the whole game, not for this plugin's animation vocabulary — and means a
 * downloaded model whose author happened to call something "rig" cannot collide
 * with ours.
 *
 * THE PIVOTS. See `modelAxisPivot`; it is the half of this that is not
 * obvious, and the half that broke first.
 */
function prepareRigidified(spec: SpeciesAssetSpec, asset: RigAsset): InstalledSpecies {
  const root = new Group();
  const rig = new Group();
  rig.name = RIG_JOINT;
  root.add(rig);
  rig.add(asset.scene);

  const joints: Record<string, Object3D> = { [RIG_JOINT]: rig };
  for (const name of spec.joints) {
    if (name === RIG_JOINT) continue;
    joints[name] = modelAxisPivot(asset.node(name), rig);
  }
  for (const { node, under } of spec.adopt ?? []) {
    const host = joints[under];
    if (host === undefined) {
      throw new Error(
        `${spec.file}: adopt "${node}" names host joint "${under}", which the species ` +
          'does not declare in `joints`',
      );
    }
    adoptKeepingTransform(asset.node(node), host);
  }
  return { asset, root, joints };
}

/** Frees every installed asset. Blueprints baked from them must go FIRST. */
export function disposeSpeciesAssets(): void {
  for (const entry of installed.values()) entry.asset.dispose();
  installed.clear();
}

/**
 * Builds one species from its installed asset.
 *
 * `animate` is the species file's own — the asset carries no animation and is
 * never asked for one, which is what keeps a re-export from changing how a
 * creature moves.
 */
export function assetSpeciesBuilder(
  spec: SpeciesAssetSpec,
  animate: (joints: SpeciesJoints, seconds: number, phase: number) => void,
): SpeciesModelBuilder {
  return (): AuthoredSpecies => {
    const entry = installed.get(spec.species);
    if (entry === undefined) {
      throw new Error(
        `${spec.file}: no asset installed for "${spec.species}" — the wildlife plugin's ` +
          'preload (or installSpeciesAsset, under Node) runs first',
      );
    }
    // The tree was prepared at install (see InstalledSpecies). bakeRig consumes
    // it as data and clones every buffer it keeps, so it survives repeated bakes.
    return { root: entry.root, joints: entry.joints, animate };
  };
}

// ── Driving a converted armature ─────────────────────────────────────────────
//
// Everything below exists because a `--rigidify` import is a real skeleton
// flattened into Empties, and an Empty that came from a bone is not yet a hinge
// this plugin's animations can drive. Both facilities are general: any
// downloaded model normalised by tools/blender/import_model.py needs them, and
// neither knows anything about any particular species.

/** Scratch for the one decompose per re-home. Never escapes this module. */
const scratchMatrix = new Matrix4();

/** `node`'s world transform, rewritten as a local transform in `host`'s frame. */
function localiseInto(node: Object3D, host: Object3D): void {
  scratchMatrix
    .copy(host.matrixWorld)
    .invert()
    .multiply(node.matrixWorld)
    .decompose(node.position, node.quaternion, node.scale);
}

/**
 * Hangs an identity-oriented pivot for `node` off `host`, and returns it. The
 * animation drives the PIVOT; the bone hangs under it, unmoved.
 *
 * WHY A PIVOT AND NOT THE BONE ITSELF. `--rigidify` puts an Empty at each
 * bone's head carrying the BONE's rest rotation (import_model.py,
 * build_joint_empties), because that is the only orientation the source states.
 * Two things break on that, and this fixes both:
 *
 *   * WRONG AXES. Every animation in this directory drives MODEL axes —
 *     ./quadruped.ts's poseWalk swings a leg with `rotation.z` because a model
 *     faces +X, so Z is fore-and-aft — and a deer's femur points down and back,
 *     so `rotation.z` on its own Empty twists the leg sideways.
 *   * A REST TRANSFORM THE ANIMATION DESTROYS. `joint.rotation.z = swing` is an
 *     assignment to an EULER and three rebuilds the whole quaternion from it:
 *     x and y come back zero and any rest rotation the node had is gone. The
 *     same is true of `joint.position.y = bob`, which is absolute. Every
 *     hand-built hinge in this directory rests at the identity, so that has
 *     always been harmless; a bone Empty does not, and the model comes apart on
 *     the first posed frame — observed 2026-09-04, the deer's legs lying flat
 *     with its hooves scattered on the ground.
 *
 * `host` is the species' `rig`, which sits at the identity inside the authored
 * root, so a pivot placed in its space is placed in the MODEL's frame. The
 * pivot takes the joint's position there and nothing else — no rotation, no
 * scale — and the bone keeps the rest the pivot did not take, so the model does
 * not move by a hair.
 *
 * WHAT THIS GIVES UP, stated because it is a real constraint and not an
 * oversight: a driven joint no longer inherits from the bones ABOVE it, only
 * from `rig`. For the walkers here that changes nothing — the torso and neck
 * bones between the rig and a leg never move — but an animation that wanted to
 * swing a shoulder AND the leg under it would have to pivot both and accept
 * that the second does not follow the first.
 */
export function modelAxisPivot(node: Object3D, host: Object3D): Group {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
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

/**
 * Re-homes `node` under `host` without moving it: its transform is re-expressed
 * in the host's frame, so the model looks identical and only the tree changed.
 *
 * This is what `SpeciesAssetSpec.adopt` is applied with — see that field for
 * why a converted rig can leave geometry on a node no animation reaches.
 */
export function adoptKeepingTransform(node: Object3D, host: Object3D): void {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  localiseInto(node, host);
  host.add(node);
}

/** One measured-versus-declared check, with the file named in the failure. */
function assertClose(
  spec: SpeciesAssetSpec,
  label: string,
  measured: number,
  declared: number,
  against: string,
): void {
  if (Math.abs(measured - declared) <= ENVELOPE_TOLERANCE_WORLD_UNITS) return;
  throw new Error(
    `${spec.file}: ${label} measures ${measured.toFixed(4)} but ${against} says ` +
      `${declared.toFixed(4)} — outside the ${ENVELOPE_TOLERANCE_WORLD_UNITS} world-unit tolerance`,
  );
}
