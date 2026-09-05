// The sperm whale: `whale` variant 2 on the wire, and the EIGHTH body drawn
// from a Blender-built asset — the third and last whale, and the end of the
// procedural whale.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish, shark, ray, eel, angelfish, the humpback and the
// blue whale went first, this file follows them). The body used to be
// `spermSet` in ../whaleSpecies.ts — a swept hull with boxiness, wrinkle,
// hump and knuckle displacement (../whaleHull.ts's sweptHull and
// profileFromPoints), a second swept hull for the jaw, and extruded flippers
// and flukes (finGeometry) — assembled and animated in ../models.ts, and
// FITTED into WHALE_ENVELOPE at 0.7805 (5.05 long but only -0.551..0.473
// tall, its scale capped by the length). It is now ../assets/sperm-whale.glb,
// authored by tools/blender/build_sperm_whale.py and loaded through
// ./assetSpecies.ts, and it FILLS the box (./whale.ts). With it the
// procedural whale machinery is gone: ../whaleSpecies.ts keeps only
// WHALE_SPECIES and WHALE_ENVELOPE, ../models.ts herds the three bodies as
// asset species like any in this directory, and ../whaleHull.ts is no
// longer imported by any whale — it is NOT orphaned, ibex and bison still
// build on it; nothing in ./bodyKit.ts was ever used by the whale.
//
// WHAT DID NOT CHANGE, and must not:
//   * WHALE_ENVELOPE's three numbers, and the placement rows that read them
//     (../placement.ts's BODY_COLUMNS.whale and SWIM_PROFILES.whale, which
//     is hand-set against the 5.05 length). SPERM_WHALE_ENVELOPE is DERIVED
//     from them by ./whale.ts's whaleEnvelope, so crownY, bellyY and length
//     are WHALE_ENVELOPE's own values, by identity; only halfWidth is this
//     body's. The whale therefore sits in the same water it always did, the
//     same 5.05 long and now the full 1.245 tall — intended (the species
//     sheet: every whale asset fills the box).
//   * WHALE_SPECIES's order — an individual keeps its body for life.
//   * The animation. Same 0.45 Hz beat, same 0.3 rad fluke pitch, same 0.12
//     body-roll fraction: ./whale.ts's animateWhale, the same function the
//     humpback and the blue whale run on.
//   * The colour. 0x39506b body (the WHALE_COLOR models.ts used to hold,
//     dark slate): the owner reads a whale by its colour, and
//     build_sperm_whale.py paints it — plus one paler tone (0xb8c4cf: the
//     lower jaw, a sperm whale's white lips, as a vertex tint that fades to
//     the body tone where the jaw enters the throat) and one dark eye
//     (0x0b0e13).
//
// THE CROWN IS THE HUMP, THE BELLY IS THE CHEST — the species sheet fixes
// the hump as the crown (a sperm whale has no dorsal fin: a rounded hump two
// thirds back, then knuckles down the tail stock), and for the belly offered
// the jaw's underside or the chest. This body takes the CHEST: the hull's
// bottom plateaus at -0.575 behind the head, and the jaw — a narrow rod
// underslung beneath a head that overhangs it, a rigid body part with no
// joint — bottoms out 0.02 or more above it (asserted by the build:
// JAW_ABOVE_BELLY), as do the short paddle flippers. The knuckles are proven
// to stay under the hump (KNUCKLE_BELOW_CROWN). installSpeciesAsset measures
// the file AT REST and both extremes are hull geometry, so nothing assigned
// by `animate` can be an extreme. The flank is the hull's boxy head and
// chest at their widest, SPERM_WHALE_HALF_WIDTH; the flippers reach 0.77 out
// and are the upper-bound case the install allows.
//
// ONE ENVELOPE. See ./whale.ts: the flukes' sweep stays inside the box and
// only shortens the length, so the rest file is the conservative reading.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/**
 * The hull's widest half-width, on the head-and-chest plateau — the `flank`
 * anchor and the one envelope field that is this body's own. The widest of
 * the three whales: a sperm whale is a barrel with a box on the front, and
 * the procedural body's fitted hull measured 0.4375 (../placement.ts's
 * SWIM_PROFILES.whale keeps its hand-set halfWidth 0.5, the widest case;
 * this is what the file measures).
 */
export const SPERM_WHALE_HALF_WIDTH = 0.44;

/**
 * What this body measures, in world units at model scale 1: WHALE_ENVELOPE's
 * crown, belly and length by identity, and SPERM_WHALE_HALF_WIDTH. Placement
 * reads WHALE_ENVELOPE directly; this is the contract the asset is CHECKED
 * against (./assetSpecies.ts).
 */
export const SPERM_WHALE_ENVELOPE = whaleEnvelope(SPERM_WHALE_HALF_WIDTH);

/**
 * The asset this body is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk. The key is
 * the install-map key only — the wire species is `whale`.
 */
export const SPERM_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-sperm',
  file: 'sperm-whale.glb',
  joints: WHALE_JOINTS,
  envelope: SPERM_WHALE_ENVELOPE,
};

export const buildSpermWhale = assetSpeciesBuilder(SPERM_WHALE_ASSET, animateWhale);
