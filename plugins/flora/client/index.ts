import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
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
  cropKey,
  fringeKey,
  grassKey,
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
  stumpKey,
  treeKey,
  type CropCell,
  type FringeBySpecies,
  type FringeCell,
  type FringeSpecies,
  type GrassCell,
  type StumpCell,
  type TreeCell,
} from '../protocol.ts';
import { createCropModels, type CropModels } from './cropModels.ts';
import { cropPlacementsFor } from './cropPlacement.ts';
import { createFringeModels, type FringeModels } from './fringeModels.ts';
import { fringePlacementsFor } from './fringePlacement.ts';
import { createGrassModels, type GrassModels } from './grassModels.ts';
import { grassPlacementsFor } from './grassPlacement.ts';
import { createFloraModels, type FloraModels } from './models.ts';
import { cropOccupancy, treeOccupancy } from './occupancy.ts';
import { placementsFor } from './placement.ts';
import { createStumpModels, type StumpModels } from './stumpModels.ts';
import { stumpPlacementsFor } from './stumpPlacement.ts';

export const FLORA_GROUND_RETRY_SECONDS = 0.5;

let models: FloraModels | null = null;
let cropModels: CropModels | null = null;
let grassModels: GrassModels | null = null;
let fringeModels: FringeModels | null = null;
let stumpModels: StumpModels | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unmarkPickable: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

const trees = new Map<number, TreeCell>();

const crops = new Map<number, CropCell>();

const grass = new Map<number, GrassCell>();

const fringe = new Map<number, FringeSpecies>();

const stumps = new Map<number, StumpCell>();

let pendingGround = 0;
let sinceRetrySeconds = 0;

let pendingCropGround = 0;

const pendingGrassGround = new Set<number>();

const pendingFringeGround = new Set<number>();

let pendingStumpGround = 0;

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(trees.values(), (x, y) => ctx.terrainHeightAt(x, y));
  models.apply(result.placements);
  pendingGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function groundLookup(ctx: ClientPluginCtx): (x: number, y: number) => number | null {
  return (x, y) => ctx.terrainHeightAt(x, y);
}

function rebuildGrass(ctx: ClientPluginCtx): void {
  if (grassModels === null) return;
  const result = grassPlacementsFor(grass.values(), groundLookup(ctx));
  grassModels.apply(result.placements);
  pendingGrassGround.clear();
  for (const key of result.pendingCells) pendingGrassGround.add(key);
  sinceRetrySeconds = 0;
}

function applyGrassDelta(
  ctx: ClientPluginCtx,
  sprouted: readonly GrassCell[],
  withered: readonly GrassCell[],
): void {
  if (grassModels === null) return;
  for (const cell of withered) pendingGrassGround.delete(grassKey(cell.x, cell.y));

  const result = grassPlacementsFor(sprouted, groundLookup(ctx));
  for (const placement of result.placements) {
    pendingGrassGround.delete(grassKey(placement.cellX, placement.cellY));
  }
  for (const key of result.pendingCells) pendingGrassGround.add(key);

  grassModels.applyDelta(result.placements, withered);
  sinceRetrySeconds = 0;
}

function rebuildFringe(ctx: ClientPluginCtx): void {
  if (fringeModels === null) return;
  const result = fringePlacementsFor(fringe, groundLookup(ctx));
  fringeModels.apply(result.placements);
  pendingFringeGround.clear();
  for (const key of result.pendingCells) pendingFringeGround.add(key);
  sinceRetrySeconds = 0;
}

function applyFringeDelta(
  ctx: ClientPluginCtx,
  sprouted: FringeBySpecies,
  withered: readonly FringeCell[],
): void {
  if (fringeModels === null) return;
  for (const cell of withered) pendingFringeGround.delete(fringeKey(cell.x, cell.y));

  const plants: Array<readonly [number, FringeSpecies]> = [];
  for (const cell of sprouted.reed) plants.push([fringeKey(cell.x, cell.y), 'reed']);
  for (const cell of sprouted.heather) plants.push([fringeKey(cell.x, cell.y), 'heather']);

  const result = fringePlacementsFor(plants, groundLookup(ctx));
  for (const placement of result.placements) {
    pendingFringeGround.delete(fringeKey(placement.cellX, placement.cellY));
  }
  for (const key of result.pendingCells) pendingFringeGround.add(key);

  fringeModels.applyDelta(result.placements, withered);
  sinceRetrySeconds = 0;
}

function rebuildStumps(ctx: ClientPluginCtx): void {
  if (stumpModels === null) return;
  const result = stumpPlacementsFor(stumps.values(), (x, y) => ctx.terrainHeightAt(x, y));
  stumpModels.apply(result.placements);
  pendingStumpGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function rebuildCrops(ctx: ClientPluginCtx): void {
  if (cropModels === null) return;
  const result = cropPlacementsFor(crops.values(), (x, y) => ctx.terrainHeightAt(x, y));
  cropModels.apply(result.placements);
  pendingCropGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function replaceForest(cells: readonly TreeCell[]): void {
  trees.clear();
  for (const cell of cells) trees.set(treeKey(cell.x, cell.y), cell);
}

function replaceCrops(cells: readonly CropCell[]): void {
  crops.clear();
  for (const cell of cells) crops.set(cropKey(cell.x, cell.y), cell);
}

function replaceGrass(cells: readonly GrassCell[]): void {
  grass.clear();
  for (const cell of cells) grass.set(grassKey(cell.x, cell.y), cell);
}

function replaceStumps(cells: readonly StumpCell[]): void {
  stumps.clear();
  for (const cell of cells) stumps.set(stumpKey(cell.x, cell.y), cell);
}

function replaceFringe(bySpecies: FringeBySpecies): void {
  fringe.clear();
  for (const cell of bySpecies.reed) fringe.set(fringeKey(cell.x, cell.y), 'reed');
  for (const cell of bySpecies.heather) fringe.set(fringeKey(cell.x, cell.y), 'heather');
}

function applyChanges(grown: readonly TreeCell[], felled: readonly TreeCell[]): void {
  for (const cell of felled) trees.delete(treeKey(cell.x, cell.y));
  for (const cell of grown) trees.set(treeKey(cell.x, cell.y), cell);
}

function applyCropChanges(sprouted: readonly CropCell[], withered: readonly CropCell[]): void {
  for (const cell of withered) crops.delete(cropKey(cell.x, cell.y));
  for (const cell of sprouted) crops.set(cropKey(cell.x, cell.y), cell);
}

function applyGrassChanges(sprouted: readonly GrassCell[], withered: readonly GrassCell[]): void {
  for (const cell of withered) grass.delete(grassKey(cell.x, cell.y));
  for (const cell of sprouted) grass.set(grassKey(cell.x, cell.y), cell);
}

function applyFringeChanges(sprouted: FringeBySpecies, withered: readonly FringeCell[]): void {
  for (const cell of withered) fringe.delete(fringeKey(cell.x, cell.y));
  for (const cell of sprouted.reed) fringe.set(fringeKey(cell.x, cell.y), 'reed');
  for (const cell of sprouted.heather) fringe.set(fringeKey(cell.x, cell.y), 'heather');
}

function applyStumpChanges(left: readonly StumpCell[], rotted: readonly StumpCell[]): void {
  for (const cell of rotted) stumps.delete(stumpKey(cell.x, cell.y));
  for (const cell of left) stumps.set(stumpKey(cell.x, cell.y), cell);
}

const TREE_DRAW_OBJECTS = 3;
const CROP_DRAW_OBJECTS = 2;
const GRASS_DRAW_OBJECTS = 3;
const STUMP_DRAW_OBJECTS = 2;
const FRINGE_DRAW_OBJECTS = 4;

export const clientPlugin: TerraceClientPlugin = {
  name: FLORA_PLUGIN_NAME,

  drawBudget: TREE_DRAW_OBJECTS +
    CROP_DRAW_OBJECTS +
    GRASS_DRAW_OBJECTS +
    STUMP_DRAW_OBJECTS +
    FRINGE_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    trees.clear();
    crops.clear();
    grass.clear();
    fringe.clear();
    stumps.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround.clear();
    pendingFringeGround.clear();
    pendingStumpGround = 0;
    sinceRetrySeconds = 0;

    models = createFloraModels();
    ctx.layer.add(models.root);
    unmarkPickable.push(
      ctx.markPickable(models.root, treeOccupancy(trees, groundLookup(ctx))),
    );

    cropModels = createCropModels();
    ctx.layer.add(cropModels.root);
    unmarkPickable.push(
      ctx.markPickable(
        cropModels.root,
        cropOccupancy(crops, groundLookup(ctx), cropModels.plotReach),
      ),
    );

    grassModels = createGrassModels();
    ctx.layer.add(grassModels.root);

    stumpModels = createStumpModels();
    ctx.layer.add(stumpModels.root);

    fringeModels = createFringeModels();
    ctx.layer.add(fringeModels.root);

    unsubscribeMessages = [
      ctx.onMessage(FLORA_FOREST_MESSAGE, (payload) => {
        const cells = parseForestPayload(payload);
        if (cells === null) return;
        replaceForest(cells);
        rebuild(ctx);
      }),

      ctx.onMessage(FLORA_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        applyChanges(changes.grown, changes.felled);
        rebuild(ctx);
      }),

      ctx.onMessage(FLORA_CROPS_MESSAGE, (payload) => {
        const cells = parseCropsPayload(payload);
        if (cells === null) return;
        replaceCrops(cells);
        rebuildCrops(ctx);
      }),

      ctx.onMessage(FLORA_CROP_CHANGES_MESSAGE, (payload) => {
        const changes = parseCropChangesPayload(payload);
        if (changes === null) return;
        applyCropChanges(changes.sprouted, changes.withered);
        rebuildCrops(ctx);
      }),

      ctx.onMessage(FLORA_GRASS_MESSAGE, (payload) => {
        const cells = parseGrassPayload(payload);
        if (cells === null) return;
        replaceGrass(cells);
        rebuildGrass(ctx);
      }),

      ctx.onMessage(FLORA_GRASS_CHANGES_MESSAGE, (payload) => {
        const changes = parseGrassChangesPayload(payload);
        if (changes === null) return;
        applyGrassChanges(changes.sprouted, changes.withered);
        applyGrassDelta(ctx, changes.sprouted, changes.withered);
      }),

      ctx.onMessage(FLORA_FRINGE_MESSAGE, (payload) => {
        const bySpecies = parseFringePayload(payload);
        if (bySpecies === null) return;
        replaceFringe(bySpecies);
        rebuildFringe(ctx);
      }),

      ctx.onMessage(FLORA_FRINGE_CHANGES_MESSAGE, (payload) => {
        const changes = parseFringeChangesPayload(payload);
        if (changes === null) return;
        applyFringeChanges(changes.sprouted, changes.withered);
        applyFringeDelta(ctx, changes.sprouted, changes.withered);
      }),

      ctx.onMessage(FLORA_STUMP_MESSAGE, (payload) => {
        const cells = parseStumpsPayload(payload);
        if (cells === null) return;
        replaceStumps(cells);
        rebuildStumps(ctx);
      }),

      ctx.onMessage(FLORA_STUMP_CHANGES_MESSAGE, (payload) => {
        const changes = parseStumpChangesPayload(payload);
        if (changes === null) return;
        applyStumpChanges(changes.left, changes.rotted);
        rebuildStumps(ctx);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (
        pendingGround === 0 &&
        pendingCropGround === 0 &&
        pendingGrassGround.size === 0 &&
        pendingFringeGround.size === 0 &&
        pendingStumpGround === 0
      ) {
        return;
      }
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < FLORA_GROUND_RETRY_SECONDS) return;
      if (pendingGround !== 0) rebuild(ctx);
      if (pendingCropGround !== 0) rebuildCrops(ctx);
      if (pendingGrassGround.size !== 0) rebuildGrass(ctx);
      if (pendingFringeGround.size !== 0) rebuildFringe(ctx);
      if (pendingStumpGround !== 0) rebuildStumps(ctx);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    for (const unmark of unmarkPickable) unmark();
    unmarkPickable = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    trees.clear();
    crops.clear();
    grass.clear();
    fringe.clear();
    stumps.clear();
    pendingGround = 0;
    pendingCropGround = 0;
    pendingGrassGround.clear();
    pendingFringeGround.clear();
    pendingStumpGround = 0;
    sinceRetrySeconds = 0;

    stumpModels?.dispose();
    stumpModels = null;

    fringeModels?.dispose();
    fringeModels = null;

    grassModels?.dispose();
    grassModels = null;

    cropModels?.dispose();
    cropModels = null;

    models?.dispose();
    models = null;
  },
};
