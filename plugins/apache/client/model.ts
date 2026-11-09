import { Quaternion, Vector3, type Bone, type Mesh, type Object3D } from 'three';
import type { NodeMaterial } from 'three/webgpu';
import type { ClientPluginCtx } from '../../../client/src/plugins/types.ts';
import { createPreloadAssets } from '../../../client/src/plugins/kit/preloadAssets.ts';
import { assertAssetFits, type RigAsset } from '../../../client/src/render/rigAsset.ts';
import { bakeRig, instantiateRig, type RigBlueprint, type RigInstance } from '../../../client/src/render/rigSkin.ts';
import { toNodeMaterial } from '../../../client/src/render/nodeMaterialFrom.ts';
import apacheUrl from '../../../client/src/assets/apache/apache.glb?url';
import {
  APACHE_AUTHORED_LENGTH_WORLD_UNITS,
  APACHE_AUTHORED_CLEARANCE_RADIUS_WORLD_UNITS,
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
const pendingAssets = createPreloadAssets<RigAsset>();

function assertClearanceEnvelope(loaded: RigAsset): void {
  loaded.scene.updateMatrixWorld(true);
  const pivots = ['main_rotor_pivot', 'tail_rotor_pivot'].map((name) => loaded.node(name));
  const point = new Vector3(), centre = new Vector3();
  loaded.scene.traverse((node) => {
    if ((node as Partial<Mesh>).isMesh !== true) return;
    let ancestor: Object3D | null = node;
    while (ancestor !== null && !pivots.includes(ancestor)) ancestor = ancestor.parent;
    if (ancestor !== null) ancestor.getWorldPosition(centre);
    const positions = (node as Mesh).geometry.getAttribute('position');
    for (let i = 0; i < positions.count; i++) {
      point.fromBufferAttribute(positions, i).applyMatrix4(node.matrixWorld);
      const reach = ancestor === null ? point.length() : centre.length() + point.distanceTo(centre);
      if (reach > APACHE_AUTHORED_CLEARANCE_RADIUS_WORLD_UNITS) {
        throw new Error('[apache] model exceeds the complete-rotor clearance envelope');
      }
    }
  });
}

export async function preloadApache(ctx: ClientPluginCtx): Promise<void> {
  await pendingAssets.load(ctx.signal, async () => {
    const loaded = await ctx.loadRigAsset(apacheUrl, 'sky-environment');
    // The server sizes the flight corridor from these extents, so the GLB must not outgrow them.
    try {
      assertAssetFits(loaded, {
        x: APACHE_AUTHORED_LENGTH_WORLD_UNITS,
        z: APACHE_AUTHORED_ROTOR_RADIUS_WORLD_UNITS * 2,
      });
      assertClearanceEnvelope(loaded);
      return loaded;
    } catch (error) {
      loaded.dispose();
      throw error;
    }
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
  asset = pendingAssets.take(ctx.signal) ?? asset;
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
