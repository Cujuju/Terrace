// volcanoes — client half. Draws whatever `volcanoes:all` and
// `volcanoes:changes` say is molten and erupting, and nothing else.
//
// It holds no authority: it never sites a vent, never starts an eruption, never
// moves a flow. The one thing it computes for itself is HOW HOT a cell is,
// which it derives from the age the server sent using protocol.ts's own curve —
// the same function the server runs, in the file both halves import, so the two
// cannot drift (see LAVA_COOL_SECONDS there).
//
// TWO LAYERS, TWO ORACLES FOR THE GROUND, and the distinction is the one
// ClientPluginCtx spells out:
//
//   * the FLOW lies ON the ground and is seen against it, so every cap and
//     riser of its mesh is placed by `drawnGroundYAt` — the Y the terrain
//     actually drew (./lavaFlow.ts, which drapes rather than decals);
//   * the PLUME stands OUT OF the ground and is seen against the sky, so it is
//     placed by `terrainHeightAt`, which costs nothing and is right for
//     anything standing up (./plume.ts).
//
// Getting those the other way round is the water bug this codebase paid four
// rewrites for, which is why they are named here as well as in each renderer.

import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  VOLCANOES_ALL_MESSAGE,
  VOLCANOES_CHANGES_MESSAGE,
  VOLCANOES_PLUGIN_NAME,
  parseAllPayload,
  parseChangesPayload,
  type VentState,
} from '../protocol.ts';
import { createLavaFlow, type LavaFlowRenderer } from './lavaFlow.ts';
import { createPlume, type PlumeRenderer, type PlumeSource } from './plume.ts';

/**
 * Seconds between retries while some flow cell's ground is still unknown.
 *
 * Exactly structures' and flora's 0.5 s and for the same reason: the condition
 * resolves on a NETWORK event at human pace (a chunk streaming in), not on a
 * per-frame one, so retrying every frame would pay for a chunk's contour plan
 * sixty times a second to answer a question that changes twice a minute.
 */
export const VOLCANOES_GROUND_RETRY_SECONDS = 0.5;

let flow: LavaFlowRenderer | null = null;
let plume: PlumeRenderer | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

/** Every vent this client knows about, by id. Vents never move. */
const vents = new Map<number, VentState>();

/**
 * The shared animation clock, in seconds since attach.
 *
 * ONE CLOCK FOR BOTH RENDERERS, driven from the host's own capped dt rather
 * than from `performance.now()`: the host caps dt so a background-tab hiccup
 * cannot produce a giant step, and a wall clock would let the plume jump a
 * minute forward the moment the tab is focused again.
 */
let elapsedSeconds = 0;
let sinceRetrySeconds = 0;

/** The erupting vents, with the ground under each — what the plume draws. */
function plumeSources(ctx: ClientPluginCtx): PlumeSource[] {
  const sources: PlumeSource[] = [];
  for (const vent of vents.values()) {
    if (!vent.erupting) continue;
    // A THING STANDING ON THE GROUND, so terrainHeightAt is the right oracle —
    // see this file's header. Null means the vent's chunk has not streamed in;
    // the column is simply not drawn until it has, and `apply` runs every frame
    // so the next one retries for free.
    const groundY = ctx.terrainHeightAt(vent.x, vent.y);
    if (groundY === null) continue;
    sources.push({ id: vent.id, x: vent.x, y: vent.y, groundY });
  }
  return sources;
}

function replaceVents(list: readonly VentState[]): void {
  vents.clear();
  for (const vent of list) vents.set(vent.id, vent);
}

/**
 * One merged surface each, for every eruption in the world: LAVA_CELL_CAP and
 * MAX_PLUMES bound what goes INTO them, not how many calls they cost. Measured
 * 2026-08-29.
 */
const LAVA_FLOW_DRAW_OBJECTS = 1;
const PLUME_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: VOLCANOES_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: LAVA_FLOW_DRAW_OBJECTS + PLUME_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    vents.clear();
    elapsedSeconds = 0;
    sinceRetrySeconds = 0;

    flow = createLavaFlow();
    ctx.layer.add(flow.root);
    plume = createPlume();
    ctx.layer.add(plume.root);

    const groundAt = (cellX: number, cellY: number): number | null =>
      ctx.drawnGroundYAt(cellX, cellY);

    unsubscribeMessages = [
      ctx.onMessage(VOLCANOES_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload);
        // A malformed payload is dropped WHOLE — the previous state keeps
        // rendering until the next good message, which is at most one keepalive
        // away. Every plugin in this repo follows the same rule.
        if (all === null) return;
        replaceVents(all.vents);
        flow?.replaceAll(all.lava, elapsedSeconds, groundAt);
      }),

      ctx.onMessage(VOLCANOES_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        // The vent list travels COMPLETE in every delta (protocol.ts), so this
        // is a replace and not a merge — a vent that stopped erupting is one
        // whose flag is now false, never one that was removed.
        replaceVents(changes.vents);
        // Forget before adding: a cell the server evicted and immediately
        // re-melted would otherwise be dropped after being added. That ordering
        // now lives INSIDE the renderer, along with the reason this is one call
        // and not two — a message is worth at most one rebuild of the mesh, and
        // a message that moved no cell at all is worth none (lavaFlow.ts's
        // `apply`). It was two calls, and each of them rebuilt.
        flow?.apply(changes.forgotten, changes.molten, elapsedSeconds, groundAt);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      elapsedSeconds += dt;

      plume?.apply(plumeSources(ctx));
      plume?.update(dt, elapsedSeconds);
      // No `dt`: the flow's cooling is a uniform and a per-vertex birth time,
      // so a frame in which nothing changed writes nothing at all.
      flow?.update(elapsedSeconds);

      if (flow === null || !flow.pendingGround) return;
      sinceRetrySeconds += dt;
      if (sinceRetrySeconds < VOLCANOES_GROUND_RETRY_SECONDS) return;
      sinceRetrySeconds = 0;
      flow.retryPending(groundAt);
    });
  },

  dispose(): void {
    for (const unsubscribe of unsubscribeMessages) unsubscribe();
    unsubscribeMessages = [];
    unsubscribeFrames?.();
    unsubscribeFrames = null;

    vents.clear();
    elapsedSeconds = 0;
    sinceRetrySeconds = 0;

    flow?.dispose();
    flow = null;
    plume?.dispose();
    plume = null;
  },
};
