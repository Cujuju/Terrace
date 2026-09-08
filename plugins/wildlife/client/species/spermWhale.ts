import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

export const SPERM_WHALE_HALF_WIDTH = 0.44;

export const SPERM_WHALE_ENVELOPE = whaleEnvelope(SPERM_WHALE_HALF_WIDTH);

export const SPERM_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-sperm',
  file: 'sperm-whale.glb',
  joints: WHALE_JOINTS,
  envelope: SPERM_WHALE_ENVELOPE,
};

export const buildSpermWhale = assetSpeciesBuilder(SPERM_WHALE_ASSET, animateWhale);
