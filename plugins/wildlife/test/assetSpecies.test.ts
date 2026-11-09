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
import { HUMPBACK_ASSET } from '../client/species/humpback.ts';
import { BLUE_WHALE_ASSET } from '../client/species/blueWhale.ts';
import { SPERM_WHALE_ASSET } from '../client/species/spermWhale.ts';
import { SHARK_ASSET } from '../client/species/shark.ts';
import { modelScaleFor } from '../client/modelScale.ts';
import { SEA_SURFACE_WORLD_Y, swimProfileOf, swimmerSeabedY } from '../client/placement.ts';
import { erodedSamplerFor, hullHalfBeamCellsOf, isHullPoseValid } from '../server/hull.ts';
import { walkerProfileOf, type HabitatWorld } from '../server/census.ts';
import { SHARK_AUTHORED_BOUNDS, sharkMaxGroundHeight } from '../swimmerBounds.ts';
import { WILDLIFE_SIZE_CLASSES } from '../protocol.ts';
import { WORLD_UNITS_PER_BAND, bandLevelHeight, drawnBandOfSample } from '@terrace/shared';

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

// Retain geometry, transforms and skinning; texture decoding is outside these bounds checks.
function geometryOnlyGlb(bytes: Buffer): ArrayBuffer {
  const jsonLength = bytes.readUInt32LE(12);
  const gltf = JSON.parse(bytes.subarray(20, 20 + jsonLength).toString()) as {
    materials?: unknown[]; images?: unknown[]; textures?: unknown[]; samplers?: unknown[];
    extensionsUsed?: string[]; extensionsRequired?: string[];
  };
  const stripTextures = (value: unknown): void => {
    if (typeof value !== 'object' || value === null) return;
    const record = value as Record<string, unknown>;
    for (const key of Object.keys(record)) {
      if (key.endsWith('Texture')) delete record[key];
      else stripTextures(record[key]);
    }
  };
  for (const material of gltf.materials ?? []) stripTextures(material);
  delete gltf.images;
  delete gltf.textures;
  delete gltf.samplers;
  for (const key of ['extensionsUsed', 'extensionsRequired'] as const) {
    if (gltf[key]) gltf[key] = gltf[key].filter((extension) => extension !== 'KHR_texture_basisu');
  }
  const json = Buffer.from(JSON.stringify(gltf));
  const padded = Buffer.alloc(Math.ceil(json.length / 4) * 4, ' ');
  json.copy(padded);
  const binary = bytes.subarray(28 + jsonLength);
  const result = Buffer.alloc(28 + padded.length + binary.length);
  bytes.copy(result, 0, 0, 12);
  result.writeUInt32LE(result.length, 8);
  result.writeUInt32LE(padded.length, 12);
  result.writeUInt32LE(0x4e4f534a, 16);
  padded.copy(result, 20);
  result.writeUInt32LE(binary.length, 20 + padded.length);
  result.writeUInt32LE(0x004e4942, 24 + padded.length);
  binary.copy(result, 28 + padded.length);
  return Uint8Array.from(result).buffer;
}

describe('physical swimmer bounds', () => {
  it('validates full bounds against every shipped whale body and shark, including fins', async () => {
    for (const spec of [HUMPBACK_ASSET, BLUE_WHALE_ASSET, SPERM_WHALE_ASSET, SHARK_ASSET]) {
      const bytes = await readFile(new URL(`../client/assets/${spec.file}`, import.meta.url));
      const asset = await parseRigAsset(geometryOnlyGlb(bytes), spec.file);
      if (spec.bounds!.halfWidth > spec.envelope.halfWidth) {
        expect(() => installSpeciesAsset({
          ...spec, bounds: { ...spec.bounds!, halfWidth: spec.envelope.halfWidth },
        }, asset)).toThrow('full width');
      }
      installSpeciesAsset(spec, asset);
      const box = new Box3().setFromObject(asset.scene);
      expect(Math.max(-box.min.z, box.max.z)).toBeCloseTo(spec.bounds!.halfWidth, 5);
    }
  });

  it('rejects a broad shore intersecting the actual humpback fin on both server and client', () => {
    const centre = 32.5;
    const shore = 35;
    const world: HabitatWorld = {
      worldSize: 64, chunksPerEdge: 4,
      heightAt: (_x, y) => Math.floor(y) >= shore ? bandLevelHeight(1) : -400,
      isCellUnlocked: () => true, isChunkUnlocked: () => true,
    };
    const id = 3;
    const profile = swimProfileOf('whale', id)!;
    const scale = modelScaleFor('whale', 'medium', id);
    expect(profile.halfWidth * scale * 4).toBeGreaterThan(shore - centre);
    expect(hullHalfBeamCellsOf('whale', 'medium', id)).toBeCloseTo(profile.halfWidth * scale * 4);
    expect(isHullPoseValid(world, erodedSamplerFor(world, 'whale', 'medium', id), 'whale', 'medium', centre, centre, 0, id)).toBe(false);
    expect(swimmerSeabedY((_x, y) => y >= shore ? 0.25 : -6.25, centre, centre, 0, profile, scale)).toBeNull();
  });

  it('admits a shark only where its scaled clearances fit, and guards impossible client columns', () => {
    for (const size of WILDLIFE_SIZE_CLASSES) {
      const raw = sharkMaxGroundHeight(size);
      const profile = walkerProfileOf('shark', size);
      expect(profile.maxGroundHeight).toBe(raw);
      const scale = modelScaleFor('shark', size, 1);
      const swim = swimProfileOf('shark', 1)!;
      const seabed = drawnBandOfSample(raw) * WORLD_UNITS_PER_BAND;
      expect(SEA_SURFACE_WORLD_Y - seabed).toBeGreaterThanOrEqual((swim.minClearance + swim.minSubmergence) * scale);
      expect(swimmerSeabedY(() => seabed, 20, 20, 0, swim, scale)).toBe(seabed);
      const tooShallow = SEA_SURFACE_WORLD_Y - (SHARK_AUTHORED_BOUNDS.crownY - SHARK_AUTHORED_BOUNDS.bellyY) * scale / 2;
      expect(swimmerSeabedY(() => tooShallow, 20, 20, 0, swim, scale)).toBeNull();
    }
  });
});
