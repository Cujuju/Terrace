// tornado — client half. Draws whatever `tornado:all` says is on the ground.
//
// It holds no authority: it never spawns a funnel, never moves one, never
// decides one has died. A tornado that stops appearing in the full-state list
// has died, and the renderer turns that ABSENCE into a dispersal on its own.
//
// A FUNNEL STANDS ON THE GROUND, so it is placed by `terrainHeightAt` — the
// lattice height, which costs nothing and is right for anything standing up,
// because a thing standing up is not seen against the surface under it. (The
// other oracle, the rendered surface, is for things that lie ON the surface;
// getting the two the wrong way round is the water bug this codebase paid four
// rewrites for.)

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

/** Module-level singletons — the host constructs exactly one plugin instance. */
let funnel: FunnelRenderer | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

/** The funnels as last broadcast, and when (on the shared clock) that was. */
let storms: readonly TornadoState[] = [];
let receivedAtSeconds = 0;

/**
 * The animation clock, in seconds since attach.
 *
 * DRIVEN FROM THE HOST'S OWN CAPPED dt rather than from `performance.now()`: the
 * host caps dt so a background-tab hiccup cannot produce a giant step, and a
 * wall clock would let a funnel jump a minute forward the moment the tab is
 * focused again.
 */
let elapsedSeconds = 0;

/** The live tornadoes, with the ground under each — what the funnel draws. */
function funnelSources(ctx: ClientPluginCtx): FunnelSource[] {
  const sources: FunnelSource[] = [];
  for (const storm of storms) {
    const at = extrapolate(storm, elapsedSeconds - receivedAtSeconds);
    // A THING STANDING ON THE GROUND, so terrainHeightAt is the right oracle —
    // see this file's header. Null means the cell's chunk has not streamed in;
    // the funnel is simply not drawn until it has, and this runs every frame so
    // the next one retries for free.
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

/**
 * The funnel rig is one instanced pool shared by every live tornado — MAX_FUNNELS
 * bounds the INSTANCES inside it, not the draw calls — so this is a fixed
 * number. Measured 2026-08-29: 2 surfaces (the vortex cone and the debris).
 */
const FUNNEL_DRAW_OBJECTS = 2;

/** Nothing here dims the sky, so the rig is drawn at the full daylight scale. */
const FULL_DAYLIGHT = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: TORNADO_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constant above.
   */
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
        // A malformed payload is dropped WHOLE — the previous state keeps
        // rendering until the next good message, which is 200 ms away. Every
        // plugin in this repo follows the same rule.
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      ctx.onFrame((dt) => {
        // REDUCED MOTION (the design record's hard requirement): this plugin's
        // own animation clock FREEZES, which stops the funnel spinning — the
        // spin is a function of it. The tornadoes themselves keep arriving and
        // moving, because their positions come from the server and hiding them
        // would be hiding the world.
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        // FULL DAYLIGHT. The funnel's material is unlit and reads none of the
        // scene's lights, so it takes a daylight number rather than a lamp; this
        // plugin darkens nothing, so the number is 1. (A cyclone's deck is the
        // thing that shades the sky, and it is a plugin of its own.)
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
