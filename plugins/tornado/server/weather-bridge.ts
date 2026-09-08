import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

const WEATHER_PLUGIN_NAME = 'weather';

const WEATHER_STORM_KIND = 'thunderstorm';

export interface WeatherCell {
  readonly kind: string;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
}

interface WeatherSystemsApi {
  livingSystems(): readonly WeatherCell[];
}

export const WEATHER_UNAVAILABLE_WARNING =
  '[tornado] weather plugin not available — no tornadoes will form';

function asWeatherApi(module: SiblingModule | null): WeatherSystemsApi | null {
  if (module === null) return null;
  if (typeof module.livingSystems !== 'function') return null;
  return module as unknown as WeatherSystemsApi;
}

const bridge = createSiblingBridge<WeatherSystemsApi>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherApi,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
});

export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

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

export function resetWeatherBridge(): void {
  bridge.reset();
}
