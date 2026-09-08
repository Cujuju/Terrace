import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

export const HUMPBACK_HALF_WIDTH = 0.47;

export const HUMPBACK_ENVELOPE = whaleEnvelope(HUMPBACK_HALF_WIDTH);

export const HUMPBACK_ASSET: SpeciesAssetSpec = {
  species: 'whale-humpback',
  file: 'humpback.glb',
  joints: WHALE_JOINTS,
  envelope: HUMPBACK_ENVELOPE,
};

export const buildHumpback = assetSpeciesBuilder(HUMPBACK_ASSET, animateWhale);
