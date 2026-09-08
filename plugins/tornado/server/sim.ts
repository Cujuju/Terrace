import { SEA_LEVEL, cellsAcross } from '@terrace/shared';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  createRotatingStorms,
  type RotatingStorm,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';
import { TORNADO_RADIUS_CELLS } from '../protocol.ts';
import { stormCells } from './weather-bridge.ts';

export const TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS = 600;
export const TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS = 90;

export function meanSpawnIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    TORNADO_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    TORNADO_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

const TORNADO_PROFILE: RotatingStormProfile = {
  speedCellsPerSecond: cellsAcross(2.5),
  veerRadiansPerSecond: 0.05,
  meanLifetimeSeconds: 60,
  spinUpSeconds: 4,
  fadeSeconds: 6,
  hostileTerrainDecayPerSecond: 0.25,
  minPeakIntensity: 0.5,
  maxPeakIntensity: 1,
  maxActive: 2,
  hostileTerrain: 'water',
  eyeRadiusFraction: 0,
  windFalloff: (r: number) => 1 - r * r,
};

export const MAX_ACTIVE_TORNADOES = TORNADO_PROFILE.maxActive;

export const TORNADO_RNG_DEFAULT_SEED = 0x57_07_3d_51;

export const tornadoes = createRotatingStorms({
  profile: TORNADO_PROFILE,
  seed: TORNADO_RNG_DEFAULT_SEED,
  radiusFor: () => TORNADO_RADIUS_CELLS,
});

export function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

export function trySpawnTornado(world: RotatingStormWorld): RotatingStorm | null {
  const cells = stormCells();
  if (cells.length === 0) return null;

  const cell = cells[Math.floor(tornadoes.random() * cells.length)]!;
  return tornadoes.trySpawn(world, (random) => {
    const angle = random() * Math.PI * 2;
    const distance = Math.sqrt(random()) * cell.radius;
    const x = cell.x + Math.cos(angle) * distance;
    const y = cell.y + Math.sin(angle) * distance;

    const cx = Math.round(x);
    const cy = Math.round(y);
    if (cx < 0 || cy < 0 || cx >= world.worldSize || cy >= world.worldSize) return null;
    if (isWaterAt(world, cx, cy)) return null;
    return { x, y };
  });
}
