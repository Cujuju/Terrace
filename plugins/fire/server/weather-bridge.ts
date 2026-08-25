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
// DEGRADED BEHAVIOUR when weather is absent (or too old to export the wind):
// the world is CALM — spread is isotropic, exactly as it would be on a windless
// day. One warning is logged, once. That is the right failure mode: a
// self-hoster who removed the weather plugin removed weather, not fire.

/** The slice of weather this plugin uses — the wind, and nothing else. */
export interface WeatherWindApi {
  currentWind(): { readonly heading: number; readonly speed: number };
}

/** Loads the weather module. Swappable so tests can exercise the absent path. */
export type WeatherModuleLoader = () => Promise<unknown>;

/** Relative to this file, resolving to the sibling plugin folder (rule 1). */
const DEFAULT_WEATHER_MODULE_LOADER: WeatherModuleLoader = () =>
  import('../../weather/server/index.ts');

export const WEATHER_UNAVAILABLE_WARNING =
  '[fire] weather plugin not available — fire will spread as if the air were still';

/**
 * The wind a world with no weather plugin has. Zero speed, so every downwind
 * term in ./spread.ts collapses to 1 and spread is isotropic; the heading is
 * then irrelevant, and 0 is the honest value for "there is no wind" rather than
 * a direction nothing is blowing in.
 */
export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

let loadModule: WeatherModuleLoader = DEFAULT_WEATHER_MODULE_LOADER;
let weatherApi: WeatherWindApi | null = null;
let loadPromise: Promise<void> | null = null;
let warned = false;

/** Duck-types a loaded module into the API we need (rule 4). */
function asWeatherApi(module: unknown): WeatherWindApi | null {
  if (typeof module !== 'object' || module === null) return null;
  const candidate = module as Partial<WeatherWindApi>;
  if (typeof candidate.currentWind !== 'function') return null;
  return candidate as WeatherWindApi;
}

function warnOnce(): void {
  if (warned) return;
  warned = true;
  console.warn(WEATHER_UNAVAILABLE_WARNING);
}

/** Starts the load (rule 2: from onWorldCreate, NOT awaited). */
export function loadWeatherBridge(): void {
  if (loadPromise !== null) return;

  loadPromise = loadModule()
    .then((module) => {
      weatherApi = asWeatherApi(module);
      if (weatherApi === null) warnOnce();
    })
    .catch(() => {
      weatherApi = null;
      warnOnce();
    });
}

/**
 * The wind right now, or CALM while the bridge is loading or absent. Callers
 * never branch on "is it loaded yet".
 *
 * Read fresh on every spread tick rather than cached: the wind veers
 * continuously (weather/server/systems.ts's bounded random walk), and a fire
 * running downwind of a wind that stopped an hour ago is a bug nobody would
 * think to look for.
 */
export function currentWind(): { readonly heading: number; readonly speed: number } {
  if (weatherApi === null) return CALM;
  const wind = weatherApi.currentWind();
  // A weather that answered with something malformed is treated as calm rather
  // than trusted into the spread arithmetic, where a NaN heading would silently
  // zero every neighbour's chance and stop fire spreading at all.
  if (!Number.isFinite(wind.heading) || !Number.isFinite(wind.speed)) return CALM;
  return wind;
}

/** Test seam: forgets the load and the warning. */
export function resetWeatherBridge(loader: WeatherModuleLoader = DEFAULT_WEATHER_MODULE_LOADER): void {
  loadModule = loader;
  weatherApi = null;
  loadPromise = null;
  warned = false;
}
