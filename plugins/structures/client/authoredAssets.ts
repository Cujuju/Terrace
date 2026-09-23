import { Matrix4 } from 'three';
import { loadBuildingAssetKit, type BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import type { BuildingQuality } from '../../../client/src/state/buildingQualityPrefs.ts';
import { STRUCTURE_SCALE_MAX, STRUCTURE_SURVEYED_GROUND_RADIUS } from '../protocol.ts';
import { AUTHORED_RADII } from './authoredRadii.ts';
import { AUTHORED_URLS } from './authoredUrls.ts';

export async function preloadAuthoredStructures(quality: BuildingQuality): Promise<BuildingAssetKit> {
  const kit = await loadBuildingAssetKit(AUTHORED_URLS[quality]);
  return {
    parts(id) {
      const parts = kit.parts(id);
      const radius = AUTHORED_RADII[id];
      const scale = Math.min(1, STRUCTURE_SURVEYED_GROUND_RADIUS / STRUCTURE_SCALE_MAX * 0.999 / radius);
      const fit = new Matrix4().makeScale(scale, scale, scale);
      for (const part of parts) for (const local of part.localMatrices) local.premultiply(fit);
      return parts;
    },
    dispose() { kit.dispose(); },
  };
}
