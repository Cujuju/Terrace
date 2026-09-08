import { SEA_LEVEL, cellsAcross, eyewallWindFalloff } from '@terrace/shared';
import { interpolateByDifficulty } from '../../../server/src/plugins/kit/difficultyCurve.ts';
import {
  createRotatingStorms,
  waterFractionUnder,
  type RotatingStorm,
  type RotatingStormProfile,
  type RotatingStormWorld,
} from '../../../server/src/plugins/kit/rotatingStorms.ts';
import {
  CYCLONE_EYE_RADIUS_FRACTION,
  cycloneNameFor,
  cycloneRadiusFor,
} from '../protocol.ts';

export const CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS = 2400;
export const CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS = 360;

export function meanSpawnIntervalSeconds(difficulty: number): number {
  return interpolateByDifficulty(
    CYCLONE_MEAN_INTERVAL_AT_EASIEST_SECONDS,
    CYCLONE_MEAN_INTERVAL_AT_HARDEST_SECONDS,
    difficulty,
  );
}

const CYCLONE_PROFILE: RotatingStormProfile = {
  speedCellsPerSecond: cellsAcross(0.25),
  veerRadiansPerSecond: 0.008,
  meanLifetimeSeconds: 480,
  spinUpSeconds: 45,
  fadeSeconds: 60,
  hostileTerrainDecayPerSecond: 0.018,
  minPeakIntensity: 0.6,
  maxPeakIntensity: 1,
  maxActive: 1,
  hostileTerrain: 'land',
  eyeRadiusFraction: CYCLONE_EYE_RADIUS_FRACTION,
  windFalloff: (r: number) => eyewallWindFalloff(r, CYCLONE_EYE_RADIUS_FRACTION),
};

export const MAX_ACTIVE_CYCLONES = CYCLONE_PROFILE.maxActive;

export const CYCLONE_MIN_OPEN_WATER_FRACTION = 0.85;

export const CYCLONE_RNG_DEFAULT_SEED = 0x3d_51_57_07;

export const cyclones = createRotatingStorms({
  profile: CYCLONE_PROFILE,
  seed: CYCLONE_RNG_DEFAULT_SEED,
  radiusFor: cycloneRadiusFor,
  nameFor: cycloneNameFor,
  reportsLandfall: true,
});

export function isWaterAt(world: RotatingStormWorld, x: number, y: number): boolean {
  return world.heightAt(x, y) <= SEA_LEVEL;
}

export function isOpenWater(
  world: RotatingStormWorld,
  x: number,
  y: number,
  radius: number,
): boolean {
  return waterFractionUnder(world, x, y, radius) >= CYCLONE_MIN_OPEN_WATER_FRACTION;
}

export function trySpawnCyclone(world: RotatingStormWorld): RotatingStorm | null {
  const radius = cycloneRadiusFor(world.worldSize);
  return cyclones.trySpawn(world, (random) => {
    const x = random() * world.worldSize;
    const y = random() * world.worldSize;
    if (!isOpenWater(world, x, y, radius)) return null;
    return { x, y };
  });
}
