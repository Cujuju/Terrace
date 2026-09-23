import { BAND_HEIGHT, DRAWN_GROUND_BAND_BIAS, drawnLevelThreshold } from '../shared/src/index.ts';

// Offline candidate. No production consumer imports this module.
// Each band blurs its own field: heights clamped to ±CLAMP_BANDS around that band's
// contour height. Gentle slopes match the plain filter; cliffs saturate, so all
// their bands share one outline and the wall stays where it was.
export const CLAMP_BANDS = 1;
const KERNEL = [1, 2, 1];

export function clampedBandField(raw, size, band) {
  const contourHeight = drawnLevelThreshold(band) - DRAWN_GROUND_BAND_BIAS;
  const low = contourHeight - CLAMP_BANDS * BAND_HEIGHT;
  const high = contourHeight + CLAMP_BANDS * BAND_HEIGHT;
  const clamped = Int32Array.from(raw, (h) => (h < low ? low : h > high ? high : h));
  const at = (x, y) => clamped[Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x))];
  const out = new Int32Array(raw.length);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      let numerator = 0;
      for (let j = -1; j <= 1; j++) {
        for (let i = -1; i <= 1; i++) numerator += at(x + i, y + j) * KERNEL[i + 1] * KERNEL[j + 1];
      }
      out[y * size + x] = numerator;
    }
  }
  return out;
}
