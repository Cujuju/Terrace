import {
  Box3,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three';
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  applyMapColourSpaces,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

export const RIG_TEXTURE_ANISOTROPY = 4;

export interface RigAsset {
  readonly scene: Object3D;
  node(name: string): Object3D;
  anchor(name: string): Vector3;
  dispose(): void;
}

export async function loadRigAsset(url: string, environment: Texture | null): Promise<RigAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createRigAsset(url, gltf.scene, environment);
}

export async function parseRigAsset(data: ArrayBuffer, label: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  return createRigAsset(label, gltf.scene, null);
}

function createRigAsset(label: string, scene: Object3D, environment: Texture | null): RigAsset {
  scene.updateMatrixWorld(true);

  let meshes = 0;
  const textures = new Set<Texture>();
  scene.traverse((child) => {
    const mesh = child as Partial<Mesh> & Object3D;
    if (mesh.isMesh !== true) return;
    meshes++;
    const material = (mesh as Mesh).material as Material | Material[];
    if (Array.isArray(material)) {
      throw new Error(
        `rigAsset "${label}": mesh "${mesh.name || '(unnamed)'}" has several materials — ` +
          `split it into one part per material, the way bakeRig requires`,
      );
    }
    const geometry = (mesh as Mesh).geometry;
    for (const channel of uvChannelsUsed(material)) {
      const attribute = uvAttributeName(channel);
      if (geometry.getAttribute(attribute) === undefined) {
        throw new Error(
          `rigAsset "${label}": mesh "${mesh.name || '(unnamed)'}" uses a textured material ` +
            `that samples uv channel ${channel} but carries no ${attribute} attribute`,
        );
      }
    }
    if (environment !== null && material instanceof MeshStandardMaterial) {
      material.envMap = environment;
    }
    applyMapColourSpaces(material);
    for (const texture of texturesOf(material)) textures.add(texture);
  });
  if (meshes === 0) {
    throw new Error(`rigAsset "${label}": the file contains no meshes`);
  }

  for (const texture of textures) {
    texture.generateMipmaps = true;
    texture.anisotropy = RIG_TEXTURE_ANISOTROPY;
  }

  const find = (name: string): Object3D => {
    const found = scene.getObjectByName(name);
    if (found === undefined) {
      throw new Error(`rigAsset "${label}": node "${name}" not found`);
    }
    return found;
  };

  let disposed = false;
  return {
    scene,
    node: find,
    anchor(name: string): Vector3 {
      return find(name).getWorldPosition(new Vector3());
    },
    dispose(): void {
      if (disposed) return;
      disposed = true;
      const geometries = new Set<{ dispose(): void }>();
      const materials = new Set<Material>();
      const maps = new Set<Texture>();
      scene.traverse((child) => {
        const mesh = child as Partial<Mesh> & Object3D;
        if (mesh.isMesh !== true) return;
        geometries.add((mesh as Mesh).geometry);
        const material = (mesh as Mesh).material as Material;
        if (Array.isArray(material)) return;
        materials.add(material);
        for (const texture of texturesOf(material)) maps.add(texture);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      for (const map of maps) map.dispose();
    },
  };
}

export const ASSET_FIT_TOLERANCE_WORLD_UNITS = 0.02;

export interface AssetFootprint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

export function assertAssetFits(
  asset: RigAsset,
  footprint: AssetFootprint,
  tolerance: number = ASSET_FIT_TOLERANCE_WORLD_UNITS,
): void {
  asset.scene.updateMatrixWorld(true);
  const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
  const overruns: string[] = [];
  const check = (axis: string, measured: number, budget: number | undefined): void => {
    if (budget === undefined) return;
    if (measured > budget + tolerance) {
      overruns.push(`${axis} ${measured.toFixed(3)} > ${budget}`);
    }
  };
  check('x', size.x, footprint.x);
  check('y', size.y, footprint.y);
  check('z', size.z, footprint.z);
  if (overruns.length > 0) {
    throw new Error(
      `rigAsset: the model overruns its authored footprint in world units ` +
        `(${overruns.join('; ')}, tolerance ${tolerance})`,
    );
  }
}
