import { Quaternion, Vector3, type Bone } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { assertAssetFits, type RigAsset } from '../../../client/src/render/rigAsset.ts';
import { bakeRig, instantiateRig, type RigBlueprint, type RigInstance } from '../../../client/src/render/rigSkin.ts';
import { toNodeMaterial } from '../../../client/src/render/nodeMaterialFrom.ts';
import apacheUrl from '../../../client/src/assets/apache/apache.glb?url';
import {
  APACHE_AUTHORED_LENGTH_WORLD_UNITS,
  APACHE_AUTHORED_ROTOR_RADIUS_WORLD_UNITS,
  APACHE_DRAW_SCALE,
} from '../protocol.ts';

export interface ApacheModel {
  readonly rig: RigInstance;
  readonly materials: readonly NodeMaterial[];
  animateRotors(seconds: number): void;
  dispose(): void;
}

let asset: RigAsset | null = null;

export async function preloadApache(ctx: ClientPluginCtx): Promise<void> {
  asset = await ctx.loadRigAsset(apacheUrl, 'sky-environment');
  // The server sizes the flight corridor from these extents, so the GLB must not outgrow them.
  assertAssetFits(asset, {
    x: APACHE_AUTHORED_LENGTH_WORLD_UNITS,
    z: APACHE_AUTHORED_ROTOR_RADIUS_WORLD_UNITS * 2,
  });
}

export function releaseApache(): void {
  asset?.dispose();
  asset = null;
}

function rotor(blueprint: RigBlueprint, rig: RigInstance, name: string): Bone {
  return rig.joints[blueprint.jointIndex(asset!.node(name))]!;
}

export function createApache(ctx: ClientPluginCtx): ApacheModel {
  if (asset === null) throw new Error('[apache] model did not preload');
  const blueprint = bakeRig(asset.scene);
  if (blueprint.surfaceCount !== 1) {
    blueprint.dispose();
    throw new Error('[apache] expected a single combined draw surface');
  }
  const rig = instantiateRig(blueprint);
  const materials = rig.meshes.map((mesh) => {
    if (Array.isArray(mesh.material)) throw new Error('[apache] expected one material');
    const material = toNodeMaterial(mesh.material);
    material.alphaHash = true;
    ctx.applyRevealClip(material, 'apache:airframe');
    mesh.material = material;
    mesh.name = 'apache:airframe';
    return material;
  });
  const mainRotor = rotor(blueprint, rig, 'main_rotor_pivot');
  const tailRotor = rotor(blueprint, rig, 'tail_rotor_pivot');
  const mainRest = mainRotor.quaternion.clone(), tailRest = tailRotor.quaternion.clone();
  const mainAxis = new Vector3(0, 1, 0), tailAxis = new Vector3(0, 0, 1);
  const spin = new Quaternion();
  rig.root.name = 'apache:visitor';
  rig.root.scale.setScalar(APACHE_DRAW_SCALE);
  rig.root.rotation.order = 'YZX';
  rig.root.visible = false;
  ctx.layer.add(rig.root);
  ctx.requestShaderWarmup();
  return {
    rig, materials,
    animateRotors(seconds): void {
      mainRotor.quaternion.copy(mainRest).multiply(spin.setFromAxisAngle(mainAxis, seconds * 31));
      tailRotor.quaternion.copy(tailRest).multiply(spin.setFromAxisAngle(tailAxis, seconds * 139));
    },
    dispose(): void {
      rig.root.removeFromParent();
      rig.dispose();
      for (const material of materials) material.dispose();
      blueprint.dispose();
    },
  };
}
