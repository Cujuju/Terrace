// day & night — client half. Turns the server's occasional `phase` broadcast
// into a continuous sky, through the ONE new core capability this card needed
// (ClientPluginCtx.setSkyRig — client/src/plugins/types.ts).
//
// NO rig.ts, UNLIKE WEATHER. Weather's rig.ts exists to own Three.js objects
// (geometry, materials, a pooled set of meshes) that live in the plugin's own
// Group; this plugin creates no mesh, no material, no light of its own — it
// only ever hands nine plain numbers to core's setSkyRig, which is the ONE
// object (render/skyRig.ts's applySkyRig) permitted to touch the real lights.
// There is nothing here for a rig module to own, so this file calls sky.ts's
// pure functions directly rather than adding an empty pass-through layer.
//
// NEVER TOUCHES ctx.layer: this plugin puts nothing into the scene graph at
// all, which is also why it never imports three — the whole client half is
// pure numeric glue.

import type { ClientPluginCtx, TerraceClientPlugin } from '../../../client/src/plugins/types.ts';
import {
  DAYNIGHT_CLOCK_MESSAGE,
  DAYNIGHT_PLUGIN_NAME,
  parseClockPayload,
} from '../protocol.ts';
import { DayNightInterpolator } from './interpolation.ts';
import { formatWorldClock } from './formatTime.ts';
import { setWorldTimeText } from '../../../client/src/plugins/hudPanels.ts';
import { skyStateAtPhase } from './sky.ts';

const REDUCED_MOTION_QUERY = '(prefers-reduced-motion: reduce)';

/**
 * Tracks the user's motion preference LIVE — the same pattern weather and
 * monsters use, restated rather than imported (plugin halves do not depend on
 * each other's internals). Falls back to "reduced" being false where
 * matchMedia does not exist, which is the node test runner: the only
 * environment here without it, and it draws nothing, so defaulting to true
 * there would let the normal (non-frozen) path go untested.
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
const interpolator = new DayNightInterpolator();
let reducedMotion: { matches(): boolean; stop(): void } | null = null;
/**
 * True once this plugin has pushed a sky state at least once. See the
 * onFrame callback below: a reduced-motion user still gets ONE real
 * day/night state — whatever the world's phase is at attach — rather than
 * being left on core's unclaimed default forever; only updates AFTER that
 * first paint are what "no rapid transitions" actually gates.
 */
let hasPushedInitialSky = false;
/**
 * THE CALENDAR HALF OF THE CLOCK, as last broadcast — the world's age in days
 * and the calendar day it began on (protocol.ts). Null until a server that
 * sends them has been heard from, which the formatter renders as the time
 * alone.
 *
 * NOT INTERPOLATED, unlike the phase, and it does not need to be: this is an
 * integer that changes once per world-day, so the only moment a broadcast-
 * driven value could differ from the true one is the few seconds either side
 * of the turnover — and the turnover is dawn, where the sky is already sliding
 * between two broadcasts anyway. Advancing it locally would mean a second
 * clock in this file that could disagree with the one the server owns.
 */
let calendarDay: number | null = null;
let calendarGenesisDay: number | null = null;
let unsubscribeMessages: (() => void) | null = null;
let unsubscribeFrames: (() => void) | null = null;

export const clientPlugin: TerraceClientPlugin = {
  name: DAYNIGHT_PLUGIN_NAME,

  attach(ctx: ClientPluginCtx): void {
    reducedMotion = watchReducedMotion();
    hasPushedInitialSky = false;
    calendarDay = null;
    calendarGenesisDay = null;

    unsubscribeMessages = ctx.onMessage(DAYNIGHT_CLOCK_MESSAGE, (payload) => {
      const clock = parseClockPayload(payload);
      // A malformed payload is dropped whole: the sky already on screen keeps
      // reading until the next good message, a few seconds away.
      if (clock === null) return;
      interpolator.receive(clock.phase);
      calendarDay = clock.day;
      calendarGenesisDay = clock.genesisDay;
    });

    // THE RENDER PATH. Once per animation frame: a fixed handful of sines and
    // lerps (sky.ts) and at most one setSkyRig call — there is no per-system
    // fan-out the way weather's frame path has, because there is exactly one
    // clock.
    //
    // REDUCED MOTION (design record's hard requirement — see plugins/weather/
    // client/rig.ts's own header for the precedent this follows). At minimum,
    // "no rapid transitions": a full sweep is already a 1 440-second period
    // (protocol.ts's DAY_LENGTH_SECONDS) — nowhere near a flicker or strobe
    // hazard on its own — but this codebase treats prefers-reduced-motion as a
    // blanket "stop this plugin's own animation" instruction rather than a
    // narrowly-scoped flash guard (weather freezes its whole cosmetic clock,
    // fog spin and bob included, even though FOG_LAYERS' own comment notes
    // none of that motion is a photosensitivity concern by itself). This file
    // follows the same policy: once the initial sky is painted
    // (hasPushedInitialSky), no further setSkyRig call is made while reduced
    // motion is active, so the sky HOLDS STILL rather than continuing to sweep
    // — the strictest reading of "no rapid transitions" is "no transitions".
    // `interpolator` keeps advancing and receiving broadcasts regardless
    // (matching weather's own interpolator.advance(dt) — always run, never
    // gated), so the moment the preference is turned off mid-session the next
    // frame resumes from the world's REAL current phase, not a stale one.
    unsubscribeFrames = ctx.onFrame((dt) => {
      interpolator.advance(dt);

      // THE WORLD CLOCK READOUT (owner ask, 2026-08-21): the same interpolated
      // phase that drives the sky also feeds the header's time text, so the
      // clock and the sky can never disagree. Written every frame but as a
      // minute-granular string — Solid's signal dedupes equal values, so the
      // DOM updates once per in-world minute, not per frame. Cleared on
      // dispose so a plugin unload leaves no frozen lie on the header.
      setWorldTimeText(
        formatWorldClock(interpolator.samplePhase(), calendarDay, calendarGenesisDay),
      );

      const reduced = reducedMotion?.matches() ?? false;
      if (reduced && hasPushedInitialSky) return;

      ctx.setSkyRig(skyStateAtPhase(interpolator.samplePhase()));
      hasPushedInitialSky = true;
    });
  },

  dispose(): void {
    unsubscribeMessages?.();
    unsubscribeFrames?.();
    unsubscribeMessages = null;
    unsubscribeFrames = null;

    interpolator.clear();
    hasPushedInitialSky = false;
    calendarDay = null;
    calendarGenesisDay = null;
    setWorldTimeText(null);

    reducedMotion?.stop();
    reducedMotion = null;
  },
};
