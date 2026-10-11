import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  TORNADO_ALL_MESSAGE,
  TORNADO_PLUGIN_NAME,
  parseAllPayload,
  MAX_ACTIVE_TORNADOES,
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

type MutableFunnelSource = { -readonly [K in keyof FunnelSource]: FunnelSource[K] };

function blankSource(): MutableFunnelSource {
  return { id: 0, x: 0, groundY: 0, z: 0, intensity: 0 };
}

const sourcePool: MutableFunnelSource[] = [];
const sources: FunnelSource[] = [];

// Refilled in place over a pool: this runs every frame and must allocate nothing.
function funnelSources(ctx: ClientPluginCtx): readonly FunnelSource[] {
  sources.length = 0;
  for (const storm of storms) {
    const at = extrapolate(storm, elapsedSeconds - receivedAtSeconds);
    const groundY = ctx.drawnGroundYAt(at.x, at.y);
    if (groundY === null) continue;
    while (sourcePool.length <= sources.length) sourcePool.push(blankSource());
    const filled = sourcePool[sources.length]!;
    filled.id = storm.id;
    filled.x = at.x * CELL_WORLD_SIZE;
    filled.groundY = groundY;
    filled.z = at.y * CELL_WORLD_SIZE;
    filled.intensity = storm.intensity;
    sources.push(filled);
  }
  return sources;
}

const FUNNEL_DRAW_OBJECTS = 2;

function forgetStorms(): void {
  storms = [];
  receivedAtSeconds = 0;
  elapsedSeconds = 0;
  sources.length = 0;
}

export const clientPlugin: TerraceClientPlugin = {
  name: TORNADO_PLUGIN_NAME,

  drawBudget: FUNNEL_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    forgetStorms();
    reducedMotion = watchReducedMotion();

    funnel = createFunnel((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(funnel.root);

    unsubscribes = [
      ctx.onMessage(TORNADO_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload, MAX_ACTIVE_TORNADOES);
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.onWorldReset(() => {
        forgetStorms();
        funnel?.clear();
      }),

      ctx.onFrame((dt) => {
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        funnel?.apply(funnelSources(ctx));
        funnel?.update(dt, elapsedSeconds);
      }),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    forgetStorms();

    funnel?.dispose();
    funnel = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
