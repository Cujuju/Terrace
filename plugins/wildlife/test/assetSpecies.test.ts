import { afterEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { Box3, Vector3, type Mesh } from 'three';
import { bakeRig } from '../../../client/src/render/rigSkin.ts';
import { parseRigAsset, type RigAsset } from '../../../client/src/render/rigAsset.ts';
import {
  disposeSpeciesAssets,
  installSpeciesAsset,
} from '../client/species/assetSpecies.ts';
import { GRAZER_ASSET, buildGrazer } from '../client/species/grazer.ts';
import type { SpeciesModelPool } from '../client/species/speciesModel.ts';

const assetUrl = new URL('../client/assets/grazer-deer.glb', import.meta.url);
const assetBuffer = await readFile(assetUrl);
const assetBytes = assetBuffer.buffer.slice(
  assetBuffer.byteOffset,
  assetBuffer.byteOffset + assetBuffer.byteLength,
);

function loadAsset(): Promise<RigAsset> {
  return parseRigAsset(assetBytes.slice(0), 'grazer-deer.glb');
}

const unusedPool: SpeciesModelPool = new Proxy({} as SpeciesModelPool, {
  get(_target, property): never {
    throw new Error(`an asset species must not ask the pool for ${String(property)}`);
  },
});

afterEach(() => {
  disposeSpeciesAssets();
});

describe('a converted (--rigidify) asset species', () => {
  it('bakes with every joint its animation drives, the synthesised rig included', async () => {
    installSpeciesAsset(GRAZER_ASSET, await loadAsset());
    const authored = buildGrazer(unusedPool);
    const blueprint = bakeRig(authored.root);

    for (const name of GRAZER_ASSET.joints) {
      const node = authored.joints[name];
      expect(node, `joint "${name}" is missing from the authored species`).toBeDefined();
      expect(blueprint.jointIndex(node!)).toBeGreaterThanOrEqual(0);
    }
    expect(GRAZER_ASSET.joints).toContain('rig');
    expect(() => GRAZER_ASSET.joints.includes('rig') && authored.joints.rig!.name).not.toThrow();

    blueprint.dispose();
  });

  it('is prepared once, so a second bake gets the same tree rather than a nested one', async () => {
    installSpeciesAsset(GRAZER_ASSET, await loadAsset());
    const first = buildGrazer(unusedPool);
    const firstBox = new Box3().setFromObject(first.root).getSize(new Vector3());

    const second = buildGrazer(unusedPool);
    expect(second.root).toBe(first.root);
    for (const name of GRAZER_ASSET.joints) {
      expect(second.joints[name]).toBe(first.joints[name]);
    }
    const secondBox = new Box3().setFromObject(second.root).getSize(new Vector3());
    expect(secondBox.x).toBeCloseTo(firstBox.x, 6);
    expect(secondBox.y).toBeCloseTo(firstBox.y, 6);
    expect(secondBox.z).toBeCloseTo(firstBox.z, 6);
  });

  it('costs one draw call, because its materials differ only in colour', async () => {
    installSpeciesAsset(GRAZER_ASSET, await loadAsset());
    const authored = buildGrazer(unusedPool);
    const materials = new Set<unknown>();
    authored.root.traverse((child) => {
      if ((child as Partial<Mesh>).isMesh === true) materials.add((child as Mesh).material);
    });
    expect(materials.size).toBeGreaterThan(1);

    const blueprint = bakeRig(authored.root);
    expect(blueprint.surfaceCount).toBe(1);
    blueprint.dispose();
  });
});

describe('installing a species asset', () => {
  it('frees the one it replaces, and frees everything on disposeSpeciesAssets', async () => {
    const first = await loadAsset();
    const freed: string[] = [];
    const spy = (asset: RigAsset, label: string): RigAsset => ({
      ...asset,
      node: asset.node,
      anchor: asset.anchor,
      dispose(): void {
        freed.push(label);
        asset.dispose();
      },
    });

    installSpeciesAsset(GRAZER_ASSET, spy(first, 'first'));
    expect(freed).toEqual([]);
    installSpeciesAsset(GRAZER_ASSET, spy(await loadAsset(), 'second'));
    expect(freed).toEqual(['first']);

    disposeSpeciesAssets();
    expect(freed).toEqual(['first', 'second']);
  });
});
