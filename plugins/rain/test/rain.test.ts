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
  DISC_MIN_PEAK_INTENSITY,
  discMaxRadiusFor,
  discMinRadiusFor,
} from '../../../server/src/plugins/kit/discSystems.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  RAIN_FOOTPRINT_AREA_SCALE,
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

const TICK_SECONDS = 0.1;

const WORLD_SIZE = cellsAcross(512);

function flatWorld(): World {
  return worldWithTerrain(WORLD_SIZE, () => SEA_LEVEL - BAND_HEIGHT);
}

const HUB_WIND = { heading: 0.7, speed: 1.3 };

const HUB_WIND_VELOCITY = {
  vx: Math.cos(HUB_WIND.heading) * HUB_WIND.speed,
  vy: Math.sin(HUB_WIND.heading) * HUB_WIND.speed,
};

const registered = new Map<string, { spawnOne?(): boolean }>();

const fakeHub = {
  currentWind: () => HUB_WIND,
  registerSkyKind: (entry: { name: string; spawnOne?(): boolean }) => {
    registered.set(entry.name, entry);
    return () => registered.delete(entry.name);
  },
  spawnSkyKind: (name: string) => registered.get(name)?.spawnOne?.() === true,
};

const fakeHubPlugin = { name: 'weather' };

interface Harness {
  readonly world: World;
  readonly host: PluginHost;
  readonly sink: RecordingSink;
}

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
    let overCap = 0;
    let outOfBand = 0;
    const cap = rainSystems.capFor(WORLD_SIZE);
    const minRadius = discMinRadiusFor(RAIN_FOOTPRINT_AREA_SCALE);
    const maxRadius = discMaxRadiusFor(WORLD_SIZE, RAIN_FOOTPRINT_AREA_SCALE);
    for (let tick = 0; tick < 72000; tick++) {
      host.tick(TICK_SECONDS);
      const alive = livingSystems();
      if (alive.length > cap) overCap++;
      if (alive.length > mostAlive) mostAlive = alive.length;
      for (const system of alive) {
        if (
          system.radius < minRadius ||
          system.radius > maxRadius
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
    expect(mostAlive).toBe(cap);
    expect(cap).toBeLessThanOrEqual(MAX_ACTIVE_SYSTEMS);
    expect(BROADCAST_SYSTEM_CEILING).toBe(MAX_ACTIVE_SYSTEMS);
  });

  it('gathers a new system from nothing rather than popping it in', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    expect(system.envelope).toBe(0);
    expect(systemStates()[0]!.intensity).toBe(0);

    const halfTicks = Math.round(DISC_FADE_SECONDS / 2 / TICK_SECONDS);
    for (let tick = 0; tick < halfTicks; tick++) host.tick(TICK_SECONDS);
    expect(system.envelope).toBeCloseTo(0.5, 6);
    for (let tick = 0; tick < halfTicks + 1; tick++) host.tick(TICK_SECONDS);
    expect(system.envelope).toBe(1);
  });

  it('dissipates over the same fade, then removes the system', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    setRainRandomSource(() => 0.999999);
    system.envelope = 1;
    system.retiring = true;

    const fadeTicks = Math.round(DISC_FADE_SECONDS / TICK_SECONDS);
    for (let tick = 0; tick < fadeTicks - 1; tick++) host.tick(TICK_SECONDS);
    expect(livingSystems()).toHaveLength(1);
    expect(system.envelope).toBeGreaterThan(0);

    host.tick(TICK_SECONDS);
    host.tick(TICK_SECONDS);
    expect(livingSystems()).toHaveLength(0);
  });
});

describe('drift coherence', () => {
  it('moves every system by exactly the hub wind’s displacement each tick', () => {
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
    expect(deltas[0]!.dx).toBeCloseTo(HUB_WIND_VELOCITY.vx * TICK_SECONDS, 12);
    expect(deltas[0]!.dy).toBeCloseTo(HUB_WIND_VELOCITY.vy * TICK_SECONDS, 12);
  });

  it('never changes a system’s radius — the mass moves as a whole', () => {
    const { host } = bootOn(flatWorld());
    const system = rainSystems.spawnOne(WORLD_SIZE)!;
    const radius = system.radius;
    for (let tick = 0; tick < 600; tick++) host.tick(TICK_SECONDS);
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
    setRainRandomSource(() => 1);
    const { host, sink } = bootOn(flatWorld());
    for (let tick = 0; tick < BROADCAST_TICK_INTERVAL; tick++) host.tick(TICK_SECONDS);
    const message = sink.ofType(NAMESPACED_TYPE)[0]!;
    expect(message.payload).toEqual({ systems: [] });
    expect(parseDiscSystemsPayload(message.payload)).toEqual([]);
  });

  it('carries exactly the seven documented keys, rounded, and round-trips', () => {
    const { host, sink } = bootOn(flatWorld());
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) rainSystems.spawnOne(WORLD_SIZE);
    for (let tick = 0; tick < DISC_FADE_SECONDS / TICK_SECONDS; tick++) host.tick(TICK_SECONDS);

    const message = sink.ofType(NAMESPACED_TYPE).at(-1)!;
    const payload = message.payload as { systems: Record<string, unknown>[] };
    expect(payload.systems.length).toBeGreaterThan(0);
    expect(payload.systems.length).toBeLessThanOrEqual(BROADCAST_SYSTEM_CEILING);

    for (const system of payload.systems) {
      expect(Object.keys(system).sort()).toEqual(
        ['id', 'intensity', 'radius', 'vx', 'vy', 'x', 'y'].sort(),
      );
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
    for (let n = 0; n < MAX_ACTIVE_SYSTEMS; n++) {
      expect(fakeHub.spawnSkyKind(RAIN_PLUGIN_NAME)).toBe(true);
    }
    expect(livingSystems()).toHaveLength(MAX_ACTIVE_SYSTEMS);
    expect(fakeHub.spawnSkyKind(RAIN_PLUGIN_NAME)).toBe(false);
    expect(fakeHub.spawnSkyKind('hail')).toBe(false);
    host.tick(TICK_SECONDS);
  });
});
