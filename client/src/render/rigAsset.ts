// Loading an externally authored model as a rigSkin authoring tree.
//
// WHY THIS EXISTS. Models used to be hand-built from three.js primitives
// inside a synchronous plugin attach(), but glTF parsing is promise-based. A
// plugin that wants an authored model preloads it through here
// (TerraceClientPlugin.preload) and hands the resulting scene to bakeRig
// exactly as if it had built the part-tree itself.
//
// THE AUTHORING CONVENTION (docs/model-assets.md): units are cells (1 unit =
// 1 cell), Y up, forward = +X, origin on the centreline at the keel. Axis
// placement and origin are convention only, enforced by
// tools/blender/export_glb.py and the per-asset fit check at the callsite.
// What IS checked here, because a silent fallback would show up as bad art:
// the file has at least one mesh, every mesh takes a single material (bakeRig
// cannot bake a multi-material part), and every mesh carries the uv attribute
// for every uv channel its material samples.
//
// AN ARMATURE IS ACCEPTED (not always — until 2026-09-04 a skinned file was
// rejected here and had to be split by dominant weight offline, tearing a
// deer's shoulder open mid-stride). A SkinnedMesh IS a Mesh, so every check
// below applies unchanged; bakeRig keeps its weights — see rigSkin's header.
//
// THE FULL glTF MATERIAL SET IS SUPPORTED via ./materialMaps.ts, which owns
// which slots a material can carry and which uv channel each reads — this
// file never keeps its own slot list.

import {
  Box3,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three';
// Shipped inside the `three` package (see its package.json "exports"), the
// same reach rigSkin.ts already makes.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';
import {
  applyMapColourSpaces,
  texturesOf,
  uvAttributeName,
  uvChannelsUsed,
} from './materialMaps.ts';

/**
 * Anisotropy for an authored model's colour textures.
 *
 * 4: the most a surface at the game's grazing camera angles can use before
 * three's own hardware-max clamp — past it is a sharper number on the same
 * blurry texel.
 */
export const RIG_TEXTURE_ANISOTROPY = 4;

/** One loaded model file: its scene graph plus the convention's accessors. */
export interface RigAsset {
  /** The file's scene, at the identity transform and unparented — bakeRig's `authoredRoot` shape. Consumed as data; never added to the render graph. */
  readonly scene: Object3D;
  /** The authored node of that name (an oar pivot, the sail, a mast). Throws naming the file and node when absent — a missing pivot would otherwise drive the wrong joint silently. */
  node(name: string): Object3D;
  /** The position of a named Empty (a `waterline`, `fire_top`-style anchor) in scene space. Throws exactly like node() when absent. */
  anchor(name: string): Vector3;
  /**
   * Frees the source geometries, materials and textures. Call AFTER the
   * blueprint built from this asset is disposed — baked surfaces sample the
   * same texture objects.
   */
  dispose(): void;
}

/** Parses one model file over HTTP: the browser path (a plugin's preload). `url` is typically a `.glb?url` import — see client/vite.config.ts's assetsInclude entry. */
export async function loadRigAsset(url: string, environment: Texture | null): Promise<RigAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createRigAsset(url, gltf.scene, environment);
}

/** Parses one model file from bytes already in hand: the Node path (a verification script, a fixture-reading test). Same GLTFLoader and validation as loadRigAsset, so a file that passes here passes there. */
export async function parseRigAsset(data: ArrayBuffer, label: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  // No environment on the node path: no renderer built one, nothing is drawn.
  return createRigAsset(label, gltf.scene, null);
}

/**
 * `environment` — the prefiltered sky (render/skyEnvironment.ts) every PBR
 * material is pointed at, or null to leave the file lamp-lit. Set here, on
 * the source materials, so every clone and bake inherits it for free.
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
    // No silent fallback: an unmapped UV lookup samples the texture's first
    // texel across the whole part. Checked per channel since occlusion may
    // sit on the second uv set (glTF `texCoord: 1`).
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
    // GLTFLoader assigns colour spaces itself for files it writes; verified
    // here rather than assumed, since a hand-edited file or another exporter
    // can leave a colour texture linear (renders too dark) or mark a data
    // texture sRGB (gamma-decodes a number before use) — indistinguishable
    // from bad art downstream.
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
      // The scene sits at the identity, so this is the anchor's authored
      // position — the number the callsite measures its constants from.
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
      // map, doesn't duplicate it) — the reading blueprint must already be disposed.
      for (const map of maps) map.dispose();
    },
  };
}

/**
 * How far past its footprint a model may reach before it is rejected at load.
 *
 * 0.02 world units: absorbs float dust in the bounding box (a loft's box edge
 * lands a few ulps off the intended dimension), never a real overhang. Began
 * life as boats' BOAT_FIT_TOLERANCE_CELLS; shared because the reason applies
 * to any asset.
 */
export const ASSET_FIT_TOLERANCE_WORLD_UNITS = 0.02;

/**
 * A footprint in WORLD UNITS — the asset's own units, the ones three draws.
 *
 * Not cells (orchestrator decision, 2026-09-04): a model carries no runtime
 * scale, so its bounding box can only be compared in the renderer's unit. A
 * cell is CELL_WORLD_SIZE world units (shared/src/constants.ts:50); a
 * server-side cell count converts via `cellsAcross` before reaching here.
 *
 * `y` is optional: most callers budget only the ground area.
 */
export interface AssetFootprint {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

/**
 * Throws unless the model's bounding box fits the footprint it was authored for.
 *
 * Not folded into createRigAsset: the loader can't know what a file is FOR
 * (a boat gets a cell's worth of world units, a temple its own plan), so the
 * budget is the callsite's to state — but the measurement and tolerance stay
 * here so no callsite's own Box3 can forget an axis.
 */
export function assertAssetFits(
  asset: RigAsset,
  footprint: AssetFootprint,
  tolerance: number = ASSET_FIT_TOLERANCE_WORLD_UNITS,
): void {
  // World space, so a scene whose nodes carry transforms needs them resolved first.
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
