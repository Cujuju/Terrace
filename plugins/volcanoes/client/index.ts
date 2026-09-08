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

export const VOLCANOES_GROUND_RETRY_SECONDS = 0.5;

let flow: LavaFlowRenderer | null = null;
let plume: PlumeRenderer | null = null;
let unsubscribeMessages: Array<() => void> = [];
let unsubscribeFrames: (() => void) | null = null;

const vents = new Map<number, VentState>();

let elapsedSeconds = 0;
let sinceRetrySeconds = 0;

function plumeSources(ctx: ClientPluginCtx): PlumeSource[] {
  const sources: PlumeSource[] = [];
  for (const vent of vents.values()) {
    if (!vent.erupting) continue;
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

const LAVA_FLOW_DRAW_OBJECTS = 1;
const PLUME_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: VOLCANOES_PLUGIN_NAME,

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
        if (all === null) return;
        replaceVents(all.vents);
        flow?.replaceAll(all.lava, elapsedSeconds, groundAt);
      }),

      ctx.onMessage(VOLCANOES_CHANGES_MESSAGE, (payload) => {
        const changes = parseChangesPayload(payload);
        if (changes === null) return;
        replaceVents(changes.vents);
        flow?.apply(changes.forgotten, changes.molten, elapsedSeconds, groundAt);
      }),
    ];

    unsubscribeFrames = ctx.onFrame((dt) => {
      elapsedSeconds += dt;

      plume?.apply(plumeSources(ctx));
      plume?.update(dt, elapsedSeconds);
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
