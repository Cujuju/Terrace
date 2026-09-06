// `whale` variant 2: ../assets/sperm-whale.glb (tools/blender/build_sperm_whale.py).
// Fills WHALE_ENVELOPE (./whale.ts); only halfWidth is this body's own.
// The crown is the hump, the belly the chest; the underslung jaw stays above it.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/** The `flank` anchor: the head-and-chest plateau. Placement keeps its own hand-set 0.5. */
export const SPERM_WHALE_HALF_WIDTH = 0.44;

export const SPERM_WHALE_ENVELOPE = whaleEnvelope(SPERM_WHALE_HALF_WIDTH);

/** Install-map key only; the wire species is `whale`. */
export const SPERM_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-sperm',
  file: 'sperm-whale.glb',
  joints: WHALE_JOINTS,
  envelope: SPERM_WHALE_ENVELOPE,
};

export const buildSpermWhale = assetSpeciesBuilder(SPERM_WHALE_ASSET, animateWhale);
