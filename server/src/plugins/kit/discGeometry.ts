import { cellsAcross } from '@terrace/shared';

export const DISC_MIN_ACTIVE_SYSTEMS = 1;

export const DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS = 20;

export const DISC_EFFECTIVE_LIFETIME_SECONDS = 130;

export const DISC_EQUILIBRIUM_OCCUPANCY =
  DISC_EFFECTIVE_LIFETIME_SECONDS /
  (DISC_EFFECTIVE_LIFETIME_SECONDS + DISC_MEAN_SPAWN_INTERVAL_PER_SLOT_SECONDS);

export const DISC_SYSTEM_MIN_RADIUS_CELLS = cellsAcross(24);
export const DISC_SYSTEM_MAX_RADIUS_CELLS = cellsAcross(56);

export const DISC_DEFAULT_FOOTPRINT_AREA_SCALE = 1;

export const DISC_MAX_RADIUS_WORLD_FRACTION = 0.35;

export const DISC_SPAWN_MARGIN_RADII = 1;

export const DISC_DESPAWN_MARGIN_RADII = 1.5;

export interface DiscSystem {
  readonly id: number;
  x: number;
  y: number;
  readonly radius: number;
  readonly peakIntensity: number;
  envelope: number;
  retiring: boolean;
}

export function discRadiusFactorFor(footprintAreaScale: number): number {
  return Math.sqrt(footprintAreaScale);
}

export function discMinRadiusFor(
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return DISC_SYSTEM_MIN_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale);
}

export function discMaxRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  const fromWorld = worldSize * DISC_MAX_RADIUS_WORLD_FRACTION;
  return Math.max(
    discMinRadiusFor(footprintAreaScale),
    Math.min(DISC_SYSTEM_MAX_RADIUS_CELLS * discRadiusFactorFor(footprintAreaScale), fromWorld),
  );
}

export function discMeanRadiusFor(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  return (
    (discMinRadiusFor(footprintAreaScale) + discMaxRadiusFor(worldSize, footprintAreaScale)) / 2
  );
}

export function discMeanFootprintCells(
  worldSize: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  const a = discMinRadiusFor(footprintAreaScale);
  const b = discMaxRadiusFor(worldSize, footprintAreaScale);
  return (Math.PI * (a * a + a * b + b * b)) / 3;
}

// The cap is what keeps coverageFraction honest: a scaled footprint means
// fewer fronts, not more sky covered.
export function discActiveCapFor(
  worldSize: number,
  coverageFraction: number,
  ceiling: number,
  footprintAreaScale: number = DISC_DEFAULT_FOOTPRINT_AREA_SCALE,
): number {
  const spawnFieldEdge =
    worldSize + 2 * discMeanRadiusFor(worldSize, footprintAreaScale) * DISC_SPAWN_MARGIN_RADII;
  const perSystemCoverage =
    discMeanFootprintCells(worldSize, footprintAreaScale) / (spawnFieldEdge * spawnFieldEdge);
  const wanted = Math.round(coverageFraction / perSystemCoverage / DISC_EQUILIBRIUM_OCCUPANCY);
  return Math.max(DISC_MIN_ACTIVE_SYSTEMS, Math.min(ceiling, wanted));
}

export function discHasLeftWorld(system: DiscSystem, worldSize: number): boolean {
  const margin = system.radius * DISC_DESPAWN_MARGIN_RADII;
  return (
    system.x < -margin ||
    system.y < -margin ||
    system.x > worldSize + margin ||
    system.y > worldSize + margin
  );
}
