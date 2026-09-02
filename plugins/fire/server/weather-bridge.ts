// fire → weather, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (plugins/relics/server/mana-bridge.ts — read its header; this file follows
// its four rules, with rule 3 not applying: this bridge only READS, so there is
// no desired state to buffer and replay).
//
// WHY FIRE BRIDGES OUT HERE, having just argued (./fuel.ts) that fuel must
// register inward. The two are different relationships and the direction
// follows the difference:
//
//   FUEL is an open set. Anything might burn, so `fire` must not hold a list of
//   what does — hence registration, so `fire` never changes when something new
//   catches.
//   WIND is one fact from one named plugin. There is no second source of wind
//   and there never will be; `fire` asking weather for it adds nothing to
//   weather and costs one file here.
//
// DEGRADED BEHAVIOUR when weather is absent, disabled here, or too old to
// export the wind:
// the world is CALM — spread is isotropic, exactly as it would be on a windless
// day. One warning is logged, once. That is the right failure mode: a
// self-hoster who removed the weather plugin removed weather, not fire.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/**
 * The slice of weather this plugin uses: the wind that carries a fire, and the
 * rain that ends one. Two members, and they are the whole compatibility surface
 * between two independently-deletable folders — every one added here is another
 * way a version mismatch can degrade.
 */
export interface WeatherWindApi {
  currentWind(): { readonly heading: number; readonly speed: number };
  /**
   * How wet a cell is, in [0, 1]. OPTIONAL on purpose: a weather plugin from
   * before 2026-08-24 exports `currentWind` and not this, and the right
   * degradation is "the wind still steers the fire, but rain does not put it
   * out" rather than refusing the whole bridge over a missing member.
   */
  precipitationAt?(x: number, y: number): number;
}

/**
 * The name the host knows weather by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196): the host hands back the plugin RUNNING as
 * `weather` in this session, so a weather that is absent OR disabled for this
 * world resolves to null, where the old import answered from the module map
 * either way.
 */
const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[fire] weather plugin not available — fire will spread as if the air were still';

/**
 * The wind a world with no weather plugin has. Zero speed, so every downwind
 * term in ./spread.ts collapses to 1 and spread is isotropic; the heading is
 * then irrelevant, and 0 is the honest value for "there is no wind" rather than
 * a direction nothing is blowing in.
 */
export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asWeatherApi(module: SiblingModule | null): WeatherWindApi | null {
  if (module === null) return null;
  if (typeof module.currentWind !== 'function') return null;
  return module as unknown as WeatherWindApi;
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
const bridge = createSiblingBridge<WeatherWindApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

/**
 * Resolves weather through the host, from onWorldCreate.
 *
 * NOTHING IS IN FLIGHT ANY MORE: the old rule 2 (start the import, do not await
 * it) existed because module resolution is asynchronous, and the host's lookup
 * is not. Re-resolved on every call, so a weather the operator has just enabled
 * is picked up on the reopen; the bridge's warn-once keeps an absent one to a single line.
 */
export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * The wind right now, or CALM when no weather is running here. Callers
 * never branch on whether there is one.
 *
 * Read fresh on every spread tick rather than cached: the wind veers
 * continuously (weather/server/systems.ts's bounded random walk), and a fire
 * running downwind of a wind that stopped an hour ago is a bug nobody would
 * think to look for.
 */
export function currentWind(): { readonly heading: number; readonly speed: number } {
  const api = bridge.api();
  if (api === null) return CALM;
  const wind = api.currentWind();
  // A weather that answered with something malformed is treated as calm rather
  // than trusted into the spread arithmetic, where a NaN heading would silently
  // zero every neighbour's chance and stop fire spreading at all.
  if (!Number.isFinite(wind.heading) || !Number.isFinite(wind.speed)) return CALM;
  return wind;
}

/**
 * How wet cell (x, y) is, in [0, 1]. Zero — bone dry — when no weather is
 * running here, and when the installed weather is too old to answer. Callers
 * never branch on any of that.
 */
export function precipitationAt(x: number, y: number): number {
  const api = bridge.api();
  if (api === null || api.precipitationAt === undefined) return 0;
  const wetness = api.precipitationAt(x, y);
  // A malformed answer is treated as dry rather than trusted into the
  // suppression arithmetic, where a NaN would make every comparison false and
  // silently disable rain.
  if (!Number.isFinite(wetness)) return 0;
  return Math.min(1, Math.max(0, wetness));
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetWeatherBridge(): void {
  bridge.reset();
}
