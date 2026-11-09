import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_CROPS_MESSAGE,
  FLORA_CROP_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_GRASS_MESSAGE,
  FLORA_GRASS_CHANGES_MESSAGE,
  FLORA_FRINGE_MESSAGE,
  FLORA_FRINGE_CHANGES_MESSAGE,
  FLORA_STUMP_MESSAGE,
  FLORA_STUMP_CHANGES_MESSAGE,
  FLORA_PLUGIN_NAME,
  fringeKey,
  parseChangesPayload,
  parseCropChangesPayload,
  parseCropsPayload,
  parseForestPayload,
  parseFringeChangesPayload,
  parseFringePayload,
  parseGrassChangesPayload,
  parseGrassPayload,
  parseStumpChangesPayload,
  parseStumpsPayload,
  type FringeBySpecies,
  type FringeCell,
  type FringeSpecies,
} from '../protocol.ts';
import { createCropModels } from './cropModels.ts';
import { cropPlacementsFor } from './cropPlacement.ts';
import { createFringeModels } from './fringeModels.ts';
import { fringePlacementsFor } from './fringePlacement.ts';
import { createGrassModels } from './grassModels.ts';
import { grassPlacementsFor } from './grassPlacement.ts';
import { createFloraModels } from './models.ts';
import { cropOccupancy, treeOccupancy } from './occupancy.ts';
import { placementsFor, supportedTreeGroundAt } from './placement.ts';
import { createStumpModels } from './stumpModels.ts';
import { stumpPlacementsFor } from './stumpPlacement.ts';
import { FloraGroundChanges } from './groundChanges.ts';
import { GroundedPlants } from './groundedPlants.ts';

interface FringePlant extends FringeCell {
  readonly species: FringeSpecies;
}

function fringePlants(bySpecies: FringeBySpecies): FringePlant[] {
  return [
    ...bySpecies.reed.map((cell): FringePlant => ({ ...cell, species: 'reed' })),
    ...bySpecies.heather.map((cell): FringePlant => ({ ...cell, species: 'heather' })),
  ];
}

let disposeAttached: (() => void) | null = null;

const TREE_DRAW_OBJECTS = 4;
const CROP_DRAW_OBJECTS = 2;
const GRASS_DRAW_OBJECTS = 3;
const STUMP_DRAW_OBJECTS = 2;
const FRINGE_DRAW_OBJECTS = 4;

export const clientPlugin: TerraceClientPlugin = {
  name: FLORA_PLUGIN_NAME,

  drawBudget: TREE_DRAW_OBJECTS + CROP_DRAW_OBJECTS + GRASS_DRAW_OBJECTS +
    STUMP_DRAW_OBJECTS + FRINGE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    disposeAttached?.();
    const treeModels = createFloraModels();
    const cropModels = createCropModels();
    const grassModels = createGrassModels();
    const fringeModels = createFringeModels();
    const stumpModels = createStumpModels();
    const models = [treeModels, cropModels, grassModels, fringeModels, stumpModels];
    for (const model of models) ctx.layer.add(model.root);

    const trees = new GroundedPlants(treeModels, placementsFor, new FloraGroundChanges(
      (ground, x, y) => supportedTreeGroundAt(
        (sx, sy) => ground.drawnGroundYAt(sx, sy), x, y, ground.worldSize(),
      ),
    ));
    const crops = new GroundedPlants(cropModels, cropPlacementsFor);
    const grass = new GroundedPlants(grassModels, grassPlacementsFor);
    const fringe = new GroundedPlants(fringeModels, (plants: Iterable<FringePlant>, groundAt) =>
      fringePlacementsFor(
        Array.from(plants, (plant) => [fringeKey(plant.x, plant.y), plant.species] as const),
        groundAt,
      ),
    );
    const stumps = new GroundedPlants(stumpModels, stumpPlacementsFor);
    const views = [trees, crops, grass, fringe, stumps];

    const unmarkPickable = [
      ctx.markPickable(treeModels.root, treeOccupancy(trees.cells, trees.heightAt), treeModels.cellOfHit),
      ctx.markPickable(cropModels.root, cropOccupancy(crops.cells, crops.heightAt, cropModels.plotReach)),
    ];

    const unsubscribeMessages = [
      ctx.onMessage(FLORA_FOREST_MESSAGE, (payload) => {
        const cells = parseForestPayload(payload);
        if (cells !== null) trees.replace(ctx, cells);
      }),
      ctx.onMessage(FLORA_CHANGES_MESSAGE, (payload) => {
        const change = parseChangesPayload(payload);
        if (change !== null) trees.change(ctx, change.grown, change.felled);
      }),
      ctx.onMessage(FLORA_CROPS_MESSAGE, (payload) => {
        const cells = parseCropsPayload(payload);
        if (cells !== null) crops.replace(ctx, cells);
      }),
      ctx.onMessage(FLORA_CROP_CHANGES_MESSAGE, (payload) => {
        const change = parseCropChangesPayload(payload);
        if (change !== null) crops.change(ctx, change.sprouted, change.withered);
      }),
      ctx.onMessage(FLORA_GRASS_MESSAGE, (payload) => {
        const cells = parseGrassPayload(payload);
        if (cells !== null) grass.replace(ctx, cells);
      }),
      ctx.onMessage(FLORA_GRASS_CHANGES_MESSAGE, (payload) => {
        const change = parseGrassChangesPayload(payload);
        if (change !== null) grass.change(ctx, change.sprouted, change.withered);
      }),
      ctx.onMessage(FLORA_FRINGE_MESSAGE, (payload) => {
        const cells = parseFringePayload(payload);
        if (cells !== null) fringe.replace(ctx, fringePlants(cells));
      }),
      ctx.onMessage(FLORA_FRINGE_CHANGES_MESSAGE, (payload) => {
        const change = parseFringeChangesPayload(payload);
        if (change !== null) fringe.change(ctx, fringePlants(change.sprouted), change.withered);
      }),
      ctx.onMessage(FLORA_STUMP_MESSAGE, (payload) => {
        const cells = parseStumpsPayload(payload);
        if (cells !== null) stumps.replace(ctx, cells);
      }),
      ctx.onMessage(FLORA_STUMP_CHANGES_MESSAGE, (payload) => {
        const change = parseStumpChangesPayload(payload);
        if (change !== null) stumps.change(ctx, change.left, change.rotted);
      }),
    ];

    // The server skips empty snapshots, so every world reset clears all populations.
    const unsubscribeReset = ctx.onWorldReset(() => {
      for (const view of views) view.clear();
    });
    const unsubscribeTerrain = ctx.onTerrainChanged((dirty) => {
      for (const view of views) view.terrainChanged(ctx, dirty);
    });

    disposeAttached = () => {
      for (const unsubscribe of unsubscribeMessages) unsubscribe();
      for (const unmark of unmarkPickable) unmark();
      unsubscribeTerrain();
      unsubscribeReset();
      for (const view of views) view.clear();
      for (const model of models) {
        model.root.removeFromParent();
        model.dispose();
      }
    };
  },

  dispose(): void {
    disposeAttached?.();
    disposeAttached = null;
  },
};
