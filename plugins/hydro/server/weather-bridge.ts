import { createRegisteringBridge } from '../../../server/src/plugins/kit/bridge.ts';
import type { SiblingModule, WorldApi } from '../../../server/src/plugins/types.ts';

export interface SkyCell {
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly intensity: number;
}

export interface SkyKindEntry {
  readonly name: string;
  cells(): readonly SkyCell[];
  wetnessAt(x: number, y: number): number;
  spawnOne?(): boolean;
}

export interface WeatherHubApi {
  registerSkyKind(entry: SkyKindEntry): () => void;
}

const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[hydro] weather plugin not available — poured water will not put fires out';

function asWeatherHub(module: SiblingModule | null): WeatherHubApi | null {
  if (module === null) return null;
  if (typeof module.registerSkyKind !== 'function') return null;
  return module as unknown as WeatherHubApi;
}

const bridge = createRegisteringBridge<WeatherHubApi, SkyKindEntry>({
  pluginName: WEATHER_PLUGIN_NAME,
  duckType: asWeatherHub,
  unavailableWarning: WEATHER_UNAVAILABLE_WARNING,
  register: (api, entry) => api.registerSkyKind(entry),
});

export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

export function registerWithHub(entry: SkyKindEntry): void {
  bridge.registerWith(entry);
}

export function unregisterFromHub(): void {
  bridge.clear();
}

export function resetWeatherBridge(): void {
  bridge.reset();
}
