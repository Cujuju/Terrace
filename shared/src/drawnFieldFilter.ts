import { DRAWN_GROUND_BAND_BIAS, drawnLevelThreshold } from './bands.ts';

export type DrawnSurfaceMode = 'raw' | 'binomial';
export const DRAWN_FILTER_DENOM = 16;
export const DRAWN_FILTER_REACH = 1;

/** All callbacks read the original field. Missing samples never enter the kernel. */
export interface DrawnFieldSource {
  readonly size: number;
  sample(x: number, y: number, band: number | null): number;
  available(x: number, y: number): boolean;
}

/** Explicit, local visual-surface contract; authoritative terrain never selects it. */
export interface DrawnSurfaceField {
  readonly scale: number;
  readonly reach: number;
  sample(x: number, y: number, band: number | null): number;
}

export function drawnSurfaceThreshold(band: number, scale: number): number {
  return (drawnLevelThreshold(band) - DRAWN_GROUND_BAND_BIAS) * scale + DRAWN_GROUND_BAND_BIAS;
}

/** One immutable-input [1,2,1]² pass, numerator over 16. No feature guards.
 * Missing terrain falls back to the original sample; world edges clamp.
 */
export function binomialDrawnSample(
  source: DrawnFieldSource,
  x: number,
  y: number,
  band: number | null,
): number {
  const clamp = (v: number): number => Math.max(0, Math.min(source.size - 1, v));
  x = clamp(x);
  y = clamp(y);
  const original = source.sample(x, y, band) * DRAWN_FILTER_DENOM;
  let numerator = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      if (!source.available(clamp(x + i), clamp(y + j))) return original;
      numerator += source.sample(clamp(x + i), clamp(y + j), band)
        * (i === 0 ? 2 : 1) * (j === 0 ? 2 : 1);
    }
  }
  return numerator;
}
