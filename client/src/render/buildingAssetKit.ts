import { loadRigAsset, type RigAsset } from './rigAsset.ts';
import { flattenAssetParts, type AssetPart } from './staticAsset.ts';

export interface BuildingAssetKit {
  parts(id: string): AssetPart[];
  dispose(): void;
}

export async function loadBuildingAssetKit(
  urls: Readonly<Record<string, string>>,
  multipartIds: readonly string[] = [],
): Promise<BuildingAssetKit> {
  const assets = new Map<string, RigAsset>();
  const results = await Promise.allSettled(Object.entries(urls).map(async ([id, url]) => {
    const asset = await loadRigAsset(url, null);
    assets.set(id, asset);
    const parts = flattenAssetParts(asset);
    if (!multipartIds.includes(id) && (parts.length !== 1 || parts[0].localMatrices.length !== 1)) {
      throw new Error(`building ${id}: expected one mesh and material`);
    }
  }));
  const failure = results.find((result) => result.status === 'rejected');
  if (failure?.status === 'rejected') {
    for (const asset of assets.values()) asset.dispose();
    throw failure.reason;
  }
  return {
    parts(id) {
      const asset = assets.get(id);
      if (asset === undefined) throw new Error(`building asset not loaded: ${id}`);
      return flattenAssetParts(asset).map((part) => ({
        geometry: part.geometry.clone(),
        material: part.material.clone(),
        localMatrices: part.localMatrices.map((matrix) => matrix.clone()),
      }));
    },
    dispose() {
      for (const asset of assets.values()) asset.dispose();
      assets.clear();
    },
  };
}
