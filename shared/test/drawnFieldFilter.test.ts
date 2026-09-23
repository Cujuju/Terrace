import { describe, expect, it } from 'vitest';
import { bandLevelHeight, drawnBandOfSample } from '../src/bands.ts';
import { createHeightmap } from '../src/grid.ts';
import { drawnBandAt, drawnSampleIsInside } from '../src/drawnGround.ts';
import { binomialDrawnSample, drawnSurfaceThreshold, type DrawnFieldSource } from '../src/drawnFieldFilter.ts';

function field(values: Int32Array, size: number): DrawnFieldSource {
  return { size, sample: (x, y) => values[y * size + x]!, available: () => true };
}

describe('binomial drawn-field contract', () => {
  it('keeps constant fields and signed band boundaries exact, with bias applied once', () => {
    const map = createHeightmap(16);
    for (const h of [-1536, -32, -1, 0, 1, 16, 17, 1024]) {
      map.cells.fill(h);
      const source = field(Int32Array.from(map.cells), 16);
      expect(binomialDrawnSample(source, 8, 8, null)).toBe(h * 16);
      const surface = { scale: 16, reach: 1, sample: (x: number, y: number, band: number | null) => binomialDrawnSample(source, x, y, band) };
      expect(drawnBandAt(map, 8.75, 8.25, surface)).toBe(drawnBandAt(map, 8.75, 8.25));
      for (const band of [drawnBandOfSample(h), drawnBandOfSample(h) + 1]) {
        expect(drawnSampleIsInside(h * 16, drawnSurfaceThreshold(band, 16))).toBe(drawnBandOfSample(h) >= band);
      }
    }
  });

  it('averages a one-cell terrace or hole instead of preserving the feature', () => {
    const size = 9;
    for (const inverted of [false, true]) {
      const surrounding = bandLevelHeight(inverted ? 2 : 0);
      const centre = bandLevelHeight(inverted ? 0 : 2);
      const raw = new Int32Array(size * size).fill(surrounding);
      raw[4 * size + 4] = centre;
      expect(binomialDrawnSample(field(raw, size), 4, 4, null)).toBe(4 * centre + 12 * surrounding);
    }
  });

  it('filters original inputs once, clamps world edges, and rejects missing stencil inputs', () => {
    const raw = Int32Array.from({ length: 81 }, (_, i) => 100 + (i % 9) ** 2);
    const before = raw.slice();
    const source = field(raw, 9);
    // Quadratic x: [1,2,1]/4 adds exactly one half to x².
    expect(binomialDrawnSample(source, 4, 4, null)).toBe(116 * 16 + 8);
    expect(raw).toEqual(before);
    expect(binomialDrawnSample(source, 0, 0, null)).toBe(100 * 16 + 4);
    // A band-specific field uses the same kernel without a layered-feature veto.
    expect(binomialDrawnSample(source, 4, 4, 6)).toBe(116 * 16 + 8);
    source.available = (x, y) => x !== 5 || y !== 5;
    expect(binomialDrawnSample(source, 4, 4, null)).toBe(116 * 16);
  });
});
