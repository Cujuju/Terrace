// The contract between a DOWNLOADED, `--rigidify`-converted model file and
// this plugin's asset-species path.
//
// WHY THE GRAZER AND NOT THE FISH. fish.glb is built by a script in this repo
// (tools/blender/build_fish.py) straight to the convention; grazer-deer.glb is
// somebody else's armature put through tools/blender/import_model.py, and the
// conversion is the half of ../client/species/assetSpecies.ts that a built
// asset never exercises. So these tests are about the converted path only.
//
// DELIBERATELY NOT TESTED HERE: whether the deer looks like a deer. That is a
// question for a picture (client/preview-species.html), and the pictures are in
// .model-import/shots/wildlife. What a picture is bad at is (1) that every
// joint the walk drives survives the bake, (2) that preparing the file is done
// once rather than once per bake, (3) how many draw calls the file costs — the
// number ../client/index.ts budgets against — and (4) that an install frees
// what it replaces.
//
// The asset is read off disk and parsed with parseRigAsset: under Vitest there
// is no Vite pipeline and no `.glb?url` import, and this is the SAME GLTFLoader
// class and the SAME validation the browser's loadRigAsset runs — transport
// aside, a file that passes here passes there. Same recipe as
// plugins/boats/test/models.test.ts.

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

/**
 * A fresh parse per install: installing PREPARES the file in place (the rig
 * wrap, the model-axis pivots, the adoptions), so two installs sharing one
 * parsed asset would not be installing the same thing.
 */
function loadAsset(): Promise<RigAsset> {
  return parseRigAsset(assetBytes.slice(0), 'grazer-deer.glb');
}

/**
 * A pool that fails if it is used. An asset-sourced species draws with the
 * geometries and materials the FILE brought; anything it took from the pool
 * would be pool-owned and freed on the pool's schedule, which is the ownership
 * split assetSpecies.ts's header sets out.
 */
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
    // `rig` is the one the file does NOT carry: it is wrapped around the
    // scene at install, and every animation moves it.
    expect(GRAZER_ASSET.joints).toContain('rig');
    expect(() => GRAZER_ASSET.joints.includes('rig') && authored.joints.rig!.name).not.toThrow();

    blueprint.dispose();
  });

  it('is prepared once, so a second bake gets the same tree rather than a nested one', async () => {
    installSpeciesAsset(GRAZER_ASSET, await loadAsset());
    const first = buildGrazer(unusedPool);
    const firstBox = new Box3().setFromObject(first.root).getSize(new Vector3());

    const second = buildGrazer(unusedPool);
    // Same objects, not merely equivalent ones: preparing per build would wrap
    // a second rig and hang a second pivot off every joint, and the model would
    // drift a little further from its rest pose on every bake.
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
    // The file really does carry several materials — otherwise the assertion
    // below would be true for an uninteresting reason.
    expect(materials.size).toBeGreaterThan(1);

    const blueprint = bakeRig(authored.root);
    // rigSkin's materialSignature leaves COLOUR out on purpose (a vertex colour
    // attribute carries it), so materials that agree on everything else merge.
    // This is the number ../client/index.ts's GRAZER_ASSET_DRAW_OBJECTS states.
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
    // A plugin remount installs over the previous mount's file; the old one
    // must not be left holding GPU buffers nobody can reach.
    installSpeciesAsset(GRAZER_ASSET, spy(await loadAsset(), 'second'));
    expect(freed).toEqual(['first']);

    disposeSpeciesAssets();
    expect(freed).toEqual(['first', 'second']);
  });
});
