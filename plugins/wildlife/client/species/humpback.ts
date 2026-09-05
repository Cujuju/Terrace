// The humpback whale: `whale` variant 0 on the wire, and the SIXTH body drawn
// from a Blender-built asset — the first whale.
//
// WHAT CHANGED (owner, 2026-09-04: every fish and whale becomes a GLB, one
// species per pass; fish, shark, ray, eel and angelfish went first, this
// file follows them). The body used to be `humpbackSet` in
// ../whaleSpecies.ts — a swept hull with tubercle and hump displacement
// (../whaleHull.ts's sweptHull and profileFromPoints) and extruded flippers,
// dorsal and flukes (finGeometry) — assembled and animated inline in
// ../models.ts, and FITTED into WHALE_ENVELOPE at 0.6907 (4.48 long, its
// scale capped by a flipper tip). It is now ../assets/humpback.glb, authored
// by tools/blender/build_humpback.py and loaded through ./assetSpecies.ts,
// and it FILLS the box (./whale.ts). ../whaleHull.ts is NOT orphaned — the
// blue and sperm bodies still build on it, as do ibex and bison; nothing in
// ./bodyKit.ts was used by the whale.
//
// WHAT DID NOT CHANGE, and must not:
//   * WHALE_ENVELOPE's three numbers, and the placement rows that read them
//     (../placement.ts's BODY_COLUMNS.whale and SWIM_PROFILES.whale, which
//     is hand-set against the 5.05 length). HUMPBACK_ENVELOPE is DERIVED
//     from them by ./whale.ts's whaleEnvelope, so crownY, bellyY and length
//     are WHALE_ENVELOPE's own values, by identity; only halfWidth is this
//     body's. The whale therefore sits in the same water it always did,
//     ~13 % bigger than the fitted body was — intended (the species sheet).
//   * WHALE_SPECIES's order — an individual keeps its body for life.
//   * The animation. Same 0.45 Hz beat, same 0.3 rad fluke pitch, same 0.12
//     body-roll fraction: ./whale.ts's animateWhale, the same constants the
//     two procedural bodies still run on.
//   * The colour. 0x39506b body (models.ts's WHALE_COLOR, dark slate): the
//     owner reads a whale by its colour, and build_humpback.py paints it —
//     plus one pale ventral tone (0xb9c6d2: the throat's pleats, the flipper
//     and fluke undersides, the humpback's white) and one dark eye
//     (0x0b0e13).
//
// THE BELLY IS AUTHORED, NOT ASSIGNED — the species sheet's decision, and
// why. installSpeciesAsset measures the file AT REST, so the lowest point
// must be geometry in the file: it is the STARBOARD FLIPPER TIP, the
// flippers being rigid body parts baked at their hang angle under no hinge
// (build_humpback.py FLIPPER_ROOT_Y derives the root height so the tip
// lands on -0.575 exactly); the barrel chest bottoms 0.065 above it. The
// crown is the dorsal's tip on the hump. The flank is the hull's chest at
// its widest, HUMPBACK_HALF_WIDTH; the flippers reach 1.87 out and are the
// upper-bound case the install allows.
//
// ONE ENVELOPE. See ./whale.ts: the flukes' sweep stays inside the box and
// only shortens the length, so the rest file is the conservative reading.
import { assetSpeciesBuilder, type SpeciesAssetSpec } from './assetSpecies.ts';
import { WHALE_JOINTS, animateWhale, whaleEnvelope } from './whale.ts';

/**
 * The hull's widest half-width, on the chest plateau — the `flank` anchor
 * and the one envelope field that is this body's own. A fifth of the length
 * across, which is how ../placement.ts's SWIM_PROFILES.whale describes the
 * widest of the three whales (its hand-set halfWidth 0.5 stays the
 * placement figure; this is what the file measures).
 */
export const HUMPBACK_HALF_WIDTH = 0.47;

/**
 * What this body measures, in world units at model scale 1: WHALE_ENVELOPE's
 * crown, belly and length by identity, and HUMPBACK_HALF_WIDTH. Placement
 * reads WHALE_ENVELOPE directly; this is the contract the asset is CHECKED
 * against (./assetSpecies.ts).
 */
export const HUMPBACK_ENVELOPE = whaleEnvelope(HUMPBACK_HALF_WIDTH);

/**
 * The asset this body is drawn from. The plugin's preload installs it
 * (./assets.ts lists it); Node feeds the same install from disk. The key is
 * the install-map key only — the wire species is `whale`.
 */
export const HUMPBACK_ASSET: SpeciesAssetSpec = {
  species: 'whale-humpback',
  file: 'humpback.glb',
  joints: WHALE_JOINTS,
  envelope: HUMPBACK_ENVELOPE,
};

export const buildHumpback = assetSpeciesBuilder(HUMPBACK_ASSET, animateWhale);
