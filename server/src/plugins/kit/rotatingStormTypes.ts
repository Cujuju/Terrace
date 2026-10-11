import type { RotatingStormState } from '@terrace/shared';
import { DEFAULT_TICK_HZ } from '../../config.ts';

export interface RotatingStormWorld {
  readonly worldSize: number;
  heightAt(x: number, y: number): number;
}

export type HostileTerrain = 'land' | 'water';

export interface RotatingStormProfile {
  readonly speedCellsPerSecond: number;
  readonly veerRadiansPerSecond: number;
  readonly meanLifetimeSeconds: number;
  readonly spinUpSeconds: number;
  readonly fadeSeconds: number;
  readonly hostileTerrainDecayPerSecond: number;
  readonly minPeakIntensity: number;
  readonly maxPeakIntensity: number;
  readonly maxActive: number;
  readonly hostileTerrain: HostileTerrain;
  readonly eyeRadiusFraction: number;
  windFalloff(r: number): number;
}

export interface RotatingStormsSpec {
  readonly profile: RotatingStormProfile;
  readonly seed: number;
  radiusFor(worldSize: number): number;
  nameFor?(index: number, x: number, y: number, worldSize: number): string;
  readonly reportsLandfall?: boolean;
}

export const ROTATING_STORM_SITING_ATTEMPTS = 6;

export const ROTATING_STORM_DESPAWN_MARGIN_RADII = 1.5;

export const ROTATING_STORM_DAMAGE_INTERVAL_SECONDS = 1;

export const ROTATING_STORM_DAMAGE_SAMPLE_CELLS = 12;

// Veer is a zero-mean random walk: steps scale with √dt so the spread is
// TICK_HZ-independent, and reproduce the profile's draw at the default rate.
const REFERENCE_TICK_SECONDS = 1 / DEFAULT_TICK_HZ;

export const ROTATING_STORM_VEER_SQRT_REFERENCE_SECONDS = Math.sqrt(REFERENCE_TICK_SECONDS);

export interface RotatingStorm {
  readonly id: number;
  x: number;
  y: number;
  readonly radius: number;
  heading: number;
  readonly peakIntensity: number;
  envelope: number;
  retiring: boolean;
  lifeSeconds: number;
  readonly name?: string;
  landfallReported: boolean;
  damageDebtSeconds: number;
  ownerDebtSeconds: number;
}

export interface RotatingStormDamage {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly radius: number;
  readonly eyeRadius: number;
  readonly intensity: number;
  readonly durationSeconds: number;
  readonly cells: ReadonlyArray<{
    readonly x: number;
    readonly y: number;
    readonly severity: number;
  }>;
}

export interface RotatingStormLandfall {
  readonly stormId: number;
  readonly x: number;
  readonly y: number;
  readonly intensity: number;
  readonly name?: string;
}

export interface RotatingStormTick {
  readonly changed: boolean;
  readonly damage: readonly RotatingStormDamage[];
  readonly landfalls: readonly RotatingStormLandfall[];
}

export interface RotatingStormsSnapshot {
  readonly nextStormId: number;
  readonly namedCount: number;
  readonly rngState: number;
  readonly storms: readonly RotatingStorm[];
}

export interface RotatingStorms {
  readonly sitingAttempts: number;
  readonly maxActive: number;
  random(): number;
  rollSpawn(ratePerSecond: number, dt: number): boolean;
  storms(): readonly RotatingStorm[];
  count(): number;
  trySpawn(
    world: RotatingStormWorld,
    drawSite: (random: () => number) => { readonly x: number; readonly y: number } | null,
  ): RotatingStorm | null;
  spawnAt(world: RotatingStormWorld, x: number, y: number): RotatingStorm;
  advance(world: RotatingStormWorld, dt: number): RotatingStormTick;
  states(): RotatingStormState[];
  snapshot(): RotatingStormsSnapshot;
  restore(snapshot: RotatingStormsSnapshot): void;
  reset(): void;
  clear(): void;
  freeze(frozen: boolean): void;
  isFrozen(): boolean;
}
