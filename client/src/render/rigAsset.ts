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
// (bakeRig cannot bake a multi-material part), the file carries no armature
// (see RIGIDIFY_INSTRUCTION), and every mesh MUST carry the uv attribute for
// EVERY uv channel its material samples — a textured part with no UVs is a
// load error naming the file, never an untextured fallback.
//
// THE FULL glTF MATERIAL SET IS SUPPORTED. Which slots a material can carry,
// which of them are colour data and which are numbers, and which uv channel
// each reads is the business of ./materialMaps.ts — this file asks it and
// never keeps a slot list of its own (see that module's header for why).

import {
  Box3,
  MeshStandardMaterial,
  Vector3,
  type Material,
  type Mesh,
  type Object3D,
  type Texture,
} from 'three';
// Shipped inside the `three` package itself (see its package.json "exports"),
// not a separate dependency — the same reach rigSkin.ts already makes.
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
export async function loadRigAsset(url: string, environment: Texture | null): Promise<RigAsset> {
  const gltf = await new GLTFLoader().loadAsync(url);
  return createRigAsset(url, gltf.scene, environment);
}

/**
 * Parses one model file from bytes already in hand: the Node path (a
 * verification script, a test that reads the fixture off disk). The SAME
 * GLTFLoader class and the SAME validation as loadRigAsset — the transport is
 * the only thing that differs, so a file that passes here passes there.
 */
export async function parseRigAsset(data: ArrayBuffer, label: string): Promise<RigAsset> {
  const gltf = await new GLTFLoader().parseAsync(data, '');
  // No environment on the node path: there is no renderer to have built one,
  // and nothing here is drawn.
  return createRigAsset(label, gltf.scene, null);
}

/**
 * `environment` — the prefiltered sky (render/skyEnvironment.ts) every
 * PBR material in the file is pointed at, or null to leave the file lit by
 * the lamps alone. Set HERE, on the source materials, so every clone and every
 * bake made from the asset inherits it without a second wiring step.
 */
function createRigAsset(label: string, scene: Object3D, environment: Texture | null): RigAsset {
  scene.updateMatrixWorld(true);

  let meshes = 0;
  const textures = new Set<Texture>();
  scene.traverse((child) => {
    // An armature is rejected at LOAD, not at bake: the bake would otherwise
    // consume the skinned mesh at its bind pose with the joints thrown away,
    // which draws as a creature frozen mid-T-pose — art that looks authored
    // wrong rather than loaded wrong.
    assertNotSkinned(label, child);
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
    // texel across the whole part, which reads as a part painted one flat
    // wrong colour — a load error names the file instead. Asked per CHANNEL,
    // because a file is free to put its occlusion map on the second uv set
    // (glTF `texCoord: 1`) and `uv` alone would not cover it.
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
    // GLTFLoader assigns the colour spaces itself for the files IT writes;
    // VERIFIED here, not assumed — a hand-edited file, or another exporter,
    // that leaves a colour texture linear renders every texel too dark, and a
    // data texture marked sRGB has every value gamma-decoded before it is used
    // as a number. Nothing downstream could tell either from bad art.
    applyMapColourSpaces(material);
    for (const texture of texturesOf(material)) textures.add(texture);
  });
  if (meshes === 0) {
    throw new Error(`rigAsset "${label}": the file contains no meshes`);
  }

  for (const texture of textures) {
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
        for (const texture of texturesOf(material)) maps.add(texture);
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

/**
 * What a file with an armature has to be told, verbatim, wherever one is found.
 *
 * ONE SENTENCE IN ONE PLACE because it is a CONTRACT with the authoring
 * pipeline, not an error message: the rig kit binds every vertex rigidly to the
 * node it was authored under (see rigSkin's header), so a skinned mesh has to
 * be turned back into a node tree before it can be baked, and the tool that
 * does it is named here so the message is the whole fix.
 */
export const RIGIDIFY_INSTRUCTION =
  'the asset must be rigidified — run tools/blender/import_model.py --rigidify';

/**
 * Throws when a node is a bone or a skinned mesh — the only two ways an
 * armature shows up IN a scene graph (a Skeleton is not an Object3D; it hangs
 * off the SkinnedMesh, which this catches).
 *
 * Checked by three's own `is*` flags rather than by `instanceof`, so a node
 * that arrived through a different copy of three (a bundler resolving two) is
 * still caught.
 */
function assertNotSkinned(label: string, node: Object3D): void {
  const skinned = node as Object3D & { isBone?: boolean; isSkinnedMesh?: boolean };
  if (skinned.isBone !== true && skinned.isSkinnedMesh !== true) return;
  throw new Error(
    `rigAsset "${label}": node "${node.name || '(unnamed)'}" is part of an armature — ` +
      RIGIDIFY_INSTRUCTION,
  );
}

/**
 * How far past its footprint a model may reach before it is rejected at load.
 *
 * Two hundredths of a cell: the fit is AUTHORED, not fitted — the number only
 * absorbs float dust in the bounding box (a loft's vertices are computed, so
 * the box edge lands a few ulps either side of the intended dimension), never
 * a real overhang. It began life as boats' BOAT_FIT_TOLERANCE_CELLS and is
 * shared because the reason for it has nothing to do with boats.
 */
export const ASSET_FIT_TOLERANCE_CELLS = 0.02;

/** A footprint in cells. `y` is optional: most callers budget only the ground area. */
export interface AssetFootprintCells {
  readonly x: number;
  readonly z: number;
  readonly y?: number;
}

/**
 * Throws unless the model's bounding box fits the footprint it was authored for.
 *
 * WHY EVERY ASSET NEEDS THIS AND WHY IT IS NOT IN createRigAsset: the loader
 * cannot know what a file is FOR — a boat gets one cell, a temple gets its
 * own plan — so the budget is the callsite's to state, but the measurement and
 * the tolerance are not, and a callsite writing its own Box3 is a callsite that
 * can forget an axis. World-object fidelity is a standing rule: a structure
 * that overruns its ground footprint reads as art hanging off its own plot.
 */
export function assertAssetFits(
  asset: RigAsset,
  footprint: AssetFootprintCells,
  toleranceCells: number = ASSET_FIT_TOLERANCE_CELLS,
): void {
  // The box is taken in world space, so a scene whose nodes carry transforms
  // must have them resolved first — cheap, and the caller may have moved
  // nothing since the load.
  asset.scene.updateMatrixWorld(true);
  const size = new Box3().setFromObject(asset.scene).getSize(new Vector3());
  const overruns: string[] = [];
  const check = (axis: string, measured: number, budget: number | undefined): void => {
    if (budget === undefined) return;
    if (measured > budget + toleranceCells) {
      overruns.push(`${axis} ${measured.toFixed(3)} > ${budget}`);
    }
  };
  check('x', size.x, footprint.x);
  check('y', size.y, footprint.y);
  check('z', size.z, footprint.z);
  if (overruns.length > 0) {
    throw new Error(
      `rigAsset: the model overruns its authored footprint in cells ` +
        `(${overruns.join('; ')}, tolerance ${toleranceCells})`,
    );
  }
}
