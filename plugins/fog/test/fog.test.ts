import { describe, expect, it } from 'vitest';
import {
  HAZE_CEILING_WORLD_UNITS,
  HAZE_LAYERS,
  PRECIPITATION_HAZE_SCALE,
  hazeEdgeWobble,
} from '../../../client/src/plugins/kit/hazeBank.ts';
import { FOG_COVERAGE_FRACTION, FOG_PLUGIN_NAME, MAX_ACTIVE_SYSTEMS } from '../protocol.ts';
import { plugin as fogPlugin, wetnessAt } from '../server/index.ts';
import { FOG_HAZE_STRENGTH, FOG_KIND_DRAW_OBJECTS } from '../client/rig.ts';
import { clientPlugin as fogClient } from '../client/index.ts';
import { HAZE_DECK_DRAW_OBJECTS } from '../../../client/src/plugins/kit/hazeDeck.ts';
import type { WorldApi } from '../../../server/src/plugins/types.ts';

describe('the haze bank', () => {
  it('stays below the height a player can raise land clear of it', () => {
    for (const layer of HAZE_LAYERS) {
      expect(layer.height + layer.bobUnits).toBeLessThan(HAZE_CEILING_WORLD_UNITS);
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
  });
});

function fakeHub(): { module: Record<string, unknown>; entries: Record<string, unknown>[] } {
  const entries: Record<string, unknown>[] = [];
  const module = {
    currentWind: () => ({ heading: 0, speed: 0 }),
    registerSkyKind: (entry: Record<string, unknown>) => {
      entries.push(entry);
      return () => undefined;
    },
  };
  return { module, entries };
}

function stubWorld(hub: Record<string, unknown>): WorldApi {
  return { worldSize: 512, sibling: () => hub, broadcast: () => undefined } as unknown as WorldApi;
}

describe('fog as a client plugin', () => {
  it('draws exactly one object: its haze deck', () => {
    expect(FOG_KIND_DRAW_OBJECTS).toBe(HAZE_DECK_DRAW_OBJECTS);
    expect(fogClient.drawBudget).toBe(HAZE_DECK_DRAW_OBJECTS);
  });
});

describe('fog as a kind of weather', () => {
  it('wets nothing, ever — a haze is not precipitation', () => {
    const hub = fakeHub();
    const api = stubWorld(hub.module);
    fogPlugin.onWorldCreate?.(api);
    fogPlugin.onAction?.(api, FOG_PLUGIN_NAME, { x: 100, y: 100 });
    for (const [x, y] of [[100, 100], [0, 0], [-5, 2000], [Number.NaN, 1]]) {
      expect(wetnessAt(x!, y!)).toBe(0);
    }
    expect(hub.entries[0]!['spawnOne']).toBeUndefined();
    fogPlugin.onWorldClose?.(api);
  });

  it('summons up to its ceiling, then refuses with the count', () => {
    const hub = fakeHub();
    const api = stubWorld(hub.module);
    fogPlugin.onWorldCreate?.(api);
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) {
      expect(fogPlugin.onAction?.(api, FOG_PLUGIN_NAME, { x: 10, y: 10 })?.ok).toBe(true);
    }
    const refused = fogPlugin.onAction?.(api, FOG_PLUGIN_NAME, { x: 10, y: 10 });
    expect(refused?.ok).toBe(false);
    expect(refused?.detail).toContain(`${MAX_ACTIVE_SYSTEMS} fog systems`);
    fogPlugin.onWorldClose?.(api);
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
