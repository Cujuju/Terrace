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
  SNOW_COVERAGE_FRACTION,
  SNOW_FOOTPRINT_AREA_SCALE,
  SNOW_PLUGIN_NAME,
  SNOW_SYSTEMS_MESSAGE,
} from '../protocol.ts';
import { snowRandom } from './rng.ts';
import { isSnowSite, type SnowWorld } from './siting.ts';
import {
  handOffSpawnTo,
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

export const BROADCAST_TICK_INTERVAL = 10;

export const BROADCAST_SYSTEM_CEILING = MAX_ACTIVE_SYSTEMS;

export const SNOW_DEV_FORCE_ENV = devForceEnvName(SNOW_PLUGIN_NAME);

export const SNOW_HAND_OFF_KIND = 'rain';

let currentWorld: SnowWorld | null = null;

const systems = createDiscSystems({
  coverageFraction: SNOW_COVERAGE_FRACTION,
  footprintAreaScale: SNOW_FOOTPRINT_AREA_SCALE,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: snowRandom,
  siting: (x, y, radius) =>
    currentWorld !== null && isSnowSite(currentWorld, x, y, radius),
  onUnsited: () => {
    handOffSpawnTo(SNOW_HAND_OFF_KIND);
  },
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

function simulate(world: WorldApi, dt: number): void {
  currentWorld = world;
  systems.advance(world.worldSize, dt, windVelocity());

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(SNOW_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: SNOW_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;
    currentWorld = world;

    loadWeatherBridge(world);
    registerWithHub({
      name: SNOW_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
    });

    const forced = readDevForce(SNOW_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[snow] ${SNOW_DEV_FORCE_ENV}=1 — one snow system parked over the world centre`,
      );
    }
  },

  onWorldClose(): void {
    unregisterFromHub();
    systems.reset();
    currentWorld = null;
  },

  archetype: 'weather',
  actions: [
    {
      key: SNOW_PLUGIN_NAME,
      label: 'Bring snow',
      description:
        'A snow system gathers over where you are looking — high ground or not, since a person who asked for snow to look at it is not served by rain — then drifts on the wind like any other.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== SNOW_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    if (systems.isForced()) {
      return {
        ok: false,
        detail: `${SNOW_DEV_FORCE_ENV} is set — the sky is parked; unset it and restart`,
      };
    }
    if (systems.systems().length >= MAX_ACTIVE_SYSTEMS) {
      return { ok: false, detail: `${MAX_ACTIVE_SYSTEMS} snow systems are already in the sky` };
    }
    const system = systems.spawnAt(world.worldSize, site.x, site.y);
    world.broadcast(SNOW_SYSTEMS_MESSAGE, { systems: systemStates() });
    return { ok: true, detail: `snow system ${system.id} gathering at (${site.x}, ${site.y})` };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

export function resetSnowState(): void {
  tickCount = 0;
  systems.reset();
}

export { systems as snowSystems };
export function setSnowWorld(world: SnowWorld | null): void {
  currentWorld = world;
}
