// What the bake does with a full PBR material (client/src/render/rigSkin.ts).
//
// The differential pose test lives in rigSkin.test.ts; this file guards the
// three ways a textured asset could bake into something that still LOOKS
// plausible: parts merged that must not be, a uv set stripped that a map needs,
// and an armature's own weights thrown away at its bind pose.
//
// Headless: real Three.js objects, no WebGLRenderer.

import { describe, expect, it } from 'vitest';
import {
  BoxGeometry,
  Bone,
  BufferAttribute,
  Group,
  Mesh,
  MeshStandardMaterial,
  Skeleton,
  SkinnedMesh,
  Texture,
} from 'three';
import { bakeRig } from '../src/render/rigSkin.ts';

/** The uv channel an occlusion map on glTF `texCoord: 1` reads. */
const SECOND_UV_CHANNEL = 1;

/** Bones per vertex in three's skin attributes, as rigSkin.ts writes them. */
const SKIN_INFLUENCES = 4;

/** A weight split no dominant-weight rigidify could reproduce: the seam case. */
const SHOULDER_SHARE = 0.6;
/** Components per uv, for the second set copied below. */
const UV_COMPONENTS = 2;

/** A box part carrying `uv` (BoxGeometry emits one) at the given offset. */
function part(material: MeshStandardMaterial, x: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.position.set(x, 0, 0);
  return mesh;
}

/** Copies the geometry's `uv` into `uv1`, the way an exporter writes a second set. */
function addSecondUvSet(mesh: Mesh): void {
  const uv = mesh.geometry.getAttribute('uv');
  const copy = new Float32Array(uv.count * UV_COMPONENTS);
  for (let v = 0; v < uv.count; v++) {
    copy[v * UV_COMPONENTS] = uv.getX(v);
    copy[v * UV_COMPONENTS + 1] = uv.getY(v);
  }
  mesh.geometry.setAttribute('uv1', new BufferAttribute(copy, UV_COMPONENTS));
}

describe('bakeRig with PBR materials', () => {
  it('does not merge two parts that differ only in normal map', () => {
    const base = new Texture();
    const one = new MeshStandardMaterial({ map: base, normalMap: new Texture() });
    const other = new MeshStandardMaterial({ map: base, normalMap: new Texture() });
    const root = new Group();
    root.add(part(one, -1));
    root.add(part(other, 1));
    const blueprint = bakeRig(root);
    // Two draws, because a merged surface takes ONE material: merging these
    // would shade both parts with whichever normal map arrived first.
    expect(blueprint.surfaceCount).toBe(2);
    blueprint.dispose();
  });

  it('keeps uv1 for a map that reads the second uv set', () => {
    const occlusion = new Texture();
    occlusion.channel = SECOND_UV_CHANNEL;
    const material = new MeshStandardMaterial({ map: new Texture(), aoMap: occlusion });
    const mesh = part(material, 0);
    addSecondUvSet(mesh);
    const root = new Group();
    root.add(mesh);
    const blueprint = bakeRig(root);
    const geometry = blueprint.surfaces[0]!.geometry;
    expect(geometry.getAttribute('uv')).toBeDefined();
    expect(geometry.getAttribute('uv1')).toBeDefined();
    blueprint.dispose();
  });

  it('drops a uv set nothing samples', () => {
    // A stray second set would split every merge with a part that lacks one.
    const mesh = part(new MeshStandardMaterial({ map: new Texture() }), 0);
    addSecondUvSet(mesh);
    const root = new Group();
    root.add(mesh);
    const blueprint = bakeRig(root);
    expect(blueprint.surfaces[0]!.geometry.getAttribute('uv1')).toBeUndefined();
    blueprint.dispose();
  });

  it('throws for a part whose material samples a uv set the part lacks', () => {
    const occlusion = new Texture();
    occlusion.channel = SECOND_UV_CHANNEL;
    const root = new Group();
    root.add(part(new MeshStandardMaterial({ aoMap: occlusion }), 0));
    expect(() => bakeRig(root)).toThrow(/uv channel 1.*no uv1 attribute/s);
  });

  it('keeps an armature-bound part\u2019s own four weights, remapped onto the baked bones', () => {
    // The seam fix (2026-09-04): a vertex shared 60/40 across a joint must bake
    // as 60/40, on the two bones the bake collected, not wholly onto one.
    const geometry = new BoxGeometry(1, 1, 1);
    const vertices = geometry.getAttribute('position').count;
    const indices = new Uint16Array(vertices * SKIN_INFLUENCES);
    const weights = new Float32Array(vertices * SKIN_INFLUENCES);
    for (let v = 0; v < vertices; v++) {
      indices[v * SKIN_INFLUENCES + 1] = 1;
      weights[v * SKIN_INFLUENCES] = SHOULDER_SHARE;
      weights[v * SKIN_INFLUENCES + 1] = 1 - SHOULDER_SHARE;
    }
    geometry.setAttribute('skinIndex', new BufferAttribute(indices, SKIN_INFLUENCES));
    geometry.setAttribute('skinWeight', new BufferAttribute(weights, SKIN_INFLUENCES));

    const upper = new Bone();
    const lower = new Bone();
    upper.add(lower);
    const skinned = new SkinnedMesh(geometry, new MeshStandardMaterial());
    const root = new Group();
    root.add(upper);
    root.add(skinned);
    skinned.bind(new Skeleton([upper, lower]));

    const blueprint = bakeRig(root);
    const baked = blueprint.surfaces[0]!.geometry;
    // Depth-first from the root: root 0, upper 1, lower 2, skinned 3.
    expect(baked.getAttribute('skinIndex').getX(0)).toBe(1);
    expect(baked.getAttribute('skinIndex').getY(0)).toBe(2);
    expect(baked.getAttribute('skinWeight').getX(0)).toBeCloseTo(SHOULDER_SHARE);
    expect(baked.getAttribute('skinWeight').getY(0)).toBeCloseTo(1 - SHOULDER_SHARE);
    blueprint.dispose();
  });
});
