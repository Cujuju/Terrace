// A .glb supplies the part tree and named joints; the species .ts supplies the
// envelope and `animate`. The envelope is ASSERTED against the file, never read from it.
//
// Dispose blueprints (models.dispose) BEFORE assets (disposeSpeciesAssets): bakeRig holds texture references.

import { Box3, Group, Matrix4, type Object3D } from 'three';
import type { RigAsset } from '../../../../client/src/render/rigAsset.ts';
import type { AuthoredSpecies, SpeciesJoints, SpeciesModelBuilder } from './speciesModel.ts';

/** World units at model scale 1; what placement.ts reads and the .glb must measure. */
export interface SpeciesEnvelope {
  readonly length: number;
  readonly halfLength: number;
  /** The BODY's widest half-width; fins may reach further (see `flank`). */
  readonly halfWidth: number;
  readonly crownY: number;
  /** Negative. */
  readonly bellyY: number;
}

export interface SpeciesAssetSpec {
  /** One asset per key; installing twice replaces and frees the previous one. */
  readonly species: string;
  readonly file: string;
  /** Node names `animate` addresses. Must include `rig`. */
  readonly joints: readonly string[];
  readonly envelope: SpeciesEnvelope;
  /**
   * A converted armature (tools/blender/import_model.py): it has no `rig` node
   * (synthesised here) and its pivots are bone-oriented (driven via modelAxisPivot).
   */
  readonly rigidified?: boolean;
  /** Nodes weighted outside the driven skeleton (IK targets), re-homed under a joint. */
  readonly adopt?: readonly { readonly node: string; readonly under: string }[];
}

const RIG_JOINT = 'rig';

/**
 * Swimmer joint convention (docs/model-assets.md): `rig` at the origin, `tail` at
 * the peduncle, pectoral hinges at rest identity. Port is -Z (+X forward, +Y up).
 */
export const SWIMMER_JOINTS: readonly string[] = [
  'rig',
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

/** Anchors that must sit at a bounding-box extreme. `flank` is not one: fins reach past the body. */
const ENVELOPE_ANCHORS = [
  { anchor: 'nose', axis: 'x', side: 'max' },
  { anchor: 'tail_tip', axis: 'x', side: 'min' },
  { anchor: 'crown', axis: 'y', side: 'max' },
  { anchor: 'belly', axis: 'y', side: 'min' },
] as const;

/** Far above glTF float32 rounding, far below a pixel at the play camera. */
export const ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01;

/** Prepared ONCE at install: rigidified preparation mutates the tree, and per-bake would nest pivots. */
interface InstalledSpecies {
  readonly asset: RigAsset;
  /** Unparented and at the identity, as bakeRig requires. */
  readonly root: Object3D;
  readonly joints: Readonly<Record<string, Object3D>>;
}

const installed = new Map<string, InstalledSpecies>();

/**
 * The one install path (browser preload and Node tests alike). Every check runs
 * before anything is stored, so a rejected file leaves the previous asset untouched.
 */
export function installSpeciesAsset(spec: SpeciesAssetSpec, asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  if (!spec.joints.includes('rig')) {
    throw new Error(
      `${spec.file}: the species declares no "rig" joint — every AuthoredSpecies ` +
        'must expose the whole-body node (see species/speciesModel.ts)',
    );
  }
  // Joints resolve now, not at first frame. A rigidified import's `rig` is synthesised below.
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

  installed.get(spec.species)?.asset.dispose();
  installed.set(
    spec.species,
    spec.rigidified === true ? prepareRigidified(spec, asset) : prepareAuthored(spec, asset),
  );
}

function prepareAuthored(spec: SpeciesAssetSpec, asset: RigAsset): InstalledSpecies {
  const joints: Record<string, Object3D> = {};
  for (const name of spec.joints) joints[name] = asset.node(name);
  return { asset, root: asset.scene, joints };
}

/**
 * Converted armature: wrap the scene under a synthesised `rig`, pivot every joint
 * (modelAxisPivot). No vertex moves; world transforms are preserved throughout.
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

/** Blueprints baked from these must be disposed FIRST. */
export function disposeSpeciesAssets(): void {
  for (const entry of installed.values()) entry.asset.dispose();
  installed.clear();
}

/** `animate` is the species file's own; the asset never supplies motion. */
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
    return { root: entry.root, joints: entry.joints, animate };
  };
}

// ── Driving a converted armature ─────────────────────────────────────────────

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
 * Identity pivot for `node` under `rig`; animations assign Euler rotations outright,
 * which would destroy a bone's rest. Cost: the joint no longer inherits from bones above.
 */
export function modelAxisPivot(node: Object3D, host: Object3D): Group {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  localiseInto(node, host);

  const pivot = new Group();
  pivot.name = `${node.name}:modelAxis`;
  // Pivot takes position only; the node keeps rotation and scale.
  pivot.position.copy(node.position);
  host.add(pivot);

  node.position.set(0, 0, 0);
  pivot.add(node);
  return pivot;
}

/** Re-homes `node` under `host` with its world transform preserved (SpeciesAssetSpec.adopt). */
export function adoptKeepingTransform(node: Object3D, host: Object3D): void {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  localiseInto(node, host);
  host.add(node);
}

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
