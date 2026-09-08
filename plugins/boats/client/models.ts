import {
  Color,
  Euler,
  InstancedBufferAttribute,
  InstancedMesh,
  Matrix4,
  Mesh,
  MeshStandardMaterial,
  Quaternion,
  Sphere,
  Vector3,
  type BufferGeometry,
  type Bone,
  type Material,
  type Object3D,
} from 'three';
import { bakeRig, type RigBlueprint } from '../../../client/src/render/rigSkin.ts';
import { createRigHerd } from '../../../client/src/render/rigHerd.ts';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import {
  assertAssetFits,
  type AssetFootprint,
  type RigAsset,
} from '../../../client/src/render/rigAsset.ts';
import { BOATS_PAYLOAD_CAP } from '../protocol.ts';
import { createSailSlots } from './sailSlots.ts';

const BOAT_DRAW_OBJECTS_MAX = 4;

export const FLEET_SAIL_DRAW_OBJECTS = 1;

const MATRIX_ELEMENT_COUNT = 16;

const COLOR_ELEMENT_COUNT = 3;

let drawObjects: number = BOAT_DRAW_OBJECTS_MAX;

let shape: {
  readonly waterlineLift: number;
  readonly fireColumn: { readonly bottomY: number; readonly height: number };
} | null = null;

function installedShape(): NonNullable<typeof shape> {
  if (shape === null) {
    throw new Error(
      'BOAT_SHAPE: no boat asset installed — preloadBoatModels (or installBoatKit) runs first',
    );
  }
  return shape;
}

export const BOAT_SHAPE: {
  readonly waterlineLift: number;
  readonly fireColumn: { readonly bottomY: number; readonly height: number };
  readonly drawObjects: number;
} = Object.freeze({
  get waterlineLift(): number {
    return installedShape().waterlineLift;
  },

  get fireColumn(): { readonly bottomY: number; readonly height: number } {
    return installedShape().fireColumn;
  },

  get drawObjects(): number {
    return drawObjects;
  },
});

const BOAT_FOOTPRINT_WORLD_UNITS: AssetFootprint = { x: 1, z: 1 };

const SAIL_COLOR = 0xe8e0cf;
const SAIL_FIGHTING_COLOR = 0xb03a2e;

const SAIL_REST_TINT = new Color(SAIL_COLOR);
const SAIL_FIGHTING_TINT = new Color(SAIL_FIGHTING_COLOR);

const SAIL_MATERIAL_COLOR = 0xffffff;

const PARKED_SAIL_MATRIX = new Matrix4().makeScale(0, 0, 0);

const OAR_PIVOTS = [
  { name: 'oar_port_1', side: -1 },
  { name: 'oar_port_2', side: -1 },
  { name: 'oar_starboard_1', side: 1 },
  { name: 'oar_starboard_2', side: 1 },
] as const;

const OAR_SWEEP_RADIANS = 0.45;
const OAR_STROKE_HZ = 0.55;
const OAR_FIGHTING_RATE = 2.1;

const SWELL_ROLL_RADIANS = 0.07;
const SWELL_PITCH_RADIANS = 0.04;
const SWELL_HZ = 0.31;
const SWELL_PITCH_BEAT_RATIO = 0.73;

const TWO_PI = Math.PI * 2;

const OAR_POSE_SLOTS = 128;

const HULL_UNSCALED_REACH = 1;

export const HULL_MESH_NAME = 'boats:hulls';
export const SAIL_MESH_NAME = 'boats:sails';

export interface BoatModel {
  draw(
    x: number,
    y: number,
    z: number,
    heading: number,
    elapsedSeconds: number,
    phase: number,
    stepSeconds: number,
    fighting: boolean,
  ): void;
  dispose(): void;
}

export interface BoatModels {
  readonly objects: readonly Object3D[];
  readonly joints: readonly Bone[];
  create(): BoatModel;
  beginFrame(): void;
  commitFrame(): void;
  dispose(): void;
}

interface BoatKit {
  readonly asset: RigAsset;
  readonly sailGeometry: BufferGeometry;
  readonly sailMaterial: MeshStandardMaterial;
  readonly sailPosition: Vector3;
  readonly sailQuaternion: { x: number; y: number; z: number; w: number };
  readonly sailScale: Vector3;
}

let kit: BoatKit | null = null;

export async function preloadBoatModels(
  ctx: Pick<ClientPluginCtx, 'loadRigAsset'>,
  url: string,
): Promise<void> {
  installBoatKit(await ctx.loadRigAsset(url, 'lamps-only'));
}

export function installBoatKit(asset: RigAsset): void {
  asset.scene.updateMatrixWorld(true);

  const waterline = asset.anchor('waterline');
  const deckTop = asset.anchor('deck_top');
  const fireTop = asset.anchor('fire_top');
  if (!(fireTop.y > deckTop.y)) {
    throw new Error(
      `boat asset: fire_top (${fireTop.y}) is not above deck_top (${deckTop.y}) — ` +
        `the fire column would burn downward`,
    );
  }
  try {
    assertAssetFits(asset, BOAT_FOOTPRINT_WORLD_UNITS);
  } catch (cause) {
    throw new Error(
      `boat asset: the rowed silhouette breaks the one-cell fit budget — ` +
        `the fight's geometry is counted in whole cells`,
      { cause },
    );
  }
  const sailNode = asset.node('sail');
  if (!(sailNode instanceof Mesh)) {
    throw new Error('boat asset: the sail node is not a mesh');
  }
  const sailMaterial = (sailNode as Mesh).material as Material;
  if (Array.isArray(sailMaterial) || !(sailMaterial instanceof MeshStandardMaterial)) {
    throw new Error('boat asset: the sail needs one standard material to recolour per boat');
  }
  for (const pivot of OAR_PIVOTS) asset.node(pivot.name);

  disposeBoatKit();
  shape = {
    waterlineLift: -waterline.y,
    fireColumn: { bottomY: deckTop.y, height: fireTop.y - deckTop.y },
  };
  kit = {
    asset,
    sailGeometry: (sailNode as Mesh).geometry as BufferGeometry,
    sailMaterial,
    sailPosition: sailNode.position.clone(),
    sailQuaternion: {
      x: sailNode.quaternion.x,
      y: sailNode.quaternion.y,
      z: sailNode.quaternion.z,
      w: sailNode.quaternion.w,
    },
    sailScale: sailNode.scale.clone(),
  };
}

export function disposeBoatKit(): void {
  kit?.asset.dispose();
  kit = null;
  shape = null;
  drawObjects = BOAT_DRAW_OBJECTS_MAX;
}

export function createBoatModels(): BoatModels {
  const installed = kit;
  if (installed === null) {
    throw new Error(
      'createBoatModels: no boat asset installed — preloadBoatModels (or installBoatKit) runs first',
    );
  }
  const sailNode = installed.asset.node('sail');
  const parent = sailNode.parent;
  sailNode.removeFromParent();
  let blueprint: RigBlueprint;
  try {
    blueprint = bakeRig(installed.asset.scene);
  } finally {
    parent?.add(sailNode);
  }

  const oarJoints: number[] = [];
  const oarSides: number[] = [];
  for (const pivot of OAR_PIVOTS) {
    oarJoints.push(blueprint.jointIndex(installed.asset.node(pivot.name)));
    oarSides.push(pivot.side);
  }

  drawObjects = blueprint.surfaceCount;

  const herd = createRigHerd(blueprint, {
    capacity: BOATS_PAYLOAD_CAP,
    poseSlots: OAR_POSE_SLOTS,
    staticPoses: true,
  });
  for (const mesh of herd.meshes) mesh.name = HULL_MESH_NAME;

  function poseOars(oarPhase: number): void {
    const swing = Math.sin(oarPhase) * OAR_SWEEP_RADIANS;
    for (let i = 0; i < oarJoints.length; i++) {
      herd.joints[oarJoints[i]!]!.rotation.y = swing * oarSides[i]!;
    }
  }

  const sailMaterial = installed.sailMaterial.clone();
  sailMaterial.color.setHex(SAIL_MATERIAL_COLOR);

  const sails = new InstancedMesh(installed.sailGeometry, sailMaterial, BOATS_PAYLOAD_CAP);
  sails.name = SAIL_MESH_NAME;
  sails.count = 0;
  sails.instanceColor = new InstancedBufferAttribute(
    new Float32Array(BOATS_PAYLOAD_CAP * COLOR_ELEMENT_COUNT).fill(1),
    COLOR_ELEMENT_COUNT,
  );
  for (let slot = 0; slot < BOATS_PAYLOAD_CAP; slot++) {
    sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
  }

  const slots = createSailSlots(BOATS_PAYLOAD_CAP);

  const authoredSailMatrix = new Matrix4().compose(
    installed.sailPosition,
    new Quaternion(
      installed.sailQuaternion.x,
      installed.sailQuaternion.y,
      installed.sailQuaternion.z,
      installed.sailQuaternion.w,
    ),
    installed.sailScale,
  );

  if (installed.sailGeometry.boundingSphere === null) {
    installed.sailGeometry.computeBoundingSphere();
  }
  const sailSphere = installed.sailGeometry.boundingSphere;
  const sailReach =
    sailSphere === null
      ? 0
      : (sailSphere.center.length() + sailSphere.radius) *
        Math.max(installed.sailScale.x, installed.sailScale.y, installed.sailScale.z);

  const sailMatrix = new Matrix4();
  const boatMatrix = new Matrix4();
  const boatRotation = new Euler(0, 0, 0, 'XYZ');

  let minX = Infinity;
  let minY = Infinity;
  let minZ = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  let maxZ = -Infinity;

  return {
    objects: [...herd.meshes, sails],
    joints: herd.joints,

    create(): BoatModel {
      let slot = slots.acquire();
      sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
      sails.setColorAt(slot, SAIL_REST_TINT);
      if (sails.instanceColor !== null) sails.instanceColor.needsUpdate = true;

      let wasFighting = false;
      let oarPhase = -1;

      return {
        draw(
          x: number,
          y: number,
          z: number,
          heading: number,
          elapsedSeconds: number,
          phase: number,
          stepSeconds: number,
          fighting: boolean,
        ): void {
          if (slot < 0) return;
          if (oarPhase < 0) oarPhase = phase * TWO_PI;
          const strokeRate = fighting ? OAR_STROKE_HZ * OAR_FIGHTING_RATE : OAR_STROKE_HZ;
          oarPhase += stepSeconds * strokeRate * TWO_PI;

          const t = elapsedSeconds + phase;
          boatRotation.set(
            Math.sin(t * SWELL_HZ * TWO_PI * SWELL_PITCH_BEAT_RATIO) * SWELL_PITCH_RADIANS,
            heading,
            Math.sin(t * SWELL_HZ * TWO_PI) * SWELL_ROLL_RADIANS,
          );
          boatMatrix.makeRotationFromEuler(boatRotation);
          boatMatrix.setPosition(x, y, z);

          const poseSlot = herd.poseSlotOf(oarPhase);
          if (herd.needsPose(poseSlot)) {
            poseOars(herd.poseSlotPhase(poseSlot));
            herd.capturePose(poseSlot);
          }
          herd.placeMatrix(poseSlot, boatMatrix, HULL_UNSCALED_REACH);

          sailMatrix.multiplyMatrices(boatMatrix, authoredSailMatrix);
          sails.setMatrixAt(slot, sailMatrix);

          const at = sailMatrix.elements;
          if (at[12]! < minX) minX = at[12]!;
          if (at[12]! > maxX) maxX = at[12]!;
          if (at[13]! < minY) minY = at[13]!;
          if (at[13]! > maxY) maxY = at[13]!;
          if (at[14]! < minZ) minZ = at[14]!;
          if (at[14]! > maxZ) maxZ = at[14]!;

          if (fighting !== wasFighting) {
            sails.setColorAt(slot, fighting ? SAIL_FIGHTING_TINT : SAIL_REST_TINT);
            if (sails.instanceColor !== null) sails.instanceColor.needsUpdate = true;
            wasFighting = fighting;
          }
        },
        dispose(): void {
          if (slot < 0) return;
          sails.setMatrixAt(slot, PARKED_SAIL_MATRIX);
          slots.release(slot);
          slot = -1;
        },
      };
    },

    beginFrame(): void {
      herd.beginFrame();
    },

    commitFrame(): void {
      herd.endFrame();
      const drawn = slots.drawnCount;
      sails.count = drawn;
      sails.instanceMatrix.clearUpdateRanges();
      sails.instanceMatrix.addUpdateRange(0, drawn * MATRIX_ELEMENT_COUNT);
      sails.instanceMatrix.needsUpdate = true;

      const sphere = (sails.boundingSphere ??= new Sphere());
      if (minX > maxX) {
        sphere.makeEmpty();
      } else {
        sphere.center.set((minX + maxX) / 2, (minY + maxY) / 2, (minZ + maxZ) / 2);
        sphere.radius = Math.hypot(maxX - minX, maxY - minY, maxZ - minZ) / 2 + sailReach;
      }
      minX = Infinity;
      minY = Infinity;
      minZ = Infinity;
      maxX = -Infinity;
      maxY = -Infinity;
      maxZ = -Infinity;
    },

    dispose(): void {
      herd.dispose();
      blueprint.dispose();
      sails.dispose();
      sailMaterial.dispose();
    },
  };
}
