import type { CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { BOATS_PLUGIN_NAME, BOATS_STATE_MESSAGE } from '../protocol.ts';
import {
  KRAKEN_KIND,
  parseMonsterSightings,
  parseVillageChanges,
} from './events.ts';
import { parseStormDamage } from '../../../server/src/plugins/kit/rotatingStormDamage.ts';
import { CYCLONE_DAMAGE_EVENT_NAME } from './cyclone-event.ts';
import {
  advanceFleet,
  boatPosition,
  boatStates,
  burnBoats,
  burnableBoatAt,
  flammableBoats,
  forgetVillage,
  noteStormWind,
  rememberVillage,
  resetFleet,
  resurveyAllShipyards,
  resurveyShipyardsNear,
  type KrakenTarget,
} from './fleet.ts';
import { closeFireBridge, loadFireBridge, registerBoatsFuel } from './fire-bridge.ts';
import { loadBoats, saveBoats } from './persistence.ts';

export const BROADCAST_TICK_INTERVAL = 5;

const EVENT_STRUCTURES_CHANGES = 'structures:changes';
const EVENT_MONSTERS_POSITIONS = 'monsters:positions';

export const DEFEATED_EVENT = 'defeated';

let tickCount = 0;

let krakenThisTick: KrakenTarget | null = null;

function simulate(world: WorldApi, dt: number): void {
  const kraken = krakenThisTick;
  krakenThisTick = null;

  const outcome = advanceFleet(world, kraken, dt);

  if (outcome.routed) {
    world.emitEvent(DEFEATED_EVENT, {
      kind: KRAKEN_KIND,
      x: kraken?.x ?? 0,
      y: kraken?.y ?? 0,
    });
  }

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  world.broadcastVisible(
    BOATS_STATE_MESSAGE,
    boatStates(world.worldSize),
    (boat) => ({ x: boat.x, y: boat.y }),
    (visible) => ({ boats: visible }),
  );
}

const persistence: PersistenceSlice = {
  version: 1,
  save(): unknown {
    return saveBoats();
  },
  load(data: unknown): void {
    loadBoats(data);
  },
};

export const BOATS_BURN_SECONDS = 16;

function boatsBurnedOut(ids: readonly number[]): void {
  burnBoats(ids);
}

export const plugin: TerracePlugin = {
  name: BOATS_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    loadFireBridge(world);
    registerBoatsFuel({
      name: BOATS_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const boat = burnableBoatAt(x, y);
        if (boat === null) return null;
        return {
          id: boat.id,
          fuel: { burnSeconds: BOATS_BURN_SECONDS },
          distanceCells: boat.distanceCells,
        };
      },
      positionOf: boatPosition,
      flammable: function* () {
        for (const boat of flammableBoats()) {
          yield {
            sourceName: BOATS_PLUGIN_NAME,
            id: boat.id,
            fuel: { burnSeconds: BOATS_BURN_SECONDS },
            x: boat.x,
            y: boat.y,
            radiusCells: boat.radiusCells,
          };
        }
      },
      onBurnedOut: boatsBurnedOut,
      idsSurviveRestore: true,
    });
  },

  onWorldClose(): void {
    closeFireBridge();
    resetBoatsState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(_world: WorldApi, diff: readonly CellDiff[]): void {
    resurveyShipyardsNear(diff);
  },

  onChunkUnlockedForToken(): void {
    resurveyAllShipyards();
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event === EVENT_STRUCTURES_CHANGES) {
      const changes = parseVillageChanges(payload);
      if (changes === null) return;
      for (const cell of changes.gained) rememberVillage(cell.x, cell.y);
      for (const cell of changes.lost) forgetVillage(cell.x, cell.y);
      return;
    }

    if (event === EVENT_MONSTERS_POSITIONS) {
      const sightings = parseMonsterSightings(payload);
      if (sightings === null) return;
      const kraken = sightings.find((seen) => seen.kind === KRAKEN_KIND);
      krakenThisTick = kraken === undefined ? null : { x: kraken.x, y: kraken.y };
      return;
    }

    if (event === CYCLONE_DAMAGE_EVENT_NAME) {
      const damage = parseStormDamage(payload);
      if (damage === null) return;
      noteStormWind(damage);
    }
  },

  persistence,
};

export function resetBoatsState(): void {
  tickCount = 0;
  krakenThisTick = null;
  resetFleet();
}
