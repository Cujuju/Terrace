// flora — client half. Draws whatever the server's `flora:forest` and
// `flora:changes` messages say is standing, and nothing else.
//
// It holds no authority: it never plants, never fells, never predicts. A tree
// does not move and does not animate, so unlike wildlife there is nothing to
// interpolate between messages either — which is exactly why the server can send
// deltas instead of a stream (see ../protocol.ts).
//
// ─────────────────────────────────────────────────────────────────────────────
// WHEN THE SCENE IS REBUILT, AND WHY THAT IS ALL OF IT.
//
// Every instance matrix is recomputed whenever the tree list changes. The
// obvious alternative — patching only the changed instances — needs a free-list
// mapping cell → instance slot per mesh, plus compaction when a tree in the
// middle is felled, plus a way to keep two meshes' slots consistent. That is
// real bookkeeping to save work that measures as follows:
//
//   3000 trees × (one compose + two setMatrixAt) ≈ tens of microseconds,
//   plus a 192 KB instance-matrix upload per mesh.
//
// A rebuild happens on a growth delta (once per 5 s at most), on a fell (up to
// the sculpt rate, ~10 Hz while a player is actively digging), and on the 60 s
// keepalive. The worst case is therefore a few milliseconds per second during
// sustained sculpting, on the CPU side of a frame that is drawing a thousand
// terrain chunks. Bookkeeping loses.
// ─────────────────────────────────────────────────────────────────────────────

import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  FLORA_CHANGES_MESSAGE,
  FLORA_FOREST_MESSAGE,
  FLORA_PLUGIN_NAME,
  parseChangesPayload,
  parseForestPayload,
  treeKey,
  type TreeCell,
} from '../protocol.ts';
import { createFloraModels, type FloraModels } from './models.ts';
import { placementsFor } from './placement.ts';

/**
 * Seconds between retries while some tree's ground is still unknown.
 *
 * The condition resolves when a chunk's heights arrive — a network event at
 * human pace (someone unlocking territory, or the join snapshot landing), never
 * a per-frame one. Half a second is imperceptible for a tree appearing and costs
 * at most two rebuilds a second, and only while at least one tree is waiting; a
 * fully-streamed world does no work here at all.
 *
 * The alternative — re-checking every tree every frame — is 3000 height lookups
 * and a full matrix upload per frame, forever, to catch an event that happens a
 * handful of times per session.
 */
export const FLORA_GROUND_RETRY_SECONDS = 0.5;

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin, and
 * `attach`/`dispose` bracket their whole lifetime.
 */
let models: FloraModels | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Standing trees by packed cell key. The client's whole model of the world. */
const trees = new Map<number, TreeCell>();

/** Trees whose ground was unknown at the last rebuild, and the retry clock. */
let pendingGround = 0;
let sinceRetrySeconds = 0;

function rebuild(ctx: ClientPluginCtx): void {
  if (models === null) return;
  const result = placementsFor(trees.values(), (x, y) => ctx.terrainHeightAt(x, y));
  models.apply(result.placements);
  pendingGround = result.pendingGround;
  sinceRetrySeconds = 0;
}

function replaceForest(cells: readonly TreeCell[]): void {
  trees.clear();
  for (const cell of cells) trees.set(treeKey(cell.x, cell.y), cell);
}

/**
 * Applies one delta. Fells are processed BEFORE growths so that a message which
 * (impossibly today, but cheaply guarded) lists the same cell in both ends up
 * with the tree present — matching the server, where a cell can only be replanted
 * by a survey that ran after the fell.
 */
function applyChanges(grown: readonly TreeCell[], felled: readonly TreeCell[]): void {
  for (const cell of felled) trees.delete(treeKey(cell.x, cell.y));
  for (const cell of grown) trees.set(treeKey(cell.x, cell.y), cell);
}

export const clientPlugin: TerraceClientPlugin = {
  name: FLORA_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    // Module scope outlives an attach, so a re-attach after a rejoin would
    // otherwise open on the previous world's forest.
    trees.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;

    models = createFloraModels();
    ctx.layer.add(models.root);

    unsubscribeMessages = [
      ctx.onMessage(FLORA_FOREST_MESSAGE, (payload) => {
        const cells = parseForestPayload(payload);
        // A malformed payload is dropped whole: the previous forest keeps
        // rendering until the next good message, which is at most one keepalive
        // away. Clearing the world on a parse failure would be the one outcome
        // strictly worse than showing slightly stale trees.
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
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      if (pendingGround === 0) return;
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < FLORA_GROUND_RETRY_SECONDS) return;
      rebuild(ctx);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    trees.clear();
    pendingGround = 0;
    sinceRetrySeconds = 0;

    // The host empties and removes the layer itself; what it cannot know about
    // is the GPU memory behind the instanced meshes, so that is released here.
    models?.dispose();
    models = null;
  },
};
