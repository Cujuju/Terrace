import { BAND_HEIGHT, DRAWN_SHORE_HEIGHT } from './constants.ts';

// Drawn-band contract (lane A).
//
// The renderer draws a height sample `h` as band `drawnBandOfSample(h)`, which
// reads the biased field `h + DRAWN_GROUND_BAND_BIAS`. Sculpt targets and
// coverage predicates must agree with that field, or a press can move raw
// heights without changing what is drawn (e.g. raising 8 to 16 used to stay
// inside drawn band 1).
//
// Determinism: every function here is integer-only — Math.floor (an
// exactly-specified IEEE-754 operation whose result is immediately used as an
// integer), integer +/-1 steps, and comparisons — evaluated in a fixed order
// with no iteration. Identical inputs give identical outputs on server and
// client.

/** Half a band. The biased field `height + DRAWN_GROUND_BAND_BIAS` is what the isolines read. */
export const DRAWN_GROUND_BAND_BIAS = BAND_HEIGHT / 2;

/** Band k's threshold in the biased field (`height + DRAWN_GROUND_BAND_BIAS`). */
export function drawnLevelThreshold(band: number): number {
  return band === 0 ? DRAWN_SHORE_HEIGHT + DRAWN_GROUND_BAND_BIAS : band * BAND_HEIGHT;
}

/** Drawn band of a raw height sample. Sea (at or below the waterline) draws as band -1, never 0. */
export function drawnBandOfSample(height: number): number {
  const band = Math.floor((height + DRAWN_GROUND_BAND_BIAS) / BAND_HEIGHT);
  return band === 0 && height + DRAWN_GROUND_BAND_BIAS < drawnLevelThreshold(0) ? -1 : band;
}

/** Lowest raw height that draws as band k. Band 0 starts at the shore; every other band spans 16 heights. */
export function bandFloorHeight(band: number): number {
  return band === 0 ? DRAWN_SHORE_HEIGHT : band * BAND_HEIGHT - DRAWN_GROUND_BAND_BIAS;
}

/** Canonical write level for band k: the raw level the sculpt pipeline writes (raw k*16, 1 at the shore). */
export function bandLevelHeight(band: number): number {
  return band === 0 ? DRAWN_SHORE_HEIGHT : band * BAND_HEIGHT;
}

/** Drawn-equality: height draws as band k. Equivalent to `drawnBandOfSample(height) === band`. */
export function isHeightInBand(height: number, band: number): boolean {
  return height >= bandFloorHeight(band) && height < bandFloorHeight(band + 1);
}

/**
 * Displacement that leaves `height`'s own drawn band. Every band is
 * BAND_HEIGHT tall except the waterline band, which runs from its floor up to
 * SEA_LEVEL, so a press there has further to travel than BAND_HEIGHT.
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
