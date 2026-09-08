import type {
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import {
  DAY_LENGTH_SECONDS,
  DAYNIGHT_CLOCK_MESSAGE,
  DAYNIGHT_PLUGIN_NAME,
  roundBroadcastPhase,
  wrapPhase,
} from '../protocol.ts';
import { dayOfSimMillis, worldAgeDays } from '@terrace/shared';

export const DAYNIGHT_BROADCAST_INTERVAL_SECONDS = 5;

const BROADCAST_INTERVAL_EPSILON_SECONDS = 1e-9;

const MILLISECONDS_PER_SECOND = 1000;

let elapsedSeconds = 0;
let sinceBroadcast = 0;

export function currentPhase(): number {
  return wrapPhase(elapsedSeconds / DAY_LENGTH_SECONDS);
}

function simulate(world: WorldApi, dt: number): void {
  elapsedSeconds = world.simMillis / MILLISECONDS_PER_SECOND;
  sinceBroadcast += dt;
  if (sinceBroadcast < DAYNIGHT_BROADCAST_INTERVAL_SECONDS - BROADCAST_INTERVAL_EPSILON_SECONDS) {
    return;
  }
  sinceBroadcast -= DAYNIGHT_BROADCAST_INTERVAL_SECONDS;

  world.broadcast(DAYNIGHT_CLOCK_MESSAGE, {
    phase: roundBroadcastPhase(currentPhase()),
    day: worldAgeDays(world.simMillis, world.genesisMillis),
    genesisDay: dayOfSimMillis(world.genesisMillis),
  });
}

export const plugin: TerracePlugin = {
  name: DAYNIGHT_PLUGIN_NAME,

  onWorldCreate(): void {
    elapsedSeconds = 0;
    sinceBroadcast = 0;
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },
};

export function resetDayNightState(): void {
  elapsedSeconds = 0;
  sinceBroadcast = 0;
}
