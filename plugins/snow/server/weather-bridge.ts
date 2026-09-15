import { polarVelocity } from '@terrace/shared';
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
  currentWind(): { readonly heading: number; readonly speed: number };
  registerSkyKind(entry: SkyKindEntry): () => void;
  spawnSkyKind?(name: string): boolean;
}

const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[snow] weather plugin not available — snow will gather where it forms and never drift';

export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

function asWeatherHub(module: SiblingModule | null): WeatherHubApi | null {
  if (module === null) return null;
  if (typeof module.currentWind !== 'function') return null;
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

export function currentWind(): { readonly heading: number; readonly speed: number } {
  const api = bridge.api();
  if (api === null) return CALM;
  const wind = api.currentWind();
  if (!Number.isFinite(wind.heading) || !Number.isFinite(wind.speed)) return CALM;
  return wind;
}

export function windVelocity(): { vx: number; vy: number } {
  const wind = currentWind();
  return polarVelocity(wind.heading, wind.speed);
}

export function resetWeatherBridge(): void {
  bridge.reset();
}

export function handOffSpawnTo(name: string): boolean {
  const api = bridge.api();
  if (api?.spawnSkyKind === undefined) return false;
  return api.spawnSkyKind(name) === true;
}
