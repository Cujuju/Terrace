// The one thing this plugin's own suite pins: A FUNNEL SURVIVES A RESTART.
//
// The sim itself is the plugin kit's and is tested there
// (server/test/plugin-kit-rotating-storms.test.ts). What is this plugin's is the
// SLICE — that what `save` writes, `load` reads back through JSON, which is the
// path a real world takes through the database and the one place a version skew
// or a renamed field would be silently lost.

import { describe, expect, it } from 'vitest';
import { loadTornadoes, saveTornadoes, TORNADO_SLICE_VERSION } from '../server/persistence.ts';
import { tornadoes } from '../server/sim.ts';
import type { RotatingStormWorld } from '../../../server/src/plugins/kit/rotatingStorms.ts';

/** Flat land, so a forced funnel is at home and nothing decays it. */
const WORLD: RotatingStormWorld = { worldSize: 256, heightAt: () => 400 };

describe('the tornado slice', () => {
  it('restores the funnels and the generator through a JSON round trip', () => {
    tornadoes.reset();
    const before = tornadoes.spawnAt(WORLD, 100, 120);
    before.envelope = 1;
    tornadoes.advance(WORLD, 0.1);

    // What the host actually writes and reads back.
    const written = JSON.parse(JSON.stringify(saveTornadoes()));
    const expected = tornadoes.states();

    tornadoes.reset();
    expect(tornadoes.count()).toBe(0);

    loadTornadoes(written);

    expect(tornadoes.states()).toEqual(expected);
    // The id counter travelled too: the next funnel is not this one's twin.
    expect(tornadoes.spawnAt(WORLD, 10, 10).id).toBe(before.id + 1);
  });

  it('leaves an empty sky when the slice is unreadable, rather than the old one', () => {
    tornadoes.reset();
    tornadoes.spawnAt(WORLD, 100, 120);
    loadTornadoes({ nextStormId: 'no' });
    expect(tornadoes.count()).toBe(0);
  });

  it('is version 1 — the only version there has been', () => {
    expect(TORNADO_SLICE_VERSION).toBe(1);
  });
});
