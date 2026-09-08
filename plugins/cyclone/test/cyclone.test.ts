import { describe, expect, it } from 'vitest';
import { CYCLONE_SLICE_VERSION, loadCyclones, saveCyclones } from '../server/persistence.ts';
import { cyclones } from '../server/sim.ts';
import type { RotatingStormWorld } from '../../../server/src/plugins/kit/rotatingStorms.ts';

const WORLD: RotatingStormWorld = { worldSize: 256, heightAt: () => 0 };

describe('the cyclone slice', () => {
  it('restores the storm, its name and the roster counter through a JSON round trip', () => {
    cyclones.reset();
    const before = cyclones.spawnAt(WORLD, 100, 120);
    before.envelope = 1;
    cyclones.advance(WORLD, 0.1);
    expect(before.name).toBe('Hurricane Ada');

    const written = JSON.parse(JSON.stringify(saveCyclones()));
    const expected = cyclones.states();

    cyclones.reset();
    expect(cyclones.count()).toBe(0);

    loadCyclones(written);

    expect(cyclones.states()).toEqual(expected);
    expect(cyclones.storms()[0]?.name).toBe('Hurricane Ada');
    expect(cyclones.spawnAt(WORLD, 100, 120).name).toBe('Hurricane Bramble');
  });

  it('leaves an empty sky when the slice is unreadable, rather than the old one', () => {
    cyclones.reset();
    cyclones.spawnAt(WORLD, 100, 120);
    loadCyclones({ storms: 'not a list' });
    expect(cyclones.count()).toBe(0);
  });

  it('is version 1 — the only version there has been', () => {
    expect(CYCLONE_SLICE_VERSION).toBe(1);
  });
});
