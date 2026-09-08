export const WHALE_SPECIES = ['humpback', 'blue', 'sperm'] as const;
export type WhaleSpecies = (typeof WHALE_SPECIES)[number];

export const WHALE_ENVELOPE = {
  crownY: 0.670,
  bellyY: -0.575,
  length: 5.05,
} as const;
