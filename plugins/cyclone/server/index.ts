import { devForceEnvName } from '../../../server/src/plugins/kit/devForce.ts';
import {
  createRotatingStormDev,
  isRotatingStormRefusal,
  summonRotatingStorm,
} from '../../../server/src/plugins/kit/rotatingStormSummon.ts';
import type {
  PersistenceSlice,
  Player,
  PluginActionOutcome,
  PluginActionSite,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_DAMAGE_EVENT,
  CYCLONE_FREQUENCIES,
  CYCLONE_FREQUENCY_SETTING_KEY,
  CYCLONE_LANDFALL_EVENT,
  CYCLONE_PLUGIN_NAME,
  CYCLONE_SURGE_MODES,
  CYCLONE_SURGE_SETTING_KEY,
  DEFAULT_CYCLONE_FREQUENCY,
  DEFAULT_CYCLONE_SURGE_MODE,
  FREQUENCY_INTERVAL_MULTIPLIERS,
  MAX_ACTIVE_CYCLONES,
  parseFrequency,
  parseSurgeMode,
  type CycloneFrequency,
  type CycloneState,
  type CycloneSurgeMode,
} from '../protocol.ts';
import {
  CYCLONE_SLICE_VERSION,
  loadCyclones,
  saveCyclones,
  takeRestoredThisCreate,
} from './persistence.ts';
import { cyclones, isCycloneSite, meanSpawnIntervalSeconds, trySpawnCyclone } from './sim.ts';
import { tickSurge } from './surge.ts';
import { scourStruckGround } from './wind-scour.ts';

export const BROADCAST_TICK_INTERVAL = 2;

export { CYCLONE_DAMAGE_EVENT, CYCLONE_LANDFALL_EVENT };

const CYCLONE_DEV_FORCE_ENV = devForceEnvName(CYCLONE_PLUGIN_NAME);

const CYCLONE_NOUN = 'cyclone';

const CYCLONE_SITING_NOUN = 'open water';

const dev = createRotatingStormDev({
  storms: cyclones,
  pluginName: CYCLONE_PLUGIN_NAME,
  accepts: isCycloneSite,
  noun: CYCLONE_NOUN,
  sitingNoun: CYCLONE_SITING_NOUN,
  envName: CYCLONE_DEV_FORCE_ENV,
});

let tickCount = 0;

let broadcastPending = false;

let frequency: CycloneFrequency = DEFAULT_CYCLONE_FREQUENCY;
let surgeMode: CycloneSurgeMode = DEFAULT_CYCLONE_SURGE_MODE;

function resetSessionState(): void {
  tickCount = 0;
  broadcastPending = false;
  frequency = DEFAULT_CYCLONE_FREQUENCY;
  surgeMode = DEFAULT_CYCLONE_SURGE_MODE;
  cyclones.reset();
}

function intervalMultiplier(): number {
  return frequency === 'common'
    ? FREQUENCY_INTERVAL_MULTIPLIERS.common
    : FREQUENCY_INTERVAL_MULTIPLIERS.rare;
}

function rollSpawn(world: WorldApi, dt: number): void {
  if (cyclones.count() >= MAX_ACTIVE_CYCLONES) return;

  const meanInterval = meanSpawnIntervalSeconds(world.difficulty) * intervalMultiplier();
  if (!cyclones.rollSpawn(1 / meanInterval, dt)) return;

  const born = trySpawnCyclone(world);
  if (born === null) return;
  console.info(
    `[${CYCLONE_PLUGIN_NAME}] ${born.name ?? 'a cyclone'} formed at ` +
      `(${Math.round(born.x)}, ${Math.round(born.y)})`,
  );
}

function broadcastCyclones(world: WorldApi, onlyPlayerId?: string): void {
  world.broadcastVisible(
    CYCLONE_ALL_MESSAGE,
    cyclones.states(),
    (storm: CycloneState) => ({ x: Math.round(storm.x), y: Math.round(storm.y) }),
    (visible) => ({ storms: visible }),
    { skipEmpty: false, onlyPlayerId },
  );
}

function simulate(world: WorldApi, dt: number): void {
  tickCount++;

  rollSpawn(world, dt);

  const tick = cyclones.advance(world, dt);

  for (const event of tick.landfalls) world.emitEvent(CYCLONE_LANDFALL_EVENT, event);
  for (const event of tick.damage) world.emitEvent(CYCLONE_DAMAGE_EVENT, event);

  if (surgeMode === 'on') {
    for (const event of tick.damage) scourStruckGround(world, event);
  }

  if (surgeMode === 'on') {
    for (const storm of cyclones.storms()) {
      tickSurge(world, storm, storm.peakIntensity * storm.envelope, dt, cyclones.random);
    }
  }

  if (tick.changed) broadcastPending = true;
  if (tickCount % BROADCAST_TICK_INTERVAL === 0 && broadcastPending) {
    broadcastPending = false;
    broadcastCyclones(world);
  }
}

const persistence: PersistenceSlice = {
  version: CYCLONE_SLICE_VERSION,
  save(): unknown {
    return saveCyclones();
  },
  load(data: unknown): void {
    loadCyclones(data);
  },
};

export const plugin: TerracePlugin = {
  name: CYCLONE_PLUGIN_NAME,

  settings: [
    {
      key: CYCLONE_FREQUENCY_SETTING_KEY,
      values: CYCLONE_FREQUENCIES,
      defaultValue: DEFAULT_CYCLONE_FREQUENCY,
    },
    {
      key: CYCLONE_SURGE_SETTING_KEY,
      values: CYCLONE_SURGE_MODES,
      defaultValue: DEFAULT_CYCLONE_SURGE_MODE,
    },
  ],

  onWorldCreate(world: WorldApi): void {
    tickCount = 0;
    if (!takeRestoredThisCreate()) {
      cyclones.reset();
      broadcastPending = false;
    }
    cyclones.freeze(false);

    frequency = parseFrequency(world.setting(CYCLONE_FREQUENCY_SETTING_KEY));
    surgeMode = parseSurgeMode(world.setting(CYCLONE_SURGE_SETTING_KEY));

    if (frequency === 'off') return;

    dev.forceFromEnv(world, process.env);

    console.info(
      `[${CYCLONE_PLUGIN_NAME}] frequency: ${frequency}, surge: ${surgeMode}, ` +
        `difficulty ${world.difficulty} → one every ~${Math.round(
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
      key: 'cyclone',
      label: 'Spawn a cyclone',
      description:
        'A cyclone over the nearest open water to where you are looking, at full strength.',
    },
  ],

  onAction(world: WorldApi, key: string, site: PluginActionSite): PluginActionOutcome {
    if (key !== 'cyclone') return { ok: false, detail: `no such action "${key}"` };
    if (frequency === 'off') {
      return { ok: false, detail: 'cyclones are off for this world — set the frequency first' };
    }
    const summoned = summonRotatingStorm({
      storms: cyclones,
      world,
      site,
      accepts: isCycloneSite,
      forcedEnv: CYCLONE_DEV_FORCE_ENV,
      ceiling: MAX_ACTIVE_CYCLONES,
      noun: CYCLONE_NOUN,
      sitingNoun: CYCLONE_SITING_NOUN,
    });
    if (isRotatingStormRefusal(summoned)) return summoned;

    broadcastPending = false;
    broadcastCyclones(world);
    return {
      ok: true,
      detail: `${summoned.name ?? 'a cyclone'} spawned at (${summoned.x}, ${summoned.y})`,
    };
  },

  onTick(world: WorldApi, dt: number): void {
    if (frequency === 'off') return;
    simulate(world, dt);
  },

  onPlayerJoin(world: WorldApi, player: Player): void {
    if (frequency === 'off') return;
    broadcastCyclones(world, player.id);
  },

  persistence,
};
