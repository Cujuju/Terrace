import { loadBuildingAssetKit, type BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import type { BuildingQuality } from '../../../client/src/state/buildingQualityPrefs.ts';
import { createPreloadAssets } from '../../../client/src/plugins/kit/preloadAssets.ts';
import lowUrl from './assets/authored/low/temple.glb?url';
import originalUrl from './assets/authored/original/temple.glb?url';

const pendingKits = createPreloadAssets<BuildingAssetKit>();

export function preloadAuthoredTemple(quality: BuildingQuality): Promise<BuildingAssetKit> {
  return loadBuildingAssetKit({ temple: quality === 'low' ? lowUrl : originalUrl });
}

export function preloadTempleForMount(signal: AbortSignal, quality: BuildingQuality): Promise<void> {
  return pendingKits.load(signal, () => preloadAuthoredTemple(quality));
}

export function takeTempleForMount(signal: AbortSignal): BuildingAssetKit | undefined {
  return pendingKits.take(signal);
}
