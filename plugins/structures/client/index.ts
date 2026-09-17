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
import timberHouseUrl from './assets/timber-house.glb?url';
import {
  createStructureModels,
  preloadStructureModels,
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

// Pending sites wait on terrain that may never arrive (fogged chunks); retry only once it changes,
// and at most once a second while terrain streams in.
export const STRUCTURES_PENDING_CHECK_SECONDS = 1;

let models: StructureModels | null = null;
let skiffModels: SkiffModels | null = null;
let siteSurveys: SiteSurveyCache | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

const buildings = new Map<number, StructureCell>();

let pendingCells: PlacementResult['pendingCells'] = [];
let pendingRevision = 0;
let sinceCheckSeconds = 0;

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
    (x, y) => ctx.drawnGroundYAt(x, y),
    siteSurveys ?? undefined,
  );
  models.apply(result.placements);
  skiffModels?.apply(result.skiffs);
  pendingCells = result.pendingCells;
  pendingRevision = pendingRevisionOf(ctx);
  sinceCheckSeconds = 0;
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

const STRUCTURE_SURFACE_DRAW_OBJECTS = 35;

const SKIFF_SURFACE_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  drawBudget: STRUCTURE_SURFACE_DRAW_OBJECTS + SKIFF_SURFACE_DRAW_OBJECTS,

  preload(): Promise<void> {
    return Promise.all([
      preloadSkiffModels(skiffUrl),
      preloadStructureModels(timberHouseUrl),
    ]).then(() => undefined);
  },

  attach(ctx: ClientPluginCtx): void {
    buildings.clear();
    pendingCells = [];
    pendingRevision = 0;
    sinceCheckSeconds = 0;

    siteSurveys = createSiteSurveyCache((x, y) => ctx.terrainRevisionAt(x, y));
    models = createStructureModels();
    ctx.layer.add(models.root);
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

    unsubscribeFrames = ctx.onFrame((dt) => {
      models?.animate(dt);
      skiffModels?.animate(dt);

      if (pendingCells.length === 0) return;
      sinceCheckSeconds += dt;
      if (sinceCheckSeconds < STRUCTURES_PENDING_CHECK_SECONDS) return;
      sinceCheckSeconds = 0;
      if (pendingRevisionOf(ctx) === pendingRevision) return;
      rebuild(ctx);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    buildings.clear();
    pendingCells = [];
    pendingRevision = 0;
    sinceCheckSeconds = 0;

    siteSurveys?.clear();
    siteSurveys = null;
    models?.dispose();
    models = null;
    skiffModels?.dispose();
    skiffModels = null;
    disposeSkiffKit();
  },
};
