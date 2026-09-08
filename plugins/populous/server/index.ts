import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import {
  stepPopulous,
  type PopulousCellRecord,
  type PopulousContext,
  type PopulousStepResult,
  type PopulousWorld,
} from './model.ts';
import { emitSettlerFrom, loadPilgrimsBridge } from './pilgrims-bridge.ts';
import {
  clearGrowthModel,
  loadStructuresBridge,
  registerGrowthModel,
} from './structures-bridge.ts';

export const POPULOUS_PLUGIN_NAME = 'populous';

export const POPULOUS_REGISTERED_MESSAGE =
  '[populous] growth model registered — it drives the board in worlds set to it';

const model = {
  name: POPULOUS_PLUGIN_NAME,
  step(
    world: PopulousWorld,
    live: ReadonlyMap<number, PopulousCellRecord>,
    ctx: PopulousContext,
  ): PopulousStepResult {
    return stepPopulous(world, live, ctx);
  },
  afterSwap(emitted: ReadonlyArray<{ x: number; y: number }>): void {
    for (const cell of emitted) emitSettlerFrom(cell.x, cell.y);
  },
};

export const plugin: TerracePlugin = {
  name: POPULOUS_PLUGIN_NAME,

  onWorldCreate(world: WorldApi): void {
    loadStructuresBridge(world);
    loadPilgrimsBridge(world);
    registerGrowthModel(model);
    console.info(POPULOUS_REGISTERED_MESSAGE);
  },

  onWorldClose(): void {
    clearGrowthModel();
  },
};

export function growthModelForTest(): typeof model {
  return model;
}
