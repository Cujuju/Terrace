// storms — client half. Draws whatever `storms:all` says is in the air, and
// darkens the sky when one of them is overhead.
//
// It holds no authority: it never spawns a storm, never moves one, never
// decides one has died. A storm that stops appearing in the full-state list has
// died, and the renderers turn that ABSENCE into a dispersal on their own.
//
// TWO RENDERERS, TWO PLACEMENTS, and the distinction is the one ClientPluginCtx
// spells out:
//
//   * a FUNNEL stands ON the ground, so it is placed by `terrainHeightAt` — the
//     lattice height, which costs nothing and is right for anything standing
//     up, because a thing standing up is not seen against the surface under it;
//   * a cyclone's DECK is a cloud layer at a fixed height and asks neither
//     oracle. Nothing about where the ground is changes where a cloud is.
//
// Getting those the other way round is the water bug this codebase paid four
// rewrites for, which is why they are named here as well as in each renderer.
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
  STORMS_ALL_MESSAGE,
  STORMS_PLUGIN_NAME,
  parseAllPayload,
  type StormState,
} from '../protocol.ts';
import { createFunnel, type FunnelRenderer, type FunnelSource } from './funnel.ts';
import { createSpiral, type SpiralRenderer, type SpiralSource } from './spiral.ts';
import {
  CLOUD_GLOOM_RESPONSE,
  GLOOM_RESPONSE_PER_SECOND,
  MAX_GLOOM_LIGHT_LOSS,
  applyGloom,
  overheadFraction,
} from './gloom.ts';

/**
 * Seconds a storm's last-known velocity may be extrapolated past the push that
 * carried it.
 *
 * ONE SECOND, five times the 200 ms broadcast interval, so a client rides out
 * four consecutive dropped messages before a storm visibly stalls. Extrapolation
 * rather than weather's interpolate-between-two-samples, and the difference is
 * what is being smoothed: weather's discs are enormous and slow, so a third of
 * a second of latency costs nothing and interpolating BEHIND the server is
 * free. A tornado covers two cells between pushes against a six-cell radius —
 * a third of its own width — so rendering it a push behind would put the funnel
 * visibly off the ground the server says it is flattening.
 */
export const MAX_EXTRAPOLATION_SECONDS = 1;

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

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference LIVE — the same pattern weather, monsters
 * and day/night each use, restated rather than imported (plugin halves do not
 * depend on each other's internals). Falls back to "not reduced" where
 * matchMedia does not exist, which is the node test runner: the only
 * environment here without it, and it draws nothing, so defaulting the other
 * way would leave the normal path untested.
 */
function watchReducedMotion(): { matches(): boolean; stop(): void } {
  const query =
    typeof window !== 'undefined' && typeof window.matchMedia === 'function'
      ? window.matchMedia(REDUCED_MOTION_QUERY)
      : null;
  if (query === null) return { matches: () => false, stop: () => {} };

  let reduced = query.matches;
  const onChange = (event: MediaQueryListEvent): void => {
    reduced = event.matches;
  };
  query.addEventListener('change', onChange);
  return {
    matches: () => reduced,
    stop: () => query.removeEventListener('change', onChange),
  };
}

/** Module-level singletons — the host constructs exactly one plugin instance. */
let funnel: FunnelRenderer | null = null;
let spiral: SpiralRenderer | null = null;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribes: Array<() => void> = [];

/** The storms as last broadcast, and when (on the shared clock) that was. */
let storms: readonly StormState[] = [];
let receivedAtSeconds = 0;

/**
 * The shared animation clock, in seconds since attach.
 *
 * ONE CLOCK FOR BOTH RENDERERS AND THE EXTRAPOLATION, driven from the host's
 * own capped dt rather than from `performance.now()`: the host caps dt so a
 * background-tab hiccup cannot produce a giant step, and a wall clock would let
 * a funnel jump a minute forward the moment the tab is focused again.
 */
let elapsedSeconds = 0;

/** Current gloom depth, easing toward the target — see ./gloom.ts. */
let gloomDepth = 0;
/** The cell the camera is aimed at, re-asked on GLOOM_AIM_INTERVAL_SECONDS. */
let aimedCell: { x: number; y: number } | null = null;
let sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;

/** Where a storm is RIGHT NOW, in cell space, extrapolated from its velocity. */
function extrapolated(storm: StormState): { x: number; y: number } {
  const age = Math.min(MAX_EXTRAPOLATION_SECONDS, Math.max(0, elapsedSeconds - receivedAtSeconds));
  return { x: storm.x + storm.vx * age, y: storm.y + storm.vy * age };
}

/** The live tornadoes, with the ground under each — what the funnel draws. */
function funnelSources(ctx: ClientPluginCtx): FunnelSource[] {
  const sources: FunnelSource[] = [];
  for (const storm of storms) {
    if (storm.kind !== 'tornado') continue;
    const at = extrapolated(storm);
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

/** The live cyclones — what the spiral draws. No ground lookup; see the header. */
function spiralSources(): SpiralSource[] {
  const sources: SpiralSource[] = [];
  for (const storm of storms) {
    if (storm.kind !== 'cyclone') continue;
    const at = extrapolated(storm);
    sources.push({
      id: storm.id,
      x: at.x * CELL_WORLD_SIZE,
      z: at.y * CELL_WORLD_SIZE,
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
 * storms do not make the sky twice as dark as cloud can make it, and a sum
 * would exceed 1 and clip. Tornadoes are excluded — a funnel is a few cells
 * across and darkens nothing but the ground it is standing on.
 */
function gloomTarget(): number {
  if (aimedCell === null) return 0;
  let deepest = 0;
  for (const storm of storms) {
    if (storm.kind !== 'cyclone') continue;
    const at = extrapolated(storm);
    const dx = aimedCell.x - at.x;
    const dy = aimedCell.y - at.y;
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
  // THE CENTRE OF THE SCREEN is the honest proxy for "where the player is",
  // and the only positional question ClientPluginCtx can answer: it exposes
  // pickers that take viewport coordinates, not the camera itself. A miss
  // (the pointer over sea with no terrain, or locked territory) leaves the
  // last aim standing rather than snapping the sky back to clear, which is
  // what a null-means-no-storm reading would do every time the camera swung
  // over the ocean.
  const cell = ctx.pickTerrainCell(window.innerWidth / 2, window.innerHeight / 2);
  if (cell !== null) aimedCell = cell;
}

export const clientPlugin: TerraceClientPlugin = {
  name: STORMS_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    storms = [];
    receivedAtSeconds = 0;
    elapsedSeconds = 0;
    gloomDepth = 0;
    aimedCell = null;
    sinceAimSeconds = GLOOM_AIM_INTERVAL_SECONDS;
    reducedMotion = watchReducedMotion();

    funnel = createFunnel();
    ctx.layer.add(funnel.root);
    spiral = createSpiral();
    ctx.layer.add(spiral.root);

    unsubscribes = [
      ctx.onMessage(STORMS_ALL_MESSAGE, (payload) => {
        const all = parseAllPayload(payload);
        // A malformed payload is dropped WHOLE — the previous state keeps
        // rendering until the next good message, which is 200 ms away. Every
        // plugin in this repo follows the same rule.
        if (all === null) return;
        storms = all.storms;
        receivedAtSeconds = elapsedSeconds;
      }),

      // MODULATE, DO NOT CLAIM — ./gloom.ts's header has the argument. The
      // depth is read at CALL time rather than captured, so this closure is
      // registered once and follows the storm for the session.
      ctx.modulateSkyRig((state: SkyRigState) => applyGloom(state, gloomDepth)),

      ctx.onFrame((dt) => {
        // REDUCED MOTION (the design record's hard requirement, and the policy
        // weather and day/night already implement): this plugin's own animation
        // clock FREEZES, which stops the funnel spinning, the deck rotating and
        // the gloom deepening in one place — they are all functions of it. The
        // storms themselves keep arriving and moving, because their positions
        // come from the server and hiding them would be hiding the world.
        if (!(reducedMotion?.matches() ?? false)) elapsedSeconds += dt;

        // THE CLOUDS TRACK THE LIGHT, BUT NOT AS FAR AS THE GROUND DOES.
        //
        // Both renderers use unlit materials, which read none of the scene's
        // lights, so the gloom has to reach them as a number or a storm would
        // sit at full brightness in the darkness it is causing (spiral.ts's
        // uDaylight note). The number is NOT the ground's, though: the deck is
        // on the sunny side of the cloud that is doing the shading, so it keeps
        // most of its light — see gloom.ts's CLOUD_GLOOM_RESPONSE. Derived from
        // the same gloom depth as the sky, so the two can only ever disagree by
        // a frame.
        const daylight = 1 - gloomDepth * MAX_GLOOM_LIGHT_LOSS * CLOUD_GLOOM_RESPONSE;

        funnel?.apply(funnelSources(ctx));
        funnel?.update(dt, elapsedSeconds, daylight);
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

    funnel?.dispose();
    funnel = null;
    spiral?.dispose();
    spiral = null;

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
