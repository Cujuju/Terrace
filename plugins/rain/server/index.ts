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
  MAX_ACTIVE_SYSTEMS,
  RAIN_COVERAGE_FRACTION,
  RAIN_FOOTPRINT_AREA_SCALE,
  RAIN_PLUGIN_NAME,
  RAIN_SYSTEMS_MESSAGE,
} from '../protocol.ts';
import { rainRandom } from './rng.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

export const BROADCAST_TICK_INTERVAL = 10;

export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

export const RAIN_DEV_FORCE_ENV = devForceEnvName(RAIN_PLUGIN_NAME);

const systems = createDiscSystems({
  coverageFraction: RAIN_COVERAGE_FRACTION,
  footprintAreaScale: RAIN_FOOTPRINT_AREA_SCALE,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: rainRandom,
});

let tickCount = 0;

export function livingSystems(): ReturnType<typeof systems.systems> {
  return systems.systems();
}

export function systemStates(): ReturnType<typeof systems.states> {
  return systems.states(windVelocity());
}

export function wetnessAt(x: number, y: number): number {
  return systems.intensityAt(x, y);
}

export function spawnOne(): boolean {
  if (systems.isForced()) return false;
  if (systems.systems().length >= systems.capFor(currentWorldSize)) return false;
  return systems.spawnOne(currentWorldSize) !== null;
}

let currentWorldSize = 0;

function simulate(world: WorldApi, dt: number): void {
  currentWorldSize = world.worldSize;
  systems.advance(world.worldSize, dt, windVelocity());

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(RAIN_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: RAIN_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;
    currentWorldSize = world.worldSize;

    loadWeatherBridge(world);
    registerWithHub({
      name: RAIN_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      spawnOne,
    });

    const forced = readDevForce(RAIN_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[rain] ${RAIN_DEV_FORCE_ENV}=1 — one rain system parked over the world centre`,
      );
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
  },

  archetype: 'weather',
  actions: [
    {
      key: RAIN_PLUGIN_NAME,
      label: 'Bring rain',
      description:
        'A rain system gathers over where you are looking, then drifts on the wind like any other.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== RAIN_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${RAIN_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} rain systems are already in the sky` };
    }
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    world.broadcast(RAIN_SYSTEMS_MESSAGE, { systems: systemStates() });
    return { ok: true, detail: `rain system ${system.id} gathering at (${site.x}, ${site.y})` };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

export function resetRainState(): void {
  tickCount = 0;
  systems.reset();
}

export { systems as rainSystems };
