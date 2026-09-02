// tornado → weather, via THE CROSS-PLUGIN DEPENDENCY PATTERN (host-mediated
// sibling lookup, WorldApi.sibling — issue #196; the same shape
// plugins/fire/server/weather-bridge.ts uses, restated here rather than
// imported, because plugins do not depend on each other's internals).
//
// WHAT THIS PLUGIN WANTS FROM WEATHER, and why it is a read and not a call:
//
//   A TORNADO IS BORN OUT OF A THUNDERSTORM CELL. That is issue #213's rule and
//   it is also what keeps the two plugins honest — a funnel dropping out of a
//   clear blue sky is the tell that this sim invented its own weather. So this
//   bridge asks the weather hub for its LIVING SYSTEMS and the spawner picks the
//   `thunderstorm`-kind ones. The hub is not told anything and does not change.
//
//   A FUNNEL RIDES ITS OWN TRACK, not the world's wind. The hub's wind is one
//   shared vector for the whole world; a funnel outruns the front that made it,
//   so this bridge is NOT consulted for movement. That is why `currentWind` is
//   absent from the surface below even though the hub exports it: every member
//   here is another way a version mismatch can degrade, so the surface holds
//   only what is actually used.
//
// DEGRADED BEHAVIOUR when the hub is absent, disabled for this world, or too old
// to export its systems: THERE ARE NO TORNADOES. One warning, once. That is the
// right failure mode — a self-hoster who removed the weather plugin removed the
// storm cells tornadoes come out of, and a plugin that invented them anyway
// would be quietly overriding their choice.

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

/**
 * The kind name the hub gives a thundering system. Duck-typed, so restated.
 *
 * The hub stamps a living system's `kind` with the name of the plugin that owns
 * it, which for thundering systems is `thunderstorm`. A STRING, and the
 * documented coupling between the two folders: this plugin holds no import of
 * that one, and a world running neither hub nor thunderstorm simply grows no
 * funnels.
 */
const WEATHER_STORM_KIND = 'thunderstorm';

/**
 * One weather system, as much of it as this plugin reads.
 *
 * DELIBERATELY NARROWER THAN WEATHER'S OWN `WeatherSystem`: a system also
 * carries an envelope, a retiring flag and a peak intensity, and none of them
 * decide where a funnel drops. Naming only what is used is what makes the
 * compatibility surface auditable.
 */
export interface WeatherCell {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

/** The slice of weather this plugin uses. One member; see the header. */
interface WeatherSystemsApi {
  livingSystems(): readonly WeatherCell[];
}

export const WEATHER_UNAVAILABLE_WARNING =
  '[tornado] weather plugin not available — no tornadoes will form';

/** Duck-types the sibling's module namespace into the API we need. */
function asWeatherApi(module: SiblingModule | null): WeatherSystemsApi | null {
  if (module === null) return null;
  if (typeof module.livingSystems !== 'function') return null;
  return module as unknown as WeatherSystemsApi;
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
const bridge = createSiblingBridge<WeatherSystemsApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

/**
 * Resolves weather through the host, from onWorldCreate.
 *
 * The host's lookup is synchronous and complete whatever the load order, so
 * there is nothing in flight and nothing to buffer: this bridge only READS, so
 * there is no desired state that would need replaying once a sibling appears.
 * Re-resolved on every call, so a weather the operator has just enabled is
 * picked up on the reopen.
 */
export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

/**
 * The THUNDERING weather systems right now — the cells a tornado may drop out
 * of. Empty when no weather is running here; callers never branch on that.
 *
 * Read fresh on every spawn roll rather than cached: a front drifts
 * continuously and dies without notice, and a funnel hanging under a storm cell
 * that blew over an hour ago is a bug nobody would think to look for.
 *
 * A MALFORMED SYSTEM IS SKIPPED, NOT TRUSTED, for fire's reason: a NaN centre
 * would propagate straight into a funnel's position and put a tornado nowhere.
 */
export function stormCells(): readonly WeatherCell[] {
  const api = bridge.api();
  if (api === null) return [];
  const systems = api.livingSystems();
  if (!Array.isArray(systems)) return [];
  const cells: WeatherCell[] = [];
  for (const system of systems) {
    if (system === null || typeof system !== 'object') continue;
    if (system.kind !== WEATHER_STORM_KIND) continue;
    if (!Number.isFinite(system.x) || !Number.isFinite(system.y)) continue;
    if (!Number.isFinite(system.radius) || system.radius <= 0) continue;
    cells.push(system);
  }
  return cells;
}

/** Test seam: forgets the resolved sibling and the warning. */
export function resetWeatherBridge(): void {
  bridge.reset();
}
