// mudslides → weather, via THE CROSS-PLUGIN DEPENDENCY PATTERN (host-mediated
// sibling lookup, WorldApi.sibling — issue #196; the same shape
// plugins/storms/server/weather-bridge.ts and plugins/fire's use, restated here
// rather than imported, because plugins do not depend on each other's internals).
//
// WHAT THIS PLUGIN WANTS FROM WEATHER: HOW WET IS THIS HILLSIDE, RIGHT NOW.
// `precipitationAt(x, y)` is weather's own answer to exactly that question — the
// strongest wetting system covering the cell, in [0, 1] — so the surface below
// holds that one member and nothing else. Weather is not told anything and does
// not change.
//
// WHY NOT `livingSystems()`, which weather also exports and storms uses. Storms
// needs to know WHERE the storm cells are, because a funnel drops out of one;
// this plugin needs to know whether the ground under a particular hillside is
// being rained on, which is a point query weather already answers correctly
// (including the intensity envelope and the overlap rule). Re-deriving it here
// from the system list would be a second, drifting copy of weather's own
// wetting rule — and every member on this surface is another way a version
// mismatch can degrade, so it holds only what is used.
//
// DEGRADED BEHAVIOUR when weather is absent, disabled for this world, or too old
// to export `precipitationAt`: IT NEVER RAINS, so the only trigger left is
// FRESHWATER ADJACENCY (WorldApi.freshwater — core's own fact, always there).
// Slides still happen, on river banks, and nowhere else. One warning, once. That
// is the honest degradation: a self-hoster who removed weather removed the rain,
// and a plugin that invented rain anyway would be overriding their choice.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * The name the host knows weather by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196): the host hands back the plugin RUNNING as
 * `weather` in this session, so a weather that is absent OR disabled for this
 * world resolves to null, where an import would answer from the module map
 * either way.
 */
const WEATHER_PLUGIN_NAME = 'weather';

/** The slice of weather this plugin uses. One member; see the header. */
interface WeatherRainApi {
  precipitationAt(x: number, y: number): number;
}

export const WEATHER_UNAVAILABLE_WARNING =
  '[mudslides] weather plugin not available — no rain trigger; ' +
  'slides will only start on freshwater-adjacent ground';

/** Duck-types the sibling's module namespace into the API we need. */
function asWeatherApi(module: SiblingModule | null): WeatherRainApi | null {
  if (module === null) return null;
  if (typeof module.precipitationAt !== 'function') return null;
  return module as unknown as WeatherRainApi;
}

/**
 * The sibling, resolved through the host — the MECHANISM only: the name lookup,
 * the warn-once, the re-resolve on every load, the clear on close.
 *
 * It lives in core's plugin kit (server/src/plugins/kit/bridge.ts) because
 * nineteen bridges each carried a copy of it. What stays HERE is the duck-typed
 * interface above and the accessors below, because those are the CONTRACT
 * between two independently-deletable folders — the thing that has to survive
 * one side being absent or older.
 */
const bridge = createSiblingBridge<WeatherRainApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

/**
 * Resolves weather through the host, from onWorldCreate.
 *
 * The host's lookup is synchronous and complete whatever the load order, so
 * there is nothing in flight and nothing to buffer — this bridge only READS, so
 * there is no desired state that would need replaying once a sibling appears.
 * Re-resolved on every call, so a weather the operator has just enabled is
 * picked up on the reopen.
 */
export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * How hard it is raining on this cell, in [0, 1]. Zero when no weather is
 * running here; callers never branch on that.
 *
 * A MALFORMED ANSWER IS TREATED AS DRY, NOT TRUSTED, for fire's reason: a NaN
 * would propagate straight into a saturation accumulator and make every
 * comparison against it false forever, which is a bug that looks like "mudslides
 * stopped working" three hours later.
 */
export function rainAt(x: number, y: number): number {
  const api = bridge.api();
  if (api === null) return 0;
  const value = api.precipitationAt(x, y);
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetWeatherBridge(): void {
  bridge.reset();
}
