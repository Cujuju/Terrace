// The one thing this plugin's own suite pins: A NAMED STORM SURVIVES A RESTART.
//
// The sim itself is the plugin kit's and is tested there
// (server/test/plugin-kit-rotating-storms.test.ts). What is this plugin's is the
// SLICE — that what `save` writes, `load` reads back through JSON, which is the
// path a real world takes through the database. A cyclone lives eight minutes
// and is a NAMED event a world can be in the middle of, so this is the one
// plugin here where a lost slice is something a player would notice.

import { describe, expect, it } from 'vitest';
import { CYCLONE_SLICE_VERSION, loadCyclones, saveCyclones } from '../server/persistence.ts';
import { cyclones } from '../server/sim.ts';
import type { RotatingStormWorld } from '../../../server/src/plugins/kit/rotatingStorms.ts';

/** All water, so a forced storm is at home and nothing decays it. */
const WORLD: RotatingStormWorld = { worldSize: 256, heightAt: () => 0 };

describe('the cyclone slice', () => {
  it('restores the storm, its name and the roster counter through a JSON round trip', () => {
    cyclones.reset();
    const before = cyclones.spawnAt(WORLD, 100, 120);
    before.envelope = 1;
    cyclones.advance(WORLD, 0.1);
    expect(before.name).toBe('Hurricane Ada');

    // What the host actually writes and reads back.
    const written = JSON.parse(JSON.stringify(saveCyclones()));
    const expected = cyclones.states();

    cyclones.reset();
    expect(cyclones.count()).toBe(0);

    loadCyclones(written);

    expect(cyclones.states()).toEqual(expected);
    expect(cyclones.storms()[0]?.name).toBe('Hurricane Ada');
    // The roster counter travelled too: a restarted world does not hand out a
    // second Hurricane Ada.
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
