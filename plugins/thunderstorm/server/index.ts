import { logInfo } from '../../../server/src/log.ts';
import type {
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { devForceEnvName, readDevForce } from '../../../server/src/plugins/kit/devForce.ts';
import { createDiscSystems } from '../../../server/src/plugins/kit/discSystems.ts';
import { isRefusal, summonDisc } from '../../../server/src/plugins/kit/discSummon.ts';
import {
  MAX_ACTIVE_SYSTEMS,
  THUNDERSTORM_COVERAGE_FRACTION,
  THUNDERSTORM_PLUGIN_NAME,
  THUNDERSTORM_STRIKES_MESSAGE,
  THUNDERSTORM_SYSTEMS_MESSAGE,
  packStrikes,
} from '../protocol.ts';
import { rollStrikes } from './lightning.ts';
import { thunderstormRandom } from './rng.ts';
import {
  loadWeatherBridge,
  registerWithHub,
  unregisterFromHub,
  windVelocity,
} from './weather-bridge.ts';

export const BROADCAST_TICK_INTERVAL = 10;

export const THUNDERSTORM_DEV_FORCE_ENV = devForceEnvName(THUNDERSTORM_PLUGIN_NAME);

const systems = createDiscSystems({
  coverageFraction: THUNDERSTORM_COVERAGE_FRACTION,
  maxActiveSystems: MAX_ACTIVE_SYSTEMS,
  random: thunderstormRandom,
});

let tickCount = 0;

export function systemStates(): ReturnType<typeof systems.states> {
  return systems.states(windVelocity());
}

export function wetnessAt(x: number, y: number): number {
  return systems.intensityAt(x, y);
}

export function spawnOne(): boolean {
  return systems.spawnOne(currentWorldSize) !== null;
}

let currentWorldSize = 0;

function simulate(world: WorldApi, dt: number): void {
  currentWorldSize = world.worldSize;
  systems.advance(world.worldSize, dt, windVelocity());

  const strikes = rollStrikes(world, systems.systems(), dt);
  if (strikes.length > 0) {
    world.broadcastVisible(
      THUNDERSTORM_STRIKES_MESSAGE,
      strikes,
      (strike) => strike,
      (visible) => ({ strikes: packStrikes(visible) }),
      { skipEmpty: true },
    );
    world.emitEvent(THUNDERSTORM_STRIKES_MESSAGE, { strikes: packStrikes(strikes) });
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;
  world.broadcast(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: systemStates() });
}

export const plugin: TerracePlugin = {
  name: THUNDERSTORM_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    systems.reset();
    tickCount = 0;
    currentWorldSize = world.worldSize;

    loadWeatherBridge(world);
    registerWithHub({
      name: THUNDERSTORM_PLUGIN_NAME,
      cells: () => systems.cells(),
      wetnessAt,
      spawnOne,
    });

    const forced = readDevForce(THUNDERSTORM_DEV_FORCE_ENV, process.env);
    systems.force(forced);
    if (forced) {
      logInfo(
        `[thunderstorm] ${THUNDERSTORM_DEV_FORCE_ENV}=1 — one thunderstorm parked over the world centre`,
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
      key: THUNDERSTORM_PLUGIN_NAME,
      label: 'Bring a thunderstorm',
      description:
        'A thunderstorm gathers over where you are looking, then drifts on the wind like any other system — and throws bolts while it is there.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== THUNDERSTORM_PLUGIN_NAME) return { ok: false, detail: `no such action "${key}"` };
    const summoned = summonDisc({
      systems,
      worldSize: world.worldSize,
      site,
      forcedEnv: THUNDERSTORM_DEV_FORCE_ENV,
      ceiling: MAX_ACTIVE_SYSTEMS,
      noun: 'thunderstorms',
    });
    if (isRefusal(summoned)) return summoned;
    const system = summoned;
    world.broadcast(THUNDERSTORM_SYSTEMS_MESSAGE, { systems: systemStates() });
    return {
      ok: true,
      detail: `thunderstorm ${system.id} gathering at (${site.x}, ${site.y})`,
    };
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

export function resetThunderstormState(): void {
  tickCount = 0;
  systems.reset();
}

export { systems as thunderstormSystems };
