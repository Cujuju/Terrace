// Why this exists: glTF parsing is promise-based, so a plugin preloads through
// here (TerraceClientPlugin.preload) and hands the scene to bakeRig as if it
// had built the part-tree itself.
//
// Authoring convention (docs/model-assets.md): units are cells, Y up, forward
// +X, origin on the centreline at the keel — enforced by export_glb.py and the
// per-asset fit check at the callsite.
//
// A skinned file is accepted since 2026-09-04; before that it had to be split
// by dominant weight offline, which tore a deer's shoulder open mid-stride.
//
// ./materialMaps.ts owns which slots a material carries and which uv channel
// each reads — this file never keeps its own slot list.

import {
  Box3,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three';
// Deep import: shipped inside the `three` package's "exports", as rigSkin.ts does.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  applyMapColourSpaces,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

/**
 * 4: the most a surface at the game's grazing angles can use before three's own
 * hardware-max clamp — past it is a sharper number on the same blurry texel.
 */
export const RIG_TEXTURE_ANISOTROPY = 4;

export interface RigAsset {
  /** At the identity and unparented — bakeRig's `authoredRoot` shape. Consumed as data; never added to the render graph. */
  readonly scene: Object3D;
  /** Throws when absent, naming file and node — a missing pivot would otherwise drive the wrong joint silently. */
  node(name: string): Object3D;
  anchor(name: string): Vector3;
  /**
   * Call AFTER the blueprint built from this asset is disposed — baked surfaces
   * sample the same texture objects.
   */
  dispose(): void;
}

/** `url` is typically a `.glb?url` import — see client/vite.config.ts's assetsInclude entry. */
export async function loadRigAsset(url: string, environment: Texture | null): Promise<RigAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createRigAsset(url, gltf.scene, environment);
}

/** The Node path (verification scripts, fixture tests). Same loader and validation as loadRigAsset, so a file that passes here passes there. */
export async function parseRigAsset(data: ArrayBuffer, label: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  // No environment on the node path: no renderer built one, nothing is drawn.
  return createRigAsset(label, gltf.scene, null);
}

/**
 * `environment` is the prefiltered sky (render/skyEnvironment.ts), or null to
 * leave the file lamp-lit. Set on the SOURCE materials, so every clone and bake
 * inherits it for free.
 */
function createRigAsset(label: string, scene: Object3D, environment: Texture | null): RigAsset {
  scene.updateMatrixWorld(true);

  let meshes = 0;
  const textures = new Set<Texture>();
  scene.traverse((child) => {
    // A SkinnedMesh sets isMesh too, so it takes every check below unchanged.
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
    // An unmapped UV lookup samples the texture's first texel across the whole
    // part. Per channel: occlusion may sit on the second uv set (`texCoord: 1`).
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
    // Verified, not assumed: a hand-edited file or another exporter can leave a
    // colour texture linear (too dark) or mark a data texture sRGB.
    applyMapColourSpaces(material);
    for (const texture of texturesOf(material)) textures.add(texture);
  });
  if (meshes === 0) {
    throw new Error(`rigAsset "${label}": the file contains no meshes`);
  }

  for (const texture of textures) {
    // Minified under the game's overhead camera; a small texture without
    // mipmaps shimmers.
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
      // The scene sits at the identity, so this is the authored position — the
      // number the callsite measures its constants from.
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
      // Baked surfaces sample these same texture objects (clone() shares the
      // map) — the reading blueprint must already be disposed.
      for (const map of maps) map.dispose();
    },
  };
}

/**
 * 0.02 absorbs float dust in the bounding box (a loft's edge lands a few ulps
 * off the intended dimension), never a real overhang. Was boats'
 * BOAT_FIT_TOLERANCE_CELLS; shared because the reason applies to any asset.
 */
export const ASSET_FIT_TOLERANCE_WORLD_UNITS = 0.02;

/**
 * World units, not cells (orchestrator decision, 2026-09-04): a model carries no
 * runtime scale, so its bounding box compares only in the renderer's own unit.
 *
 * A cell is CELL_WORLD_SIZE world units; a server-side cell count converts via
 * `cellsAcross` before reaching here. `y` is optional — most callers budget
 * only the ground area.
 */
export interface AssetFootprint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

/**
 * Not folded into createRigAsset: only the callsite knows what a file is FOR, so
 * the budget is its to state. The measurement and tolerance stay here so no
 * callsite's own Box3 can forget an axis.
 */
export function assertAssetFits(
  asset: RigAsset,
  footprint: AssetFootprint,
  tolerance: number = ASSET_FIT_TOLERANCE_WORLD_UNITS,
): void {
  // World space: a scene whose nodes carry transforms needs them resolved first.
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
