// fog → weather, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (server/src/plugins/kit/bridge.ts — read its header; this file follows its
// four rules, rule 3 included: this bridge BUFFERS, because the thing it has to
// say to weather is "fog is in the sky", and a hub that resolves later must
// still be told).
//
// WHY A BRIDGE AND NOT AN IMPORT. `plugins/` is auto-discovered and a self-hoster
// is invited to delete folders they do not want. A static import of the hub would
// turn "I deleted the weather folder" into "the server no longer boots".
//
// DEGRADED BEHAVIOUR when weather is absent, disabled here, or too old to export
// the register: the world is CALM and nobody is told about the fog. Systems
// still gather, sit and fade in place and are still broadcast to clients, so it
// still falls — it just does not drift, and fire does not learn that the ground
// is wet. That is the right failure mode: a self-hoster who removed the weather
// plugin removed the wind, not the fog.

import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

/** One disc in the sky, as the hub passes it around. */
export interface SkyCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

/** What this plugin hands the hub when it joins the sky. */
export interface SkyKindEntry {
  readonly name: string;
  cells(): readonly SkyCell[];
  wetnessAt(x: number, y: number): number;
  spawnOne?(): boolean;
}

/**
 * The slice of weather this plugin uses: the wind it drifts on, and the register
 * it joins. Two members, and they are the whole compatibility surface between two
 * independently-deletable folders — every one added here is another way a version
 * mismatch can degrade.
 */
export interface WeatherHubApi {
  currentWind(): { readonly heading: number; readonly speed: number };
  registerSkyKind(entry: SkyKindEntry): () => void;
}

/**
 * The name the host knows the hub by — the key `WorldApi.sibling` answers to.
 *
 * A NAME, NOT A PATH (issue #196): the host hands back the plugin RUNNING as
 * `weather` in this session, so a hub that is absent OR disabled for this world
 * resolves to null.
 */
const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[fog] weather plugin not available — fog will gather where it forms and never drift';

/**
 * The wind a world with no weather hub has. Zero speed, so a system sits where
 * it formed; the heading is then irrelevant, and 0 is the honest value for
 * "there is no wind" rather than a direction nothing is blowing in.
 */
export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asWeatherHub(module: SiblingModule | null): WeatherHubApi | null {
  if (module === null) return null;
  if (typeof module.currentWind !== 'function') return null;
  if (typeof module.registerSkyKind !== 'function') return null;
  return module as unknown as WeatherHubApi;
}

/**
 * The entry this plugin wants registered, held as DESIRED STATE (rule 3) so a
 * hub that resolves after us — or one re-resolved on a reopen — is told without
 * this plugin having to notice.
 */
let desired: SkyKindEntry | null = null;
/** The hub's own unregister for the live registration, if there is one. */
let unregister: (() => void) | null = null;

const bridge = createSiblingBridge<WeatherHubApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherHub,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
  onResolved: (api) => {
    if (desired === null) return;
    unregister = api.registerSkyKind(desired);
  },
});

/** Resolves the hub through the host, from onWorldCreate. */
export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * Joins the sky. Safe to call before the bridge has resolved: the entry is kept
 * and replayed when (and if) a hub turns up.
 */
export function registerWithHub(entry: SkyKindEntry): void {
  desired = entry;
  const api = bridge.api();
  if (api === null) return;
  unregister = api.registerSkyKind(entry);
}

/**
 * Leaves the sky and forgets the resolved hub — what this bridge does when its
 * world closes. A module-scope view must not outlive the world it was resolved
 * for (the 2026-08-25 revocation rule).
 */
export function unregisterFromHub(): void {
  unregister?.();
  unregister = null;
  desired = null;
  bridge.clear();
}

/**
 * The wind right now, or CALM when no hub is running here. Callers never branch
 * on whether there is one.
 *
 * Read fresh on every tick rather than cached: the wind veers continuously
 * (plugins/weather/server/wind.ts's bounded random walk), and a front riding a
 * wind that stopped an hour ago is a bug nobody would think to look for.
 */
export function currentWind(): { readonly heading: number; readonly speed: number } {
  const api = bridge.api();
  if (api === null) return CALM;
  const wind = api.currentWind();
  // A hub that answered with something malformed is treated as calm rather than
  // trusted into the drift arithmetic, where a NaN would put every system at an
  // undefined position and take the broadcast with it.
  if (!Number.isFinite(wind.heading) || !Number.isFinite(wind.speed)) return CALM;
  return wind;
}

/** Cell-space velocity of the wind this plugin drifts on. */
export function windVelocity(): { vx: number; vy: number } {
  const wind = currentWind();
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

/** Test seam: forgets the resolved hub, the registration and the warning. */
export function resetWeatherBridge(): void {
  unregister = null;
  desired = null;
  bridge.reset();
}
