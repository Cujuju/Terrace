// `whale` variant 0: ../assets/humpback.glb (tools/blender/build_humpback.py).
// Fills WHALE_ENVELOPE (./whale.ts); only halfWidth is this body's own.
// The belly is the starboard flipper tip, a rigid part authored at its hang angle.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/** The `flank` anchor: the chest plateau. Placement keeps its own hand-set 0.5. */
export const HUMPBACK_HALF_WIDTH = 0.47;

export const HUMPBACK_ENVELOPE = whaleEnvelope(HUMPBACK_HALF_WIDTH);

/** Install-map key only; the wire species is `whale`. */
export const HUMPBACK_ASSET: SpeciesAssetSpec = {
  species: 'whale-humpback',
  file: 'humpback.glb',
  joints: WHALE_JOINTS,
  envelope: HUMPBACK_ENVELOPE,
};

export const buildHumpback = assetSpeciesBuilder(HUMPBACK_ASSET, animateWhale);
