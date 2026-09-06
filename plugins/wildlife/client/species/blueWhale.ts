// `whale` variant 1: ../assets/blue-whale.glb (tools/blender/build_blue_whale.py).
// Fills WHALE_ENVELOPE (./whale.ts); only halfWidth is this body's own.
// The crown is the flat back, not the dorsal nub, which sits under it.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/** The `flank` anchor: the chest plateau. Placement keeps its own hand-set 0.5. */
export const BLUE_WHALE_HALF_WIDTH = 0.37;

export const BLUE_WHALE_ENVELOPE = whaleEnvelope(BLUE_WHALE_HALF_WIDTH);

/** Install-map key only; the wire species is `whale`. */
export const BLUE_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-blue',
  file: 'blue-whale.glb',
  joints: WHALE_JOINTS,
  envelope: BLUE_WHALE_ENVELOPE,
};

export const buildBlueWhale = assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale);
