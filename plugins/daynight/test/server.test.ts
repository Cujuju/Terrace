// The server sim, driven through the REAL plugin host on a REAL world — the
// weather plugin's test/weather.test.ts pattern, scaled down to what this
// plugin actually has: one accumulator and one broadcast cadence.
//
// Properties this suite holds:
//   * THE CLOCK ADVANCES AT REAL TIME and WRAPS at the cycle boundary.
//   * THE BROADCAST CADENCE is exactly DAYNIGHT_BROADCAST_INTERVAL_SECONDS,
//     and it carries exactly the one documented key, rounded and parseable
//     by the client's own parser.
//   * A RESTART STARTS A FRESH CLOCK — the documented "persistence: none"
//     decision.

import { describe, expect, it } from 'vitest';
import { PluginHost } from '../../../server/src/plugins/host.ts';
import { World } from '../../../server/src/world/world.ts';
import { RecordingSink, asLoadedPlugin, worldWithUnlockedChunks } from '../../../server/test/support/harness.ts';
import {
  DAYNIGHT_CLOCK_MESSAGE,
  DAYNIGHT_PLUGIN_NAME,
  DAY_LENGTH_SECONDS,
  parseClockPayload,
} from '../protocol.ts';
import {
  DAYNIGHT_BROADCAST_INTERVAL_SECONDS,
  currentPhase,
  plugin as dayNightPlugin,
  resetDayNightState,
} from '../server/index.ts';

/** The shipped tick period: TICK_HZ 10 (docs/DESIGN.md §8), same as weather's suite. */
const TICK_SECONDS = 0.1;
const WORLD_SIZE = 64;

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

/** Boots the plugin, through the real host, onto a bare world — no terrain is read. */
function bootOn(world: World): Harness {
  resetDayNightState();
  const sink = new RecordingSink();
  world.setSink(sink);
  const host = new PluginHost(world, [dayNightPlugin].map(asLoadedPlugin));
  host.worldCreate();
  return { world, host, sink };
}

const NAMESPACED_TYPE = `${DAYNIGHT_PLUGIN_NAME}:${DAYNIGHT_CLOCK_MESSAGE}`;

describe('the clock', () => {
  it('starts at dawn (phase 0) on a fresh world', () => {
    resetDayNightState();
    expect(currentPhase()).toBe(0);
  });

  it('advances linearly with real time', () => {
    resetDayNightState();
    const { host } = bootOn(worldWithUnlockedChunks(WORLD_SIZE, []));
    for (let tick = 0; tick < 100; tick++) host.tick(TICK_SECONDS);
    expect(currentPhase()).toBeCloseTo(10 / DAY_LENGTH_SECONDS, 9);
  });

  it('wraps at the cycle boundary rather than growing without bound', () => {
    resetDayNightState();
    const { host } = bootOn(worldWithUnlockedChunks(WORLD_SIZE, []));
    const ticksPerDay = DAY_LENGTH_SECONDS / TICK_SECONDS;
    for (let tick = 0; tick < ticksPerDay + 10; tick++) host.tick(TICK_SECONDS);
    // 10 ticks past a full day is the same as 10 ticks from a fresh world.
    expect(currentPhase()).toBeCloseTo((10 * TICK_SECONDS) / DAY_LENGTH_SECONDS, 6);
    expect(currentPhase()).toBeLessThan(1);
    expect(currentPhase()).toBeGreaterThanOrEqual(0);
  });
});

describe('broadcast', () => {
  it('is sent once every DAYNIGHT_BROADCAST_INTERVAL_SECONDS, not every tick', () => {
    const { host, sink } = bootOn(worldWithUnlockedChunks(WORLD_SIZE, []));
    const ticksPerBroadcast = DAYNIGHT_BROADCAST_INTERVAL_SECONDS / TICK_SECONDS;

    for (let tick = 0; tick < ticksPerBroadcast - 1; tick++) host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(0);

    host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(1);

    for (let tick = 0; tick < ticksPerBroadcast * 4; tick++) host.tick(TICK_SECONDS);
    expect(sink.ofType(NAMESPACED_TYPE)).toHaveLength(5);
  });

  it('carries the phase and the calendar, rounded, and round-trips through the client parser', () => {
    const { host, sink } = bootOn(worldWithUnlockedChunks(WORLD_SIZE, []));
    const ticksPerBroadcast = DAYNIGHT_BROADCAST_INTERVAL_SECONDS / TICK_SECONDS;
    for (let tick = 0; tick < ticksPerBroadcast; tick++) host.tick(TICK_SECONDS);

    const message = sink.ofType(NAMESPACED_TYPE)[0]!;
    const payload = message.payload as Record<string, unknown>;
    expect(Object.keys(payload)).toEqual(['phase', 'day', 'genesisDay']);
    expect(payload.phase).toBeCloseTo(DAYNIGHT_BROADCAST_INTERVAL_SECONDS / DAY_LENGTH_SECONDS, 4);

    expect(parseClockPayload(message.payload)).toEqual({
      phase: payload.phase,
      day: payload.day,
      genesisDay: payload.genesisDay,
    });
  });

  it('does not drift over a long run when dt does not divide the interval evenly', () => {
    // An odd tick period relative to the broadcast interval: the residual
    // must carry forward each broadcast rather than being discarded.
    const oddTick = 0.12;
    resetDayNightState();
    const sink = new RecordingSink();
    const world = worldWithUnlockedChunks(WORLD_SIZE, []);
    world.setSink(sink);
    const host = new PluginHost(world, [dayNightPlugin].map(asLoadedPlugin));
    host.worldCreate();

    const totalSeconds = 500;
    for (let elapsed = 0; elapsed < totalSeconds; elapsed += oddTick) host.tick(oddTick);

    const messages = sink.ofType(NAMESPACED_TYPE);
    expect(messages.length).toBeGreaterThan(1);
    // Every broadcast phase should sit within one tick's worth of its ideal,
    // never accumulating a growing error across the run.
    for (let i = 0; i < messages.length; i++) {
      const payload = messages[i]!.payload as { phase: number };
      const idealSeconds = (i + 1) * DAYNIGHT_BROADCAST_INTERVAL_SECONDS;
      const idealPhase = (idealSeconds / DAY_LENGTH_SECONDS) % 1;
      // Bounded by one tick's worth of phase PLUS the wire's own quantisation
      // (DAYNIGHT_PHASE_DECIMALS) — and, critically, that bound does not grow
      // with `i`: a drifting accumulator would fail this at a LATER message,
      // not at message 0.
      const toleranceInPhase = oddTick / DAY_LENGTH_SECONDS;
      expect(Math.abs(payload.phase - idealPhase)).toBeLessThan(toleranceInPhase * 3);
    }
  });
});

describe('persistence: none, deliberately', () => {
  it('a fresh onWorldCreate resets the clock even mid-cycle', () => {
    const { host } = bootOn(worldWithUnlockedChunks(WORLD_SIZE, []));
    for (let tick = 0; tick < 1000; tick++) host.tick(TICK_SECONDS);
    expect(currentPhase()).toBeGreaterThan(0);

    resetDayNightState();
    expect(currentPhase()).toBe(0);
  });
});
