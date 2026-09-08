import { Box3, Group, Matrix4, type Object3D } from 'three';
import type { MoverGait } from '../../../../client/src/plugins/kit/moverGait.ts';
import type { RigAsset } from '../../../../client/src/render/rigAsset.ts';
import type { AuthoredSpecies, SpeciesJoints, SpeciesModelBuilder } from './speciesModel.ts';

export interface SpeciesEnvelope {
  readonly length: number;
  readonly halfLength: number;
  readonly halfWidth: number;
  readonly crownY: number;
  readonly bellyY: number;
}

export interface SpeciesAssetSpec {
  readonly species: string;
  readonly file: string;
  readonly joints: readonly string[];
  readonly envelope: SpeciesEnvelope;
  readonly rigidified?: boolean;
  readonly adopt?: readonly { readonly node: string; readonly under: string }[];
}

const RIG_JOINT = 'rig';

export const SWIMMER_JOINTS: readonly string[] = [
  'rig',
  'tail',
  'pectoral_port',
  'pectoral_starboard',
];

const ENVELOPE_ANCHORS = [
  { anchor: 'nose', axis: 'x', side: 'max' },
  { anchor: 'tail_tip', axis: 'x', side: 'min' },
  { anchor: 'crown', axis: 'y', side: 'max' },
  { anchor: 'belly', axis: 'y', side: 'min' },
] as const;

export const ENVELOPE_TOLERANCE_WORLD_UNITS = 0.01;

interface InstalledSpecies {
  readonly asset: RigAsset;
  readonly root: Object3D;
  readonly joints: Readonly<Record<string, Object3D>>;
}

const installed = new Map<string, InstalledSpecies>();

export function installSpeciesAsset(spec: SpeciesAssetSpec, asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  if (!spec.joints.includes('rig')) {
    throw new Error(
      `${spec.file}: the species declares no "rig" joint — every AuthoredSpecies ` +
        'must expose the whole-body node (see species/speciesModel.ts)',
    );
  }
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

export function disposeSpeciesAssets(): void {
  for (const entry of installed.values()) entry.asset.dispose();
  installed.clear();
}

export function assetSpeciesBuilder(
  spec: SpeciesAssetSpec,
  animate: (joints: SpeciesJoints, seconds: number, phase: number, gait: MoverGait) => void,
  posesByGait: boolean = false,
): SpeciesModelBuilder {
  return (): AuthoredSpecies => {
    const entry = installed.get(spec.species);
    if (entry === undefined) {
      throw new Error(
        `${spec.file}: no asset installed for "${spec.species}" — the wildlife plugin's ` +
          'preload (or installSpeciesAsset, under Node) runs first',
      );
    }
    return { root: entry.root, joints: entry.joints, animate, posesByGait };
  };
}

const scratchMatrix = new Matrix4();

function localiseInto(node: Object3D, host: Object3D): void {
  scratchMatrix
    .copy(host.matrixWorld)
    .invert()
    .multiply(node.matrixWorld)
    .decompose(node.position, node.quaternion, node.scale);
}

export function modelAxisPivot(node: Object3D, host: Object3D): Group {
  host.updateMatrixWorld(true);
  node.updateWorldMatrix(true, false);
  localiseInto(node, host);

  const pivot = new Group();
  pivot.name = `${node.name}:modelAxis`;
  pivot.position.copy(node.position);
  host.add(pivot);

  node.position.set(0, 0, 0);
  pivot.add(node);
  return pivot;
}

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
