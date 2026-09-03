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
  GroundShadeDisc,
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
import {
  createSpiral,
  CYCLONE_DECK_BASE_WORLD_Y,
  CYCLONE_SHADE_CORE_FRACTION,
  CYCLONE_SHADE_DARKNESS,
  MAX_SPIRALS,
  type SpiralRenderer,
  type SpiralSource,
} from './spiral.ts';
import {
  createCycloneRainField,
  CYCLONE_RAIN_DRAW_OBJECTS,
  type CycloneRainField,
  type CycloneRainSource,
} from './rain.ts';
import {
  GLOOM_RESPONSE_PER_SECOND,
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
let rain: CycloneRainField | null = null;
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
 * The live cyclones, as ./rain.ts is told about them.
 *
 * REUSED, NEVER REALLOCATED, for the reason `shade` below is: it is rebuilt
 * every frame, and a fresh array per frame is garbage for nothing.
 *
 * IT CARRIES THE DRIFT AND THE SPIRAL'S SOURCE DOES NOT, which is why these are
 * two lists and not one: the deck's arms do not lean, and a source type
 * carrying a velocity the deck never reads would be a field a reader has to
 * check the deck for.
 */
const rainSources: CycloneRainSource[] = [];

function refreshRainSources(): readonly CycloneRainSource[] {
  rainSources.length = 0;
  for (const storm of storms) {
    const centre = at(storm);
    rainSources.push({
      id: storm.id,
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      radiusWorldUnits: storm.radius * CELL_WORLD_SIZE,
      intensity: storm.intensity,
      // The wire's velocity is in CELLS per second — one conversion here, so no
      // line further down has to remember which space it is in.
      vx: storm.vx * CELL_WORLD_SIZE,
      vz: storm.vy * CELL_WORLD_SIZE,
    });
  }
  return rainSources;
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
 * The shade a cyclone's deck throws on the ground.
 *
 * AT THE DECK'S OWN BASE, which is now the same cloud base every other sky
 * plugin's deck sits on (spiral.ts's CYCLONE_DECK_BASE_WORLD_Y, and the reason
 * this stopped being a height of its own). A shadow falls from where its cloud
 * actually is, and `GroundShadeDisc.y` stays per disc for exactly that reason —
 * it is simply no longer a different answer for this plugin.
 *
 * REUSED, NEVER REALLOCATED — core reads it every frame. Read from the same
 * EXTRAPOLATED positions the deck is drawn at (`at`), so the shadow cannot be a
 * push behind its own cloud.
 */
const shade: GroundShadeDisc[] = [];

function shadeDiscs(): readonly GroundShadeDisc[] {
  shade.length = 0;
  for (const storm of storms) {
    if (storm.intensity <= 0) continue;
    const centre = at(storm);
    shade.push({
      x: centre.x * CELL_WORLD_SIZE,
      z: centre.y * CELL_WORLD_SIZE,
      y: CYCLONE_DECK_BASE_WORLD_Y,
      radius: storm.radius * CELL_WORLD_SIZE,
      darkness: CYCLONE_SHADE_DARKNESS * storm.intensity,
      inner: CYCLONE_SHADE_CORE_FRACTION,
    });
  }
  return shade;
}

/**
 * The spiral rig is one instanced pool shared by every live cyclone — MAX_SPIRALS
 * bounds the INSTANCES inside it, not the draw calls — so this is a fixed
 * number. Measured 2026-08-29: 1 surface. The gloom draws nothing at all: it
 * modulates the sky rig core already draws.
 */
const SPIRAL_DRAW_OBJECTS = 1;

/**
 * Every draw call this plugin can submit at once, derived from its OWN cap and
 * never typed: the one instanced deck, plus one rain column per storm this
 * renderer can hold.
 *
 * MAX_SPIRALS rather than the server's cap, for the reason `groundShadeBudget`
 * below gives: a dispersing storm is still drawing a deck, and it is still
 * raining.
 */
const CYCLONE_DRAW_OBJECTS = SPIRAL_DRAW_OBJECTS + MAX_SPIRALS * CYCLONE_RAIN_DRAW_OBJECTS;

export const clientPlugin: TerraceClientPlugin = {
  name: CYCLONE_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constant above.
   */
  drawBudget: CYCLONE_DRAW_OBJECTS,

  /**
   * One shade disc per storm this renderer can hold, so the budget IS that cap
   * — an expression of the plugin's own numbers, exactly as `drawBudget` is.
   * MAX_SPIRALS rather than the server's cap because a dispersing storm is
   * still drawing a deck and must still be casting its shadow.
   */
  groundShadeBudget: MAX_SPIRALS,

  attach(ctx: ClientPluginCtx): void {
    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;
    sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;
    reducedMotion = watchReducedMotion();

    spiral = createSpiral((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(spiral.root);

    rain = createCycloneRainField((material, label) => ctx.applyRevealClip(material, label));
    ctx.layer.add(rain.root);

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

      ctx.publishGroundShade(shadeDiscs),

      ctx.onFrame((dt) => {
        // REDUCED MOTION (the design record's hard requirement): this plugin's
        // own animation clock FREEZES, which stops the deck rotating and the
        // gloom deepening in one place — they are both functions of it. The
        // storms themselves keep arriving and moving, because their positions
        // come from the server and hiding them would be hiding the world.
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        // THE CLOUDS TRACK THE LIGHT AND NOBODY HAS TO SAY SO. The deck is
        // Lambert-lit (spiral.ts's CYCLONE_DECK_COLOR), so the sky rig this
        // plugin is already dimming through `modulateSkyRig` reaches it the
        // same way it reaches the ground — no daylight number, and no second
        // copy of the arithmetic to keep in step with the first.
        // BEFORE ANYTHING IS SUBMITTED. The deck and the rain are composited
        // in submission order this frame — both are depth-write-off transparent
        // geometry — so which side of the cloud base the camera is on has to be
        // settled before either goes in (spiral.ts's
        // SPIRAL_RENDER_ORDER_CAMERA_ABOVE_BASE, #300).
        spiral?.orderAgainstCamera(ctx.cameraPosition().y);

        spiral?.apply(spiralSources());
        spiral?.update(dt, elapsedSeconds);
        // THE SAME FROZEN CLOCK the deck turns on, so the rain becalms under
        // prefers-reduced-motion from the one fact above and needs no branch of
        // its own.
        rain?.apply(refreshRainSources(), elapsedSeconds);

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

    rain?.dispose();
    rain = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
