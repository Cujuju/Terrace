const TWO_PI = Math.PI * 2;

export const DECK_TIERS: number = 5;

export const DECK_TIER_POPULATION_TAPER = 0.45;

export const DECK_RADIAL_EXPONENT = 0.75;

export function tierPopulations(total: number, tiers: number): number[] {
  const weights: number[] = [];
  let sum = 0;
  for (let tier = 0; tier < tiers; tier++) {
    const up = tiers === 1 ? 0 : tier / (tiers - 1);
    const weight = 1 - DECK_TIER_POPULATION_TAPER * up;
    weights.push(weight);
    sum += weight;
  }

  const counts: number[] = [];
  let dealt = 0;
  for (let tier = 0; tier < tiers; tier++) {
    const count = Math.floor((total * weights[tier]!) / sum);
    counts.push(count);
    dealt += count;
  }
  counts[0] = counts[0]! + (total - dealt);
  return counts;
}

const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));

const GOLDEN_RATIO_CONJUGATE = 0.6180339887;

export interface DeckLayout {
  readonly slots: Float32Array;
  readonly seeds: Float32Array;
  readonly tiers: Float32Array;
  readonly polars: Float32Array;
}

// The dome as instance attributes: which mass, which tier, a seed, and the
// (radial, angular) polar seat of every puff.
export function buildDeckLayout(maxMasses: number, puffsPerMass: number): DeckLayout {
  const capacity = maxMasses * puffsPerMass;
  const slotOf = new Float32Array(capacity);
  const seeds = new Float32Array(capacity);
  const tiers = new Float32Array(capacity);
  const polars = new Float32Array(capacity * 2);

  const perTier = tierPopulations(puffsPerMass, DECK_TIERS);
  for (let slot = 0; slot < maxMasses; slot++) {
    let puff = 0;
    for (let tier = 0; tier < DECK_TIERS; tier++) {
      const inTier = perTier[tier]!;
      const tierFraction = DECK_TIERS === 1 ? 0 : tier / (DECK_TIERS - 1);
      for (let index = 0; index < inTier; index++) {
        const instance = slot * puffsPerMass + puff;
        slotOf[instance] = slot;
        tiers[instance] = tierFraction;
        seeds[instance] = (instance * GOLDEN_RATIO_CONJUGATE) % 1;
        polars[instance * 2] = Math.pow((index + 0.5) / inTier, DECK_RADIAL_EXPONENT);
        polars[instance * 2 + 1] = index * GOLDEN_ANGLE + tier * TWO_PI * GOLDEN_RATIO_CONJUGATE;
        puff++;
      }
    }
  }

  return { slots: slotOf, seeds, tiers, polars };
}
