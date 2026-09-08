import type { RotatingStorm } from '../../../server/src/plugins/kit/rotatingStorms.ts';
import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  DEFAULT_TORNADO_FREQUENCY,
  FREQUENCY_INTERVAL_MULTIPLIERS,
  TORNADO_ALL_MESSAGE,
  TORNADO_DAMAGE_EVENT,
  TORNADO_FREQUENCIES,
  TORNADO_FREQUENCY_SETTING_KEY,
  TORNADO_PLUGIN_NAME,
  parseFrequency,
  type TornadoFrequency,
  type TornadoState,
} from '../protocol.ts';
import { loadTornadoes, saveTornadoes, TORNADO_SLICE_VERSION } from './persistence.ts';
import {
  MAX_ACTIVE_TORNADOES,
  meanSpawnIntervalSeconds,
  tornadoes,
  trySpawnTornado,
} from './sim.ts';
import { forceSpawnFromEnv, forceTornadoNear } from './dev.ts';
import { loadWeatherBridge, resetWeatherBridge } from './weather-bridge.ts';

export const BROADCAST_TICK_INTERVAL = 2;

export { TORNADO_DAMAGE_EVENT };

export { MAX_ACTIVE_TORNADOES };

let tickCount = 0;

let broadcastPending = false;

let frequency: TornadoFrequency = DEFAULT_TORNADO_FREQUENCY;

function resetSessionState(): void {
  tickCount = 0;
  frequency = DEFAULT_TORNADO_FREQUENCY;
  tornadoes.reset();
  tornadoes.freeze(false);
  resetWeatherBridge();
}

function intervalMultiplier(): number {
  return frequency === 'common'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.common
    : FREQUENCY_INTERVAL_MULTIPLIERS.rare;
}

function rollSpawn(world: WorldApi, dt: number): void {
  if (tornadoes.count() >= MAX_ACTIVE_TORNADOES) return;

  const meanInterval = meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier();
  if (!tornadoes.rollSpawn(1 / meanInterval, dt)) return;

  const born = trySpawnTornado(world);
  if (born === null) return;
  console.info(
    `[${TORNADO_PLUGIN_NAME}] a tornado touched down at ` +
      `(${Math.round(born.x)}, ${Math.round(born.y)})`,
  );
}

function broadcastTornadoes(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    TORNADO_ALL_MESSAGE,
    tornadoes.states(),
    (storm: TornadoState) => ({ x: Math.round(storm.x), y: Math.round(storm.y) }),
    (visible) => ({ storms: visible }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollSpawn(world, dt);

  const tick = tornadoes.advance(world, dt);
  for (const event of tick.damage) world.emitEvent(TORNADO_DAMAGE_EVENT, event);

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastTornadoes(world);
  }
}

const persistence: PersistenceSlice = {
  version: TORNADO_SLICE_VERSION,
  save(): unknown {
    return saveTornadoes();
  },
  load(data: unknown): void {
    loadTornadoes(data);
  },
};

export const plugin: TerracePlugin = {
  name: TORNADO_PLUGIN_NAME,

  settings: [
    {
      key: TORNADO_FREQUENCY_SETTING_KEY,
      values: TORNADO_FREQUENCIES,
      defaultValue: DEFAULT_TORNADO_FREQUENCY,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    tickCount = 0;
    tornadoes.freeze(false);
    resetWeatherBridge();

    frequency = parseFrequency(world.setting(TORNADO_FREQUENCY_SETTING_KEY));
    loadWeatherBridge(world);

    if (frequency === 'off') return;

    forceSpawnFromEnv(world, process.env);

    console.info(
      `[${TORNADO_PLUGIN_NAME}] frequency: ${frequency}, difficulty ` +
        `${world.difficulty} → one every ~${Math.round(
          meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier(),
        )}s`,
    );
  },

  onWorldClose(): void {
    resetSessionState();
  },

  archetype: 'weather',
  actions: [
    {
      key: 'tornado',
      label: 'Spawn a tornado',
      description: 'A funnel on the nearest land to where you are looking, at full strength.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== 'tornado') return { ok: false, detail: `no such action "${key}"` };
    if (frequency === 'off') {
      return { ok: false, detail: 'tornadoes are off for this world — set the frequency first' };
    }
    if (tornadoes.count() >= MAX_ACTIVE_TORNADOES) {
      return {
        ok: false,
        detail: `${MAX_ACTIVE_TORNADOES} tornadoes are already in the air`,
      };
    }
    const { storm, detail } = forceTornadoNear(world, site);
    if (storm === null) return { ok: false, detail };
    broadcastPending = false;
    broadcastTornadoes(world);
    return { ok: true, detail };
  },

  onTick(world: WorldApi, dt: number): void {
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (frequency === 'off') return;
    broadcastTornadoes(world, player.id);
  },

  persistence,
};

export function resetTornadoState(): void {
  resetSessionState();
}

export function livingTornadoes(): readonly RotatingStorm[] {
  return tornadoes.storms();
}
