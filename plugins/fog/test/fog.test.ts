import { describe, expect, it } from 'vitest';
import {
  HAZE_LAYERS,
  PRECIPITATION_HAZE_SCALE,
  hazeEdgeWobble,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import { FOG_COVERAGE_FRACTION, FOG_PLUGIN_NAME, MAX_ACTIVE_SYSTEMS } from '../protocol.ts';
import { plugin as fogPlugin, wetnessAt } from '../server/index.ts';
import { FOG_HAZE_STRENGTH, FOG_RIG_DRAW_OBJECTS } from '../client/rig.ts';

describe('the haze bank', () => {
  it('stays below the height a player can raise land clear of it', () => {
    for (const layer of HAZE_LAYERS) {
      expect(layer.height + layer.bobUnits).toBeLessThan(3);
      expect(layer.opacity).toBeGreaterThan(0);
      expect(layer.radiusScale).toBeGreaterThan(0);
      expect(layer.radiusScale).toBeLessThanOrEqual(1);
    }
  });

  it('never lets two sheets share a spin or bob rate', () => {
    const spins = HAZE_LAYERS.map((layer) => layer.spinHz);
    const bobs = HAZE_LAYERS.map((layer) => layer.bobHz);
    expect(new Set(spins).size).toBe(spins.length);
    expect(new Set(bobs).size).toBe(bobs.length);
    for (const rate of [...spins, ...bobs]) expect(Math.abs(rate)).toBeLessThan(0.05);
  });

  it('tears the outline without ever inverting it', () => {
    for (let step = 0; step < 360; step++) {
      const wobble = hazeEdgeWobble((step / 360) * Math.PI * 2);
      expect(wobble).toBeGreaterThan(0.5);
      expect(wobble).toBeLessThan(1.5);
    }
  });

  it('gives fog the whole bank, where a precipitating kind gets a third', () => {
    expect(FOG_HAZE_STRENGTH).toBe(1);
    expect(PRECIPITATION_HAZE_SCALE).toBeLessThan(FOG_HAZE_STRENGTH);
    expect(FOG_RIG_DRAW_OBJECTS).toBe(HAZE_LAYERS.length);
  });
});

describe('fog as a kind of weather', () => {
  it('wets nothing, ever — a haze is not precipitation', () => {
    expect(wetnessAt()).toBe(0);
  });

  it('carries its own share of the sky, and its own ceiling', () => {
    expect(FOG_COVERAGE_FRACTION).toBeCloseTo(0.027, 12);
    expect(MAX_ACTIVE_SYSTEMS).toBe(2);
  });

  it('contributes nothing to the snapshot, and never edits the world', () => {
    expect(fogPlugin.name).toBe(FOG_PLUGIN_NAME);
    expect(fogPlugin.persistence).toBeUndefined();
    expect(fogPlugin.onIntent).toBeUndefined();
    expect(fogPlugin.onTerrainChanged).toBeUndefined();
  });
});
