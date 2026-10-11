import { Matrix4 } from 'three';
import { loadBuildingAssetKit, type BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import type { BuildingQuality } from '../../../client/src/state/buildingQualityPrefs.ts';
import { buildingDrawScale } from './buildingScale.ts';
import { AUTHORED_URLS } from './authoredUrls.ts';

export async function preloadAuthoredStructures(quality: BuildingQuality): Promise<BuildingAssetKit> {
  const kit = await loadBuildingAssetKit(AUTHORED_URLS[quality], ['flipper-shrimp']);
  return {
    parts(id) {
      const parts = kit.parts(id);
      const scale = buildingDrawScale(id, parts);
      const toRealSize = new Matrix4().makeScale(scale, scale, scale);
      for (const part of parts) for (const local of part.localMatrices) local.premultiply(toRealSize);
      return parts;
    },
    dispose() { kit.dispose(); },
  };
}
