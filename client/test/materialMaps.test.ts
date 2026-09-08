import { describe, expect, it } from 'vitest';
import { MeshStandardMaterial, NoColorSpace, SRGBColorSpace, Texture } from 'three';
import {
  applyMapColourSpaces,
  mapIdentitySignature,
  texturesOf,
  uvChannelsUsed,
} from '../src/render/materialMaps.ts';

const SECOND_UV_CHANNEL = 1;

function pbrMaterial(): {
  material: MeshStandardMaterial;
  base: Texture;
  normal: Texture;
  metallicRoughness: Texture;
  occlusion: Texture;
} {
  const base = new Texture();
  const normal = new Texture();
  const metallicRoughness = new Texture();
  const occlusion = new Texture();
  occlusion.channel = SECOND_UV_CHANNEL;
  const material = new MeshStandardMaterial();
  material.map = base;
  material.normalMap = normal;
  material.metalnessMap = metallicRoughness;
  material.roughnessMap = metallicRoughness;
  material.aoMap = occlusion;
  return { material, base, normal, metallicRoughness, occlusion };
}

describe('materialMaps', () => {
  it('answers for every slot of a PBR material and dedupes a shared texture', () => {
    const { material, base, normal, metallicRoughness, occlusion } = pbrMaterial();
    const textures = texturesOf(material);
    expect(new Set(textures)).toEqual(new Set([base, normal, metallicRoughness, occlusion]));
    expect(textures).toHaveLength(4);
  });

  it('owns nothing on a bare material', () => {
    const bare = new MeshStandardMaterial();
    expect(texturesOf(bare)).toEqual([]);
    expect(uvChannelsUsed(bare).size).toBe(0);
  });

  it('reports every uv channel its textures read', () => {
    const { material } = pbrMaterial();
    expect([...uvChannelsUsed(material)].sort()).toEqual([0, SECOND_UV_CHANNEL]);
  });

  it('signature-matches two materials that sample the same textures', () => {
    const a = pbrMaterial();
    const b = new MeshStandardMaterial();
    b.map = a.base;
    b.normalMap = a.normal;
    b.metalnessMap = a.metallicRoughness;
    b.roughnessMap = a.metallicRoughness;
    b.aoMap = a.occlusion;
    expect(mapIdentitySignature(b)).toBe(mapIdentitySignature(a.material));
  });

  it('separates two materials that differ only in normal map', () => {
    const a = pbrMaterial();
    const b = pbrMaterial();
    b.material.map = a.base;
    b.material.metalnessMap = a.metallicRoughness;
    b.material.roughnessMap = a.metallicRoughness;
    b.material.aoMap = a.occlusion;
    expect(mapIdentitySignature(b.material)).not.toBe(mapIdentitySignature(a.material));
  });

  it('separates the same texture read through a different uv channel', () => {
    const one = new MeshStandardMaterial();
    const other = new MeshStandardMaterial();
    const shared = new Texture();
    one.map = shared;
    other.map = shared;
    const signature = mapIdentitySignature(one);
    shared.channel = SECOND_UV_CHANNEL;
    expect(mapIdentitySignature(other)).not.toBe(signature);
  });

  it('puts colour slots in sRGB and data slots back to linear', () => {
    const { material, base, normal } = pbrMaterial();
    base.colorSpace = NoColorSpace;
    normal.colorSpace = SRGBColorSpace;
    applyMapColourSpaces(material);
    expect(base.colorSpace).toBe(SRGBColorSpace);
    expect(normal.colorSpace).toBe(NoColorSpace);
  });
});
