// The three whales: which bodies a whale can be, and the box every one of
// them fills.
//
// One "whale" on the wire is drawn as one of three real species, chosen from
// the creature's id so an individual keeps the same body for its whole life.
// They are deliberately not variations on a theme: a humpback, a blue whale and
// a sperm whale disagree about nearly every proportion an animal has, and the
// point of drawing three is that you can tell which is which at a glance.
//
// SINCE 2026-09-05 (fish+whales arc, passes 6–8) ALL THREE BODIES ARE
// Blender-built assets: species/humpback.ts (../assets/humpback.glb),
// species/blueWhale.ts (../assets/blue-whale.glb) and species/spermWhale.ts
// (../assets/sperm-whale.glb), each authored straight into WHALE_ENVELOPE by
// its tools/blender/build_*.py, whose header keeps the profile numbers of
// the procedural body it replaced as the reference silhouette. The
// procedural machinery that used to live here — the swept hulls on
// ./whaleHull.ts, the extruded fins, the fitting scale — is gone with the
// last of them; models.ts herds the three through species/whale.ts's shared
// joints and animation. What this file keeps is the contract: WHALE_SPECIES
// (the selection order, a promise to every living whale) and WHALE_ENVELOPE
// (the placement box every body fills — species/whale.ts derives each
// asset's envelope from it).
//
// Sizing: whales draw their size class PER MEMBER (WHALE_SIZE_WEIGHTS with
// sizeDraw 'per-member' on the server, and WILDLIFE_SIZE_MODEL_SCALE applied to
// the rig here), so a big/medium/small axis genuinely exists — but it is NOT
// what separates these three bodies. They are SPECIES variants (humpback /
// blue / sperm), chosen by entity id — an axis orthogonal to the size-class
// scale — and they are all authored into the SAME envelope the shipped whale
// occupied. See WHALE_ENVELOPE for why that matters.

/** The three bodies a whale can be drawn as. Order is the selection order. */
export const WHALE_SPECIES = ['humpback', 'blue', 'sperm'] as const;
export type WhaleSpecies = (typeof WHALE_SPECIES)[number];

/**
 * The authored envelope every whale body is fitted into, in world units,
 * measured from the whale this replaces.
 *
 * These are not style choices, they are the placement contract:
 * `SWIM_PROFILES.whale` (placement.ts) guarantees only `minClearance` 0.7 of
 * water between the swim origin and the sea surface, and `minSubmergence` 0.7
 * below. The old model's crown sat at y = 0.670 and its belly at y = -0.575,
 * and those two figures are what the clearance numbers were tuned against
 * (see WHALE_DORSAL_HEIGHT in models.ts for that history, including the
 * 2026-08-19 report of a whale that read as capsized because its dorsal was
 * buried). A body that fits inside this box cannot break through the sea
 * surface or sink into the seabed anywhere the old one did not.
 */
export const WHALE_ENVELOPE = {
  crownY: 0.670,
  bellyY: -0.575,
  length: 5.05,
} as const;
