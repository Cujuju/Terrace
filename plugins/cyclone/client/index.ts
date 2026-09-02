// cyclone — client half. Draws whatever `cyclone:all` says is in the air, and
// darkens the sky when one of them is overhead.
//
// It holds no authority: it never spawns a storm, never moves one, never decides
// one has died. A storm that stops appearing in the full-state list has died,
// and the renderer turns that ABSENCE into a dispersal on its own.
//
// A CYCLONE'S DECK IS A CLOUD LAYER AT A FIXED HEIGHT and asks neither terrain
// oracle: nothing about where the ground is changes where a cloud is. (The other
// case — a thing standing ON the ground, placed by `terrainHeightAt` — is the
// tornado plugin's funnel. Getting the two the wrong way round is the water bug
// this codebase paid four rewrites for, which is why they are named in both.)
//
// ─────────────────────────────────────────────────────────────────────────────
// THE SKY IS NOT THIS PLUGIN'S TO CLAIM. See ./gloom.ts.

import type {
  ClientPluginCtx,
  SkyRigState,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import {
  CYCLONE_ALL_MESSAGE,
  CYCLONE_PLUGIN_NAME,
  parseAllPayload,
  type CycloneState,
} from '../protocol.ts';
import { createSpiral, type SpiralRenderer, type SpiralSource } from './spiral.ts';
import {
  CLOUD_GLOOM_RESPONSE,
  GLOOM_RESPONSE_PER_SECOND,
  MAX_GLOOM_LIGHT_LOSS,
  applyGloom,
  overheadFraction,
} from './gloom.ts';
import { extrapolate } from '../../../client/src/plugins/kit/extrapolation.ts';
import { watchReducedMotion } from '../../../client/src/plugins/kit/reducedMotion.ts';

/**
 * Seconds between re-asking what the camera is looking at, for the gloom.
 *
 * A QUARTER SECOND. The question is answered by a raycast against the terrain
 * (ClientPluginCtx.pickTerrainCell), which is not a per-frame cost to take for
 * an effect that ramps over three seconds — and the answer only changes as fast
 * as the player moves the camera. This is the same throttle-a-network-paced-
 * question pattern the flora, structures and volcano renderers use for their
 * ground lookups.
 */
export const GLOOM_AIM_INTERVAL_SECONDS = 0.25;

/** Module-level singletons — the host constructs exactly one plugin instance. */
let spiral: SpiralRenderer | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

/** The storms as last broadcast, and when (on the shared clock) that was. */
let storms: readonly CycloneState[] = [];
let receivedAtSeconds = 0;

/**
 * The shared animation clock, in seconds since attach.
 *
 * ONE CLOCK FOR THE RENDERER AND THE EXTRAPOLATION, driven from the host's own
 * capped dt rather than from `performance.now()`: the host caps dt so a
 * background-tab hiccup cannot produce a giant step, and a wall clock would let
 * the deck jump a minute forward the moment the tab is focused again.
 */
let elapsedSeconds = 0;

/** Current gloom depth, easing toward the target — see ./gloom.ts. */
let gloomDepth = 0;
/** The cell the camera is aimed at, re-asked on GLOOM_AIM_INTERVAL_SECONDS. */
let aimedCell: { x: number; y: number } | null = null;
let sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;

/** Where a storm is RIGHT NOW, in cell space, extrapolated from its velocity. */
function at(storm: CycloneState): { x: number; y: number } {
  return extrapolate(storm, elapsedSeconds - receivedAtSeconds);
}

/** The live cyclones — what the spiral draws. No ground lookup; see the header. */
function spiralSources(): SpiralSource[] {
  const sources: SpiralSource[] = [];
  for (const storm of storms) {
    const centre = at(storm);
    sources.push({
      id: storm.id,
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      radiusCells: storm.radius,
      intensity: storm.intensity,
    });
  }
  return sources;
}

/**
 * How dark it should be where the camera is looking, in [0, 1].
 *
 * THE STRONGEST CYCLONE OVER THAT CELL, not the sum of them: two overlapping
 * storms do not make the sky twice as dark as cloud can make it, and a sum would
 * exceed 1 and clip.
 */
function gloomTarget(): number {
  if (aimedCell === null) return 0;
  let deepest = 0;
  for (const storm of storms) {
    const centre = at(storm);
    const dx = aimedCell.x - centre.x;
    const dy = aimedCell.y - centre.y;
    const depth = storm.intensity * overheadFraction(Math.hypot(dx, dy), storm.radius);
    if (depth > deepest) deepest = depth;
  }
  return deepest;
}

/** Re-asks what the camera is aimed at, on the throttle. */
function refreshAim(ctx: ClientPluginCtx, dt: number): void {
  sinceAimSeconds += dt;
  if (sinceAimSeconds < GLOOM_AIM_INTERVAL_SECONDS) return;
  sinceAimSeconds = 0;
  if (typeof window === 'undefined') return;
  // THE CENTRE OF THE SCREEN is the honest proxy for "where the player is", and
  // the only positional question ClientPluginCtx can answer: it exposes pickers
  // that take viewport coordinates, not the camera itself. A miss (the pointer
  // over sea with no terrain, or locked territory) leaves the last aim standing
  // rather than snapping the sky back to clear, which is what a
  // null-means-no-storm reading would do every time the camera swung over the
  // ocean.
  const cell = ctx.pickTerrainCell(window.innerWidth / 2, window.innerHeight / 2);
  if (cell !== null) aimedCell = cell;
}

/**
 * The spiral rig is one instanced pool shared by every live cyclone — MAX_SPIRALS
 * bounds the INSTANCES inside it, not the draw calls — so this is a fixed
 * number. Measured 2026-08-29: 1 surface. The gloom draws nothing at all: it
 * modulates the sky rig core already draws.
 */
const SPIRAL_DRAW_OBJECTS = 1;

export const clientPlugin: TerraceClientPlugin = {
  name: CYCLONE_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constant above.
   */
  drawBudget: SPIRAL_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;
    sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;
    reducedMotion = watchReducedMotion();

    spiral = createSpiral();
    ctx.layer.add(spiral.root);

    unsubscribes = [
      ctx.onMessage(CYCLONE_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload);
        // A malformed payload is dropped WHOLE — the previous state keeps
        // rendering until the next good message, which is 200 ms away. Every
        // plugin in this repo follows the same rule.
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      // MODULATE, DO NOT CLAIM — ./gloom.ts's header has the argument. The depth
      // is read at CALL time rather than captured, so this closure is registered
      // once and follows the storm for the session.
      ctx.modulateSkyRig((state: SkyRigState) => applyGloom(state, gloomDepth)),

      ctx.onFrame((dt) => {
        // REDUCED MOTION (the design record's hard requirement): this plugin's
        // own animation clock FREEZES, which stops the deck rotating and the
        // gloom deepening in one place — they are both functions of it. The
        // storms themselves keep arriving and moving, because their positions
        // come from the server and hiding them would be hiding the world.
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        // THE CLOUDS TRACK THE LIGHT, BUT NOT AS FAR AS THE GROUND DOES.
        //
        // The renderer uses an unlit material, which reads none of the scene's
        // lights, so the gloom has to reach it as a number or a storm would sit
        // at full brightness in the darkness it is causing (spiral.ts's
        // uDaylight note). The number is NOT the ground's, though: the deck is
        // on the sunny side of the cloud that is doing the shading, so it keeps
        // most of its light — see gloom.ts's CLOUD_GLOOM_RESPONSE. Derived from
        // the same gloom depth as the sky, so the two can only ever disagree by
        // a frame.
        const daylight = 1 - gloomDepth * MAX_GLOOM_LIGHT_LOSS * CLOUD_GLOOM_RESPONSE;

        spiral?.apply(spiralSources());
        spiral?.update(dt, elapsedSeconds, daylight);

        refreshAim(ctx, dt);
        // Eased rather than assigned, so a 5 Hz push and a re-aimed camera do
        // not step the light. Linear, not exponential, so it ARRIVES — the same
        // argument the server's envelope makes.
        const target = gloomTarget();
        const step = GLOOM_RESPONSE_PER_SECOND * dt;
        gloomDepth =
          target > gloomDepth
            ? Math.min(target, gloomDepth + step)
            : Math.max(target, gloomDepth - step);
      }),
    ];
  },

  dispose(): void {
    for (const unsubscribe of unsubscribes) unsubscribe();
    unsubscribes = [];

    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;

    spiral?.dispose();
    spiral = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
