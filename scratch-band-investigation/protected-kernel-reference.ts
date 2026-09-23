import { DRAWN_GROUND_BAND_BIAS, drawnBandOfSample, drawnLevelThreshold } from '../shared/src/bands.ts';

export type DrawnSurfaceMode = 'raw' | 'protected-binomial';
export const DRAWN_FILTER_DENOM = 16;
export const DRAWN_FILTER_REACH = 2;

/** All callbacks read the original field. Missing samples never enter the kernel. */
export interface DrawnFieldSource {
  readonly size: number;
  sample(x: number, y: number, band: number | null): number;
  layered(x: number, y: number): boolean;
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

/** Historical protected kernel for benchmarks; production uses plain binomial.
 * Returns a numerator over 16, retaining extrema, diagonal saddles, and layered neighborhoods.
 */
export function protectedDrawnSample(
  source: DrawnFieldSource,
  x: number,
  y: number,
  band: number | null,
  scratch: Int32Array = new Int32Array(25),
): number {
  const clamp = (v: number): number => Math.max(0, Math.min(source.size - 1, v));
  x = clamp(x);
  y = clamp(y);
  const original = source.sample(x, y, band) * DRAWN_FILTER_DENOM;
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      if (!source.available(clamp(x + i), clamp(y + j))) return original;
    }
  }
  for (let j = -2; j <= 2; j++) {
    for (let i = -2; i <= 2; i++) {
      scratch[(j + 2) * 5 + i + 2] = source.sample(clamp(x + i), clamp(y + j), band);
    }
  }
  const b = (i: number, j: number): number => drawnBandOfSample(scratch[(j + 2) * 5 + i + 2]!);
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      if (source.layered(clamp(x + i), clamp(y + j))) return original;
      const centre = b(i, j);
      let solid = false;
      let open = false;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const a = b(i + ox, j + oy), c = b(i + ox + 1, j + oy);
          const d = b(i + ox, j + oy + 1), e = b(i + ox + 1, j + oy + 1);
          solid ||= Math.min(a, c, d, e) >= centre;
          open ||= Math.max(a, c, d, e) <= centre;
        }
      }
      if (!solid || !open) return original;
    }
  }
  for (let j = -1; j <= 0; j++) {
    for (let i = -1; i <= 0; i++) {
      const a = b(i, j), c = b(i + 1, j), d = b(i, j + 1), e = b(i + 1, j + 1);
      if (Math.min(a, e) > Math.max(c, d) || Math.min(c, d) > Math.max(a, e)) return original;
    }
  }
  let numerator = 0;
  for (let j = -1; j <= 1; j++) {
    for (let i = -1; i <= 1; i++) {
      numerator += scratch[(j + 2) * 5 + i + 2]! * (i === 0 ? 2 : 1) * (j === 0 ? 2 : 1);
    }
  }
  return numerator;
}
