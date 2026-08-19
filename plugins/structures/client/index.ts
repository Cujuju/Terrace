// structures — client half. Draws whatever the server's `structures:all` and
// `structures:changes` messages say is standing, and nothing else.
//
// It holds no authority: it never founds, never upgrades, never demolishes —
// exactly flora's client half, extended with one more delta kind
// (`upgraded`, alongside `founded`/`demolished`) because a standing structure
// can change without being added or removed.

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
import { createStructureModels, type StructureModels } from './models.ts';
import { placementsFor } from './placement.ts';

/**
 * Seconds between retries while some structure's ground is still unknown.
 * Exactly flora's FLORA_GROUND_RETRY_SECONDS and for the same reason: the
 * condition resolves on a network event at human pace (a chunk streaming in),
 * not a per-frame one.
 */
export const STRUCTURES_GROUND_RETRY_SECONDS = 0.5;

/**
 * Module-level singletons, matching every other plugin's shape here: the
 * client host constructs one instance, and attach/dispose bracket its life.
 */
let models: StructureModels | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Standing structures by packed cell key. The client's whole model of the world. */
const buildings = new Map<number, StructureCell>();

let pendingGround = 0;
let sinceRetrySeconds = 0;

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(buildings.values(), (x, y) => ctx.terrainHeightAt(x, y));
  models.apply(result.placements);
  pendingGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function replaceAll(cells: readonly StructureCell[]): void {
  buildings.clear();
  for (const cell of cells) buildings.set(structureKey(cell.x, cell.y), cell);
}

/**
 * Applies one delta. Order: demolitions, then foundings, then upgrades — a
 * cell that (impossibly today, but cheaply guarded) appears in more than one
 * half of the same message ends up in whatever state the LAST list says,
 * matching the server's own event order (a fell always precedes anything
 * that could re-found the same cell within one broadcast).
 */
function applyChanges(
  founded: readonly StructureCell[],
  upgraded: readonly StructureCell[],
  demolished: ReadonlyArray<{ x: number; y: number }>,
): void {
  for (const cell of demolished) buildings.delete(structureKey(cell.x, cell.y));
  for (const cell of founded) buildings.set(structureKey(cell.x, cell.y), cell);
  for (const cell of upgraded) buildings.set(structureKey(cell.x, cell.y), cell);
}

export const clientPlugin: TerraceClientPlugin = {
  name: STRUCTURES_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    buildings.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;

    models = createStructureModels();
    ctx.layer.add(models.root);

    unsubscribeMessages = [
      ctx.onMessage(STRUCTURES_ALL_MESSAGE, (payload) => {
        const cells = parseAllPayload(payload);
        // A malformed payload is dropped whole — the previous state keeps
        // rendering until the next good message, exactly flora's rule.
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
      // The Durand's sign flash runs every frame regardless of pendingGround
      // — it is not gated on the ground-retry condition below, which exists
      // for a completely different reason (a chunk that has not streamed in
      // yet).
      models?.animate(dt);

      if (pendingGround === 0) return;
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < STRUCTURES_GROUND_RETRY_SECONDS) return;
      rebuild(ctx);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    buildings.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;

    models?.dispose();
    models = null;
  },
};
