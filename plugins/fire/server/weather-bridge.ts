import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface WeatherWindApi {
  currentWind(): { readonly heading: number; readonly speed: number };
  precipitationAt?(x: number, y: number): number;
}

const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[fire] weather plugin not available — fire will spread as if the air were still';

export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

function asWeatherApi(module: SiblingModule | null): WeatherWindApi | null {
  if (module === null) return null;
  if (typeof module.currentWind !== 'function') return null;
  return module as unknown as WeatherWindApi;
}

const bridge = createSiblingBridge<WeatherWindApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

export function currentWind(): { readonly heading: number; readonly speed: number } {
  const api = bridge.api();
  if (api === null) return CALM;
  const wind = api.currentWind();
  if (!Number.isFinite(wind.heading) || !Number.isFinite(wind.speed)) return CALM;
  return wind;
}

export function precipitationAt(x: number, y: number): number {
  const api = bridge.api();
  if (api === null || api.precipitationAt === undefined) return 0;
  const wetness = api.precipitationAt(x, y);
  if (!Number.isFinite(wetness)) return 0;
  return Math.min(1, Math.max(0, wetness));
}

export function resetWeatherBridge(): void {
  bridge.reset();
}
