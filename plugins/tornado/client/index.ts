import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  TORNADO_ALL_MESSAGE,
  TORNADO_PLUGIN_NAME,
  parseAllPayload,
  type TornadoState,
} from '../protocol.ts';
import { createFunnel, type FunnelRenderer, type FunnelSource } from './funnel.ts';
import { extrapolate } from '../../../client/src/plugins/kit/extrapolation.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

let funnel: FunnelRenderer | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

let storms: readonly TornadoState[] = [];
let receivedAtSeconds = 0;

let elapsedSeconds = 0;

function funnelSources(ctx: ClientPluginCtx): FunnelSource[] {
  const sources: FunnelSource[] = [];
  for (const storm of storms) {
    const at = extrapolate(storm, elapsedSeconds - receivedAtSeconds);
    const groundY = ctx.terrainHeightAt(Math.round(at.x), Math.round(at.y));
    if (groundY === null) continue;
    sources.push({
      id: storm.id,
      x: at.x * CELL_WORLD_SIZE,
      groundY,
      z: at.y * CELL_WORLD_SIZE,
      intensity: storm.intensity,
    });
  }
  return sources;
}

const FUNNEL_DRAW_OBJECTS = 2;

const FULL_DAYLIGHT = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: TORNADO_PLUGIN_NAME,

  drawBudget: FUNNEL_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    reducedMotion = watchReducedMotion();

    funnel = createFunnel(ctx.revealClipUniforms());
    ctx.layer.add(funnel.root);

    unsubscribes = [
      ctx.onMessage(TORNADO_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload);
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.onFrame((dt) => {
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        funnel?.apply(funnelSources(ctx));
        funnel?.update(dt, elapsedSeconds, FULL_DAYLIGHT);
      }),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;

    funnel?.dispose();
    funnel = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
