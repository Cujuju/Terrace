// Loading an externally authored model as a rigSkin authoring tree.
//
// WHY THIS EXISTS. Every model used to be hand-built from three.js primitives
// inside a synchronous plugin attach() — and glTF parsing is promise-based, so
// no sync path exists. A plugin that wants an authored model preloads it
// through here (see TerraceClientPlugin.preload) and hands the resulting scene
// to bakeRig exactly as if it had built the part-tree itself.
//
// THE AUTHORING CONVENTION, enforced where it is checkable and documented
// where it is not (see docs/model-assets.md): units are cells (1 unit =
// 1 cell), Y up, forward = +X, origin on the centreline at the keel. Axis
// placement and the origin are by convention — a loader cannot tell a boat
// modelled backwards from one modelled forwards — and are enforced by
// tools/blender/export_glb.py plus the per-asset fit check at the callsite.
// What IS checked here, because a silent fallback would show up as bad art:
// the file must contain at least one mesh, every mesh takes a single material
// (bakeRig cannot bake a multi-material part), and every mesh drawn under a
// mapped material MUST carry `uv` — a textured part with no UVs is a load
// error naming the file, never an untextured fallback.

import {
  SRGBColorSpace,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency — the same reach rigSkin.ts already makes.
import { GLTFLoader } from 'three/examples/jsm/loaders/GLTFLoader.js';

/**
 * Anisotropy for an authored model's colour textures.
 *
 * FOUR: the most a surface viewed at the game's grazing camera angles can use
 * before the renderer's own cap (three clamps to the hardware maximum at
 * upload) — past it is a sharper number on the same blurry texel. One constant
 * because every authored texture is minified under the same camera.
 */
export const RIG_TEXTURE_ANISOTROPY = 4;

/** One loaded model file: its scene graph plus the convention's accessors. */
export interface RigAsset {
  /**
   * The file's scene, at the identity transform and unparented — the shape
   * bakeRig's `authoredRoot` requires, so no placement step sits between the
   * two. Consumed as data by the bake; never added to the render graph.
   */
  readonly scene: Object3D;
  /**
   * The authored node of that name (an oar pivot, the sail, a mast). Throws
   * naming the file and the node when absent, because a missing pivot would
   * otherwise show up as an animation driving the wrong joint.
   */
  node(name: string): Object3D;
  /**
   * The position of a named Empty (a `waterline`, `fire_top`-style anchor) in
   * scene space. Throws exactly like node() when absent.
   */
  anchor(name: string): Vector3;
  /**
   * Frees the source geometries, materials and textures. Call AFTER the
   * blueprint built from this asset is disposed: the baked surfaces sample the
   * same texture objects, and freeing them first would pull the texels out
   * from under a living rig.
   */
  dispose(): void;
}

/**
 * Parses one model file over HTTP: the browser path (a plugin's preload).
 * `url` is the asset's served URL — typically a `.glb?url` import, which is
 * why client/vite.config.ts carries an assetsInclude entry for .glb files.
 */
export async function loadRigAsset(url: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createRigAsset(url, gltf.scene);
}

/**
 * Parses one model file from bytes already in hand: the Node path (a
 * verification script, a test that reads the fixture off disk). The SAME
 * GLTFLoader class and the SAME validation as loadRigAsset — the transport is
 * the only thing that differs, so a file that passes here passes there.
 */
export async function parseRigAsset(data: ArrayBuffer, label: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  return createRigAsset(label, gltf.scene);
}

function createRigAsset(label: string, scene: Object3D): RigAsset {
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
    const mapped = mappedTextureOf(material);
    if (mapped !== null) {
      // No silent fallback: an unmapped UV lookup samples the texture's first
      // texel across the whole part, which reads as a part painted one flat
      // wrong colour — a load error names the file instead.
      const geometry = (mesh as Mesh).geometry;
      if (geometry.getAttribute('uv') === undefined) {
        throw new Error(
          `rigAsset "${label}": mesh "${mesh.name || '(unnamed)'}" uses a textured material ` +
            `but carries no uv attribute`,
        );
      }
      textures.add(mapped);
    }
    const emissiveMapped = emissiveTextureOf(material);
    if (emissiveMapped !== null) {
      if ((mesh as Mesh).geometry.getAttribute('uv') === undefined) {
        throw new Error(
          `rigAsset "${label}": mesh "${mesh.name || '(unnamed)'}" uses an emissive-mapped ` +
            `material but carries no uv attribute`,
        );
      }
      textures.add(emissiveMapped);
    }
  });
  if (meshes === 0) {
    throw new Error(`rigAsset "${label}": the file contains no meshes`);
  }

  for (const texture of textures) {
    // GLTFLoader assigns sRGB to baseColor textures itself; VERIFIED here, not
    // assumed — a future exporter path (or a hand-edited file) that leaves a
    // colour texture linear would otherwise render every texel too dark, and
    // nothing downstream could tell the file from a badly painted one.
    if (texture.colorSpace !== SRGBColorSpace) texture.colorSpace = SRGBColorSpace;
    // Mipmaps on: minified under the game's overhead camera, a 256² texture
    // without them shimmers. Anisotropy from the one named constant above.
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
      // Scene space, i.e. the convention's own frame: the scene sits at the
      // identity, so this is the anchor's authored position — the number the
      // callsite measures its constants from.
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
        const mapped = mappedTextureOf(material);
        if (mapped !== null) maps.add(mapped);
        const emissiveMapped = emissiveTextureOf(material);
        if (emissiveMapped !== null) maps.add(emissiveMapped);
      });
      for (const geometry of geometries) geometry.dispose();
      for (const material of materials) material.dispose();
      // The baked surfaces sample these same texture objects (clone() shares
      // the map, it does not duplicate it), so the blueprint that reads this
      // asset must already be disposed — see the method's own doc.
      for (const map of maps) map.dispose();
    },
  };
}

/** The colour texture a material is drawn with, if it has one. */
function mappedTextureOf(material: Material): Texture | null {
  const map = (material as Material & { map?: unknown }).map;
  return isTexture(map) ? map : null;
}

/** The emissive texture a material glows with, if it has one. */
function emissiveTextureOf(material: Material): Texture | null {
  const map = (material as Material & { emissiveMap?: unknown }).emissiveMap;
  return isTexture(map) ? map : null;
}

function isTexture(value: unknown): value is Texture {
  return (
    value !== undefined &&
    value !== null &&
    (value as Texture).isTexture === true
  );
}
