import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  STRUCTURES_ALL_MESSAGE,
  STRUCTURES_CHANGES_MESSAGE,
  STRUCTURES_PLUGIN_NAME,
  parseAllPayload,
  parseChangesPayload,
  structureKey,
  type StructureCell,
} from '../protocol.ts';
import { buildingQuality, registerBuildingQualityConsumer } from '../../../client/src/state/buildingQualityPrefs.ts';
import type { BuildingAssetKit } from '../../../client/src/render/buildingAssetKit.ts';
import { preloadAuthoredStructures } from './authoredAssets.ts';
import {
  createStructureModels,
  type StructureModels,
} from './models.ts';
import { placementsFor, type PlacementResult } from './placement.ts';
import {
  createSiteSurveyCache,
  neighbourhoodRevision,
  type SiteSurveyCache,
} from './site.ts';
import skiffUrl from './assets/skiff.glb?url';
import {
  createSkiffModels,
  disposeSkiffKit,
  preloadSkiffModels,
  type SkiffModels,
} from './skiffModels.ts';

let models: StructureModels | null = null;
let assetKit: BuildingAssetKit | null = null;
let unsubscribeQuality: (() => void) | null = null;
let skiffModels: SkiffModels | null = null;
let siteSurveys: SiteSurveyCache | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;
let unsubscribeTerrain: (() => void) | null = null;

const buildings = new Map<number, StructureCell>();

let pendingCells: PlacementResult['pendingCells'] = [];
let pendingRevision = 0;

function pendingRevisionOf(ctx: ClientPluginCtx): number {
  let sum = 0;
  for (const cell of pendingCells) {
    sum += neighbourhoodRevision((x, y) => ctx.terrainRevisionAt(x, y), cell.x, cell.y);
  }
  return sum;
}

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(
    buildings.values(),
    (x, y) => ctx.drawnGroundYAt(x, y),
    siteSurveys ?? undefined,
  );
  models.apply(result.placements);
  skiffModels?.apply(result.skiffs);
  pendingCells = result.pendingCells;
  pendingRevision = pendingRevisionOf(ctx);
}

function replaceAll(cells: readonly StructureCell[]): void {
  buildings.clear();
  for (const cell of cells) buildings.set(structureKey(cell.x, cell.y), cell);
}

function applyChanges(
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  for (const cell of demolished) buildings.delete(structureKey(cell.x, cell.y));
  for (const cell of founded) buildings.set(structureKey(cell.x, cell.y), cell);
  for (const cell of upgraded) buildings.set(structureKey(cell.x, cell.y), cell);
}

const STRUCTURE_SURFACE_DRAW_OBJECTS = 36;

const SKIFF_SURFACE_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  drawBudget: STRUCTURE_SURFACE_DRAW_OBJECTS + SKIFF_SURFACE_DRAW_OBJECTS,

  preload(): Promise<void> {
    return Promise.all([
      preloadSkiffModels(skiffUrl),
      preloadAuthoredStructures(buildingQuality()).then((kit) => {
        assetKit?.dispose();
        assetKit = kit;
      }),
    ]).then(() => undefined);
  },

  attach(ctx: ClientPluginCtx): void {
    buildings.clear();
    pendingCells = [];
    pendingRevision = 0;

    siteSurveys = createSiteSurveyCache((x, y) => ctx.terrainRevisionAt(x, y));
    models = createStructureModels(assetKit ?? undefined);
    ctx.layer.add(models.root);
    unsubscribeQuality = registerBuildingQualityConsumer(async (quality) => {
      const nextKit = await preloadAuthoredStructures(quality);
      let nextModels: StructureModels;
      try { nextModels = createStructureModels(nextKit); }
      catch (error) { nextKit.dispose(); throw error; }
      return {
        apply() {
          const previousModels = models;
          const previousKit = assetKit;
          models = nextModels;
          assetKit = nextKit;
          ctx.layer.add(models.root);
          if (previousModels !== null) ctx.layer.remove(previousModels.root);
          rebuild(ctx);
          previousModels?.dispose();
          previousKit?.dispose();
          ctx.requestShaderWarmup();
        },
        discard() { nextModels.dispose(); nextKit.dispose(); },
      };
    });
    skiffModels = createSkiffModels();
    ctx.layer.add(skiffModels.root);

    unsubscribeMessages = [
      ctx.onMessage(STRUCTURES_ALL_MESSAGE, (payload) => {
        const cells = parseAllPayload(payload);
        if (cells === null) return;
        replaceAll(cells);
        rebuild(ctx);
      }),

      ctx.onMessage(STRUCTURES_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        applyChanges(changes.founded, changes.upgraded, changes.demolished);
        rebuild(ctx);
      }),
    ];

    unsubscribeTerrain = ctx.onTerrainChanged(() => {
      if (pendingCells.length === 0) return;
      if (pendingRevisionOf(ctx) === pendingRevision) return;
      rebuild(ctx);
    });

    unsubscribeFrames = ctx.onFrame((dt) => {
      models?.animate(dt);
      skiffModels?.animate(dt);
    });
  },

  dispose(): void {
    unsubscribeQuality?.();
    unsubscribeQuality = null;
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeTerrain?.();
    unsubscribeTerrain = null;
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    buildings.clear();
    pendingCells = [];
    pendingRevision = 0;

    siteSurveys?.clear();
    siteSurveys = null;
    models?.dispose();
    models = null;
    assetKit?.dispose();
    assetKit = null;
    skiffModels?.dispose();
    skiffModels = null;
    disposeSkiffKit();
  },
};
