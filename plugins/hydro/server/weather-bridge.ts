// hydro → weather, via THE CROSS-PLUGIN DEPENDENCY PATTERN
// (server/src/plugins/kit/bridge.ts — read its header; this file follows its
// four rules, rule 3 included: this bridge BUFFERS, because the thing it has to
// say to weather is "there is water on the ground", and a hub that resolves
// later must still be told).
//
// THIS FILE IS THE DOUSE. Nothing in this plugin puts a fire out; fire does,
// through weather's union (plugins/weather/server/registry.ts's
// `precipitationAt`, consumed by fire's `suppressWithRain`). What hydro does is
// JOIN THAT UNION, so poured water is a wetting kind of sky exactly as rain,
// snow and thunderstorm are — and every consumer that already asks "how wet is
// this cell" learns about the bucket without being edited. That is the whole
// argument the registry's header makes for registering inward, and hydro is the
// first member of the union that is not weather at all.
//
// WHY A BRIDGE AND NOT AN IMPORT. `plugins/` is auto-discovered and a
// self-hoster is invited to delete folders they do not want. A static import of
// the hub would turn "I deleted the weather folder" into "the server no longer
// boots".
//
// DEGRADED BEHAVIOUR when weather is absent, disabled here, or too old to
// export the register: the water still lands, is still broadcast, still darkens
// the ground the player poured it on and still brings a saturated hillside down
// (../server/mudslides-bridge.ts is a separate seam). What is lost is the
// DOUSE, because nothing is asking. One warning is logged, once. That is the
// right failure mode and the one this whole plugin family keeps: a self-hoster
// who removed the weather plugin removed the sky, not the bucket.
//
// ─────────────────────────────────────────────────────────────────────────────
// THE COUPLING THAT MAKES THE LANDSLIDE HALF POSSIBLE, stated here because this
// is where it is delivered. mudslides soaks a tracked site only while
// `precipitationAt` reads at or above MUDSLIDE_SOAKING_RAIN_INTENSITY (0.35,
// plugins/mudslides/server/slides.ts) — so `wetnessAt` below MUST be able to
// exceed that figure, or a puddle would be weather the hillside never notices.
// It does: ../protocol.ts's `hydroWetness` is exactly 1 at a fresh patch's
// centre and stays above 0.35 for the first ~32 s of its 40 s life. A future
// re-tune of `hydroWetness` that capped it lower would silently delete the
// slow, ambient half of this feature — the half that works on a site mudslides
// was already watching — and leave only the directed request.

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
 * The slice of weather this plugin uses: ONE member, the register it joins.
 *
 * Narrower than rain's, and that is the point of each bridge writing its own
 * (server/src/plugins/kit/bridge.ts's "what stays a documented copy"): water on
 * the ground does not drift, so this plugin has no use for the wind, and every
 * member named here would be another way a version mismatch could degrade.
 */
export interface WeatherHubApi {
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
  '[hydro] weather plugin not available — poured water will not put fires out';

/** Duck-types the sibling's module namespace into the API we need (rule 4). */
function asWeatherHub(module: SiblingModule | null): WeatherHubApi | null {
  if (module === null) return null;
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
 *
 * SAFE TO CALL TWICE, because the hub's own register replaces by name — which
 * is what makes onWorldCreate's replay on a reopen or a rollback leave one
 * entry rather than two (the registry's SAME NAME REPLACES rule).
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

/** Test seam: forgets the resolved hub, the registration and the warning. */
export function resetWeatherBridge(): void {
  unregister = null;
  desired = null;
  bridge.reset();
}
