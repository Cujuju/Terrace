import { bandFloorHeight, drawnBandOfSample } from '../shared/src/bands.ts';

export const FILTER_WEIGHTS = [1, 2, 1];
export const FILTER_DENOM = FILTER_WEIGHTS.reduce((sum, value) => sum + value, 0) ** 2;
export const RAW_NEIGHBOR_REACH = 2;
export const GUARD_THIN = 1;
export const GUARD_SADDLE = 2;
export const GUARD_LAYER = 4;

// Offline candidate. No production consumer imports this module.
export function deriveProtectedField(raw, size, layeredCells = new Set()) {
  const index = (x, y) => Math.max(0, Math.min(size - 1, y)) * size + Math.max(0, Math.min(size - 1, x));
  const bands = Int32Array.from(raw, drawnBandOfSample);
  const guards = new Uint8Array(raw.length);
  const full = new Int32Array(raw.length);
  const clamped = new Int32Array(raw.length);
  const protectedField = new Int32Array(raw.length);
  const strictField = new Int32Array(raw.length);
  let thinSamples = 0;
  let saddleSquares = 0;

  function freezeNeighborhood(x, y, reason) {
    for (let dy = -1; dy <= 1; dy++) {
      for (let dx = -1; dx <= 1; dx++) guards[index(x + dx, y + dy)] |= reason;
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = index(x, y);
      const band = bands[cell];
      let hasSolidBlock = false;
      let hasOpenBlock = false;
      for (let oy = -1; oy <= 0; oy++) {
        for (let ox = -1; ox <= 0; ox++) {
          const corners = [bands[index(x + ox, y + oy)], bands[index(x + ox + 1, y + oy)],
            bands[index(x + ox, y + oy + 1)], bands[index(x + ox + 1, y + oy + 1)]];
          hasSolidBlock ||= corners.every(value => value >= band);
          hasOpenBlock ||= corners.every(value => value <= band);
        }
      }
      // Preserve all four contour squares touching a sample without a same-side 2×2 support block.
      if (!hasSolidBlock || !hasOpenBlock) {
        thinSamples++;
        freezeNeighborhood(x, y, GUARD_THIN);
      }
      if (layeredCells.has(cell)) freezeNeighborhood(x, y, GUARD_LAYER);

      if (x + 1 < size && y + 1 < size) {
        const corners = [cell, index(x + 1, y), index(x, y + 1), index(x + 1, y + 1)];
        const [a, b, c, d] = corners.map(i => bands[i]);
        // Any band separating the two diagonals produces an ambiguous marching square.
        if (Math.min(a, d) > Math.max(b, c) || Math.min(b, c) > Math.max(a, d)) {
          saddleSquares++;
          for (const i of corners) guards[i] |= GUARD_SADDLE;
        }
      }
    }
  }

  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const cell = index(x, y);
      let numerator = 0;
      for (let dy = -1; dy <= 1; dy++) {
        for (let dx = -1; dx <= 1; dx++) {
          numerator += raw[index(x + dx, y + dy)] * FILTER_WEIGHTS[dx + 1] * FILTER_WEIGHTS[dy + 1];
        }
      }
      full[cell] = numerator;
      // One numerator unit below the next band preserves the half-open raw band interval.
      const lower = bandFloorHeight(bands[cell]) * FILTER_DENOM;
      const upper = bandFloorHeight(bands[cell] + 1) * FILTER_DENOM - 1;
      clamped[cell] = Math.max(lower, Math.min(upper, numerator));
      protectedField[cell] = guards[cell] ? raw[cell] * FILTER_DENOM : full[cell];
      strictField[cell] = guards[cell] ? raw[cell] * FILTER_DENOM : clamped[cell];
    }
  }

  return { full, clamped, protectedField, strictField, guards, thinSamples, saddleSquares };
}
