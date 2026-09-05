// The blue whale: `whale` variant 1 on the wire, and the SEVENTH body drawn
// from a Blender-built asset — the second whale, after the humpback.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish, shark, ray, eel, angelfish and the humpback went
// first, this file follows them). The body used to be `blueSet` in
// ../whaleSpecies.ts — a swept hull with a median ridge and pleat
// displacement (../whaleHull.ts's sweptHull and profileFromPoints) and
// extruded flippers, dorsal and flukes (finGeometry) — assembled and
// animated inline in ../models.ts, and FITTED into WHALE_ENVELOPE at 0.7902
// (5.05 long but only -0.388..0.451 tall, its scale capped by the length).
// It is now ../assets/blue-whale.glb, authored by
// tools/blender/build_blue_whale.py and loaded through ./assetSpecies.ts,
// and it FILLS the box (./whale.ts). ../whaleHull.ts is NOT orphaned — the
// sperm body still builds on it, as do ibex and bison; nothing in
// ./bodyKit.ts was used by the whale.
//
// WHAT DID NOT CHANGE, and must not:
//   * WHALE_ENVELOPE's three numbers, and the placement rows that read them
//     (../placement.ts's BODY_COLUMNS.whale and SWIM_PROFILES.whale, which
//     is hand-set against the 5.05 length). BLUE_WHALE_ENVELOPE is DERIVED
//     from them by ./whale.ts's whaleEnvelope, so crownY, bellyY and length
//     are WHALE_ENVELOPE's own values, by identity; only halfWidth is this
//     body's. The whale therefore sits in the same water it always did, the
//     same 5.05 long and now the full 1.245 tall — intended (the species
//     sheet: every whale asset fills the box).
//   * WHALE_SPECIES's order — an individual keeps its body for life.
//   * The animation. Same 0.45 Hz beat, same 0.3 rad fluke pitch, same 0.12
//     body-roll fraction: ./whale.ts's animateWhale, the same constants the
//     humpback asset and the remaining procedural body run on.
//   * The colour. 0x39506b body (models.ts's WHALE_COLOR, dark slate): the
//     owner reads a whale by its colour, and build_blue_whale.py paints it —
//     plus one paler ventral tone (0x8fa4b8: the throat's pleats and the
//     flipper undersides, a blue whale's grey underside rather than the
//     humpback's white) and one dark eye (0x0b0e13).
//
// THE CROWN IS THE BACK, THE BELLY IS THE CHEST — the species sheet offered
// either the dorsal nub or the back for the crown, and this body takes the
// back: a blue whale's tell from the side is a long, low, flat back with a
// nub of a fin three quarters of the way along it, and lifting that nub to
// the crown on a lowered back would have made it a fin. So the hull's back
// plateaus at 0.670 over the chest and the nub's tip sits 0.09 under it
// (asserted by the build: DORSAL_TIP_BELOW_CROWN); the chest's bottom
// plateaus at -0.575, the flippers — small, slender, pointed, held close —
// end 0.12 above it. installSpeciesAsset measures the file AT REST and both
// extremes are hull geometry, so nothing assigned by `animate` can be an
// extreme. The flank is the hull's chest at its widest,
// BLUE_WHALE_HALF_WIDTH; the flippers reach 0.90 out and are the upper-bound
// case the install allows.
//
// ONE ENVELOPE. See ./whale.ts: the flukes' sweep stays inside the box and
// only shortens the length, so the rest file is the conservative reading.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/**
 * The hull's widest half-width, on the chest plateau — the `flank` anchor
 * and the one envelope field that is this body's own. The slimmest of the
 * three whales: a blue whale is about seven of its widths long, and the
 * procedural body's fitted hull measured 0.3646 (../placement.ts's
 * SWIM_PROFILES.whale keeps its hand-set halfWidth 0.5, the widest case;
 * this is what the file measures).
 */
export const BLUE_WHALE_HALF_WIDTH = 0.37;

/**
 * What this body measures, in world units at model scale 1: WHALE_ENVELOPE's
 * crown, belly and length by identity, and BLUE_WHALE_HALF_WIDTH. Placement
 * reads WHALE_ENVELOPE directly; this is the contract the asset is CHECKED
 * against (./assetSpecies.ts).
 */
export const BLUE_WHALE_ENVELOPE = whaleEnvelope(BLUE_WHALE_HALF_WIDTH);

/**
 * The asset this body is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk. The key is
 * the install-map key only — the wire species is `whale`.
 */
export const BLUE_WHALE_ASSET: SpeciesAssetSpec = {
  species: 'whale-blue',
  file: 'blue-whale.glb',
  joints: WHALE_JOINTS,
  envelope: BLUE_WHALE_ENVELOPE,
};

export const buildBlueWhale = assetSpeciesBuilder(BLUE_WHALE_ASSET, animateWhale);
