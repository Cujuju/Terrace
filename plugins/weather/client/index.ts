// weather — client half. Draws whatever the server's `weather:systems`
// broadcast says exists, and nothing else.
//
// It holds no authority: it never spawns a system, never moves one of its own
// accord, and never predicts. Between the 1 Hz broadcasts it interpolates
// (./interpolation.ts) and animates the falling, drifting and flashing
// (./rig.ts); both are purely cosmetic, so a client that misses messages looks
// stiller, never wrong.
//
// AN EMPTY LIST COSTS NOTHING. No systems means no rigs parented into the
// scene, no buffers written, no draw calls, and no change to any global scene
// state — the sun, the sky and scene.fog are exactly what core set them to. That
// is what makes "the existing sun stays as-is" a structural fact rather than a
// promise: this plugin has no code path that touches them.
//
// No HUD panel, deliberately: weather is a thing you look up at. A label saying
// RAIN would be the opposite of the feature.
//
// Everything it touches arrives through ClientPluginCtx: its own Group in the
// scene, the message channel, and the frame clock. Notably NOT the camera — the
// contract exposes none, and this plugin needs none: a system is a bounded disc
// of tens of cells, so its whole extent is drawn as one object anchored to the
// WEATHER rather than to the viewer. See RENDERING IS ANCHORED TO THE SYSTEM.

import { Group } from 'three';
import { CELL_WORLD_SIZE } from '@terrace/shared';
import type {
  ClientPluginCtx,
  TerraceClientPlugin,
} from '../../../client/src/plugins/types.ts';
import {
  STRIKE_NO_SYSTEM,
  WEATHER_PLUGIN_NAME,
  WEATHER_STRIKES_MESSAGE,
  WEATHER_SYSTEMS_MESSAGE,
  parseStrikesPayload,
  parseSystemsPayload,
  MAX_ACTIVE_SYSTEMS,
} from '../protocol.ts';
import { WeatherInterpolator, type InterpolatedSystem } from './interpolation.ts';
import { createWeatherRigs, type WeatherRig, type WeatherRigs } from './rig.ts';
import { LightningGovernor } from './sky.ts';

// ─────────────────────────────────────────────────────────────────────────────
// RENDERING IS ANCHORED TO THE SYSTEM, NOT TO THE CAMERA.
//
// The usual way to draw rain is a small box of particles that follows the
// viewer, because in most games weather covers the whole world and drawing all
// of it is impossible. Here it is the other way round: weather IS a bounded
// object — a disc of 24 to 56 cells — so the entire mass fits in one pooled
// particle rig, and anchoring that rig to the system rather than to the camera
// is both simpler and more correct. A front is then a body of rain that visibly
// crosses the landscape and passes over the player, which is exactly the
// owner's "moves together in large chunks"; a camera-locked box cannot show
// that, because it is always centred on you.
//
// It is also the only option available: ClientPluginCtx exposes no camera
// (client/src/plugins/types.ts), and adding one would be a change to the core
// plugin contract — out of this plugin's remit, and unnecessary given the above.
//
// COST, NAMED: the particle COUNT per rig is fixed while the radius is not, so a
// 24-cell squall rains about five times as densely as a 56-cell front. That
// reads as a compact shower being heavier than a broad drizzle, which is a
// defensible picture but is a consequence and not a decision. A camera-anchored
// field would have had constant screen-space density instead — and no front.
// ─────────────────────────────────────────────────────────────────────────────

/**
 * Cap on the animation clock's advance per frame, in seconds. `onFrame`'s dt is
 * already capped by the host, but the animation clock is an accumulator: this
 * keeps a pathological frame (a background tab coming back) from jumping every
 * drop a full cycle and every fog sheet a full turn.
 */
const MAX_ANIMATION_STEP_SECONDS = 0.1;

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference LIVE, the way the mana gauge and the
 * monsters plugin's dread do: someone who turns it on mid-session must not have
 * to reload to stop the lightning.
 *
 * Falls back to "reduced" being false where matchMedia does not exist. That is
 * the honest default rather than the safe-looking one: the only environment in
 * this project without matchMedia is the node test runner, which draws nothing,
 * and defaulting to true there would let the effect's normal path go untested.
 *
 * ONE WATCHER FOR THE WHOLE PLUGIN, not one per rig: the preference is a
 * property of the user, not of a rain cloud, and a listener per system would add
 * and remove listeners every time the weather turned over.
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

/**
 * Module-level singletons, matching the shape of this repo's other plugins. The
 * client host constructs exactly one instance of each plugin (client/src/
 * plugins/host.ts), and `attach`/`dispose` bracket their whole lifetime.
 */
let rigs: WeatherRigs | null = null;
let container: Group | null = null;
/** The rig drawing each live system, keyed by system id. */
const views = new Map<number, WeatherRig>();
const interpolator = new WeatherInterpolator();
/**
 * THE ONE THING THAT MAY START A FLASH ANYWHERE ON THIS CLIENT. Shared by every
 * storm rig, which is what makes the photosensitivity floor hold across
 * concurrent storms rather than only within one — see MIN_FLASH_INTERVAL_SECONDS.
 */
const governor = new LightningGovernor();
/**
 * The animation clock. It STOPS ADVANCING under prefers-reduced-motion, and that
 * one line is what becalms the entire sky: fall, sway, spin and bob are all
 * functions of it, so none of them needs its own reduced-motion branch.
 */
let animationSeconds = 0;
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeStrikes: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

/** Adds/removes rigs so `views` matches the sampled system list. */
function reconcileViews(sampled: ReadonlyMap<number, InterpolatedSystem>): void {
  if (rigs === null || container === null) return;

  // RELEASES FIRST, THEN ACQUIRES. One broadcast can retire a system and
  // introduce another of the same kind, and doing it the other way round makes
  // the newcomer build a rig while the one it could have reused is still a frame
  // away from the free list — a needless buffer and, for a storm, a needless
  // shader recompile.
  for (const [id, rig] of views) {
    if (sampled.has(id)) continue;
    container.remove(rig.root);
    // Back to the pool, not disposed: the next system of this kind is minutes
    // away and will want exactly this rig. See createWeatherRigs.
    rigs.release(rig);
    views.delete(id);
  }

  for (const [id, system] of sampled) {
    if (views.has(id)) continue;
    // A system's kind is fixed for its life, so the rig is chosen once here and
    // never re-chosen — which is what lets rigs be pooled by kind.
    const rig = rigs.acquire(system.kind);
    container.add(rig.root);
    views.set(id, rig);
  }
}

/**
 * THE RENDER PATH. Runs once per animation frame.
 *
 * The whole frame's work is proportional to the number of LIVE systems, which is
 * zero most of the time on a small world: `sample()` returns an empty map,
 * `reconcileViews` iterates nothing, and the loop below does not run.
 */
function renderFrame(dt: number): void {
  const reduced = reducedMotion?.matches() ?? false;
  // The clock does not advance under reduced motion — see the declaration.
  if (!reduced) animationSeconds += Math.min(dt, MAX_ANIMATION_STEP_SECONDS);

  // Advanced once per frame, BEFORE any rig asks it for permission, so every
  // storm this frame is measured against the same clock.
  governor.advance(dt);
  interpolator.advance(dt);

  // The dry bolt is advanced every frame whatever the weather: it belongs to no
  // system, so nothing else would ever decay its flash.
  rigs?.dryBolt.update(dt, reduced);

  const sampled = interpolator.sample();
  reconcileViews(sampled);

  for (const [id, system] of sampled) {
    const rig = views.get(id);
    if (rig === undefined) continue;
    rig.update(system, animationSeconds, dt, reduced, governor);
  }
}

/**
 * A bolt landed. Finds the rig drawing the system that threw it and tells it
 * where, in that rig's OWN space — the rig's root sits at the system's centre,
 * so a strike is an offset from there rather than a world position.
 *
 * THE SYSTEM'S SAMPLED POSITION, not its last broadcast one: the rig is drawn at
 * the interpolated position this frame (interpolation.ts), so measuring the
 * offset against anything else would put the bolt a fraction of a cell away from
 * where the storm actually is.
 *
 * Dropped silently when the system is unknown — a strike can arrive for a system
 * whose broadcast has not landed yet, or one this client has already retired.
 * There is nothing to draw and nothing to correct; the fire the server started
 * is not this client's to decide about.
 */
function applyStrike(systemId: number, cellX: number, cellY: number): void {
  const rig = systemId === STRIKE_NO_SYSTEM ? undefined : views.get(systemId);
  const system = rig === undefined ? undefined : interpolator.sample().get(systemId);

  if (rig === undefined || system === undefined) {
    // DRY LIGHTNING, or a bolt from a system this client does not know about —
    // one whose broadcast has not landed yet, or one already retired. Both are
    // drawn by the same loose bolt at the strike's own world position, which is
    // strictly better than the old behaviour of dropping the second case: a
    // player saw a forest catch under a clear sky with no bolt at all.
    rigs?.dryBolt.strike(cellX * CELL_WORLD_SIZE, cellY * CELL_WORLD_SIZE, governor);
    return;
  }

  rig.strike(
    (cellX - system.x) * CELL_WORLD_SIZE,
    (cellY - system.y) * CELL_WORLD_SIZE,
    governor,
  );
}

/**
 * Draw objects ONE weather system's rig costs at worst: SEVEN — a storm's
 * (rain 5, snow 5, fog 4; measured 2026-08-29 over every WeatherKind).
 */
const WEATHER_SYSTEM_DRAW_OBJECTS = 7;

/** The world's single dry bolt, which belongs to no system: ONE. */
const DRY_BOLT_DRAW_OBJECTS = 1;

/** The light bank holds PointLights, which are not drawn objects. */
const LIGHT_BANK_DRAW_OBJECTS = 0;

export const clientPlugin: TerraceClientPlugin = {
  name: WEATHER_PLUGIN_NAME,

  /**
   * Its share of the frame's draw calls, from its own caps — see
   * TerraceClientPlugin.drawBudget and the constants above.
   */
  drawBudget: MAX_ACTIVE_SYSTEMS * WEATHER_SYSTEM_DRAW_OBJECTS +
    DRY_BOLT_DRAW_OBJECTS +
    LIGHT_BANK_DRAW_OBJECTS,

  attach(ctx: ClientPluginCtx): void {
    rigs = createWeatherRigs();
    reducedMotion = watchReducedMotion();

    // One child Group of our own inside the host's layer: it keeps every system
    // under a single named node, which makes the scene graph legible in the
    // three.js inspector and gives dispose() one thing to clear.
    container = new Group();
    container.name = 'weather:systems';
    ctx.layer.add(container);

    // Beside the systems, not inside them: a dry bolt is positioned in world
    // space and must not ride any system's transform.
    ctx.layer.add(rigs.dryBolt.root);

    // The storm flash lights, all of them, dark, for the plugin's whole life —
    // so the scene's light count is fixed from here on (rig.ts, lightBank).
    ctx.layer.add(rigs.lightBank);

    unsubscribeMessages = ctx.onMessage(WEATHER_SYSTEMS_MESSAGE, (payload) => {
      const systems = parseSystemsPayload(payload);
      // A malformed payload is dropped whole: the weather already on screen
      // keeps drawing until the next good message, which is a second away.
      if (systems === null) return;
      interpolator.receive(systems);
    });

    unsubscribeStrikes = ctx.onMessage(WEATHER_STRIKES_MESSAGE, (payload) => {
      const strikes = parseStrikesPayload(payload);
      if (strikes === null) return;
      // REDUCED MOTION DROPS THE BOLT HERE, at the door, rather than inside the
      // rig: it is the one place that knows the strike is a visual event at all.
      // The server's fire burns either way — a player who asked for less motion
      // asked for less motion, not for a different world.
      if (reducedMotion?.matches() ?? false) return;
      for (const strike of strikes) applyStrike(strike.systemId, strike.x, strike.y);
    });

    unsubscribeFrames = ctx.onFrame((dt) => renderFrame(dt));
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeStrikes?.();
    unsubscribeFrames?.();
    unsubscribeMessages = null;
    unsubscribeStrikes = null;
    unsubscribeFrames = null;

    views.clear();
    interpolator.clear();
    governor.reset();

    container?.clear();
    container = null;

    // Every rig — parented or pooled — plus the shared geometry, freed here and
    // exactly once.
    rigs?.dispose();
    rigs = null;

    reducedMotion?.stop();
    reducedMotion = null;
    animationSeconds = 0;
  },
};
