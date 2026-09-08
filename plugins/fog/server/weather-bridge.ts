import { createSiblingBridge } from '../../../server/src/plugins/kit/bridge.ts';
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
}

const WEATHER_PLUGIN_NAME = 'weather';

export const WEATHER_UNAVAILABLE_WARNING =
  '[fog] weather plugin not available — fog will gather where it forms and never drift';

export const CALM: { readonly heading: number; readonly speed: number } = { heading: 0, speed: 0 };

function asWeatherHub(module: SiblingModule | null): WeatherHubApi | null {
  if (module === null) return null;
  if (typeof module.currentWind !== 'function') return null;
  if (typeof module.registerSkyKind !== 'function') return null;
  return module as unknown as WeatherHubApi;
}

let desired: SkyKindEntry | null = null;
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

export function loadWeatherBridge(world: WorldApi): void {
  bridge.load(world);
}

export function registerWithHub(entry: SkyKindEntry): void {
  desired = entry;
  const api = bridge.api();
  if (api === null) return;
  unregister = api.registerSkyKind(entry);
}

export function unregisterFromHub(): void {
  unregister?.();
  unregister = null;
  desired = null;
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
  return {
    vx: Math.cos(wind.heading) * wind.speed,
    vy: Math.sin(wind.heading) * wind.speed,
  };
}

export function resetWeatherBridge(): void {
  unregister = null;
  desired = null;
  bridge.reset();
}
