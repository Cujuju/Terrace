// The contract between an imported model file and this plugin's pool.
//
// THREE THINGS, and deliberately nothing per-species beyond them: whether the
// deer's antlers are the right shape is a question for a picture
// (client/preview-species.html), not for an assertion. What a picture is bad at
// is (1) that every joint the walk drives survives the bake, (2) that the
// buffers are freed in the one order that is safe, and (3) how many draw calls
// the file costs — the number ../client/index.ts budgets against.
//
// The asset is read off disk and parsed with parseRigAsset: under Vitest there
// is no Vite pipeline and no `.glb?url` import, and this is the SAME GLTFLoader
// class and the SAME validation the browser's loadRigAsset runs — transport
// aside, a file that passes here passes there. Same recipe as
// plugins/boats/test/models.test.ts.

import { describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import type { BufferGeometry, Mesh } from 'three';
import { bakeRig } from '../../../client/src/render/rigSkin.ts';
import { parseRigAsset, type RigAsset } from '../../../client/src/render/rigAsset.ts';
import { createWildlifeModels } from '../client/models.ts';
import {
  GRAZER_HEAD_JOINT_NAME,
  GRAZER_LEG_JOINT_NAMES,
  buildGrazer,
} from '../client/species/grazer.ts';
import type { SpeciesModelPool } from '../client/species/speciesModel.ts';

const assetUrl = new URL('../client/assets/grazer-deer.glb', import.meta.url);
const assetBuffer = await readFile(assetUrl);
const assetBytes = assetBuffer.buffer.slice(
  assetBuffer.byteOffset,
  assetBuffer.byteOffset + assetBuffer.byteLength,
);

/**
 * A fresh parse per test: building a species RE-PARENTS the asset's nodes (the
 * rig wrap and the axis pivots), so two tests sharing one asset would not be
 * testing the same thing.
 */
function loadAsset(): Promise<RigAsset> {
  return parseRigAsset(assetBytes.slice(0), 'grazer-deer.glb');
}

/**
 * A pool that fails if it is used. An asset-sourced species draws with the
 * geometries and materials the FILE brought; anything it took from the pool
 * would be pool-owned and freed on the pool's schedule, which is the ownership
 * split this whole contract exists to keep straight.
 */
const unusedPool: SpeciesModelPool = new Proxy({} as SpeciesModelPool, {
  get(_target, property): never {
    throw new Error(`an asset species must not ask the pool for ${String(property)}`);
  },
});

/** One creature of each species is enough to bake and herd every one of them. */
const ONE_OF_EACH = 1;

describe('an asset-sourced species', () => {
  it('bakes with every joint its animation drives', async () => {
    const asset = await loadAsset();
    const authored = buildGrazer(asset, unusedPool);
    const blueprint = bakeRig(authored.root);

    // `rig` is required of every species (speciesModel.ts) — the walk bob acts
    // on it — and the legs and head are what poseWalk addresses by name.
    for (const name of ['rig', ...GRAZER_LEG_JOINT_NAMES, GRAZER_HEAD_JOINT_NAME]) {
      const node = authored.joints[name];
      expect(node, `joint "${name}" is missing from the authored species`).toBeDefined();
      expect(blueprint.jointIndex(node!)).toBeGreaterThanOrEqual(0);
    }

    blueprint.dispose();
    asset.dispose();
  });

  it('costs one draw call, because its materials differ only in colour', async () => {
    const asset = await loadAsset();
    const materials = new Set<unknown>();
    asset.scene.traverse((child) => {
      if ((child as Partial<Mesh>).isMesh === true) materials.add((child as Mesh).material);
    });
    // The file really does carry several materials — otherwise the assertion
    // below would be true for an uninteresting reason.
    expect(materials.size).toBeGreaterThan(1);

    const blueprint = bakeRig(buildGrazer(asset, unusedPool).root);
    // rigSkin's materialSignature leaves COLOUR out on purpose (a vertex colour
    // attribute carries it), so materials that agree on everything else merge.
    // This is the number ../client/index.ts's GRAZER_ASSET_DRAW_OBJECTS states.
    expect(blueprint.surfaceCount).toBe(1);

    blueprint.dispose();
    asset.dispose();
  });
});

describe('the pool that owns an asset-sourced species', () => {
  it('frees the baked surfaces before the asset they sample', async () => {
    const asset = await loadAsset();
    const order: string[] = [];
    const disposeAsset = asset.dispose.bind(asset);
    const spiedAsset: RigAsset = {
      ...asset,
      node: asset.node,
      anchor: asset.anchor,
      dispose(): void {
        order.push('asset');
        disposeAsset();
      },
    };

    const models = createWildlifeModels(ONE_OF_EACH, { grazer: spiedAsset });
    // three's BufferGeometry dispatches a `dispose` event, so the baked
    // surfaces report their own freeing — no spy on an internal is needed.
    for (const object of models.objects) {
      const geometry = (object as Mesh).geometry as BufferGeometry;
      geometry.addEventListener('dispose', () => order.push('surface'));
    }
    expect(models.objects.length).toBeGreaterThan(0);

    models.dispose();

    expect(order).toContain('asset');
    expect(order).toContain('surface');
    // EVERY surface first: an asset freed earlier would pull the texels out
    // from under a rig that is still alive (rigAsset.ts, RigAsset.dispose).
    expect(order.lastIndexOf('surface')).toBeLessThan(order.indexOf('asset'));
  });
});
