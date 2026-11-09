import { afterEach, describe, expect, it } from 'vitest';
import { BAND_HEIGHT } from '@terrace/shared';
import { worldWithSibling } from '../../../server/test/support/harness.ts';
import { currentSettling, plugin } from '../server/index.ts';
import type { NamedFuelSource } from '../server/fire-bridge.ts';

const sources: NamedFuelSource[] = [];
const bridgeWorld = worldWithSibling('fire', {
  registerEntityFuel: (source: NamedFuelSource) => { sources.push(source); },
  unregisterEntityFuel: () => {},
});

afterEach(() => {
  plugin.onWorldClose?.(bridgeWorld);
  sources.length = 0;
});

describe('fire candidate selection', () => {
  it('filters rejected walkers before finding the nearest accepted individual', () => {
    plugin.onWorldCreate?.(bridgeWorld);
    const world = { worldSize: 512, heightAt: () => 6 * BAND_HEIGHT };
    const settling = currentSettling();
    expect(settling.emitFrom(world, 40, 40)).toBe(true);
    expect(settling.emitFrom(world, 40, 40)).toBe(true);
    const [nearest, next] = settling.walkers();
    nearest.x = 40.5;
    nearest.y = 40.5;
    next.x = 40.75;
    next.y = 40.5;
    const entityAt = sources[0].entityAt as (
      x: number, y: number, accepts?: (id: number) => boolean,
    ) => { id: number; distanceCells: number } | null;

    expect(entityAt(40.5, 40.5)?.id).toBe(nearest.id);
    expect(entityAt(40.5, 40.5, (id) => id !== nearest.id)?.id).toBe(next.id);
    expect(entityAt(40.5, 40.5, () => false)).toBeNull();
  });
});
