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

const SECOND_UV_CHANNEL = 1;

const SKIN_INFLUENCES = 4;

const SHOULDER_SHARE = 0.6;
const UV_COMPONENTS = 2;

function part(material: MeshStandardMaterial, x: number): Mesh {
  const mesh = new Mesh(new BoxGeometry(1, 1, 1), material);
  mesh.position.set(x, 0, 0);
  return mesh;
}

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
    expect(baked.getAttribute('skinIndex').getX(0)).toBe(1);
    expect(baked.getAttribute('skinIndex').getY(0)).toBe(2);
    expect(baked.getAttribute('skinWeight').getX(0)).toBeCloseTo(SHOULDER_SHARE);
    expect(baked.getAttribute('skinWeight').getY(0)).toBeCloseTo(1 - SHOULDER_SHARE);
    blueprint.dispose();
  });
});
