import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

export const BLUE_WHALE_HALF_WIDTH = 0.37;

export const BLUE_WHALE_ENVELOPE = whaleEnvelope(BLUE_WHALE_HALF_WIDTH);

export const BLUE_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-blue',
  file: 'blue-whale.glb',
  joints: WHALE_JOINTS,
  envelope: BLUE_WHALE_ENVELOPE,
};

export const buildBlueWhale = assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale);
