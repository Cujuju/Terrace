// Turning a loaded model file into the part list the STATIC families draw.
//
// WHY THIS EXISTS. There are two ways a plugin puts an authored model on the
// screen. A creature or a boat BAKES it (./rigSkin.ts): the node tree becomes
// one skinned mesh whose joints the plugin animates. A building, a tree, a
// relic or a crop never animates and never exists once — it exists five
// hundred times, at five hundred cells, and it is drawn as one InstancedMesh
// per (geometry, material) with one instance per placement. That family's unit
// is not a rig; it is `{geometry, material, localMatrices}`, and this module is
// the whole of the translation from a loaded file into a list of them.
//
// THE SHAPE IS DELIBERATELY THE PLUGIN'S OWN. `AssetPart` below is field-for-
// field plugins/structures/client/parts.ts's `StructurePart`, so an
// `AssetPart[]` is accepted wherever a `StructurePart[]` is, with no cast and
// no adapter at the callsite. It is DECLARED here rather than imported because
// the render kit may not import from a plugin — the kit is what every plugin
// builds against, and a kit that reached into one of them would make that
// plugin undeletable (see plugins/*/client's own "build with every other
// plugin deleted" rule). Two structurally identical declarations is the price
// of that direction, and the field names are load-bearing: rename one here
// without renaming the other and the two stop being assignable.
//
// WHAT IT DOES NOT DO, ALSO DELIBERATELY: it does not bake the local matrices
// into the geometry and it does not merge anything. The consumer already has a
// merge that is better informed than this one could be — structures' own
// mergeParts() knows which of ITS materials may share a vertex-coloured
// surface — so flattening here would only take a decision away from the one
// place that can make it. This module's whole job is the SHAPE change.

import { Matrix4, type BufferGeometry, type Material, type Mesh, type Object3D } from 'three';
import type { RigAsset } from './rigAsset.ts';

/**
 * One drawable part of a static model: a geometry, its material, and every
 * place the model puts it.
 *
 * Structurally identical to plugins/structures/client/parts.ts's
 * `StructurePart` — see this module's header for why it is redeclared rather
 * than imported, and why the field names must not drift.
 */
export interface AssetPart {
  readonly geometry: BufferGeometry;
  readonly material: Material;
  /** One matrix per instance this part contributes, per placement of the model. */
  readonly localMatrices: Matrix4[];
}

/** What to leave out of the flattened list. */
export interface FlattenAssetOptions {
  /**
   * Node names to skip, matched on `Object3D.name`.
   *
   * Not for anchors — an anchor is an Empty and carries no mesh, so it never
   * reaches the output anyway. This is for a mesh the plugin draws for itself:
   * a sail it recolours per instance, a sign it animates, a door it opens.
   */
  readonly exclude?: readonly string[];
}

/**
 * Every drawable mesh of a loaded asset, as static parts.
 *
 * OWNERSHIP — the one rule a caller must keep. The geometries, materials and
 * textures handed back are the ASSET'S, not copies: `asset.dispose()` is what
 * frees them, and a caller that disposes one of them frees it out from under
 * the file it came from (and under any other consumer of the same asset). So:
 *
 *   * never dispose a returned geometry or material;
 *   * anything BUILT from them — an InstancedMesh, a merged copy — must be
 *     disposed BEFORE `asset.dispose()` runs;
 *   * a consumer whose own pipeline disposes what it is given (structures'
 *     mergeParts() does exactly that) must hand it CLONES, not these.
 *
 * This is the same rule boats keeps between its baked blueprint and its asset
 * (see rigAsset.ts's `dispose` doc): the asset outlives everything built from
 * it, and dies last.
 *
 * ONE PART PER GEOMETRY OBJECT, NOT PER MESH. Two meshes sharing one geometry
 * — the same shutter placed on both gable ends, the same barrel four times —
 * are one part with two matrices, which is precisely what `localMatrices`
 * exists for: one InstancedMesh, two instances, rather than two meshes that
 * happen to hold the same buffer. Meshes that share a geometry but not a
 * material stay separate, because a part is a (geometry, material) pair.
 */
export function flattenAssetParts(
  asset: RigAsset,
  options: FlattenAssetOptions = {},
): AssetPart[] {
  // World matrices are what a part's local matrix IS: the asset's scene sits at
  // the identity (rigAsset.ts's `scene` doc), so a mesh's world matrix is its
  // placement in the model's own frame. Resolved here rather than trusted,
  // because a caller may have touched a node between load and flatten.
  asset.scene.updateMatrixWorld(true);

  const excluded = new Set(options.exclude ?? []);
  const parts: AssetPart[] = [];
  // Keyed by geometry AND material: sharing a geometry is what merges two
  // meshes into one part, but only while they are drawn with the same material.
  const partsByGeometry = new Map<BufferGeometry, AssetPart[]>();

  asset.scene.traverse((child: Object3D) => {
    if (excluded.has(child.name)) return;
    const mesh = child as Partial<Mesh> & Object3D;
    if (mesh.isMesh !== true) return;
    const material = (mesh as Mesh).material as Material | Material[];
    // ASSERTED, NOT RE-IMPLEMENTED: createRigAsset already rejects a
    // multi-material mesh at load, naming the file (rigAsset.ts). This catches
    // only an asset that never went through that door — a hand-assembled
    // scene in a test — and says so rather than silently drawing the first
    // material over the whole part.
    if (Array.isArray(material)) {
      throw new Error(
        `flattenAssetParts: mesh "${mesh.name || '(unnamed)'}" has several materials — ` +
          `it cannot be one part; load the asset through rigAsset.ts, which rejects this`,
      );
    }
    const geometry = (mesh as Mesh).geometry as BufferGeometry;
    const local = child.matrixWorld.clone();

    const sharing = partsByGeometry.get(geometry);
    const existing = sharing?.find((part) => part.material === material);
    if (existing !== undefined) {
      existing.localMatrices.push(local);
      return;
    }
    const part: AssetPart = { geometry, material, localMatrices: [local] };
    parts.push(part);
    if (sharing === undefined) partsByGeometry.set(geometry, [part]);
    else sharing.push(part);
  });

  if (parts.length === 0) {
    // The same "no silent fallback" rule the loader keeps: an empty part list
    // draws as nothing at all, which reads as a plugin that forgot to place
    // its buildings rather than as an asset whose meshes were all excluded.
    throw new Error(
      `flattenAssetParts: the asset has no drawable mesh left ` +
        `(excluded: ${[...excluded].join(', ') || 'none'})`,
    );
  }
  return parts;
}
