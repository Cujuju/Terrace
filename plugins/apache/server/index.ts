import { CELL_WORLD_SIZE, createSeededRng } from '@terrace/shared';
import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import { createFlightPose, sampleFlight } from '../flight.ts';
import {
  APACHE_PLUGIN_NAME, APACHE_STATE_MESSAGE, FLIGHT_SECONDS, type ApacheFlight,
} from '../protocol.ts';
import { planFlyby, settlements } from './settlements.ts';

let flight: ApacheFlight | null = null;
let nextId = 1;
let waitSeconds = 20;
let cadence = 'occasional';
let random = createSeededRng(0xa64).next;
const pose = createFlightPose();

function broadcast(world: WorldApi, onlyPlayerId?: string): void {
  const items = flight === null ? [] : [flight];
  world.broadcastVisible(APACHE_STATE_MESSAGE, items, (item) => {
    sampleFlight(item, item.elapsed, pose);
    return { x: pose.x / CELL_WORLD_SIZE, y: pose.z / CELL_WORLD_SIZE };
  }, (visible) => ({ flight: visible[0] ?? null }), { skipEmpty: false, onlyPlayerId });
}

function nextWait(): number {
  return (cadence === 'frequent' ? 60 : 150) + random() * 60;
}

export const plugin: TerracePlugin = {
  name: APACHE_PLUGIN_NAME,
  archetype: 'visitors',
  settings: [{ key: 'arrivals', values: ['occasional', 'frequent', 'manual'], defaultValue: 'occasional' }],
  actions: [{
    key: 'flyby', label: 'Buzz a settlement',
    description: 'An Apache makes a low pass over a nearby settlement, banks and climbs away.',
  }],
  onWorldCreate(world): void {
    flight = null;
    nextId = 1;
    waitSeconds = 20;
    cadence = world.setting('arrivals') ?? 'occasional';
    random = createSeededRng(0xa64 ^ world.worldSize ^ Math.floor(world.genesisMillis)).next;
    settlements.load(world);
  },
  onWorldClose(): void {
    flight = null;
    settlements.clear();
  },
  onAction(world, key, site) {
    if (key !== 'flyby') return { ok: false, detail: `No such Apache action "${key}".` };
    if (flight !== null) return { ok: false, detail: 'An Apache is already making a pass.' };
    flight = planFlyby(world, nextId, random, site);
    if (flight === null) {
      return { ok: false, detail: 'No revealed settlement within 160 cells has a clear low-pass corridor.' };
    }
    nextId++;
    broadcast(world);
    return { ok: true, detail: `Apache inbound over the settlement at (${flight.centreX}, ${flight.centreY}).` };
  },
  onTick(world, dt): void {
    if (!(dt > 0) || !Number.isFinite(dt)) return;
    if (flight !== null) {
      const elapsed = flight.elapsed + dt;
      flight = elapsed >= FLIGHT_SECONDS ? null : { ...flight, elapsed };
      if (flight === null) waitSeconds = nextWait();
      broadcast(world);
      return;
    }
    if (cadence === 'manual' || world.players().length === 0) return;
    waitSeconds -= dt;
    if (waitSeconds > 0) return;
    flight = planFlyby(world, nextId, random);
    waitSeconds = flight === null ? 15 : nextWait();
    if (flight !== null) {
      nextId++;
      broadcast(world);
    }
  },
  onPlayerJoin(world, player): void {
    broadcast(world, player.id);
  },
};
