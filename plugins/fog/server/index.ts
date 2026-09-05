// fog — drifting banks of haze, as a plugin.
//
// Core knows nothing about fog. This half owns the sim — a population of discs
// over core's disc engine (server/src/plugins/kit/discSystems.ts) — and publishes
// it on one namespaced message; the client half draws it. NOT scene.fog: core's
// scene fog, its lighting rig and its sky are never touched by either half. This
// is local geometry that moves with the mass that owns it and leaves the rest of
// the map in the sun, which is the whole difference between weather and a filter
// over the world.
//
// It reads the world NOWHERE and writes it nowhere.
//
// FOG DOES NOT WET ANYTHING. It registers with the hub like every other kind, and
// its `wetnessAt` is a constant zero: a haze is not precipitation, and a fire
// under fog is a fire in damp air, not a fire in the rain. That zero is a
// deliberate answer rather than an omission — the hub takes a max, so an honest
// zero costs nothing and a missing member would fail the registration.
//
// PERSISTENCE: NONE, DELIBERATELY. See rain's header for the argument.

import { logInfo } from '../../../server/src/log.ts';
import type {
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { devForceEnvName, readDevForce } from '../../../server/src/plugins/kit/devForce.ts';
import { createDiscSystems } from '../../../server/src/plugins/kit/discSystems.ts';
import {
  FOG_COVERAGE_FRACTION,
  FOG_PLUGIN_NAME,
  FOG_SYSTEMS_MESSAGE,
  MAX_ACTIVE_SYSTEMS,
} from '../protocol.ts';
import { fogRandom } from './rng.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

/** Ticks between broadcasts. 10 → 1 Hz at the shipped TICK_HZ of 10. */
export const BROADCAST_TICK_INTERVAL = 10;

/** Hard ceiling on systems in one broadcast. See MAX_ACTIVE_SYSTEMS. */
export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

/** The environment switch that parks one system over the world centre. */
export const FOG_DEV_FORCE_ENV = devForceEnvName(FOG_PLUGIN_NAME);

/**
 * THE SIM. One population of discs, drifting on the hub's wind.
 *
 * No siting predicate: fog forms anywhere, and a bank lying over open water is
 * the most ordinary fog there is.
 */
const systems = createDiscSystems({
  coverageFraction: FOG_COVERAGE_FRACTION,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: fogRandom,
});

/** Ticks since boot, for the broadcast cadence. */
let tickCount = 0;

/** The living systems, for tests. */
export function livingSystems(): ReturnType<typeof systems.systems> {
  return systems.systems();
}

/** The systems as they go on the wire. */
export function systemStates(): ReturnType<typeof systems.states> {
  return systems.states(windVelocity());
}

/**
 * How wet cell (x, y) is under FOG: zero, always. See this file's header — a
 * haze is not precipitation, and the pre-split sim counted it exactly this way
 * (its WETTING_KINDS were rain, storm and snow, and fog was not one of them).
 */
export function wetnessAt(): number {
  return 0;
}

function simulate(world: WorldApi, dt: number): void {
  systems.advance(world.worldSize, dt, windVelocity());

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(FOG_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: FOG_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;

    loadWeatherBridge(world);
    registerWithHub({
      name: FOG_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      // NO `spawnOne`: a roll another kind could not site is a roll for weather,
      // and handing it to fog would turn a failed snow into a haze bank — a
      // different thing in the sky, not the same cloud arriving.
    });

    const forced = readDevForce(FOG_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(`[fog] ${FOG_DEV_FORCE_ENV}=1 — one fog system parked over the world centre`);
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
  },

  // Groups this plugin's cards in the admin panel; see TerracePlugin.archetype.
  archetype: 'weather',
  actions: [
    {
      key: FOG_PLUGIN_NAME,
      label: 'Bring fog',
      description:
        'A fog bank gathers over where you are looking, then drifts on the wind like any other system.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== FOG_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${FOG_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} fog systems are already in the sky` };
    }
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    world.broadcast(FOG_SYSTEMS_MESSAGE, { systems: systemStates() });
    return { ok: true, detail: `fog system ${system.id} gathering at (${site.x}, ${site.y})` };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

/** Test seam: drops all accumulated state so a suite can start from zero. */
export function resetFogState(): void {
  tickCount = 0;
  systems.reset();
}

/** Test seam: the sim itself, for a suite that drives it without a host. */
export { systems as fogSystems };
