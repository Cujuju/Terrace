import type { TerracePlugin, WorldApi } from '../../../server/src/plugins/types.ts';
import { resetSkyRegistry } from './registry.ts';
import { advanceWind, resetWind } from './wind.ts';

export const WEATHER_PLUGIN_NAME = 'weather';

export const plugin: TerracePlugin = {
  name: WEATHER_PLUGIN_NAME,

  // Kinds register before this hook (the host runs plugins in name order), and
  // rollback re-creates without a close: the registry is cleared only on close.
  onWorldCreate(): void {
    resetWind();
  },

  onWorldClose(): void {
    resetSkyRegistry();
  },

  onTick(_world: WorldApi, dt: number): void {
    advanceWind(dt);
  },
};

export { currentWind, windVelocity, type Wind } from './wind.ts';

export {
  livingSystems,
  precipitationAt,
  registerSkyKind,
  resetSkyRegistry,
  spawnSkyKind,
  type SkyCell,
  type SkyKindEntry,
  type SkyKindSystem,
} from './registry.ts';

export function resetWeatherState(): void {
  resetSkyRegistry();
  resetWind();
}
