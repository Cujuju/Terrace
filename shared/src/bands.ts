import { BAND_HEIGHT, DRAWN_SHORE_HEIGHT } from './constants.ts';

// Drawn-band contract (lane A): sculpt targets and coverage predicates must agree
// with the biased field. Integer-only throughout, so server and client match.
// Full contract and its determinism argument: docs/decisions/terrain-relief.md.

export const DRAWN_GROUND_BAND_BIAS = BAND_HEIGHT / 2;

/** Lowest raw height that draws as band k. Band 0 starts at the shore. */
export function bandFloorHeight(band: number): number {
  return band * BAND_HEIGHT + DRAWN_SHORE_HEIGHT;
}

/** Canonical write level: the band's midpoint. */
export function bandLevelHeight(band: number): number {
  return bandFloorHeight(band) + DRAWN_GROUND_BAND_BIAS;
}

/** Band k's threshold in the biased field. Equals the canonical level. */
export function drawnLevelThreshold(band: number): number {
  return bandLevelHeight(band);
}

export function drawnBandOfSample(height: number): number {
  return Math.floor((height - DRAWN_SHORE_HEIGHT) / BAND_HEIGHT);
}

/** Drawn-equality: height draws as band k. Equivalent to `drawnBandOfSample(height) === band`. */
export function isHeightInBand(height: number, band: number): boolean {
  return height >= bandFloorHeight(band) && height < bandFloorHeight(band + 1);
}

/**
 * Smallest displacement that leaves `height`'s own drawn band. Band widths
 * vary: the shore band is 7 tall and the waterline band 25, so this is not
 * always BAND_HEIGHT.
 */
export function bandCrossingStep(height: number, raising: boolean): number {
  const band = drawnBandOfSample(height);
  return raising
    ? bandFloorHeight(band + 1) - height
    : height - bandFloorHeight(band) + 1;
}

/**
 * One press crosses at least one drawn band: step from `height` to the
 * canonical level of the neighbouring drawn band. Callers clamp to
 * [MIN_HEIGHT, MAX_HEIGHT].
 */
export function stepTowardBand(height: number, raising: boolean): number {
  const band = drawnBandOfSample(height);
  return bandLevelHeight(band + (raising ? 1 : -1));
}
