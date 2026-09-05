// flattenAssetParts' contract: a loaded model's meshes, as the part list the
// static families draw. Scenes are built in memory — the adapter's subject is
// the SHAPE of a scene graph, not any particular file's bytes.

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Group,
  Mesh,
  MeshStandardMaterial,
  Object3D,
  Vector3,
} from 'three';
import { flattenAssetParts } from '../src/render/staticAsset.ts';
import type { RigAsset } from '../src/render/rigAsset.ts';

/**
 * A RigAsset around a scene built here. Only `scene` is exercised: node(),
 * anchor() and dispose() belong to rigAsset.ts's own tests, and stubbing them
 * to throw is what keeps this file honest about which of them the adapter uses.
 */
function assetOf(scene: Object3D): RigAsset {
  return {
    scene,
    node: (name: string): Object3D => {
      throw new Error(`unused in these tests: node(${name})`);
    },
    anchor: (name: string): Vector3 => {
      throw new Error(`unused in these tests: anchor(${name})`);
    },
    dispose: (): void => {},
  };
}

describe('flattenAssetParts', () => {
  it('makes ONE part with two matrices of two meshes sharing a geometry', () => {
    const scene = new Group();
    const geometry = new BoxGeometry(1, 1, 1);
    const material = new MeshStandardMaterial();
    const left = new Mesh(geometry, material);
    left.position.set(-2, 0, 0);
    const right = new Mesh(geometry, material);
    right.position.set(2, 0, 0);
    scene.add(left, right);

    const parts = flattenAssetParts(assetOf(scene));

    expect(parts).toHaveLength(1);
    expect(parts[0].geometry).toBe(geometry);
    expect(parts[0].material).toBe(material);
    expect(parts[0].localMatrices).toHaveLength(2);
  });

  it('gives each matrix the mesh\'s own world transform, parents included', () => {
    const scene = new Group();
    const pivot = new Group();
    pivot.position.set(0, 3, 0);
    const mesh = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    mesh.position.set(1, 0, 0);
    pivot.add(mesh);
    scene.add(pivot);

    const parts = flattenAssetParts(assetOf(scene));

    // updateMatrixWorld is the adapter's job, so the caller having touched
    // nothing since building the tree must not change the answer.
    expect(parts[0].localMatrices[0].elements).toEqual(mesh.matrixWorld.elements);
    const placed = new Vector3().setFromMatrixPosition(parts[0].localMatrices[0]);
    expect(placed.x).toBeCloseTo(1);
    expect(placed.y).toBeCloseTo(3);
  });

  it('skips an excluded node by name', () => {
    const scene = new Group();
    const kept = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    kept.name = 'walls';
    const drawn_elsewhere = new Mesh(new BoxGeometry(1, 1, 1), new MeshStandardMaterial());
    drawn_elsewhere.name = 'sign';
    scene.add(kept, drawn_elsewhere);

    const parts = flattenAssetParts(assetOf(scene), { exclude: ['sign'] });

    expect(parts).toHaveLength(1);
    expect(parts[0].geometry).toBe(kept.geometry);
  });
});
