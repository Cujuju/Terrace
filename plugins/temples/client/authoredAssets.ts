import { loadBuildingAssetKit, type BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import type { BuildingQuality } from '../../../client/src/state/buildingQualityPrefs.ts';
import lowUrl from './assets/authored/low/temple.glb?url';
import originalUrl from './assets/authored/original/temple.glb?url';

export function preloadAuthoredTemple(quality: BuildingQuality): Promise<BuildingAssetKit> {
  return loadBuildingAssetKit({ temple: quality === 'low' ? lowUrl : originalUrl });
}
