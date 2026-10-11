import { MAX_BRUSH_RADIUS, type CellDiff } from '@terrace/shared';
import type {
  PersistenceSlice,
  SliceLoadOutcome,
  TerracePlugin,
  WorldApi,
} from '../../../server/src/plugins/types.ts';
import { WILDLIFE_ENTITIES_MESSAGE, WILDLIFE_PLUGIN_NAME } from '../protocol.ts';
import { WILDLIFE_POPULATION_CAP, type HabitatWorld } from './census.ts';
import { invalidateCensusIndex, markCensusCellsDirty } from './census-index.ts';
import { MAX_BIRDS_ALOFT, advanceFlocks, birdStates, resetFlocks } from './flocks.ts';
import {
  FLEE_DURATION_SECONDS,
  FLEE_SPEED_MULTIPLIER,
  advanceMovement,
  panicIndividuals,
  startleNear,
} from './movement.ts';
import { SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND } from './species.ts';
import { FIRE_IGNITED_EVENT_NAME, parseIgnitedPositions } from './fire-event.ts';
import { WILDLIFE_SLICE_VERSION, loadPopulation, savePopulation } from './persistence.ts';
import {
  advancePopulation,
  burnableEntityAt,
  flammableCreatures,
  despawnInvalidHabitat,
  entityPosition,
  entityStates,
  killEntities,
  resetPopulation,
} from './population.ts';
import { closeFireBridge, loadFireBridge, registerWildlifeFuel } from './fire-bridge.ts';
import { emitShoals } from './shoals.ts';

export const BROADCAST_TICK_INTERVAL = 2;

export const BROADCAST_ENTITY_CEILING = WILDLIFE_POPULATION_CAP + MAX_BIRDS_ALOFT;

export const FLEE_RADIUS_CELLS = MAX_BRUSH_RADIUS * 3;

export const FIRE_STARTLE_RADIUS_CELLS = Math.round(
  SLOWEST_LAND_CRUISE_SPEED_CELLS_PER_SECOND * FLEE_SPEED_MULTIPLIER * FLEE_DURATION_SECONDS,
);

let tickCount = 0;

function simulate(world: WorldApi, dt: number): void {
  advancePopulation(world, dt);
  advanceMovement(world, dt);
  despawnInvalidHabitat(world);
  advanceFlocks(world, dt);
  emitShoals(world);

  tickCount++;
  if (tickCount % BROADCAST_TICK_INTERVAL !== 0) return;

  const birds = birdStates();
  world.broadcastVisible(
    WILDLIFE_ENTITIES_MESSAGE,
    entityStates(world.worldSize),
    (entity) => ({ x: entity.x, y: entity.y }),
    (visibleHabitat) => ({ entities: [...visibleHabitat, ...birds] }),
  );
}

function reactToTerrain(world: WorldApi, diff: readonly CellDiff[]): void {
  if (diff.length === 0) return;

  let sumX = 0;
  let sumY = 0;
  for (const cell of diff) {
    sumX += cell.x;
    sumY += cell.y;
  }
  startleNear(sumX / diff.length, sumY / diff.length, FLEE_RADIUS_CELLS);

  markCensusCellsDirty(diff);

  despawnInvalidHabitat(world);
}

export const WILDLIFE_BURN_SECONDS = 8;

function wildlifeBurnedOut(ids: readonly number[]): void {
  killEntities(ids);
}

function wildlifeIgnited(ids: readonly number[]): void {
  panicIndividuals(ids, WILDLIFE_BURN_SECONDS);
}

function reactToFire(payload: unknown): void {
  const ignited = parseIgnitedPositions(payload);
  if (ignited === null) return;

  for (const at of ignited) startleNear(at.x, at.y, FIRE_STARTLE_RADIUS_CELLS);
}

function selfDescribedSliceVersion(data: unknown): number | undefined {
  if (typeof data !== 'object' || data === null) return undefined;
  const version = (data as { version?: unknown }).version;
  return Number.isSafeInteger(version) ? (version as number) : undefined;
}

const persistence: PersistenceSlice = {
  save(): unknown {
    return savePopulation();
  },
  version: WILDLIFE_SLICE_VERSION,
  load(data: unknown, fromVersion: number): SliceLoadOutcome {
    if ((selfDescribedSliceVersion(data) ?? fromVersion) > WILDLIFE_SLICE_VERSION) {
      return 'refuse';
    }
    loadPopulation(data);
    resetFlocks();
    return undefined;
  },
};

export const plugin: TerracePlugin = {
  name: WILDLIFE_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    invalidateCensusIndex();

    loadFireBridge(world);
    registerWildlifeFuel({
      name: WILDLIFE_PLUGIN_NAME,
      entityAt: (x: number, y: number) => {
        const found = burnableEntityAt(x, y);
        if (found === null) return null;
        return {
          id: found.entity.id,
          fuel: { burnSeconds: WILDLIFE_BURN_SECONDS },
          distanceCells: found.distanceCells,
        };
      },
      positionOf: entityPosition,
      flammable: function* () {
        for (const creature of flammableCreatures()) {
          yield {
            sourceName: WILDLIFE_PLUGIN_NAME,
            id: creature.id,
            fuel: { burnSeconds: WILDLIFE_BURN_SECONDS },
            x: creature.x,
            y: creature.y,
            radiusCells: creature.radiusCells,
          };
        }
      },
      onBurnedOut: wildlifeBurnedOut,
      onIgnited: wildlifeIgnited,
      idsSurviveRestore: true,
    });
  },

  onWorldClose(): void {
    closeFireBridge();
    resetWildlifeState();
  },

  onTick(world: WorldApi, dt: number): void {
    simulate(world, dt);
  },

  onTerrainChanged(world: WorldApi, diff: readonly CellDiff[]): void {
    reactToTerrain(world, diff);
  },

  onWorldEvent(_world: WorldApi, event: string, payload: unknown): void {
    if (event !== FIRE_IGNITED_EVENT_NAME) return;
    reactToFire(payload);
  },

  persistence,
};

export function resetWildlifeState(): void {
  tickCount = 0;
  invalidateCensusIndex();
  resetPopulation();
  resetFlocks();
}

export { FLEE_DURATION_SECONDS, MAX_BIRDS_ALOFT, WILDLIFE_POPULATION_CAP };
export type { HabitatWorld };
