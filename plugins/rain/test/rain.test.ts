// The rain sim, driven through the REAL plugin host on a REAL world.
//
// These are the pre-split weather suite's `spawn and decay` and `broadcast`
// blocks, moved to the kind that owns the systems now. The two properties they
// exist to hold are unchanged:
//
//   * SPAWN AND DECAY BOUNDS — never more than the cap, never a radius outside
//     the band, never an intensity outside [0, 1].
//   * BROADCAST SHAPE AND CADENCE — one message a second, carrying exactly what
//     protocol.ts says it carries, and parseable back by the client's own parser.
//
// DRIFT COHERENCE moved WITH the wind: the wind is the hub's now, so "every
// system is displaced by the same vector" is a statement about rain riding what
// the hub publishes.
//
// THE HUB IS A LOCAL FAKE, not an import of plugins/weather. A plugin's suite
// depending on a neighbouring plugin is the same cross-plugin coupling the
// shipped code refuses — the hub's own registry is tested in its own suite
// (plugins/weather/test/hub.test.ts). What is restated here is the CONTRACT this
// plugin's bridge duck-types, which is exactly what a documented copy is for,
// and a fixed wind is what makes the drift assertions deterministic.
//
// Everything stochastic is driven through setRainRandomSource, so nothing here
// is a flaky statistical assertion where a deterministic one would do.

import { beforeEach, describe, expect, it } from 'vitest';
import { SEA_LEVEL, BAND_HEIGHT, cellsAcross, createSeededRng } from '@terrace/shared';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { World } from '../../../server/src/world/world.ts';
import {
  RecordingSink,
  asLoadedPlugin,
  asLoadedPluginExporting,
} from '../../../server/test/support/harness.ts';
import { worldWithTerrain } from '../../../server/test/support/world.ts';
import {
  DISC_FADE_SECONDS,
  DISC_SYSTEM_MIN_RADIUS_CELLS,
  DISC_SYSTEM_MAX_RADIUS_CELLS,
  DISC_MIN_PEAK_INTENSITY,
} from '../../../server/src/plugins/kit/discSystems.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  RAIN_PLUGIN_NAME,
  RAIN_SYSTEMS_MESSAGE,
  parseDiscSystemsPayload,
} from '../protocol.ts';
import {
  BROADCAST_SYSTEM_CEILING,
  BROADCAST_TICK_INTERVAL,
  livingSystems,
  plugin as rainPlugin,
  rainSystems,
  resetRainState,
  systemStates,
} from '../server/index.ts';
import { setRainRandomSource } from '../server/rng.ts';
import { resetWeatherBridge } from '../server/weather-bridge.ts';

/** The shipped tick period: TICK_HZ 10 (docs/DESIGN.md). */
const TICK_SECONDS = 0.1;

/** The nominal world — 512 WORLD UNITS square, in cells. */
const WORLD_SIZE = cellsAcross(512);

function flatWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
}

/**
 * The wind the fake hub blows. Fixed and non-axis-aligned, so a displacement can
 * only match it if both components were applied.
 */
const HUB_WIND = { heading: 0.7, speed: 1.3 };

const HUB_WIND_VELOCITY = {
  vx: Math.cos(HUB_WIND.heading) * HUB_WIND.speed,
  vy: Math.sin(HUB_WIND.heading) * HUB_WIND.speed,
};

/** The registered kinds, as the real hub keeps them; see its registry.ts. */
const registered = new Map<string, { spawnOne?(): boolean }>();

/** A stand-in for the `weather` hub, exporting exactly what rain duck-types. */
const fakeHub = {
  currentWind: () => HUB_WIND,
  registerSkyKind: (entry: { name: string; spawnOne?(): boolean }) => {
    registered.set(entry.name, entry);
    return () => registered.delete(entry.name);
  },
  spawnSkyKind: (name: string) => registered.get(name)?.spawnOne?.() === true,
};

/** The hub, as a plugin the host can load under the name rain looks up. */
const fakeHubPlugin = { name: 'weather' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/**
 * Boots rain beside a stand-in hub, through the real host, with the hub's module
 * namespace exposed as a sibling — which is how rain finds the wind in the
 * shipped server (issue #196's by-name lookup).
 */
function bootOn(world: World): Harness {
  resetRainState();
  resetWeatherBridge();
  registered.clear();
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [
    asLoadedPlugin(rainPlugin),
    asLoadedPluginExporting(fakeHubPlugin, fakeHub as never),
  ]);
  host.worldCreate();
  return { world, host, sink };
}

const NAMESPACED_TYPE = `${RAIN_PLUGIN_NAME}:${RAIN_SYSTEMS_MESSAGE}`;

beforeEach(() => {
  setRainRandomSource(createSeededRng(20260814).next);
  resetRainState();
  resetWeatherBridge();
});

describe('spawn and decay', () => {
  it('never exceeds the cap, and stays inside every band, over a long run', () => {
    const { host } = bootOn(flatWorld());
    let mostAlive = 0;
    // Violations are counted rather than asserted per tick: two hours of
    // simulated time at 10 Hz is 72 000 ticks, and an assertion inside the loop
    // would make the suite spend all its time in the matcher rather than in the
    // sim. A count of zero is the same guarantee.
    let overCap = 0;
    let outOfBand = 0;
    const cap = rainSystems.capFor(WORLD_SIZE);
    for (let tick = 0; tick < 72000; tick++) {
      host.tick(TICK_SECONDS);
      const alive = livingSystems();
      if (alive.length > cap) overCap++;
      if (alive.length > mostAlive) mostAlive = alive.length;
      for (const system of alive) {
        if (
          system.radius < DISC_SYSTEM_MIN_RADIUS_CELLS ||
          system.radius > DISC_SYSTEM_MAX_RADIUS_CELLS
        ) {
          outOfBand++;
        }
        if (system.peakIntensity < DISC_MIN_PEAK_INTENSITY || system.peakIntensity > 1) {
          outOfBand++;
        }
        if (system.envelope < 0 || system.envelope > 1) outOfBand++;
      }
    }
    expect(overCap).toBe(0);
    expect(outOfBand).toBe(0);
    // The cap must actually BIND at some point, or this test proves nothing.
    expect(mostAlive).toBe(cap);
    expect(cap).toBeLessThanOrEqual(MAX_ACTIVE_SYSTEMS);
    expect(BROADCAST_SYSTEM_CEILING).toBe(MAX_ACTIVE_SYSTEMS);
  });

  it('gathers a new system from nothing rather than popping it in', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    expect(system.envelope).toBe(0);
    expect(systemStates()[0]!.intensity).toBe(0);

    // Half the fade later it is half gathered; a full fade later, fully.
    const halfTicks = Math.round(DISC_FADE_SECONDS / 2 / TICK_SECONDS);
    for (let tick = 0; tick < halfTicks; tick++) host.tick(TICK_SECONDS);
    expect(system.envelope).toBeCloseTo(0.5, 6);
    for (let tick = 0; tick < halfTicks + 1; tick++) host.tick(TICK_SECONDS);
    expect(system.envelope).toBe(1);
  });

  it('dissipates over the same fade, then removes the system', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    // A source that never rolls a spawn or a death, so the only thing that
    // happens is the one system we placed by hand.
    setRainRandomSource(() => 0.999999);
    system.envelope = 1;
    system.retiring = true;

    const fadeTicks = Math.round(DISC_FADE_SECONDS / TICK_SECONDS);
    for (let tick = 0; tick < fadeTicks - 1; tick++) host.tick(TICK_SECONDS);
    expect(livingSystems()).toHaveLength(1);
    expect(system.envelope).toBeGreaterThan(0);

    // Two more ticks, not one: 300 accumulations of 0.1/30 land a floating-point
    // hair above zero, so the fade ARRIVES within one tick of nominal rather
    // than exactly on it. That slack is the reason the fade is linear at all.
    host.tick(TICK_SECONDS);
    host.tick(TICK_SECONDS);
    expect(livingSystems()).toHaveLength(0);
  });
});

describe('drift coherence', () => {
  it('moves every system by exactly the hub wind’s displacement each tick', () => {
    // "Like regular weather patterns, it should move together in large chunks"
    // (owner, 2026-08-14) — after the split this is a statement about a kind
    // plugin riding the wind the hub publishes.
    const { host } = bootOn(flatWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) rainSystems.spawnOne(WORLD_SIZE);
    expect(livingSystems()).toHaveLength(MAX_ACTIVE_SYSTEMS);

    const before = livingSystems().map((system) => ({ x: system.x, y: system.y }));
    host.tick(TICK_SECONDS);
    const after = livingSystems().map((system) => ({ x: system.x, y: system.y }));
    expect(after).toHaveLength(before.length);

    const deltas = after.map((pose, index) => ({
      dx: pose.x - before[index]!.x,
      dy: pose.y - before[index]!.y,
    }));
    for (const delta of deltas) {
      expect(delta.dx).toBeCloseTo(deltas[0]!.dx, 12);
      expect(delta.dy).toBeCloseTo(deltas[0]!.dy, 12);
    }
    // …and it is the hub wind's own displacement, not merely a shared one.
    expect(deltas[0]!.dx).toBeCloseTo(HUB_WIND_VELOCITY.vx * TICK_SECONDS, 12);
    expect(deltas[0]!.dy).toBeCloseTo(HUB_WIND_VELOCITY.vy * TICK_SECONDS, 12);
  });

  it('never changes a system’s radius — the mass moves as a whole', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    const radius = system.radius;
    for (let tick = 0; tick < 600; tick++) host.tick(TICK_SECONDS);
    // It may have died of old age or drifted off; if it is still here, its shape
    // is untouched.
    const survivor = livingSystems().find((live) => live.id === system.id);
    if (survivor !== undefined) expect(survivor.radius).toBe(radius);
  });
});

describe('broadcast', () => {
  it('is sent once per BROADCAST_TICK_INTERVAL ticks — 1 Hz at TICK_HZ 10', () => {
    const { host, sink } = bootOn(flatWorld());
    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL - 1; tick++) host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(0);

    host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(1);

    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL * 9; tick++) host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(10);
    expect(BROADCAST_TICK_INTERVAL * TICK_SECONDS).toBe(1);
  });

  it('sends an EMPTY list for a clear sky rather than no message at all', () => {
    // A source that always returns 1 never fires a Poisson roll (rollEvent
    // compares against a probability strictly below 1), so the sky is
    // deterministically clear for this second.
    setRainRandomSource(() => 1);
    const { host, sink } = bootOn(flatWorld());
    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL; tick++) host.tick(TICK_SECONDS);
    const message = sink.ofType(NAMESPACED_TYPE)[0]!;
    expect(message.payload).toEqual({ systems: [] });
    // …and the client's own parser reads that as "no weather", not as garbage.
    expect(parseDiscSystemsPayload(message.payload)).toEqual([]);
  });

  it('carries exactly the seven documented keys, rounded, and round-trips', () => {
    // SEVEN, not the pre-split eight: `kind` is gone, because the message itself
    // is namespaced by the plugin that sends it (protocol.ts).
    const { host, sink } = bootOn(flatWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) rainSystems.spawnOne(WORLD_SIZE);
    // Gather them so intensity is not zero.
    for (let tick = 0; tick < DISC_FADE_SECONDS / TICK_SECONDS; tick++) host.tick(TICK_SECONDS);

    const message = sink.ofType(NAMESPACED_TYPE).at(-1)!;
    const payload = message.payload as { systems: Record<string, unknown>[] };
    expect(payload.systems.length).toBeGreaterThan(0);
    expect(payload.systems.length).toBeLessThanOrEqual(BROADCAST_SYSTEM_CEILING);

    for (const system of payload.systems) {
      expect(Object.keys(system).sort()).toEqual(
        ['id', 'intensity', 'radius', 'vx', 'vy', 'x', 'y'].sort(),
      );
      // Rounded to the documented precision — two places for anything in cells,
      // three for the intensity fraction.
      for (const key of ['x', 'y', 'radius', 'vx', 'vy'] as const) {
        const value = system[key] as number;
        expect(Math.round(value * 100)).toBeCloseTo(value * 100, 9);
      }
      const intensity = system.intensity as number;
      expect(Math.round(intensity * 1000)).toBeCloseTo(intensity * 1000, 9);
      expect(intensity).toBeGreaterThanOrEqual(0);
      expect(intensity).toBeLessThanOrEqual(1);
    }

    const parsed = parseDiscSystemsPayload(message.payload);
    expect(parsed).not.toBeNull();
    expect(parsed).toHaveLength(payload.systems.length);
  });

  it('gives every system the same velocity — one wind, on the wire too', () => {
    bootOn(flatWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) rainSystems.spawnOne(WORLD_SIZE);
    const states = systemStates();
    expect(states.length).toBeGreaterThan(1);
    for (const state of states) {
      expect(state.vx).toBe(states[0]!.vx);
      expect(state.vy).toBe(states[0]!.vy);
    }
  });

  it('contributes nothing to the snapshot, and never edits the world', () => {
    // The birds precedent (docs/DESIGN.md): transient ambience is re-created,
    // never restored. Rain that stopped you building would be a game mechanic.
    expect(rainPlugin.persistence).toBeUndefined();
    expect(rainPlugin.onIntent).toBeUndefined();
    expect(rainPlugin.onTerrainChanged).toBeUndefined();
  });

  it('starts a fresh sky on world create, whatever ran before it', () => {
    const world = flatWorld();
    bootOn(world);
    rainSystems.spawnOne(WORLD_SIZE);
    expect(livingSystems()).toHaveLength(1);
    bootOn(world);
    expect(livingSystems()).toHaveLength(0);
  });
});

describe('the hand-off rain offers other kinds (#285)', () => {
  it('births one system on request, and refuses once it is at its own cap', () => {
    const { host } = bootOn(flatWorld());
    // Registered with the hub, and reachable BY NAME rather than by import —
    // which is the whole mechanism snow's fallback to rain now uses.
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) {
      expect(fakeHub.spawnSkyKind(RAIN_PLUGIN_NAME)).toBe(true);
    }
    expect(livingSystems()).toHaveLength(MAX_ACTIVE_SYSTEMS);
    expect(fakeHub.spawnSkyKind(RAIN_PLUGIN_NAME)).toBe(false);
    // A kind nobody registered is a false, not a throw.
    expect(fakeHub.spawnSkyKind('hail')).toBe(false);
    host.tick(TICK_SECONDS);
  });
});
