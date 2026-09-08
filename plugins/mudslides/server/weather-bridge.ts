import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

const WEATHER_PLUGIN_NAME = 'weather';

interface WeatherRainApi {
  precipitationAt(x: number, y: number): number;
}

export const WEATHER_UNAVAILABLE_WARNING =
  '[mudslides] weather plugin not available — no rain trigger; ' +
  'slides will only start on freshwater-adjacent ground';

function asWeatherApi(module: SiblingModule | null): WeatherRainApi | null {
  if (module === null) return null;
  if (typeof module.precipitationAt !== 'function') return null;
  return module as unknown as WeatherRainApi;
}

const bridge = createSiblingBridge<WeatherRainApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

export function rainAt(x: number, y: number): number {
  const api = bridge.api();
  if (api === null) return 0;
  const value = api.precipitationAt(x, y);
  if (typeof value !== 'number' || !Number.isFinite(value)) return 0;
  return Math.min(1, Math.max(0, value));
}

export function resetWeatherBridge(): void {
  bridge.reset();
}
