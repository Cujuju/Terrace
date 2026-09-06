// One `whale` on the wire is one of three bodies (species/humpback.ts, blueWhale.ts,
// spermWhale.ts), chosen by entity id. Size class is a separate per-member axis.

/** Selection order is a promise to every living whale; never reorder. */
export const WHALE_SPECIES = ['humpback', 'blue', 'sperm'] as const;
export type WhaleSpecies = (typeof WHALE_SPECIES)[number];

/** Placement contract every whale body fills; SWIM_PROFILES.whale's 0.7 clearances were tuned against it. */
export const WHALE_ENVELOPE = {
  crownY: 0.670,
  bellyY: -0.575,
  length: 5.05,
} as const;
